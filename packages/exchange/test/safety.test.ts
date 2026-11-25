import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { auditLog, createPgliteDb, eq, reports, users, type AnyDb } from "@cheddar/db";
import { RATES, humanWait, renameUser, resolveReport, submitReport, takeRate } from "../src/index";
import { makeUser, makeWheel } from "./helpers";

let db: AnyDb;
let client: PGlite;

beforeEach(async () => {
  const r = await createPgliteDb();
  db = r.db as unknown as AnyDb;
  client = r.client;
});
afterEach(async () => {
  await client.close();
});

describe("rate limits", () => {
  it("lets people through up to the limit, then says how long to wait", async () => {
    const alice = await makeUser(db, "alice");
    const rule = { key: "t", limit: 3, windowSeconds: 60, what: "do the thing" };
    const t0 = new Date("2030-01-01T00:00:00Z");
    for (let i = 0; i < 3; i++) await takeRate(db, alice.id, rule, new Date(t0.getTime() + i * 1000));
    await expect(takeRate(db, alice.id, rule, new Date(t0.getTime() + 10_000))).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: expect.stringContaining("50 seconds"),
    });
    // The oldest event ages out of the window, freeing a slot.
    await takeRate(db, alice.id, rule, new Date(t0.getTime() + 61_000));
  });

  it("limits each person and each action separately", async () => {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    const rule = { key: "a", limit: 1, windowSeconds: 60, what: "x" };
    await takeRate(db, alice.id, rule);
    await takeRate(db, bob.id, rule);
    await takeRate(db, alice.id, { ...rule, key: "b" });
    await expect(takeRate(db, alice.id, rule)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("describes waits in human terms", () => {
    expect(humanWait(1)).toBe("1 second");
    expect(humanWait(12)).toBe("12 seconds");
    expect(humanWait(180)).toBe("3 minutes");
    expect(humanWait(7200)).toBe("2 hours");
  });
});

describe("reports", () => {
  it("lets someone report a wheel once until a Cheesemonger handles it", async () => {
    const monger = await makeUser(db, "monger", { isCheesemonger: true });
    const alice = await makeUser(db, "alice");
    const { wheel } = await makeWheel(db, monger.id, ["Yes", "No"]);
    await expect(submitReport(db, { reporterId: alice.id, targetType: "wheel", targetId: wheel.id, reason: "too short" })).rejects.toMatchObject({ code: "INVALID" });
    const r = await submitReport(db, { reporterId: alice.id, targetType: "wheel", targetId: wheel.id, reason: "This question can't be resolved" });
    await expect(
      submitReport(db, { reporterId: alice.id, targetType: "wheel", targetId: wheel.id, reason: "Reporting it again, please look" }),
    ).rejects.toMatchObject({ code: "INVALID" });
    await expect(resolveReport(db, { reportId: r.id, actorId: alice.id, action: "dismissed" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await resolveReport(db, { reportId: r.id, actorId: monger.id, action: "actioned", note: "paused it" });
    expect((await db.select().from(reports).where(eq(reports.id, r.id)))[0]).toMatchObject({ status: "actioned", resolverId: monger.id });
    await expect(resolveReport(db, { reportId: r.id, actorId: monger.id, action: "dismissed" })).rejects.toMatchObject({ code: "INVALID" });
    // Once handled, a fresh report is allowed.
    await submitReport(db, { reporterId: alice.id, targetType: "wheel", targetId: wheel.id, reason: "Still wrong after the edit" });
  });

  it("won't take reports about yourself, bots or missing things, or from suspended people", async () => {
    const alice = await makeUser(db, "alice");
    const bot = await makeUser(db, "bot", { isBot: true, hcaSub: null, botRole: "mouse" });
    const sus = await makeUser(db, "sus", { suspendedAt: new Date() });
    const reason = "This name is not okay at all";
    await expect(submitReport(db, { reporterId: alice.id, targetType: "user", targetId: alice.id, reason })).rejects.toMatchObject({ code: "INVALID" });
    await expect(submitReport(db, { reporterId: alice.id, targetType: "user", targetId: bot.id, reason })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      submitReport(db, { reporterId: alice.id, targetType: "wheel", targetId: "00000000-0000-0000-0000-000000000000", reason }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(submitReport(db, { reporterId: sus.id, targetType: "user", targetId: alice.id, reason })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rate-limits reports", async () => {
    const alice = await makeUser(db, "alice");
    const monger = await makeUser(db, "monger", { isCheesemonger: true });
    for (let i = 0; i < RATES.report.limit; i++) {
      const { wheel } = await makeWheel(db, monger.id, ["A", "B"]);
      await submitReport(db, { reporterId: alice.id, targetType: "wheel", targetId: wheel.id, reason: `Problem number ${i} with this one` });
    }
    const { wheel } = await makeWheel(db, monger.id, ["A", "B"]);
    await expect(
      submitReport(db, { reporterId: alice.id, targetType: "wheel", targetId: wheel.id, reason: "One report too many today" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("renaming", () => {
  it("lets a Cheesemonger rename someone, keeping names unique, and logs it", async () => {
    const monger = await makeUser(db, "monger", { isCheesemonger: true });
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    await expect(renameUser(db, { userId: alice.id, actorId: bob.id, name: "Nice Name", reason: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(renameUser(db, { userId: alice.id, actorId: monger.id, name: "  BOB ", reason: "x" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(renameUser(db, { userId: alice.id, actorId: monger.id, name: "", reason: "x" })).rejects.toMatchObject({ code: "INVALID" });
    await renameUser(db, { userId: alice.id, actorId: monger.id, name: "  Nice   Name ", reason: "was offensive" });
    expect((await db.select().from(users).where(eq(users.id, alice.id)))[0]!.name).toBe("Nice Name");
    const log = (await db.select().from(auditLog)).filter((l) => l.action === "user.rename");
    expect(log).toHaveLength(1);
    expect(log[0]!.details).toMatchObject({ from: "alice", to: "Nice Name" });
  });
});
