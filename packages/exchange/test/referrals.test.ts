import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createPgliteDb, eq, referrals, users, type AnyDb } from "@cheddar/db";
import {
  DEFAULT_REFERRAL,
  Exchange,
  attachReferral,
  audit,
  ensureReferralCode,
  payReferralIfDue,
  referralSummary,
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

/** `userId` trades `qty` shares at 50c against a resting bid, so their traded value is qty * 50 ticks. */
async function trade(userId: string, wedgeId: string, makerId: string, qty: number) {
  await ex.placeOrder({ userId: makerId, wedgeId, outcome: "YES", side: "BUY", price: 50, qty, tif: "GTC" });
  return ex.placeOrder({ userId, wedgeId, outcome: "NO", side: "BUY", price: 50, qty, tif: "IOC" });
}

describe("referrals", () => {
  it("makes one stable code per person", async () => {
    const alice = await makeUser(db, "alice");
    const a = await ensureReferralCode(db, alice.id);
    expect(a).toMatch(/^[a-z0-9]{8}$/);
    expect(await ensureReferralCode(db, alice.id)).toBe(a);
    const bob = await makeUser(db, "bob");
    expect(await ensureReferralCode(db, bob.id)).not.toBe(a);
  });

  it("only attaches brand-new accounts, once, and never to yourself or a suspended person", async () => {
    const alice = await makeUser(db, "alice");
    const code = await ensureReferralCode(db, alice.id);
    const bob = await makeUser(db, "bob");
    expect(await attachReferral(db, { refereeId: alice.id, code })).toBeNull(); // self
    expect(await attachReferral(db, { refereeId: bob.id, code: "nope" })).toBeNull();
    expect(await attachReferral(db, { refereeId: bob.id, code })).toEqual({ referrerId: alice.id });
    expect(await attachReferral(db, { refereeId: bob.id, code })).toBeNull(); // already invited
    expect((await db.select().from(users).where(eq(users.id, bob.id)))[0]!.referredById).toBe(alice.id);

    const old = await makeUser(db, "old");
    await db.update(users).set({ createdAt: new Date(Date.now() - 3 * 86_400_000) }).where(eq(users.id, old.id));
    expect(await attachReferral(db, { refereeId: old.id, code })).toBeNull(); // not new

    const sus = await makeUser(db, "sus", { suspendedAt: new Date() });
    const susCode = await ensureReferralCode(db, sus.id);
    const carol = await makeUser(db, "carol");
    expect(await attachReferral(db, { refereeId: carol.id, code: susCode })).toBeNull();
  });

  it("pays both people on the first real trade (40 Lc to the inviter, 20 Lc to the invited), exactly once, and the books still balance", async () => {
    const monger = await makeUser(db, "monger", { isCheesemonger: true });
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    await fund(db, bob.id, 100_000);
    await fund(db, monger.id, 100_000);
    const { wedges } = await makeWheel(db, monger.id, ["Yes"]);
    await attachReferral(db, { refereeId: bob.id, code: await ensureReferralCode(db, alice.id) });

    // Nothing to pay before he has traded, and a tiny trade (50 ticks) is under the minimum.
    expect(await payReferralIfDue(db, { refereeId: bob.id })).toBeNull();
    await trade(bob.id, wedges[0]!.id, monger.id, 1);
    expect(await payReferralIfDue(db, { refereeId: bob.id })).toBeNull();

    const before = { alice: (await balances(db, alice.id)).available, bob: (await balances(db, bob.id)).available };
    await trade(bob.id, wedges[0]!.id, monger.id, 20);
    const paid = await payReferralIfDue(db, { refereeId: bob.id });
    expect(paid).toMatchObject({ referrerTicks: DEFAULT_REFERRAL.referrerTicks, refereeTicks: DEFAULT_REFERRAL.refereeTicks });
    expect((await balances(db, alice.id)).available).toBe(before.alice + DEFAULT_REFERRAL.referrerTicks);
    expect((await balances(db, bob.id)).available).toBe(before.bob - 20 * 50 + DEFAULT_REFERRAL.refereeTicks);
    // Never twice.
    expect(await payReferralIfDue(db, { refereeId: bob.id })).toBeNull();
    expect((await db.select().from(referrals).where(eq(referrals.refereeId, bob.id)))[0]).toMatchObject({ status: "paid" });

    expect(await referralSummary(db, alice.id)).toMatchObject({ rewarded: 1, pending: 0, earnedTicks: DEFAULT_REFERRAL.referrerTicks });
    expect((await referralSummary(db, bob.id)).invitedBy).toMatchObject({ id: alice.id, status: "paid" });
  });

  it("has no limit on how many invited people the inviter earns on", async () => {
    const monger = await makeUser(db, "monger", { isCheesemonger: true });
    const alice = await makeUser(db, "alice");
    await fund(db, monger.id, 1_000_000);
    const { wedges } = await makeWheel(db, monger.id, ["Yes"]);
    const code = await ensureReferralCode(db, alice.id);
    const people = ["b1", "b2", "b3", "b4"];
    for (const name of people) {
      const u = await makeUser(db, name);
      await fund(db, u.id, 100_000);
      await attachReferral(db, { refereeId: u.id, code });
      await trade(u.id, wedges[0]!.id, monger.id, 20);
      expect(await payReferralIfDue(db, { refereeId: u.id })).toMatchObject({
        referrerTicks: DEFAULT_REFERRAL.referrerTicks,
        refereeTicks: DEFAULT_REFERRAL.refereeTicks,
        note: null,
      });
    }
    expect(await referralSummary(db, alice.id)).toMatchObject({
      rewarded: people.length,
      earnedTicks: people.length * DEFAULT_REFERRAL.referrerTicks,
    });
  });

  it("keeps a suspended invited person pending until they're back", async () => {
    const monger = await makeUser(db, "monger", { isCheesemonger: true });
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    await fund(db, bob.id, 100_000);
    await fund(db, monger.id, 100_000);
    const { wedges } = await makeWheel(db, monger.id, ["Yes"]);
    await attachReferral(db, { refereeId: bob.id, code: await ensureReferralCode(db, alice.id) });
    await trade(bob.id, wedges[0]!.id, monger.id, 20);
    await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, bob.id));
    expect(await payReferralIfDue(db, { refereeId: bob.id })).toBeNull();
    await db.update(users).set({ suspendedAt: null }).where(eq(users.id, bob.id));
    expect(await payReferralIfDue(db, { refereeId: bob.id })).not.toBeNull();
  });
});
