import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { asc, createPgliteDb, eq, positions, wedges, wheels, and, type AnyDb } from "@cheddar/db";
import {
  Exchange,
  addOutcome,
  approveProposal,
  audit,
  convertNo,
  ensureMouse,
  mergeYesSet,
  mousePrices,
  requestOutcome,
  requoteWheel,
  reviewOutcomeRequest,
  setWheelLiquidity,
  submitProposal,
  updateProposal,
  updateWheel,
} from "../src/index";
import { fund, makeUser, makeWheel } from "./helpers";

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

const self = { allowSelfReview: true };

async function prices(wheelId: string) {
  const [w] = await db.select().from(wheels).where(eq(wheels.id, wheelId));
  const ws = await db.select().from(wedges).where(eq(wedges.wheelId, wheelId)).orderBy(asc(wedges.sortOrder));
  const mouse = await ensureMouse(db);
  const pos = await db.select().from(positions).where(eq(positions.userId, mouse.id));
  const holdings = new Map(pos.map((p) => [p.wedgeId, { yes: p.yesShares, no: p.noShares }]));
  const p = mousePrices(w!, ws.map((x) => x.id), holdings)!;
  return ws.map((x) => ({ label: x.label, p: p.get(x.id)! }));
}

describe("editing proposals", () => {
  it("lets a Cheesemonger rewrite everything, including the type and outcomes", async () => {
    const monger = await makeUser(db, "monger", { isCheesemonger: true });
    const alice = await makeUser(db, "alice");
    const p = await submitProposal(db, { proposerId: alice.id, title: "Will it rain?", resolutionCriteria: "Weather", outcomes: ["Yes"] });
    await expect(
      updateProposal(db, { proposalId: p.id, editorId: alice.id, fields: { title: "x", resolutionCriteria: "y", outcomes: ["Yes"] } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const closesAt = new Date(Date.now() + 7 * 86_400_000);
    const edited = await updateProposal(db, {
      proposalId: p.id,
      editorId: monger.id,
      fields: {
        title: "Which day will it rain first?",
        resolutionCriteria: "Met office",
        category: "Fun",
        outcomes: ["Monday", "Tuesday"],
        allowAdditions: true,
        closesAt,
        icon: "svg:trophy",
      },
    });
    expect(edited).toMatchObject({ title: "Which day will it rain first?", outcomes: ["Monday", "Tuesday"], allowAdditions: true, icon: "svg:trophy" });
    expect(edited.closesAt?.getTime()).toBe(closesAt.getTime());
    // Binary proposals can't be open to new outcomes.
    const bin = await updateProposal(db, {
      proposalId: p.id,
      editorId: monger.id,
      fields: { title: "Rain?", resolutionCriteria: "x", outcomes: ["Yes"], allowAdditions: true },
    });
    expect(bin.allowAdditions).toBe(false);
    await expect(
      updateProposal(db, {
        proposalId: p.id,
        editorId: monger.id,
        fields: { title: "Rain?", resolutionCriteria: "x", outcomes: ["Yes"], closesAt: new Date(Date.now() - 1000) },
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("adding outcomes", () => {
  async function live(liquidity = 300) {
    const monger = await makeUser(db, "monger", { isCheesemonger: true });
    const alice = await makeUser(db, "alice");
    await fund(db, alice.id, 1_000_000);
    const p = await submitProposal(db, {
      proposerId: monger.id,
      title: "Best language",
      resolutionCriteria: "Hackatime",
      outcomes: ["Rust", "Go"],
      allowAdditions: true,
    });
    const { wheel, wedges: ws } = await approveProposal(db, { proposalId: p.id, reviewerId: monger.id, liquidity }, self);
    expect(wheel.allowAdditions).toBe(true);
    await requoteWheel(db, ex, wheel.id);
    return { monger, alice, wheel, wedges: ws };
  }

  it("suggestions go to a Cheesemonger, and approving one adds a tradable outcome", async () => {
    const { monger, alice, wheel } = await live();
    const r = await requestOutcome(db, { wheelId: wheel.id, userId: alice.id, label: "zig", note: "it's rising" });
    await expect(requestOutcome(db, { wheelId: wheel.id, userId: alice.id, label: "Zig" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(requestOutcome(db, { wheelId: wheel.id, userId: alice.id, label: "rust" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(reviewOutcomeRequest(db, { requestId: r.id, reviewerId: alice.id, approve: true })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const out = await reviewOutcomeRequest(db, { requestId: r.id, reviewerId: monger.id, approve: true, label: "Zig", startChance: 0.2 });
    expect(out.approved).toBe(true);
    const ps = await prices(wheel.id);
    expect(ps.map((x) => x.label)).toEqual(["Rust", "Go", "Zig"]);
    expect(ps.reduce((s, x) => s + x.p, 0)).toBeCloseTo(1, 9);
    expect(ps[2]!.p).toBeCloseTo(0.2, 6);
    expect(ps[0]!.p).toBeCloseTo(0.5 * 0.8, 6);

    await requoteWheel(db, ex, wheel.id);
    const zig = (await db.select().from(wedges).where(and(eq(wedges.wheelId, wheel.id), eq(wedges.label, "Zig"))))[0]!;
    const fill = await ex.placeOrder({ userId: alice.id, wedgeId: zig.id, outcome: "YES", side: "BUY", price: 99, qty: 20, tif: "IOC" });
    expect(fill.filled).toBe(20);
  });

  it("keeps The Mouse's prices continuous after it has traded", async () => {
    const { monger, alice, wheel, wedges: ws } = await live();
    await ex.placeOrder({ userId: alice.id, wedgeId: ws[0]!.id, outcome: "YES", side: "BUY", price: 99, qty: 150, tif: "IOC" });
    await requoteWheel(db, ex, wheel.id);
    const before = await prices(wheel.id);
    expect(before[0]!.p).toBeGreaterThan(1 / 2);
    await addOutcome(db, { wheelId: wheel.id, actorId: monger.id, label: "Zig" });
    const after = await prices(wheel.id);
    expect(after.map((x) => x.label)).toEqual(["Rust", "Go", "Zig"]);
    expect(after[2]!.p).toBeCloseTo(1 / 3, 6);
    expect(after[0]!.p).toBeCloseTo(before[0]!.p * (2 / 3), 6);
    await requoteWheel(db, ex, wheel.id);
  });

  it("rejects suggestions, and refuses them on wheels that aren't open to them", async () => {
    const { monger, alice, wheel } = await live(0);
    const r = await requestOutcome(db, { wheelId: wheel.id, userId: alice.id, label: "Zig" });
    expect(await reviewOutcomeRequest(db, { requestId: r.id, reviewerId: monger.id, approve: false, note: "dup" })).toEqual({ approved: false });
    const { wheel: closed } = await makeWheel(db, monger.id, ["A", "B"]);
    await expect(requestOutcome(db, { wheelId: closed.id, userId: alice.id, label: "C" })).rejects.toMatchObject({ code: "INVALID" });
    // Cheesemongers can still add to any multi-outcome wheel directly, but not to a Yes/No one.
    await addOutcome(db, { wheelId: closed.id, actorId: monger.id, label: "C" });
    const { wheel: bin } = await makeWheel(db, monger.id, ["Yes"]);
    await expect(addOutcome(db, { wheelId: bin.id, actorId: monger.id, label: "Maybe" })).rejects.toMatchObject({ code: "INVALID" });
  });

  it("turns whole-wheel conversions off while outcomes can still be added", async () => {
    const { alice, wheel, wedges: ws } = await live();
    for (const w of ws) await ex.placeOrder({ userId: alice.id, wedgeId: w.id, outcome: "YES", side: "BUY", price: 99, qty: 5, tif: "IOC" });
    await expect(mergeYesSet(db, { userId: alice.id, wheelId: wheel.id, shares: 5 })).rejects.toMatchObject({ code: "INVALID" });
    await expect(convertNo(db, { userId: alice.id, wheelId: wheel.id, wedgeIds: [ws[0]!.id], shares: 1 })).rejects.toMatchObject({
      code: "INVALID",
    });
  });
});

describe("editing live wheels", () => {
  it("edits details, renames (even swaps) outcomes, and moves the close time", async () => {
    const monger = await makeUser(db, "monger", { isCheesemonger: true });
    const { wheel, wedges: ws } = await makeWheel(db, monger.id, ["A", "B"], new Date(Date.now() + 86_400_000));
    await setWheelLiquidity(db, { wheelId: wheel.id, actorId: monger.id, liquidity: 100 });
    const w = await updateWheel(db, {
      wheelId: wheel.id,
      editorId: monger.id,
      fields: {
        title: "New title",
        resolutionCriteria: "New rules",
        closesAt: null,
        allowAdditions: true,
        labels: { [ws[0]!.id]: "B", [ws[1]!.id]: "A" },
      },
    });
    expect(w).toMatchObject({ title: "New title", closesAt: null, allowAdditions: true });
    const labels = await db.select().from(wedges).where(eq(wedges.wheelId, wheel.id)).orderBy(asc(wedges.sortOrder));
    expect(labels.map((x) => x.label)).toEqual(["B", "A"]);
    await expect(
      updateWheel(db, { wheelId: wheel.id, editorId: monger.id, fields: { title: "x", resolutionCriteria: "y", labels: { [ws[0]!.id]: "a" } } }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });
});
