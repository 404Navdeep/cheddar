import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import {
  accounts,
  createPgliteDb,
  journalEntries,
  ledgerLines,
  orders,
  positions,
  settlements,
  users,
  wedges,
  wheels,
  type PgliteDb,
} from "../src/index";

let db: PgliteDb;
let client: PGlite;

beforeEach(async () => {
  ({ db, client } = await createPgliteDb());
});
afterEach(async () => {
  await client.close();
});

async function issuanceAccount() {
  const [a] = await db.select().from(accounts).where(eq(accounts.kind, "churn_issuance"));
  return a!;
}

async function makeUser(name = "orpheus") {
  const [u] = await db.insert(users).values({ hcaSub: `ident!${name}`, name }).returning();
  const [avail] = await db.insert(accounts).values({ kind: "user_available", userId: u!.id }).returning();
  const [locked] = await db.insert(accounts).values({ kind: "user_locked", userId: u!.id }).returning();
  return { user: u!, avail: avail!, locked: locked! };
}

/** Post one journal entry with the given lines in a single transaction. */
async function post(kind: "churn" | "order_lock", lines: { accountId: string; amount: number }[]) {
  await db.transaction(async (tx) => {
    const [e] = await tx.insert(journalEntries).values({ kind }).returning();
    for (const l of lines) await tx.insert(ledgerLines).values({ entryId: e!.id, ...l });
  });
}

async function sumOfLines(accountId: string) {
  const r = await db.execute<{ s: string | null }>(
    sql`SELECT SUM(amount)::text AS s FROM ledger_lines WHERE account_id = ${accountId}`,
  );
  return Number(r.rows[0]?.s ?? 0);
}

/** Drizzle wraps Postgres errors; return the underlying database message. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message;
  }
  throw new Error("expected the query to fail");
}

/** Drizzle builders are thenables. `expect().rejects` only accepts a real Promise. */
function query<T>(p: PromiseLike<T>): Promise<T> {
  return Promise.resolve(p);
}

async function balanceOf(accountId: string) {
  const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  return a!.balance;
}

describe("schema", () => {
  it("migrates and seeds exactly one churn issuance account", async () => {
    const rows = await db.select().from(accounts).where(eq(accounts.kind, "churn_issuance"));
    expect(rows).toHaveLength(1);
    await expect(query(db.insert(accounts).values({ kind: "churn_issuance" }))).rejects.toThrow();
  });

  it("a balanced churn credit updates the balance cache to match the lines", async () => {
    const issuance = await issuanceAccount();
    const { avail } = await makeUser();
    await post("churn", [
      { accountId: issuance.id, amount: -2500 },
      { accountId: avail.id, amount: 2500 },
    ]);
    expect(await balanceOf(avail.id)).toBe(2500);
    expect(await sumOfLines(avail.id)).toBe(2500);
    expect(await balanceOf(issuance.id)).toBe(-2500);
  });

  it("rejects an unbalanced entry at commit and rolls everything back", async () => {
    const issuance = await issuanceAccount();
    const { avail } = await makeUser();
    await expect(
      post("churn", [
        { accountId: issuance.id, amount: -2500 },
        { accountId: avail.id, amount: 2400 },
      ]),
    ).rejects.toThrow();
    expect(await balanceOf(avail.id)).toBe(0);
    expect(await db.select().from(journalEntries)).toHaveLength(0);
  });

  it("rejects an overdraft on a user account", async () => {
    const issuance = await issuanceAccount();
    const { avail, locked } = await makeUser();
    await post("churn", [
      { accountId: issuance.id, amount: -1000 },
      { accountId: avail.id, amount: 1000 },
    ]);
    await expect(
      post("order_lock", [
        { accountId: avail.id, amount: -1001 },
        { accountId: locked.id, amount: 1001 },
      ]),
    ).rejects.toThrow();
    expect(await balanceOf(avail.id)).toBe(1000);
  });

  it("ledger lines and journal entries are append-only", async () => {
    const issuance = await issuanceAccount();
    const { avail } = await makeUser();
    await post("churn", [
      { accountId: issuance.id, amount: -100 },
      { accountId: avail.id, amount: 100 },
    ]);
    for (const q of [
      sql`UPDATE ledger_lines SET amount = 999999`,
      sql`DELETE FROM ledger_lines`,
      sql`UPDATE journal_entries SET memo = 'x'`,
      sql`TRUNCATE ledger_lines CASCADE`,
    ]) {
      expect(await pgError(db.execute(q))).toMatch(/append-only/);
    }
    expect(await sumOfLines(avail.id)).toBe(100);
  });

  it("all balances sum to zero (Latta only enters via churn issuance)", async () => {
    const issuance = await issuanceAccount();
    const a = await makeUser("a");
    const b = await makeUser("b");
    await post("churn", [
      { accountId: issuance.id, amount: -5000 },
      { accountId: a.avail.id, amount: 5000 },
    ]);
    await post("churn", [
      { accountId: issuance.id, amount: -2500 },
      { accountId: b.avail.id, amount: 2500 },
    ]);
    await post("order_lock", [
      { accountId: a.avail.id, amount: -1200 },
      { accountId: a.locked.id, amount: 1200 },
    ]);
    const r = await db.execute<{ s: string }>(sql`SELECT SUM(balance)::text AS s FROM accounts`);
    expect(Number(r.rows[0]!.s)).toBe(0);
    expect(-(await balanceOf(issuance.id))).toBe(7500);
  });

  it("enforces market and position constraints", async () => {
    const { user } = await makeUser();
    const [wheel] = await db
      .insert(wheels)
      .values({
        slug: "will-it-ship",
        title: "Will it ship?",
        resolutionCriteria: "It ships.",
        closesAt: new Date("2027-01-01"),
        creatorId: user.id,
      })
      .returning();
    const [wedge] = await db.insert(wedges).values({ wheelId: wheel!.id, label: "Yes" }).returning();

    const base = { userId: user.id, wedgeId: wedge!.id, outcome: "YES" as const, side: "BUY" as const, qty: 1, remaining: 1 };
    await expect(query(db.insert(orders).values({ ...base, price: 0 }))).rejects.toThrow();
    await expect(query(db.insert(orders).values({ ...base, price: 100 }))).rejects.toThrow();
    await expect(query(db.insert(orders).values({ ...base, price: 50, remaining: 2 }))).rejects.toThrow();
    await expect(query(db.insert(orders).values({ ...base, price: 50, lockedShares: 1 }))).rejects.toThrow();
    await db.insert(orders).values({ ...base, price: 50, lockedTicks: 50 });

    await expect(
      query(db.insert(positions).values({ userId: user.id, wedgeId: wedge!.id, yesShares: 1, yesLocked: 2 })),
    ).rejects.toThrow();

    await expect(
      query(db.insert(settlements).values({ wheelId: wheel!.id, proposerId: user.id, outcome: "wedge_wins", evidence: "trust me" })),
    ).rejects.toThrow();
    await db
      .insert(settlements)
      .values({ wheelId: wheel!.id, proposerId: user.id, outcome: "wedge_wins", winningWedgeId: wedge!.id, evidence: "link" });
    await expect(
      query(db.insert(settlements).values({ wheelId: wheel!.id, proposerId: user.id, outcome: "moldy", evidence: "dupe pending" })),
    ).rejects.toThrow();
  });

  it("humans need an HCA subject, bots do not", async () => {
    await expect(query(db.insert(users).values({ name: "nobody" }))).rejects.toThrow();
    await db.insert(users).values({ name: "The Mouse", isBot: true });
  });
});
