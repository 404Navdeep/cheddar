import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { churnSyncs, createPgliteDb, eq, journalEntries, users, type AnyDb } from "@cheddar/db";
import {
  Exchange,
  ExchangeError,
  HackatimeError,
  HackatimeHttpClient,
  addMouseFunder,
  audit,
  ensureMouse,
  removeMouseFunder,
  syncAll,
  syncUser,
  ticksForSeconds,
  type HackatimeClient,
  type HackatimeLookup,
  type HackatimeSnapshot,
} from "../src/index";
import { balances, fund, makeUser, makeWheel, position } from "./helpers";

/** Scriptable stand-in for Hackatime. */
class FakeHackatime implements HackatimeClient {
  data = new Map<string, HackatimeSnapshot | Error>();
  calls: HackatimeLookup[] = [];
  set(id: string, hours: number, trustLevel: HackatimeSnapshot["trustLevel"] = "blue") {
    this.data.set(id, { lifetimeNonAiSeconds: Math.round(hours * 3600), trustLevel });
  }
  async snapshot(u: HackatimeLookup) {
    this.calls.push(u);
    const d = this.data.get(u.hackatimeUserId ?? u.slackId ?? "");
    if (!d) throw new HackatimeError("Hackatime 404: User not found", 404);
    if (d instanceof Error) throw d;
    return d;
  }
}

let db: AnyDb;
let client: PGlite;
let ht: FakeHackatime;

beforeEach(async () => {
  const r = await createPgliteDb();
  db = r.db as unknown as AnyDb;
  client = r.client;
  ht = new FakeHackatime();
});
afterEach(async () => {
  expect(await audit(db)).toEqual([]);
  await client.close();
});

async function coder(name: string, hackatimeUserId: string, slackId?: string) {
  return makeUser(db, name, { hackatimeUserId, slackId });
}

describe("Churn", () => {
  it("converts seconds to ticks exactly: 10 Latta per hour, rounded down", () => {
    expect(ticksForSeconds(3600)).toBe(1_000);
    expect(ticksForSeconds(1)).toBe(0); // 0.28 ticks
    expect(ticksForSeconds(4)).toBe(1); // 1.11 ticks
    expect(ticksForSeconds(731_627)).toBe(203_229); // 203.23 hours -> 2,032.29 Latta
    expect(() => ticksForSeconds(1.5)).toThrow();
  });

  it("credits lifetime hours, then only the increase, and is idempotent", async () => {
    const u = await coder("orpheus", "101");
    ht.set("101", 10);
    expect(await syncUser(db, ht, u.id)).toMatchObject({ status: "credited", creditedTicks: 10_000 });
    expect(await syncUser(db, ht, u.id)).toMatchObject({ status: "no_change", creditedTicks: 0 });
    ht.set("101", 12.5);
    expect(await syncUser(db, ht, u.id)).toMatchObject({ status: "credited", creditedTicks: 2_500 });
    expect((await balances(db, u.id)).available).toBe(12_500);
  });

  it("partial-hour remainders are never lost across syncs", async () => {
    const u = await coder("drip", "102");
    let total = 0;
    for (let s = 0; s < 40; s++) {
      total += 1; // one second at a time: each step alone is < 1 tick
      ht.data.set("102", { lifetimeNonAiSeconds: total, trustLevel: "blue" });
      await syncUser(db, ht, u.id);
    }
    expect((await balances(db, u.id)).available).toBe(ticksForSeconds(40));
  });

  it("red trust earns nothing; the full backlog arrives once the ban is lifted", async () => {
    const u = await coder("sus", "103");
    ht.set("103", 8, "red");
    expect(await syncUser(db, ht, u.id)).toMatchObject({ status: "skipped_untrusted", creditedTicks: 0 });
    ht.set("103", 9, "red");
    await syncUser(db, ht, u.id);
    expect((await balances(db, u.id)).available).toBe(0);
    ht.set("103", 9, "green");
    expect(await syncUser(db, ht, u.id)).toMatchObject({ status: "credited", creditedTicks: 9_000 });
  });

  it("hours going down claw nothing back, and later growth only pays above the old high", async () => {
    const u = await coder("trimmed", "104");
    ht.set("104", 10);
    await syncUser(db, ht, u.id);
    ht.set("104", 6);
    expect(await syncUser(db, ht, u.id)).toMatchObject({ status: "no_change" });
    expect((await balances(db, u.id)).available).toBe(10_000);
    ht.set("104", 11);
    expect(await syncUser(db, ht, u.id)).toMatchObject({ creditedTicks: 1_000 });
  });

  it("records Hackatime failures without crediting, and refuses unlinked users and bots", async () => {
    const u = await coder("offline", "105");
    ht.data.set("105", new HackatimeError("Hackatime request failed: timeout"));
    expect(await syncUser(db, ht, u.id)).toMatchObject({ status: "error", creditedTicks: 0 });
    const [row] = await db.select().from(churnSyncs).where(eq(churnSyncs.userId, u.id));
    expect(row!.error).toMatch(/timeout/);

    // With neither a linked Hackatime account nor a Slack id there is nothing to look up.
    const unlinked = await makeUser(db, "nolink");
    await expect(syncUser(db, ht, unlinked.id)).rejects.toBeInstanceOf(ExchangeError);
    const mouse = await ensureMouse(db);
    await expect(syncUser(db, ht, mouse.id)).rejects.toBeInstanceOf(ExchangeError);
  });

  it("passes the user's OAuth token to Hackatime for private stats", async () => {
    const u = await coder("private", "106");
    ht.set("106", 1);
    await syncUser(db, ht, u.id, { tokenFor: async (id) => (id === u.id ? "tok_secret" : undefined) });
    expect(ht.calls.at(-1)).toMatchObject({ hackatimeUserId: "106", bearerToken: "tok_secret" });
  });

  it("syncAll covers every linked human and survives individual failures", async () => {
    const a = await coder("a", "201");
    const b = await coder("b", "202");
    const c = await coder("c", "203");
    await makeUser(db, "nolink");
    ht.set("201", 1);
    ht.set("203", 2, "red"); // 202 missing -> error
    const results = await syncAll(db, ht, { concurrency: 2 });
    const byUser = Object.fromEntries(results.map((r) => [r.userId, r.status]));
    expect(byUser).toEqual({ [a.id]: "credited", [b.id]: "error", [c.id]: "skipped_untrusted" });
  });
});

describe("Mouse funders", () => {
  it("a funder who never signed up feeds The Mouse automatically, by Slack id", async () => {
    const monger = await makeUser(db, "monger", { isCheesemonger: true, isSuperAdmin: true });
    const added = await addMouseFunder(db, { slackId: "U0STAFF01", addedById: monger.id });
    expect(added).toMatchObject({ created: true, swept: null });
    ht.set("U0STAFF01", 40); // looked up on Hackatime by Slack id, no linking
    const results = await syncAll(db, ht);
    expect(results).toEqual([expect.objectContaining({ userId: added.userId, status: "credited", creditedTicks: 40_000, toMouse: true })]);
    const mouse = await ensureMouse(db);
    expect((await balances(db, mouse.id)).available).toBe(40_000);
    expect((await balances(db, added.userId)).available).toBe(0);
    // The ledger still says whose hours earned it.
    const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.kind, "churn"));
    expect(entry).toMatchObject({ userId: added.userId, memo: "fed the mouse" });
    // Adding the same Slack id again reuses the placeholder.
    expect(await addMouseFunder(db, { slackId: "u0staff01", addedById: monger.id })).toMatchObject({ userId: added.userId, created: false });
  });

  it("a placeholder claimed on login keeps its Churn history (no double pay)", async () => {
    const monger = await makeUser(db, "monger", { isCheesemonger: true, isSuperAdmin: true });
    const { userId } = await addMouseFunder(db, { slackId: "U0STAFF09", addedById: monger.id });
    ht.set("U0STAFF09", 10);
    await syncAll(db, ht);
    // They log in with Hack Club Auth and link Hackatime: same row, now with an HCA subject and numeric id.
    await db.update(users).set({ hcaSub: "ident!staff09", name: "Staffer", hackatimeUserId: "909" }).where(eq(users.id, userId));
    ht.set("909", 12);
    expect(await syncUser(db, ht, userId)).toMatchObject({ creditedTicks: 2_000, toMouse: true }); // only the 2 new hours
    expect((await balances(db, (await ensureMouse(db)).id)).available).toBe(12_000);
  });

  it("looks people up by Slack id when they never linked, and tells private from missing", async () => {
    const monger = await makeUser(db, "monger", { isCheesemonger: true, isSuperAdmin: true });
    const plain = await makeUser(db, "plain", { slackId: "U0PLAIN01" });
    const priv = await makeUser(db, "priv", { slackId: "U0PRIVATE1" });
    const never = await makeUser(db, "never", { slackId: "U0NEVER01" });
    await makeUser(db, "noslack"); // nothing to look up: skipped
    const { userId: funder } = await addMouseFunder(db, { slackId: "U0FUNDER1", addedById: monger.id });
    ht.set("U0PLAIN01", 3);
    ht.data.set("U0PRIVATE1", new HackatimeError("Hackatime 403: user has disabled public stats", 403));
    ht.data.set("U0FUNDER1", new HackatimeError("Hackatime 403: user has disabled public stats", 403));

    const results = await syncAll(db, ht);
    const by = (id: string) => results.find((r) => r.userId === id);
    expect(by(plain.id)).toMatchObject({ status: "credited", creditedTicks: 3_000 });
    expect((await balances(db, plain.id)).available).toBe(3_000);
    expect(by(priv.id)).toMatchObject({ status: "error", error: expect.stringMatching(/^PRIVATE: .*public stats/) });
    expect(by(never.id)).toMatchObject({ status: "error", error: expect.stringMatching(/^NOT_FOUND: /) });
    expect(by(funder)).toMatchObject({ status: "error", error: expect.stringMatching(/public stats/) });
    expect(results).toHaveLength(4);
  });

  it("leaves private and never-used accounts alone for a few hours, then checks again", async () => {
    const priv = await makeUser(db, "priv", { slackId: "U0PRIVATE2" });
    ht.data.set("U0PRIVATE2", new HackatimeError("Hackatime 403: user has disabled public stats", 403));
    expect(await syncAll(db, ht)).toHaveLength(1);
    expect(await syncAll(db, ht)).toHaveLength(0); // just checked

    // They fix their settings; once the wait is over the sweep picks them up and pays.
    ht.set("U0PRIVATE2", 2);
    await db.update(churnSyncs).set({ fetchedAt: new Date(Date.now() - 4 * 3600_000) }).where(eq(churnSyncs.userId, priv.id));
    expect(await syncAll(db, ht)).toEqual([expect.objectContaining({ userId: priv.id, status: "credited", creditedTicks: 2_000 })]);
  });

  it("adding an existing user sweeps their Latta, shares and open orders to The Mouse", async () => {
    const monger = await makeUser(db, "monger", { isCheesemonger: true, isSuperAdmin: true });
    const staff = await coder("staff", "302", "U0STAFF02");
    const other = await makeUser(db, "other");
    await fund(db, staff.id, 5_000);
    await fund(db, other.id, 5_000);
    const { wedges: [w] } = await makeWheel(db, monger.id, ["Yes"]);
    const ex = new Exchange(db);
    await ex.placeOrder({ userId: staff.id, wedgeId: w!.id, outcome: "YES", side: "BUY", price: 60, qty: 10 });
    await ex.placeOrder({ userId: other.id, wedgeId: w!.id, outcome: "NO", side: "BUY", price: 40, qty: 10 }); // mint
    await ex.placeOrder({ userId: staff.id, wedgeId: w!.id, outcome: "YES", side: "SELL", price: 90, qty: 4 }); // resting sell
    await ex.placeOrder({ userId: staff.id, wedgeId: w!.id, outcome: "NO", side: "BUY", price: 5, qty: 20 }); // resting buy

    const { swept } = await addMouseFunder(db, { slackId: "u0staff02", addedById: monger.id, note: "HQ" });
    expect(swept).toEqual({ cancelledOrders: 2, movedPositions: 1, sweptTicks: 5_000 - 600 });

    const mouse = await ensureMouse(db);
    expect(await balances(db, staff.id)).toEqual({ available: 0, locked: 0 });
    expect((await balances(db, mouse.id)).available).toBe(4_400);
    expect((await position(db, mouse.id, w!.id)).yesShares).toBe(10);
    expect((await position(db, staff.id, w!.id)).yesShares).toBe(0);
    // The engine's cached book notices the sweep and drops the cancelled orders.
    expect(await ex.depth(w!.id)).toEqual({ bids: [], asks: [] });
    // The funder can no longer trade, but The Mouse can.
    await expect(
      ex.placeOrder({ userId: staff.id, wedgeId: w!.id, outcome: "YES", side: "BUY", price: 1, qty: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await ex.placeOrder({ userId: mouse.id, wedgeId: w!.id, outcome: "YES", side: "SELL", price: 55, qty: 2 });
  });

  it("only Cheesemongers manage funders; removing one stops future routing", async () => {
    const monger = await makeUser(db, "monger", { isCheesemonger: true, isSuperAdmin: true });
    const rando = await makeUser(db, "rando");
    await expect(addMouseFunder(db, { slackId: "U0STAFF03", addedById: rando.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(addMouseFunder(db, { slackId: "not-a-slack-id", addedById: monger.id })).rejects.toMatchObject({ code: "INVALID" });

    const staff = await coder("staff", "303", "U0STAFF03");
    await addMouseFunder(db, { slackId: "U0STAFF03", addedById: monger.id });
    ht.set("303", 2);
    await syncUser(db, ht, staff.id); // 2,000 -> Mouse
    await removeMouseFunder(db, { slackId: "U0STAFF03", removedById: monger.id });
    ht.set("303", 3);
    expect(await syncUser(db, ht, staff.id)).toMatchObject({ creditedTicks: 1_000, toMouse: false });
    expect((await balances(db, staff.id)).available).toBe(1_000);
    expect((await balances(db, (await ensureMouse(db)).id)).available).toBe(2_000);
  });
});

describe("HackatimeHttpClient", () => {
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("uses the public id endpoint, falls back to the Bearer token on 403, and reads trust", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.authorization;
      seen.push({ url, auth });
      if (url.includes("/trust_factor")) return respond(200, { trust_level: "green", trust_value: 2 });
      if (url.includes("/users/42/stats")) return respond(403, { error: "user has disabled public stats" });
      if (url.includes("/users/my/stats")) return respond(200, { total_seconds: 7200.9 });
      return respond(404, { error: "nope" });
    }) as typeof fetch;
    const c = new HackatimeHttpClient({ fetch: fetchStub });
    expect(await c.snapshot({ hackatimeUserId: "42", bearerToken: "tok" })).toEqual({ lifetimeNonAiSeconds: 7200, trustLevel: "green" });
    const stats = seen.filter((s) => s.url.includes("/stats"));
    expect(stats[0]!.url).toContain("no_ai_coding=true");
    expect(stats[0]!.auth).toBeUndefined();
    expect(stats[1]).toMatchObject({ auth: "Bearer tok" });
  });

  it("surfaces Hackatime errors and rejects non-numeric ids", async () => {
    const c = new HackatimeHttpClient({ fetch: (async () => respond(404, { error: "User not found" })) as unknown as typeof fetch });
    await expect(c.snapshot({ hackatimeUserId: "42" })).rejects.toThrow(/User not found/);
    await expect(c.snapshot({ hackatimeUserId: "Brody" })).rejects.toThrow(/numeric/);
  });
});
