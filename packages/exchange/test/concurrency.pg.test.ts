/**
 * Real-Postgres concurrency tests. Several Exchange instances share one database,
 * simulating separate engine processes: no shared in-process mutex, so only the
 * database's row locks stand between them and a double spend.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type pg from "pg";
import { createNodePgDb, sql, type AnyDb } from "@cheddar/db";
import { Exchange, ExchangeError, addMouseFunder, approveSettlement, audit, proposeSettlement, suspendUser, syncUser } from "../src/index";
import { balances, fund, makeUser, makeWheel, rng } from "./helpers";

let server: EmbeddedPostgres;
let dir: string;
let db: AnyDb;
let pool: pg.Pool;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cheddar-pg-"));
  const port = 54_000 + Math.floor(Math.random() * 1_000);
  server = new EmbeddedPostgres({ databaseDir: dir, port, user: "postgres", password: "postgres", persistent: false, onLog: () => {} });
  await server.initialise();
  await server.start();
  await server.createDatabase("cheddar_test");
  const r = await createNodePgDb(`postgres://postgres:postgres@localhost:${port}/cheddar_test`, { max: 20 });
  db = r.db as unknown as AnyDb;
  pool = r.pool;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const engines = () => [new Exchange(db), new Exchange(db), new Exchange(db), new Exchange(db)];

describe("concurrency on real Postgres", () => {
  it("one user cannot double-spend across engines and wedges", async () => {
    const owner = await makeUser(db, "owner");
    const spender = await makeUser(db, "spender");
    await fund(db, spender.id, 1_000);
    const { wedges } = await makeWheel(db, owner.id, ["A", "B", "C", "D", "E"]);
    const ex = engines();

    // 40 simultaneous orders costing 300 each: at most 3 can be afforded.
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        ex[i % ex.length]!.placeOrder({
          userId: spender.id,
          wedgeId: wedges[i % wedges.length]!.id,
          outcome: "YES",
          side: "BUY",
          price: 50,
          qty: 6,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof ExchangeError && r.reason.code === "INSUFFICIENT_FUNDS",
    ).length;
    expect(ok).toBe(3);
    expect(rejected).toBe(37);
    expect(await balances(db, spender.id)).toEqual({ available: 100, locked: 900 });
    expect(await audit(db)).toEqual([]);
  }, 120_000);

  it("a storm of orders and cancels from many users keeps every invariant", async () => {
    const owner = await makeUser(db, "owner2");
    const people: { id: string }[] = [];
    for (let i = 0; i < 10; i++) {
      const u = await makeUser(db, `trader${i}`);
      await fund(db, u.id, 3_000);
      people.push(u);
    }
    const { wedges } = await makeWheel(db, owner.id, ["X", "Y", "Z"]);
    const ex = engines();
    const rand = rng(1234);
    const openOrders: { userId: string; orderId: string }[] = [];

    for (let round = 0; round < 12; round++) {
      const batch = Array.from({ length: 30 }, () => {
        const engine = ex[Math.floor(rand() * ex.length)]!;
        if (openOrders.length && rand() < 0.2) {
          const [o] = openOrders.splice(Math.floor(rand() * openOrders.length), 1);
          return engine.cancelOrder(o!.userId, o!.orderId);
        }
        const u = people[Math.floor(rand() * people.length)]!;
        return engine
          .placeOrder({
            userId: u.id,
            wedgeId: wedges[Math.floor(rand() * wedges.length)]!.id,
            outcome: rand() < 0.5 ? "YES" : "NO",
            side: rand() < 0.6 ? "BUY" : "SELL",
            price: 20 + Math.floor(rand() * 61),
            qty: 1 + Math.floor(rand() * 10),
            tif: rand() < 0.2 ? "IOC" : "GTC",
          })
          .then((r) => {
            if (r.status === "open") openOrders.push({ userId: u.id, orderId: r.orderId });
          });
      });
      const settled = await Promise.allSettled(batch);
      for (const s of settled) {
        if (s.status === "rejected" && !(s.reason instanceof ExchangeError)) throw s.reason;
      }
    }

    expect(await audit(db)).toEqual([]);
    // Make sure the storm actually exercised matching and cancellation.
    const stats = (await db.execute(
      sql`SELECT (SELECT COUNT(*) FROM trades)::int AS trades,
                 (SELECT COUNT(DISTINCT kind) FROM trades)::int AS kinds,
                 (SELECT COUNT(*) FROM orders WHERE cancel_reason = 'user_cancelled')::int AS cancels`,
    )) as unknown as { rows: { trades: number; kinds: number; cancels: number }[] };
    const s = stats.rows[0]!;
    expect(s.trades).toBeGreaterThan(30);
    expect(s.kinds).toBe(4);
    expect(s.cancels).toBeGreaterThan(5);
    const fresh = new Exchange(db);
    for (const w of wedges) {
      const d = await fresh.depth(w.id);
      for (const engine of ex) expect(await engine.depth(w.id)).toEqual(d);
      if (d.bids.length && d.asks.length) expect(d.bids[0]![0]).toBeLessThan(d.asks[0]![0]);
    }
  }, 300_000);

  it("settling a wheel mid-storm pays out exactly and blocks later trades", async () => {
    const creator = await makeUser(db, "creator3");
    const monger = await makeUser(db, "monger3", { isCheesemonger: true, isSuperAdmin: true });
    const traders: { id: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const u = await makeUser(db, `settler${i}`);
      await fund(db, u.id, 4_000);
      traders.push(u);
    }
    const { wheel, wedges } = await makeWheel(db, creator.id, ["P", "Q", "R"]);
    const ex = engines();
    const rand = rng(99);
    const order = () => {
      const u = traders[Math.floor(rand() * traders.length)]!;
      return ex[Math.floor(rand() * ex.length)]!.placeOrder({
        userId: u.id,
        wedgeId: wedges[Math.floor(rand() * wedges.length)]!.id,
        outcome: rand() < 0.5 ? "YES" : "NO",
        side: rand() < 0.7 ? "BUY" : "SELL",
        price: 25 + Math.floor(rand() * 51),
        qty: 1 + Math.floor(rand() * 8),
      });
    };
    // Warm up so there are real positions and resting orders.
    await Promise.allSettled(Array.from({ length: 80 }, order));

    const storm = Array.from({ length: 120 }, order);
    const settle = (async () => {
      const s = await proposeSettlement(db, {
        wheelId: wheel.id,
        proposerId: creator.id,
        outcome: "wedge_wins",
        winningWedgeId: wedges[2]!.id,
        evidence: "R won",
      });
      return approveSettlement(db, { settlementId: s.id, reviewerId: monger.id });
    })();
    const settled = await Promise.allSettled(storm);
    const report = await settle;

    for (const s of settled) {
      if (s.status === "rejected" && !(s.reason instanceof ExchangeError)) throw s.reason;
    }
    expect(settled.some((s) => s.status === "rejected" && (s.reason as ExchangeError).code === "MARKET_CLOSED")).toBe(true);
    expect(report.reduce((n, r) => n + r.paidTicks, 0)).toBeGreaterThan(0);
    expect(await audit(db)).toEqual([]);

    // Every Latta the traders started with is back in their balances; nothing stuck or created.
    const ids = traders.map((t) => t.id);
    const r = (await db.execute(
      sql`SELECT kind, SUM(balance)::text AS s FROM accounts
          WHERE user_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) GROUP BY kind`,
    )) as unknown as { rows: { kind: string; s: string }[] };
    const byKind = Object.fromEntries(r.rows.map((row) => [row.kind, Number(row.s)]));
    expect(byKind.user_available).toBe(8 * 4_000);
    expect(byKind.user_locked).toBe(0);
    expect(await order().then(() => "OK", (e: ExchangeError) => e.code)).toBe("MARKET_CLOSED");
  }, 300_000);

  it("concurrent Churn syncs of one user credit the hours exactly once", async () => {
    const u = await makeUser(db, "racer", { hackatimeUserId: "9001" });
    let hours = 0;
    const ht = {
      async snapshot() {
        // Each caller sees a slightly later (or equal) Hackatime total.
        hours = Math.min(hours + 1, 20);
        return { lifetimeNonAiSeconds: hours * 3600, trustLevel: "blue" as const };
      },
    };
    await Promise.all(Array.from({ length: 30 }, () => syncUser(db, ht, u.id)));
    await syncUser(db, ht, u.id);
    expect((await balances(db, u.id)).available).toBe(20 * 1_000);
    expect(await audit(db)).toEqual([]);
  }, 120_000);

  it("a Mouse-funder sweep racing the user's own orders leaves nothing behind", async () => {
    const monger = await makeUser(db, "monger4", { isCheesemonger: true, isSuperAdmin: true });
    const staff = await makeUser(db, "staff4", { slackId: "U0RACE001" });
    const other = await makeUser(db, "other4");
    await fund(db, staff.id, 20_000);
    await fund(db, other.id, 20_000);
    const { wedges } = await makeWheel(db, monger.id, ["M", "N"]);
    const ex = engines();
    const rand = rng(5);
    const order = (userId: string) =>
      ex[Math.floor(rand() * ex.length)]!.placeOrder({
        userId,
        wedgeId: wedges[Math.floor(rand() * wedges.length)]!.id,
        outcome: rand() < 0.5 ? "YES" : "NO",
        side: "BUY",
        price: 30 + Math.floor(rand() * 41),
        qty: 1 + Math.floor(rand() * 5),
      });
    await Promise.allSettled(Array.from({ length: 30 }, (_, i) => order(i % 2 ? staff.id : other.id)));

    const storm = Array.from({ length: 60 }, () => order(staff.id));
    const sweep = addMouseFunder(db, { slackId: "U0RACE001", addedById: monger.id });
    const results = await Promise.allSettled(storm);
    const { swept } = await sweep;

    for (const r of results) {
      if (r.status === "rejected" && !(r.reason instanceof ExchangeError)) throw r.reason;
    }
    expect(swept).not.toBeNull();
    expect(await balances(db, staff.id)).toEqual({ available: 0, locked: 0 });
    const open = (await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM orders WHERE user_id = ${staff.id} AND status = 'open'`,
    )) as unknown as { rows: { n: number }[] };
    expect(open.rows[0]!.n).toBe(0);
    await expect(order(staff.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await audit(db)).toEqual([]);
  }, 300_000);

  it("a suspension racing the user's own orders leaves them with no open orders or escrow", async () => {
    const monger = await makeUser(db, "monger5", { isCheesemonger: true, isSuperAdmin: true });
    const bad = await makeUser(db, "bad5");
    await fund(db, bad.id, 20_000);
    const { wedges } = await makeWheel(db, monger.id, ["S", "T", "U"]);
    const ex = engines();
    const rand = rng(77);
    const order = () =>
      ex[Math.floor(rand() * ex.length)]!.placeOrder({
        userId: bad.id,
        wedgeId: wedges[Math.floor(rand() * wedges.length)]!.id,
        outcome: rand() < 0.5 ? "YES" : "NO",
        side: "BUY",
        price: 10 + Math.floor(rand() * 30),
        qty: 1 + Math.floor(rand() * 5),
      });
    const storm = Array.from({ length: 60 }, order);
    const suspension = suspendUser(db, { userId: bad.id, actorId: monger.id, reason: "race test" });
    const results = await Promise.allSettled(storm);
    await suspension;
    for (const r of results) {
      if (r.status === "rejected" && !(r.reason instanceof ExchangeError)) throw r.reason;
    }
    expect((await balances(db, bad.id)).locked).toBe(0);
    const open = (await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM orders WHERE user_id = ${bad.id} AND status = 'open'`,
    )) as unknown as { rows: { n: number }[] };
    expect(open.rows[0]!.n).toBe(0);
    await expect(order()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await audit(db)).toEqual([]);
  }, 300_000);
});
