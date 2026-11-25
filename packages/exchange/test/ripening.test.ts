import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createPgliteDb, eq, orders, proposals, sql, wedges, wheels, type AnyDb } from "@cheddar/db";
import {
  Exchange,
  ExchangeError,
  approveProposal,
  approveSettlement,
  audit,
  proposeSettlement,
  rejectProposal,
  rejectSettlement,
  submitProposal,
  withdrawProposal,
} from "../src/index";
import { balances, collateral, fund, makeUser, makeWheel } from "./helpers";

let db: AnyDb;
let client: PGlite;
let ex: Exchange;

beforeEach(async () => {
  const r = await createPgliteDb();
  db = r.db as unknown as AnyDb;
  client = r.client;
  ex = new Exchange(db);
});
afterEach(async () => {
  expect(await audit(db)).toEqual([]);
  await client.close();
});

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExchangeError) return e.code;
    throw e;
  }
  return "OK";
}

async function people() {
  const creator = await makeUser(db, "creator");
  const monger = await makeUser(db, "monger", { isCheesemonger: true });
  const monger2 = await makeUser(db, "monger2", { isCheesemonger: true });
  const yes = await makeUser(db, "yes");
  const no = await makeUser(db, "no");
  for (const u of [creator, yes, no]) await fund(db, u.id, 10_000);
  return { creator, monger, monger2, yes, no };
}

async function totalUserLatta() {
  const r = (await db.execute(
    sql`SELECT COALESCE(SUM(balance), 0)::text AS s FROM accounts WHERE kind IN ('user_available', 'user_locked')`,
  )) as unknown as { rows: { s: string }[] };
  return Number(r.rows[0]!.s);
}

/** A YES buyer and a NO buyer mint `qty` pairs at `yesPrice`. */
async function trade(wedgeId: string, yesId: string, noId: string, yesPrice: number, qty: number) {
  await ex.placeOrder({ userId: yesId, wedgeId, outcome: "YES", side: "BUY", price: yesPrice, qty });
  await ex.placeOrder({ userId: noId, wedgeId, outcome: "NO", side: "BUY", price: 100 - yesPrice, qty });
}

describe("Ripening", () => {
  it("binary wheel: YES wins, winners get 100 per share, open orders are refunded", async () => {
    const { creator, monger, yes, no } = await people();
    const { wheel, wedges: [w] } = await makeWheel(db, creator.id, ["Yes"]);
    await trade(w!.id, yes.id, no.id, 70, 10); // YES pays 700, NO pays 300
    await ex.placeOrder({ userId: creator.id, wedgeId: w!.id, outcome: "YES", side: "BUY", price: 20, qty: 5 });
    expect(await collateral(db, w!.id)).toBe(1_000);

    const s = await proposeSettlement(db, { wheelId: wheel.id, proposerId: creator.id, outcome: "wedge_wins", winningWedgeId: w!.id, evidence: "it shipped" });
    // A proposal is a banner, not a halt. A new order can rest, and cancelling it still works.
    const [wh0] = await db.select().from(wheels).where(eq(wheels.id, wheel.id));
    expect(wh0!.status).toBe("open");
    const [wedge0] = await db.select().from(wedges).where(eq(wedges.id, w!.id));
    expect(wedge0!.status).toBe("open");
    const placed = await ex.placeOrder({ userId: yes.id, wedgeId: w!.id, outcome: "YES", side: "BUY", price: 99, qty: 1 });
    await ex.cancelOrder(yes.id, placed.orderId);

    const report = await approveSettlement(db, { settlementId: s.id, reviewerId: monger.id });
    expect(report).toEqual([{ wedgeId: w!.id, result: "resolved_yes", cancelledOrders: 1, paidTicks: 1_000, holders: 1 }]);
    expect(await balances(db, yes.id)).toEqual({ available: 10_000 - 700 + 1_000, locked: 0 });
    expect(await balances(db, no.id)).toEqual({ available: 10_000 - 300, locked: 0 });
    expect(await balances(db, creator.id)).toEqual({ available: 10_000, locked: 0 });
    expect(await collateral(db, w!.id)).toBe(0);
    expect(await totalUserLatta()).toBe(30_000); // nothing created or destroyed
    const [wh] = await db.select().from(wheels).where(eq(wheels.id, wheel.id));
    expect(wh!.status).toBe("resolved");
    expect(await code(ex.placeOrder({ userId: yes.id, wedgeId: w!.id, outcome: "YES", side: "BUY", price: 50, qty: 1 }))).toBe("MARKET_CLOSED");
    expect(await ex.depth(w!.id)).toEqual({ bids: [], asks: [] });
  });

  it("binary wheel: all NO pays the NO side", async () => {
    const { creator, monger, yes, no } = await people();
    const { wheel, wedges: [w] } = await makeWheel(db, creator.id, ["Yes"]);
    await trade(w!.id, yes.id, no.id, 40, 10);
    const s = await proposeSettlement(db, { wheelId: wheel.id, proposerId: creator.id, outcome: "all_no", evidence: "did not ship" });
    await approveSettlement(db, { settlementId: s.id, reviewerId: monger.id });
    expect((await balances(db, yes.id)).available).toBe(10_000 - 400);
    expect((await balances(db, no.id)).available).toBe(10_000 - 600 + 1_000);
  });

  it("multi-outcome wheel: exactly one wedge wins, NO holders on the others are paid", async () => {
    const { creator, monger, yes, no } = await people();
    const { wheel, wedges: ws } = await makeWheel(db, creator.id, ["Orpheus", "Heidi", "Other"]);
    for (const w of ws) await trade(w.id, yes.id, no.id, 30, 10); // yes pays 300 each, no pays 700 each
    const s = await proposeSettlement(db, { wheelId: wheel.id, proposerId: creator.id, outcome: "wedge_wins", winningWedgeId: ws[1]!.id, evidence: "Heidi won" });
    const report = await approveSettlement(db, { settlementId: s.id, reviewerId: monger.id });
    expect(report.map((r) => r.result).sort()).toEqual(["resolved_no", "resolved_no", "resolved_yes"]);
    expect((await balances(db, yes.id)).available).toBe(10_000 - 900 + 1_000);
    expect((await balances(db, no.id)).available).toBe(10_000 - 2_100 + 2_000);
    for (const w of ws) expect(await collateral(db, w.id)).toBe(0);
    expect(await totalUserLatta()).toBe(30_000);
  });

  it("Moldy pays 50 per share to both sides (Polymarket 50-50)", async () => {
    const { creator, monger, yes, no } = await people();
    const { wheel, wedges: [w] } = await makeWheel(db, creator.id, ["Yes"]);
    await trade(w!.id, yes.id, no.id, 90, 10); // YES paid 900, NO paid 100
    const s = await proposeSettlement(db, { wheelId: wheel.id, proposerId: monger.id, outcome: "moldy", evidence: "ambiguous" });
    const report = await approveSettlement(db, { settlementId: s.id, reviewerId: (await makeUser(db, "m3", { isCheesemonger: true })).id });
    expect(report[0]!.result).toBe("moldy");
    expect((await balances(db, yes.id)).available).toBe(10_000 - 900 + 500);
    expect((await balances(db, no.id)).available).toBe(10_000 - 100 + 500);
    const [wh] = await db.select().from(wheels).where(eq(wheels.id, wheel.id));
    expect(wh!.status).toBe("moldy");
  });

  it("pays shares that moved through transfers, burns and resting sells", async () => {
    const { creator, monger, yes, no } = await people();
    const carol = await makeUser(db, "carol");
    await fund(db, carol.id, 10_000);
    const { wheel, wedges: [w] } = await makeWheel(db, creator.id, ["Yes"]);
    await trade(w!.id, yes.id, no.id, 50, 10);
    await ex.placeOrder({ userId: yes.id, wedgeId: w!.id, outcome: "YES", side: "SELL", price: 60, qty: 4 });
    await ex.placeOrder({ userId: carol.id, wedgeId: w!.id, outcome: "YES", side: "BUY", price: 60, qty: 4 });
    await ex.placeOrder({ userId: yes.id, wedgeId: w!.id, outcome: "YES", side: "SELL", price: 95, qty: 6 }); // resting, unfilled
    const s = await proposeSettlement(db, { wheelId: wheel.id, proposerId: creator.id, outcome: "wedge_wins", winningWedgeId: w!.id, evidence: "yes" });
    await approveSettlement(db, { settlementId: s.id, reviewerId: monger.id });
    expect((await balances(db, yes.id)).available).toBe(10_000 - 500 + 240 + 600);
    expect((await balances(db, carol.id)).available).toBe(10_000 - 240 + 400);
  });

  it("rejecting a settlement reopens trading", async () => {
    const { creator, monger, yes, no } = await people();
    const { wheel, wedges: [w] } = await makeWheel(db, creator.id, ["Yes"]);
    await trade(w!.id, yes.id, no.id, 50, 2);
    const s = await proposeSettlement(db, { wheelId: wheel.id, proposerId: creator.id, outcome: "all_no", evidence: "nope" });
    await rejectSettlement(db, { settlementId: s.id, reviewerId: monger.id, note: "event not over yet" });
    const [wedge] = await db.select().from(wedges).where(eq(wedges.id, w!.id));
    expect(wedge!.status).toBe("open");
    await trade(w!.id, yes.id, no.id, 50, 2);
    // A new proposal is allowed after a rejection.
    await proposeSettlement(db, { wheelId: wheel.id, proposerId: creator.id, outcome: "all_no", evidence: "now it's over" });
  });

  it("enforces who can propose and review, and what a settlement may say", async () => {
    const { creator, monger, monger2, yes } = await people();
    const { wheel, wedges: [w] } = await makeWheel(db, creator.id, ["A", "B"]);
    const other = await makeWheel(db, creator.id, ["Z"]);
    const base = { wheelId: wheel.id, proposerId: creator.id, evidence: "x" };

    expect(await code(proposeSettlement(db, { ...base, proposerId: yes.id, outcome: "moldy" }))).toBe("FORBIDDEN");
    expect(await code(proposeSettlement(db, { ...base, outcome: "all_no" }))).toBe("INVALID"); // multi-outcome
    expect(await code(proposeSettlement(db, { ...base, outcome: "wedge_wins", winningWedgeId: other.wedges[0]!.id }))).toBe("INVALID");
    expect(await code(proposeSettlement(db, { ...base, outcome: "wedge_wins" }))).toBe("INVALID");
    expect(await code(proposeSettlement(db, { ...base, outcome: "moldy", evidence: "  " }))).toBe("INVALID");

    const s = await proposeSettlement(db, { ...base, proposerId: monger.id, outcome: "wedge_wins", winningWedgeId: w!.id });
    expect(await code(proposeSettlement(db, { ...base, outcome: "moldy" }))).toBe("INVALID"); // one proposal at a time
    expect(await code(approveSettlement(db, { settlementId: s.id, reviewerId: yes.id }))).toBe("FORBIDDEN");
    expect(await code(approveSettlement(db, { settlementId: s.id, reviewerId: monger.id }))).toBe("FORBIDDEN"); // self-review
    expect(await code(approveSettlement(db, { settlementId: s.id, reviewerId: monger.id }, { allowSelfReview: true }))).toBe("OK");
    expect(await code(approveSettlement(db, { settlementId: s.id, reviewerId: monger2.id }))).toBe("INVALID"); // already approved
  });

  it("payout entries are unique per wedge (a second payout cannot be written)", async () => {
    const { creator, monger, yes, no } = await people();
    const { wheel, wedges: [w] } = await makeWheel(db, creator.id, ["Yes"]);
    await trade(w!.id, yes.id, no.id, 50, 1);
    const s = await proposeSettlement(db, { wheelId: wheel.id, proposerId: creator.id, outcome: "all_no", evidence: "x" });
    await approveSettlement(db, { settlementId: s.id, reviewerId: monger.id });
    await expect(
      Promise.resolve(db.execute(sql`INSERT INTO journal_entries (kind, idempotency_key) VALUES ('payout', ${`payout:${w!.id}`})`)),
    ).rejects.toThrow();
  });
});

describe("Proposals", () => {
  const future = () => new Date(Date.now() + 86_400_000);

  it("an approved proposal becomes a tradable wheel with one wedge per outcome", async () => {
    const { creator, monger, yes, no } = await people();
    const p = await submitProposal(db, {
      proposerId: creator.id,
      title: "Who tops Hackatime this week?",
      resolutionCriteria: "Weekly leaderboard at close.",
      closesAt: future(),
      outcomes: [" Orpheus ", "Heidi", "Other"],
    });
    expect(p.status).toBe("pending");
    const { wheel, wedges: ws } = await approveProposal(db, { proposalId: p.id, reviewerId: monger.id });
    expect(wheel.slug).toMatch(/^who-tops-hackatime-this-week-[0-9a-f]{6}$/);
    expect(wheel.creatorId).toBe(creator.id);
    expect(ws.map((w) => w.label)).toEqual(["Orpheus", "Heidi", "Other"]);
    await trade(ws[0]!.id, yes.id, no.id, 50, 1);
    expect(await code(approveProposal(db, { proposalId: p.id, reviewerId: monger.id }))).toBe("INVALID");
  });

  it("validates proposals and review permissions", async () => {
    const { creator, monger, yes } = await people();
    const base = { proposerId: creator.id, title: "T", resolutionCriteria: "R", closesAt: future(), outcomes: ["Yes"] };
    expect(await code(submitProposal(db, { ...base, outcomes: [] }))).toBe("INVALID");
    expect(await code(submitProposal(db, { ...base, outcomes: ["A", "a"] }))).toBe("INVALID");
    expect(await code(submitProposal(db, { ...base, closesAt: new Date("2000-01-01") }))).toBe("INVALID");
    expect(await code(submitProposal(db, { ...base, title: " " }))).toBe("INVALID");

    const p = await submitProposal(db, base);
    expect(await code(approveProposal(db, { proposalId: p.id, reviewerId: yes.id }))).toBe("FORBIDDEN");
    await rejectProposal(db, { proposalId: p.id, reviewerId: monger.id, note: "duplicate" });
    const [row] = await db.select().from(proposals).where(eq(proposals.id, p.id));
    expect(row).toMatchObject({ status: "rejected", reviewNote: "duplicate" });

    const p2 = await submitProposal(db, base);
    expect(await code(withdrawProposal(db, { proposalId: p2.id, proposerId: yes.id }))).toBe("NOT_FOUND");
    await withdrawProposal(db, { proposalId: p2.id, proposerId: creator.id });
    expect(await db.select().from(wheels)).toHaveLength(0);
    expect(await db.select().from(orders)).toHaveLength(0);
  });
});
