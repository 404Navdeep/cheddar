import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "@cheddar/db";
import type { PGlite } from "@electric-sql/pglite";
import { createPgliteDb, mouseFunders, orders, type AnyDb } from "@cheddar/db";
import { Exchange, ExchangeError, audit } from "../src/index";
import { balances, collateral, fund, makeUser, makeWheel, position, rng } from "./helpers";

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

async function setup(labels = ["Yes"]) {
  const alice = await makeUser(db, "alice");
  const bob = await makeUser(db, "bob");
  const carol = await makeUser(db, "carol");
  for (const u of [alice, bob, carol]) await fund(db, u.id, 10_000);
  const { wheel, wedges } = await makeWheel(db, alice.id, labels);
  return { alice, bob, carol, wheel, wedge: wedges[0]!, wedges };
}

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExchangeError) return e.code;
    throw e;
  }
  return "OK";
}

describe("Exchange", () => {
  it("escrows a resting buy at its limit price", async () => {
    const { alice, wedge } = await setup();
    const r = await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 40, qty: 10 });
    expect(r.status).toBe("open");
    expect(await balances(db, alice.id)).toEqual({ available: 9_600, locked: 400 });
    expect(await ex.depth(wedge.id)).toEqual({ bids: [[40, 10]], asks: [] });
  });

  it("mints a YES/NO pair backed by 100 ticks of collateral", async () => {
    const { alice, bob, wedge } = await setup();
    await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 60, qty: 10 });
    const r = await ex.placeOrder({ userId: bob.id, wedgeId: wedge.id, outcome: "NO", side: "BUY", price: 40, qty: 10 });
    expect(r.status).toBe("filled");
    expect(r.trades[0]!.kind).toBe("MINT");
    expect(await balances(db, alice.id)).toEqual({ available: 9_400, locked: 0 });
    expect(await balances(db, bob.id)).toEqual({ available: 9_600, locked: 0 });
    expect((await position(db, alice.id, wedge.id)).yesShares).toBe(10);
    expect((await position(db, bob.id, wedge.id)).noShares).toBe(10);
    expect(await collateral(db, wedge.id)).toBe(1_000);
  });

  it("refunds price improvement to the taker", async () => {
    const { alice, bob, wedge } = await setup();
    // Bob's BUY NO @40 rests as a YES ask at 60.
    await ex.placeOrder({ userId: bob.id, wedgeId: wedge.id, outcome: "NO", side: "BUY", price: 40, qty: 10 });
    const r = await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 70, qty: 10 });
    expect(r.trades[0]!.yesPrice).toBe(60);
    expect(await balances(db, alice.id)).toEqual({ available: 9_400, locked: 0 }); // paid 600, not 700
  });

  it("transfers shares between holders and burns pairs back into Latta", async () => {
    const { alice, bob, carol, wedge } = await setup();
    await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 50, qty: 10 });
    await ex.placeOrder({ userId: bob.id, wedgeId: wedge.id, outcome: "NO", side: "BUY", price: 50, qty: 10 });

    // Alice sells 4 YES to Carol at 65: a plain transfer.
    await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "SELL", price: 65, qty: 4 });
    const tr = await ex.placeOrder({ userId: carol.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 65, qty: 4 });
    expect(tr.trades[0]!.kind).toBe("TRANSFER_YES");
    expect((await balances(db, alice.id)).available).toBe(10_000 - 500 + 260);
    expect((await position(db, carol.id, wedge.id)).yesShares).toBe(4);

    // Carol sells YES @60 and Bob sells NO @40: the pair is burned, collateral pays out.
    await ex.placeOrder({ userId: carol.id, wedgeId: wedge.id, outcome: "YES", side: "SELL", price: 60, qty: 4 });
    const burn = await ex.placeOrder({ userId: bob.id, wedgeId: wedge.id, outcome: "NO", side: "SELL", price: 40, qty: 4 });
    expect(burn.trades[0]!.kind).toBe("BURN");
    expect(await collateral(db, wedge.id)).toBe(600);
    expect((await balances(db, carol.id)).available).toBe(10_000 - 260 + 240);
    expect((await balances(db, bob.id)).available).toBe(10_000 - 500 + 160);
  });

  it("rejects orders the user cannot pay for, without side effects", async () => {
    const { alice, wedge } = await setup();
    expect(
      await code(ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 50, qty: 201 })),
    ).toBe("INSUFFICIENT_FUNDS");
    expect(
      await code(ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "SELL", price: 50, qty: 1 })),
    ).toBe("INSUFFICIENT_SHARES");
    expect(
      await code(ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 100, qty: 1 })),
    ).toBe("INVALID");
    expect(await balances(db, alice.id)).toEqual({ available: 10_000, locked: 0 });
    expect(await db.select().from(orders)).toHaveLength(0);
  });

  it("cannot sell shares that are already reserved by another sell", async () => {
    const { alice, bob, wedge } = await setup();
    await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 50, qty: 5 });
    await ex.placeOrder({ userId: bob.id, wedgeId: wedge.id, outcome: "NO", side: "BUY", price: 50, qty: 5 });
    await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "SELL", price: 90, qty: 5 });
    expect(
      await code(ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "SELL", price: 95, qty: 1 })),
    ).toBe("INSUFFICIENT_SHARES");
  });

  it("self-trade prevention cancels the resting order and releases its escrow", async () => {
    const { alice, wedge } = await setup();
    const resting = await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "NO", side: "BUY", price: 50, qty: 10 });
    const r = await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 50, qty: 10 });
    expect(r.selfTradeCancelled).toEqual([resting.orderId]);
    expect(await balances(db, alice.id)).toEqual({ available: 9_500, locked: 500 });
  });

  it("IOC fills what it can and releases the rest", async () => {
    const { alice, bob, wedge } = await setup();
    await ex.placeOrder({ userId: bob.id, wedgeId: wedge.id, outcome: "NO", side: "BUY", price: 45, qty: 3 });
    const r = await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 99, qty: 10, tif: "IOC" });
    expect(r).toMatchObject({ status: "cancelled", filled: 3, remaining: 0 });
    expect(await balances(db, alice.id)).toEqual({ available: 10_000 - 3 * 55, locked: 0 });
    expect((await ex.depth(wedge.id)).bids).toEqual([]);
  });

  it("cancel releases escrow; only the owner can cancel, and only once", async () => {
    const { alice, bob, wedge } = await setup();
    const r = await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 30, qty: 10 });
    expect(await code(ex.cancelOrder(bob.id, r.orderId))).toBe("NOT_FOUND");
    await ex.cancelOrder(alice.id, r.orderId);
    expect(await balances(db, alice.id)).toEqual({ available: 10_000, locked: 0 });
    expect(await code(ex.cancelOrder(alice.id, r.orderId))).toBe("INVALID");
    expect(await ex.depth(wedge.id)).toEqual({ bids: [], asks: [] });
  });

  it("Mouse funders can't trade, and closed wedges reject orders", async () => {
    const { alice, wedge } = await setup();
    const staff = await makeUser(db, "staff", { slackId: "U_STAFF" });
    await fund(db, staff.id, 1_000);
    await db.insert(mouseFunders).values({ slackId: "U_STAFF", addedById: alice.id });
    expect(
      await code(ex.placeOrder({ userId: staff.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 50, qty: 1 })),
    ).toBe("FORBIDDEN");

    const { wedges } = await makeWheel(db, alice.id, ["Yes"], new Date("2000-01-01"));
    expect(
      await code(ex.placeOrder({ userId: alice.id, wedgeId: wedges[0]!.id, outcome: "YES", side: "BUY", price: 50, qty: 1 })),
    ).toBe("MARKET_CLOSED");
  });

  it("rebuilds books from the database and notices changes made by another engine", async () => {
    const { alice, bob, wedge } = await setup();
    await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 40, qty: 5 });
    await ex.placeOrder({ userId: bob.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 41, qty: 2 });

    const restarted = new Exchange(db);
    expect(await restarted.warmUp()).toBe(1);
    expect(await restarted.depth(wedge.id)).toEqual(await ex.depth(wedge.id));

    // The second engine trades; the first must not act on its stale book.
    await restarted.placeOrder({ userId: bob.id, wedgeId: wedge.id, outcome: "NO", side: "BUY", price: 60, qty: 5 });
    expect(await ex.depth(wedge.id)).toEqual(await restarted.depth(wedge.id));
    const r = await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "NO", side: "BUY", price: 60, qty: 5 });
    expect(r.trades).toHaveLength(0); // the 40 bid was already consumed (and 41 by Bob's own self-trade guard)
  });

  it("random trading keeps every invariant", async () => {
    const owner = await makeUser(db, "owner");
    const people: { id: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const u = await makeUser(db, `u${i}`);
      await fund(db, u.id, 5_000);
      people.push(u);
    }
    const { wedges } = await makeWheel(db, owner.id, ["A", "B"]);
    const rand = rng(7);
    const open: { userId: string; orderId: string }[] = [];
    for (let i = 0; i < 250; i++) {
      const u = people[Math.floor(rand() * people.length)]!;
      if (open.length && rand() < 0.15) {
        const [o] = open.splice(Math.floor(rand() * open.length), 1);
        const c = await code(ex.cancelOrder(o!.userId, o!.orderId));
        expect(["OK", "INVALID"]).toContain(c);
        continue;
      }
      try {
        const r = await ex.placeOrder({
          userId: u.id,
          wedgeId: wedges[Math.floor(rand() * 2)]!.id,
          outcome: rand() < 0.5 ? "YES" : "NO",
          side: rand() < 0.6 ? "BUY" : "SELL",
          price: 1 + Math.floor(rand() * 99),
          qty: 1 + Math.floor(rand() * 20),
          tif: rand() < 0.2 ? "IOC" : "GTC",
        });
        if (r.status === "open") open.push({ userId: u.id, orderId: r.orderId });
      } catch (e) {
        if (!(e instanceof ExchangeError)) throw e;
      }
    }
    expect(await audit(db)).toEqual([]);
    for (const w of wedges) {
      const d = await new Exchange(db).depth(w.id);
      expect(d).toEqual(await ex.depth(w.id));
      if (d.bids.length && d.asks.length) expect(d.bids[0]![0]).toBeLessThan(d.asks[0]![0]);
    }
    const open2 = await db.select().from(orders).where(eq(orders.status, "open"));
    expect(open2.every((o) => o.remaining > 0)).toBe(true);
  });
});
