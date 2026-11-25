import "server-only";

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export const env = {
  appUrl: (
    process.env.APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000")
  ).replace(/\/+$/, ""),
  /** Running on Vercel (serverless: no long-lived process, no writable disk). */
  onVercel: !!process.env.VERCEL,
  databaseUrl: process.env.DATABASE_URL || undefined,
  hcaClientId: process.env.HCA_CLIENT_ID ?? "",
  hcaClientSecret: process.env.HCA_CLIENT_SECRET ?? "",
  hackatimeClientId: process.env.HACKATIME_CLIENT_ID ?? "",
  hackatimeClientSecret: process.env.HACKATIME_CLIENT_SECRET ?? "",
  /** 32 random bytes, base64. Encrypts OAuth tokens and OAuth state cookies. */
  tokenKey: process.env.TOKEN_ENCRYPTION_KEY ?? "",
  cronSecret: process.env.CRON_SECRET ?? "",
  /** Bot token used for Slack DMs and the channel resync. */
  slackBotToken: process.env.SLACK_BOT_TOKEN ?? "",
  /** Channel every active user is invited to by /api/cron/slack-resync. */
  slackSyncChannelId: process.env.SLACK_SYNC_CHANNEL_ID || "C0CH8NW4UNP",
  /** Slack ids that are made Cheesemongers when they log in. */
  cheesemongerSlackIds: list(process.env.CHEDDAR_CHEESEMONGER_SLACK_IDS),
  /** Slack ids that are made super admins (and Cheesemongers) when they log in. */
  superAdminSlackIds: list(process.env.CHEDDAR_SUPER_ADMIN_SLACK_IDS),
  /** Let a Cheesemonger review their own proposals/settlements (useful while there is only one). */
  allowSelfReview: process.env.CHEDDAR_ALLOW_SELF_REVIEW === "true",
};

export function requireEnv<K extends keyof typeof env>(key: K): NonNullable<(typeof env)[K]> {
  const v = env[key];
  if (v === undefined || v === "") {
    throw new Error(`Missing configuration: ${key}. See .env.example at the repo root.`);
  }
  return v as NonNullable<(typeof env)[K]>;
}

export const secureCookies = env.appUrl.startsWith("https://");
