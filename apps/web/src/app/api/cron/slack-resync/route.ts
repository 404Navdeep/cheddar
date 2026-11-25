import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { runSlackResync } from "@/lib/slack-resync-job";

export const maxDuration = 300;

/**
 * Invite every active user to the Cheddar Slack channel.
 * Call with `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  try {
    const summary = await runSlackResync();
    return NextResponse.json({ ok: true, ...summary, ms: Date.now() - started });
  } catch (e) {
    console.error("slack-resync error:", e);
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}
