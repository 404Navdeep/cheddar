/**
 * Trigger the deployed Slack channel resync.
 *
 * The actual sync logic lives in the web app (`apps/web/src/lib/slack-resync-job.ts`)
 * so that the GitHub Actions / Vercel cron jobs share exactly one implementation.
 *
 * Usage:
 *   APP_URL=https://cheddar.vercel.app CRON_SECRET=... pnpm tsx scripts/slack-resync.ts
 */
const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const secret = process.env.CRON_SECRET ?? "";

if (!secret) {
  console.error("❌ Missing CRON_SECRET environment variable");
  process.exit(1);
}

const res = await fetch(`${appUrl}/api/cron/slack-resync`, {
  headers: { Authorization: `Bearer ${secret}` },
});
const body = await res.text();

if (!res.ok) {
  console.error(`❌ Slack resync failed (${res.status}): ${body}`);
  process.exit(1);
}

console.log(`✅ Slack resync finished: ${body}`);
