import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { and, createPgliteDb, eq, orders, type AnyDb } from "@cheddar/db";
import {
  Exchange,
  approveSettlement,
  audit,
  convertNo,
  ensureMouse,
  houseOutstanding,
  lmsr,
  mergePairs,
  mergeYesSet,
  proposeSettlement,
  requoteWheel,
  runTx,
  setWheelLiquidity,
} from "../src/index";
import { balances, fund, makeUser, makeWheel, position } from "./helpers";

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

const house = () => runTx(db, (tx) => houseOutstanding(tx));
const mouseOrders = async (mouseId: string) =>
  db.select().from(orders).where(and(eq(orders.userId, mouseId), eq(orders.status, "open")));

describe("LMSR maths", () => {
  it("prices sum to one, and bundles don't move them", () => {
    const ids = ["a", "b", "c"];
    const anchor = lmsr.anchorFor([0.5, 0.3, 0.2], [0, 0, 0], 300);
    const p = lmsr.prices(lmsr.stateFor(anchor, lmsr.payoffs(ids, new Map())), 300);
    expect(p.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
    expect(p[0]).toBeCloseTo(0.5, 6);
    // NO on every wedge (a riskless bundle) leaves prices alone.
    const bundle = new Map(ids.map((id) => [id, { yes: 0, no: 40 }]));
    const p2 = lmsr.prices(lmsr.stateFor(anchor, lmsr.payoffs(ids, bundle)), 300);
    p2.forEach((x, i) => expect(x).toBeCloseTo(p[i]!, 9));
  });

  it("ladders step away from the price and get deeper with liquidity", () => {
    const q = lmsr.anchorFor([0.5, 0.5], [0, 0], 300);
    const { asks, bids } = lmsr.ladder(q, 300, 0, 8);
    expect(asks[0]!.price).toBe(51);
    expect(bids[0]!.price).toBe(49);
    expect(asks.every((a, i) => i === 0 || a.price > asks[i - 1]!.price)).toBe(true);
    const deeper = lmsr.ladder(lmsr.anchorFor([0.5, 0.5], [0, 0], 3000), 3000, 0, 8);
    expect(deeper.asks[0]!.qty).toBeGreaterThan(asks[0]!.qty * 5);
  });
});

describe("The Mouse market maker", () => {
  async function setup(labels: string[], liquidity = 300, mouseCash = 0) {
    const monger = await makeUser(db, "monger", { isCheesemonger: true });
    const trader = await makeUser(db, "trader");
    await fund(db, trader.id, 1_000_000);
    const mouse = await ensureMouse(db);
    if (mouseCash) await fund(db, mouse.id, mouseCash);
    const { wheel, wedges } = await makeWheel(db, monger.id, labels);
    await setWheelLiquidity(db, { wheelId: wheel.id, actorId: monger.id, liquidity });
    await requoteWheel(db, ex, wheel.id);
    return { monger, trader, mouse, wheel, wedges };
  }

  it("always has a quote, refills after big orders, and moves the price", async () => {
    const { trader, mouse, wheel, wedges } = await setup(["Yes"]);
    const w = wedges[0]!;
    let bought = 0;
    for (let round = 0; round < 4; round++) {
      const r = await ex.placeOrder({ userId: trader.id, wedgeId: w.id, outcome: "YES", side: "BUY", price: 99, qty: 500, tif: "IOC" });
      expect(r.filled).toBeGreaterThan(0);
      bought += r.filled;
      await requoteWheel(db, ex, wheel.id);
    }
    expect(bought).toBeGreaterThan(200); // well past what any one ladder holds
    const asks = (await mouseOrders(mouse.id)).filter((o) => o.outcome === "NO" || o.side === "SELL");
    expect(asks.length).toBeGreaterThan(0);
    const d = await ex.depth(w.id);
    expect(d.asks[0]![0]).toBeGreaterThan(70); // buying pushed YES up from 50
  });

  it("uses its own cash first, then house backing, and repays it", async () => {
    const { trader, mouse, wheel, wedges } = await setup(["Yes"], 300, 0);
    expect(await house()).toBeGreaterThan(0); // nothing funded: quotes are house-backed
    await fund(db, mouse.id, 10_000_000);
    await requoteWheel(db, ex, wheel.id);
    expect(await house()).toBe(0); // funded now: house paid back
    await ex.placeOrder({ userId: trader.id, wedgeId: wedges[0]!.id, outcome: "NO", side: "BUY", price: 99, qty: 50, tif: "IOC" });
    await requoteWheel(db, ex, wheel.id);
    expect(await house()).toBe(0);
    expect((await balances(db, mouse.id)).available).toBeGreaterThan(0);
  });

  it("links multi-outcome prices: buying one outcome lowers the others", async () => {
    const { trader, wheel, wedges } = await setup(["A", "B", "C"]);
    const before = await Promise.all(wedges.map((w) => ex.depth(w.id)));
    expect(before[1]!.bids[0]![0]).toBeLessThanOrEqual(33);
    await ex.placeOrder({ userId: trader.id, wedgeId: wedges[0]!.id, outcome: "YES", side: "BUY", price: 99, qty: 200, tif: "IOC" });
    await requoteWheel(db, ex, wheel.id);
    const after = await Promise.all(wedges.map((w) => ex.depth(w.id)));
    expect(after[0]!.bids[0]![0]).toBeGreaterThan(before[0]!.bids[0]![0]);
    expect(after[1]!.asks[0]![0]).toBeLessThan(before[1]!.asks[0]![0]);
  });

  it("keeps quoting after a proposed outcome and settles cleanly when approved", async () => {
    const { monger, trader, mouse, wheel, wedges } = await setup(["A", "B"]);
    await ex.placeOrder({ userId: trader.id, wedgeId: wedges[0]!.id, outcome: "YES", side: "BUY", price: 99, qty: 100, tif: "IOC" });
    const s = await proposeSettlement(db, { wheelId: wheel.id, proposerId: monger.id, outcome: "wedge_wins", winningWedgeId: wedges[0]!.id, evidence: "x" });
    await requoteWheel(db, ex, wheel.id);
    expect((await mouseOrders(mouse.id)).length).toBeGreaterThan(0);
    await approveSettlement(db, { settlementId: s.id, reviewerId: monger.id, proof: "it happened" }, { allowSelfReview: true });
    expect(await mouseOrders(mouse.id)).toHaveLength(0);
  });
});

describe("linked outcomes", () => {
  async function holder(labels: string[]) {
    const monger = await makeUser(db, "monger", { isCheesemonger: true });
    const a = await makeUser(db, "a");
    const b = await makeUser(db, "b");
    await fund(db, a.id, 1_000_000);
    await fund(db, b.id, 1_000_000);
    const { wheel, wedges } = await makeWheel(db, monger.id, labels);
    // a ends up with 10 YES and 10 NO on every wedge (b is the other side each time).
    for (const w of wedges) {
      await ex.placeOrder({ userId: a.id, wedgeId: w.id, outcome: "YES", side: "BUY", price: 40, qty: 10 });
      await ex.placeOrder({ userId: b.id, wedgeId: w.id, outcome: "NO", side: "BUY", price: 60, qty: 10 });
      await ex.placeOrder({ userId: a.id, wedgeId: w.id, outcome: "NO", side: "BUY", price: 60, qty: 10 });
      await ex.placeOrder({ userId: b.id, wedgeId: w.id, outcome: "YES", side: "BUY", price: 40, qty: 10 });
    }
    return { monger, a, b, wheel, wedges };
  }

  it("merges pairs and full sets into cash", async () => {
    const { a, wheel, wedges } = await holder(["A", "B", "C"]);
    const cash0 = (await balances(db, a.id)).available;
    await mergePairs(db, { userId: a.id, wedgeId: wedges[0]!.id, shares: 4 });
    expect((await balances(db, a.id)).available - cash0).toBe(400);
    await mergeYesSet(db, { userId: a.id, wheelId: wheel.id, shares: 6 });
    expect((await balances(db, a.id)).available - cash0).toBe(1000);
    expect((await position(db, a.id, wedges[1]!.id)).yesShares).toBe(4);
  });

  it("converts NO on some outcomes into YES on the rest, and cashes in a full NO set", async () => {
    const { a, wheel, wedges } = await holder(["A", "B", "C", "D"]);
    const cash0 = (await balances(db, a.id)).available;
    // NO on A and B -> YES on C and D, plus (2 - 1) Latta per share.
    await convertNo(db, { userId: a.id, wheelId: wheel.id, wedgeIds: [wedges[0]!.id, wedges[1]!.id], shares: 3 });
    expect((await position(db, a.id, wedges[0]!.id)).noShares).toBe(7);
    expect((await position(db, a.id, wedges[2]!.id)).yesShares).toBe(13);
    expect((await balances(db, a.id)).available - cash0).toBe(300);
    // A full NO set (every wedge) pays (n - 1) per share straight away.
    await convertNo(db, { userId: a.id, wheelId: wheel.id, wedgeIds: wedges.map((w) => w.id), shares: 5 });
    expect((await balances(db, a.id)).available - cash0).toBe(300 + 5 * 3 * 100);
  });
});
