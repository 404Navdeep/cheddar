import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { asc, auditLog, categories, wheels, createPgliteDb, eq, sql, users, type AnyDb } from "@cheddar/db";
import {
  Exchange,
  addCategory,
  grantLatta,
  removeCategory,
  setCategoryIcon,
  ExchangeError,
  addMouseFunder,
  approveProposal,
  approveSettlement,
  audit,
  pauseWheel,
  proposeSettlement,
  rejectProposal,
  resumeWheel,
  setCheesemonger,
  setSuperAdmin,
  submitProposal,
  suspendUser,
  unsuspendUser,
} from "../src/index";
import { balances, fund, makeUser, makeWheel } from "./helpers";

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

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e) => {
      if (e instanceof ExchangeError) return e.code;
      throw e;
    },
  );

async function logs() {
  return db.select().from(auditLog).orderBy(asc(auditLog.id));
}

async function world() {
  const monger = await makeUser(db, "monger", { isCheesemonger: true, isSuperAdmin: true });
  const monger2 = await makeUser(db, "monger2", { isCheesemonger: true });
  const alice = await makeUser(db, "alice", { slackId: "U0ALICE01" });
  const bob = await makeUser(db, "bob");
  for (const u of [alice, bob]) await fund(db, u.id, 10_000);
  const { wheel, wedges } = await makeWheel(db, monger.id, ["Yes"]);
  return { monger, monger2, alice, bob, wheel, wedge: wedges[0]! };
}

describe("Suspension", () => {
  it("cancels open orders, blocks trading/proposing/settling, and is reversible", async () => {
    const { monger, alice, bob, wheel, wedge } = await world();
    await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 40, qty: 10 });
    const { wheel: own } = await makeWheel(db, alice.id, ["Yes"]);

    expect(await suspendUser(db, { userId: alice.id, actorId: monger.id, reason: "wash trading" })).toEqual({ cancelledOrders: 1 });
    expect(await balances(db, alice.id)).toEqual({ available: 10_000, locked: 0 });
    expect(await ex.depth(wedge.id)).toEqual({ bids: [], asks: [] }); // the engine's cached book reloaded

    const order = { userId: alice.id, wedgeId: wedge.id, outcome: "YES" as const, side: "BUY" as const, price: 50, qty: 1 };
    expect(await code(ex.placeOrder(order))).toBe("FORBIDDEN");
    expect(
      await code(
        submitProposal(db, { proposerId: alice.id, title: "T", resolutionCriteria: "R", closesAt: new Date(Date.now() + 1e7), outcomes: ["Yes"] }),
      ),
    ).toBe("FORBIDDEN");
    expect(await code(proposeSettlement(db, { wheelId: own.id, proposerId: alice.id, outcome: "all_no", evidence: "x" }))).toBe("FORBIDDEN");
    // Other people are unaffected.
    await ex.placeOrder({ ...order, userId: bob.id });

    await unsuspendUser(db, { userId: alice.id, actorId: monger.id, note: "appealed" });
    await ex.placeOrder(order);
    expect((await logs()).map((l) => l.action)).toEqual(["user.suspend", "user.unsuspend"]);
    const [s] = await logs();
    expect(s).toMatchObject({ actorId: monger.id, targetType: "user", targetId: alice.id });
    expect(s!.details).toMatchObject({ reason: "wash trading", cancelledOrders: 1 });
    void wheel;
  });

  it("guards against misuse", async () => {
    const { monger, monger2, alice, bob } = await world();
    expect(await code(suspendUser(db, { userId: alice.id, actorId: bob.id, reason: "x" }))).toBe("FORBIDDEN");
    expect(await code(suspendUser(db, { userId: monger.id, actorId: monger.id, reason: "x" }))).toBe("INVALID");
    expect(await code(suspendUser(db, { userId: monger2.id, actorId: monger.id, reason: "x" }))).toBe("INVALID");
    expect(await code(suspendUser(db, { userId: alice.id, actorId: monger.id, reason: " " }))).toBe("INVALID");
    await suspendUser(db, { userId: alice.id, actorId: monger.id, reason: "spam" });
    expect(await code(suspendUser(db, { userId: alice.id, actorId: monger.id, reason: "again" }))).toBe("INVALID");
    expect(await code(unsuspendUser(db, { userId: bob.id, actorId: monger.id }))).toBe("INVALID");
    expect(await code(setCheesemonger(db, { userId: alice.id, actorId: monger.id, value: true }))).toBe("INVALID");
  });
});

describe("Cheesemonger roles", () => {
  it("only super admins promote and demote, never themselves, and it's logged", async () => {
    const { monger, monger2, alice, bob } = await world();
    await setCheesemonger(db, { userId: alice.id, actorId: monger.id, value: true });
    await setCheesemonger(db, { userId: alice.id, actorId: monger.id, value: true }); // no-op, not logged twice
    const [a] = await db.select().from(users).where(eq(users.id, alice.id));
    expect(a!.isCheesemonger).toBe(true);
    expect(await code(setCheesemonger(db, { userId: monger.id, actorId: monger.id, value: false }))).toBe("INVALID");
    // A plain Cheesemonger can't manage roles or users.
    expect(await code(setCheesemonger(db, { userId: bob.id, actorId: monger2.id, value: true }))).toBe("FORBIDDEN");
    expect(await code(suspendUser(db, { userId: bob.id, actorId: monger2.id, reason: "x" }))).toBe("FORBIDDEN");
    await setCheesemonger(db, { userId: alice.id, actorId: monger.id, value: false });
    expect((await logs()).map((l) => l.action)).toEqual(["user.promote", "user.demote"]);
  });

  it("super admins make super admins, who are always Cheesemongers too", async () => {
    const { monger, monger2, bob } = await world();
    expect(await code(setSuperAdmin(db, { userId: bob.id, actorId: monger2.id, value: true }))).toBe("FORBIDDEN");
    await setSuperAdmin(db, { userId: bob.id, actorId: monger.id, value: true });
    const [b] = await db.select().from(users).where(eq(users.id, bob.id));
    expect(b).toMatchObject({ isSuperAdmin: true, isCheesemonger: true });
    expect(await code(setCheesemonger(db, { userId: bob.id, actorId: monger.id, value: false }))).toBe("INVALID");
    expect(await code(setSuperAdmin(db, { userId: monger.id, actorId: monger.id, value: false }))).toBe("INVALID");
    await setSuperAdmin(db, { userId: monger.id, actorId: bob.id, value: false });
    expect(await code(suspendUser(db, { userId: bob.id, actorId: monger.id, reason: "x" }))).toBe("FORBIDDEN");
  });
});

describe("Wheel pause", () => {
  it("blocks new orders, still allows cancelling, and resumes", async () => {
    const { monger, alice, bob, wheel, wedge } = await world();
    const resting = await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 40, qty: 5 });
    await pauseWheel(db, { wheelId: wheel.id, actorId: monger.id, reason: "criteria unclear" });
    const order = { userId: bob.id, wedgeId: wedge.id, outcome: "NO" as const, side: "BUY" as const, price: 60, qty: 5 };
    await expect(ex.placeOrder(order)).rejects.toThrow(/paused.*criteria unclear/);
    await ex.cancelOrder(alice.id, resting.orderId);
    expect(await code(pauseWheel(db, { wheelId: wheel.id, actorId: monger.id, reason: "again" }))).toBe("INVALID");
    expect(await code(pauseWheel(db, { wheelId: wheel.id, actorId: bob.id, reason: "x" }))).toBe("FORBIDDEN"); // permission is checked first
    await resumeWheel(db, { wheelId: wheel.id, actorId: monger.id });
    await ex.placeOrder(order);
    expect((await logs()).map((l) => l.action)).toEqual(["wheel.pause", "wheel.resume"]);
  });

  it("a paused wheel can still be settled", async () => {
    const { monger, monger2, alice, bob, wheel, wedge } = await world();
    await ex.placeOrder({ userId: alice.id, wedgeId: wedge.id, outcome: "YES", side: "BUY", price: 50, qty: 4 });
    await ex.placeOrder({ userId: bob.id, wedgeId: wedge.id, outcome: "NO", side: "BUY", price: 50, qty: 4 });
    await pauseWheel(db, { wheelId: wheel.id, actorId: monger.id, reason: "dispute" });
    const s = await proposeSettlement(db, { wheelId: wheel.id, proposerId: monger.id, outcome: "moldy", evidence: "voided" });
    await approveSettlement(db, { settlementId: s.id, reviewerId: monger2.id });
    expect((await balances(db, alice.id)).available).toBe(10_000);
  });
});

describe("Audit log", () => {
  it("records proposals, reviews, settlements and funders with the actor", async () => {
    const { monger, monger2, alice } = await world();
    const p = await submitProposal(db, {
      proposerId: alice.id,
      title: "Will it ship?",
      resolutionCriteria: "It ships.",
      closesAt: new Date(Date.now() + 86_400_000),
      outcomes: ["Yes"],
    });
    const { wheel } = await approveProposal(db, { proposalId: p.id, reviewerId: monger.id, note: "nice" });
    const p2 = await submitProposal(db, {
      proposerId: alice.id,
      title: "Dupe",
      resolutionCriteria: "x",
      closesAt: new Date(Date.now() + 86_400_000),
      outcomes: ["Yes"],
    });
    await rejectProposal(db, { proposalId: p2.id, reviewerId: monger.id, note: "duplicate" });
    const s = await proposeSettlement(db, { wheelId: wheel.id, proposerId: alice.id, outcome: "all_no", evidence: "didn't" });
    await approveSettlement(db, { settlementId: s.id, reviewerId: monger2.id });
    await addMouseFunder(db, { slackId: "U0ALICE01", addedById: monger.id, note: "staff" });

    const l = await logs();
    expect(l.map((x) => [x.action, x.actorId])).toEqual([
      ["proposal.submit", alice.id],
      ["proposal.approve", monger.id],
      ["proposal.submit", alice.id],
      ["proposal.reject", monger.id],
      ["settlement.propose", alice.id],
      ["settlement.approve", monger2.id],
      ["funder.add", monger.id],
    ]);
    expect(l[1]!.details).toMatchObject({ slug: wheel.slug, note: "nice" });
    expect(l[6]!.details).toMatchObject({ userId: alice.id, sweptTicks: 10_000 });
  });

  it("a failed action leaves no log entry, and the log is append-only", async () => {
    const { monger, alice } = await world();
    const p = await submitProposal(db, {
      proposerId: alice.id,
      title: "T",
      resolutionCriteria: "R",
      closesAt: new Date(Date.now() + 86_400_000),
      outcomes: ["Yes"],
    });
    expect(await code(approveProposal(db, { proposalId: p.id, reviewerId: alice.id }))).toBe("FORBIDDEN");
    expect((await logs()).map((x) => x.action)).toEqual(["proposal.submit"]);
    for (const q of [sql`UPDATE audit_log SET action = 'x'`, sql`DELETE FROM audit_log`, sql`TRUNCATE audit_log`]) {
      await expect(Promise.resolve(db.execute(q))).rejects.toThrow();
    }
    expect(await logs()).toHaveLength(1);
    void monger;
  });
});

describe("Categories", () => {
  it("super admins add and remove them; removing moves wheels to Hack Club", async () => {
    const { monger, monger2, wheel } = await world();
    expect(await code(addCategory(db, { name: "Sports", actorId: monger2.id }))).toBe("FORBIDDEN");
    await addCategory(db, { name: "Sports", actorId: monger.id });
    expect(await code(addCategory(db, { name: "sports", actorId: monger.id }))).toBe("INVALID");
    await db.update(wheels).set({ category: "Sports" }).where(eq(wheels.id, wheel.id));
    expect(await code(removeCategory(db, { name: "Sports", actorId: monger2.id }))).toBe("FORBIDDEN");
    expect(await code(removeCategory(db, { name: "Hack Club", actorId: monger.id }))).toBe("INVALID");
    expect(await removeCategory(db, { name: "Sports", actorId: monger.id })).toEqual({ moved: 1 });
    const [w] = await db.select().from(wheels).where(eq(wheels.id, wheel.id));
    expect(w!.category).toBe("Hack Club");
    expect((await db.select().from(categories)).map((c) => c.name)).not.toContain("Sports");
    expect(await code(removeCategory(db, { name: "Sports", actorId: monger.id }))).toBe("NOT_FOUND");
  });

  it("super admins set a category icon; bad ones are refused", async () => {
    const { monger, monger2 } = await world();
    expect(await code(setCategoryIcon(db, { name: "YSWS", icon: "img:ship.png", actorId: monger2.id }))).toBe("FORBIDDEN");
    await setCategoryIcon(db, { name: "YSWS", icon: "img:ship.png", actorId: monger.id });
    expect((await db.select().from(categories).where(eq(categories.name, "YSWS")))[0]!.icon).toBe("img:ship.png");
    expect(await code(setCategoryIcon(db, { name: "YSWS", icon: "https://evil.example/x.png", actorId: monger.id }))).toBe("INVALID");
    expect(await code(setCategoryIcon(db, { name: "Nope", icon: "img:ship.png", actorId: monger.id }))).toBe("NOT_FOUND");
    await setCategoryIcon(db, { name: "YSWS", icon: "", actorId: monger.id });
    expect((await db.select().from(categories).where(eq(categories.name, "YSWS")))[0]!.icon).toBeNull();
  });
});

describe("Grants", () => {
  it("super admins grant Latta from the house, logged and audited", async () => {
    const { monger, monger2, alice } = await world();
    const before = (await balances(db, alice.id)).available;
    expect(await code(grantLatta(db, { recipientId: alice.id, actorId: monger2.id, ticks: 500, reason: "bug bounty" }))).toBe("FORBIDDEN");
    expect(await code(grantLatta(db, { recipientId: alice.id, actorId: monger.id, ticks: 0, reason: "x" }))).toBe("INVALID");
    expect(await code(grantLatta(db, { recipientId: alice.id, actorId: monger.id, ticks: 500, reason: " " }))).toBe("INVALID");
    await grantLatta(db, { recipientId: alice.id, actorId: monger.id, ticks: 500, reason: "bug bounty" });
    expect((await balances(db, alice.id)).available).toBe(before + 500);
    const log = await db.select().from(auditLog).where(eq(auditLog.action, "grant.lc"));
    expect(log).toHaveLength(1);
    // the afterEach hook runs the full audit, which now includes the grant checks
  });
});
