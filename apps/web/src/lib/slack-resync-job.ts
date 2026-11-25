import "server-only";
import {
  and,
  eq,
  inArray,
  isNull,
  slackChannelLeft,
  slackChannelMembers,
  sql,
  users,
  type AnyDb,
} from "@cheddar/db";
import { getDb } from "./db";
import { env } from "./env";

const SLACK_API = "https://slack.com/api";

export interface SlackResyncResult {
  /** Members currently in the channel (from Slack). */
  channelMembers: number;
  /** Active app users with a Slack id on file. */
  appUsers: number;
  /** Slack ids invited on this run. */
  invited: string[];
  /** Users Slack said were already in the channel. */
  alreadyIn: string[];
  /** Users skipped because they previously left the channel. */
  skippedLeft: number;
  /** Users who left the channel since the last run. */
  newlyLeft: string[];
  /** Users who were marked as left but are back in the channel. */
  rejoined: number;
  failed: { slackId: string; error: string }[];
}

interface SlackOk<T> {
  ok: true;
}

interface SlackErr<T> {
  ok: false;
  error?: string;
  needed?: string;
  provided?: string;
}

type SlackResponse<T> = (SlackOk<T> & T) | SlackErr<T>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** POST a Slack Web API method, retrying on 429 using Slack's Retry-After. */
async function slackPost<T>(
  method: string,
  token: string,
  body: Record<string, unknown>,
  attempts = 4,
): Promise<SlackResponse<T>> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < attempts) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      // Cap the wait so one slow bucket can't eat the whole function budget.
      await sleep(Math.min(Number.isFinite(retryAfter) ? retryAfter : 1, 10) * 1000);
      continue;
    }
    return (await res.json()) as SlackResponse<T>;
  }
}

/** Every member of the channel, following pagination. */
async function listChannelMembers(token: string, channel: string): Promise<Set<string>> {
  const members = new Set<string>();
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ channel, limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${SLACK_API}/conversations.members?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as SlackResponse<{
      members?: string[];
      response_metadata?: { next_cursor?: string };
    }>;
    if (!json.ok) {
      const hint = json.needed ? ` (needs scope ${json.needed})` : "";
      throw new Error(`conversations.members failed: ${json.error ?? "unknown"}${hint}`);
    }
    for (const m of json.members ?? []) members.add(m);
    cursor = json.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return members;
}

/** Active, human users who have a Slack id on file. */
async function listAppUsers(db: AnyDb) {
  return db
    .select({ id: users.id, slackId: users.slackId })
    .from(users)
    .where(and(sql`${users.slackId} IS NOT NULL`, eq(users.isBot, false), isNull(users.suspendedAt)));
}

/**
 * Invite every active app user to the Cheddar Slack channel.
 *
 * State lives in two tables: `slack_channel_members` (ever invited) and
 * `slack_channel_left` (left on purpose, never re-added). Idempotent, so it is
 * safe to run from a frequent cron.
 */
export async function runSlackResync(): Promise<SlackResyncResult> {
  const token = env.slackBotToken;
  const channel = env.slackSyncChannelId;
  if (!token) throw new Error("Missing configuration: SLACK_BOT_TOKEN");
  if (!channel) throw new Error("Missing configuration: SLACK_SYNC_CHANNEL_ID");

  const db = await getDb();

  const [slackMembers, appUsers, addedRows, leftRows] = await Promise.all([
    listChannelMembers(token, channel),
    listAppUsers(db),
    db.select({ userId: slackChannelMembers.userId }).from(slackChannelMembers),
    db.select({ userId: slackChannelLeft.userId }).from(slackChannelLeft),
  ]);

  const addedSet = new Set(addedRows.map((r) => r.userId));
  const leftSet = new Set(leftRows.map((r) => r.userId));

  const result: SlackResyncResult = {
    channelMembers: slackMembers.size,
    appUsers: appUsers.length,
    invited: [],
    alreadyIn: [],
    skippedLeft: 0,
    newlyLeft: [],
    rejoined: 0,
    failed: [],
  };

  const everyone = appUsers.filter((u): u is { id: string; slackId: string } => !!u.slackId);

  // 1. Reconcile state for people who are already in the channel.
  const toClearLeft: string[] = [];
  const toMarkAdded: string[] = [];
  for (const user of everyone) {
    if (!slackMembers.has(user.slackId)) continue;
    toMarkAdded.push(user.id);
    if (leftSet.has(user.id)) {
      toClearLeft.push(user.id);
      result.rejoined++;
    }
  }
  if (toMarkAdded.length) {
    await db.insert(slackChannelMembers).values(toMarkAdded.map((userId) => ({ userId }))).onConflictDoNothing();
  }
  if (toClearLeft.length) {
    await db.delete(slackChannelLeft).where(inArray(slackChannelLeft.userId, toClearLeft));
  }

  // 2. People not in the channel: figure out who actually needs an invite.
  const toInvite: { id: string; slackId: string }[] = [];
  const newlyLeftIds: string[] = [];
  for (const user of everyone) {
    if (slackMembers.has(user.slackId)) continue;
    if (leftSet.has(user.id)) {
      result.skippedLeft++;
      continue;
    }
    if (addedSet.has(user.id)) {
      // We invited them before, but they're gone now: they chose to leave.
      newlyLeftIds.push(user.id);
      result.newlyLeft.push(user.slackId);
      continue;
    }
    toInvite.push(user);
  }
  if (newlyLeftIds.length) {
    await db.insert(slackChannelLeft).values(newlyLeftIds.map((userId) => ({ userId }))).onConflictDoNothing();
  }

  // 3. Invite the rest, recording each success.
  const invitedIds: string[] = [];
  let joinedChannel = false;
  for (const user of toInvite) {
    let res = await slackPost<{}>("conversations.invite", token, {
      channel,
      users: user.slackId,
    });
    // A bot can only invite people to a channel it is in. Try to join once (public
    // channels; requires channels:join) and retry.
    if (!res.ok && res.error === "not_in_channel" && !joinedChannel) {
      joinedChannel = true;
      const join = await slackPost<{}>("conversations.join", token, { channel });
      if (join.ok) {
        res = await slackPost<{}>("conversations.invite", token, { channel, users: user.slackId });
      }
    }
    if (res.ok) {
      invitedIds.push(user.id);
      result.invited.push(user.slackId);
      continue;
    }
    const error = res.error ?? "unknown_error";
    // Slack treats these as fine for our purposes: record the membership so we
    // don't keep retrying every run.
    if (error === "already_in_channel" || error === "cant_invite_self") {
      invitedIds.push(user.id);
      result.alreadyIn.push(user.slackId);
      continue;
    }
    result.failed.push({ slackId: user.slackId, error });
    console.error(`[slack-resync] invite ${user.slackId} failed: ${error}`);
  }
  if (invitedIds.length) {
    await db.insert(slackChannelMembers).values(invitedIds.map((userId) => ({ userId }))).onConflictDoNothing();
  }

  console.info(
    `[slack-resync] ${result.invited.length} invited, ${result.alreadyIn.length} already in, ` +
      `${result.newlyLeft.length} left, ${result.skippedLeft} skipped (left before), ` +
      `${result.rejoined} rejoined, ${result.failed.length} failed`,
  );
  return result;
}
