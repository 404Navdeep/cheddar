/**
 * Demo data for the LOCAL PGlite database (.data/pglite), so the UI has something to show.
 * Refuses to run against DATABASE_URL. Stop the dev server first (PGlite allows one process).
 *
 *   bun run seed:demo             first run: demo users + wheels
 *   bun run seed:demo --refresh   retire old demo wheels (Moldy, only if no real user is in them)
 *                              and create a fresh set with two weeks of realistic history
 *
 * Everything goes through the real exchange, so the ledger audit stays clean.
 */
import path from "node:path";
import {
  and,
  churnSyncs,
  createPgliteDb,
  eq,
  inArray,
  like,
  orders,
  positions,
  sql,
  users,
  wheels,
  type AnyDb,
} from "@cheddar/db";
import {
  Exchange,
  approveProposal,
  approveSettlement,
  audit,
  ledger,
  proposeSettlement,
  submitProposal,
} from "@cheddar/exchange";

if (process.env.DATABASE_URL) {
  console.error("seed-demo only touches the local PGlite database; unset DATABASE_URL.");
  process.exit(1);
}
const refresh = process.argv.includes("--refresh");

const root = path.resolve(import.meta.dirname, "..");
const { db: raw, client } = await createPgliteDb(path.join(root, ".data", "pglite"), {
  migrationsFolder: path.join(root, "packages", "db", "drizzle"),
});
const db = raw as unknown as AnyDb;
const self = { allowSelfReview: true };

let seed = 20261113;
const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;

async function fund(userId: string, latta: number) {
  await db.transaction(async (tx) => {
    const a = await ledger.userAccounts(tx, userId);
    const issuance = await ledger.churnIssuanceAccount(tx);
    const ticks = latta * 100;
    const entryId = await ledger.postEntry(
      tx,
      { kind: "churn", userId, memo: "demo seed" },
      new ledger.Deltas().add(issuance, -ticks).add(a.available, ticks),
    );
    await tx.insert(churnSyncs).values({ userId, status: "credited", creditedTicks: ticks, journalEntryId: entryId });
  });
}

async function demoUser(name: string, latta: number, extra: Partial<typeof users.$inferInsert> = {}) {
  const sub = `demo!${name}`;
  const [found] = await db.select().from(users).where(eq(users.hcaSub, sub));
  const u = found ?? (await db.insert(users).values({ hcaSub: sub, name, ...extra }).returning())[0]!;
  await fund(u.id, latta);
  return u;
}

const hasDemo = (await db.select({ id: users.id }).from(users).where(like(users.hcaSub, "demo!%"))).length > 0;
if (hasDemo && !refresh) {
  console.log("Demo data already present. Use --refresh for a new set.");
  await client.close();
  process.exit(0);
}

const monger = await demoUser("Orpheus", 2_000, { isCheesemonger: true });
const monger2 = await demoUser("Bean", 500, { isCheesemonger: true });
const traders = await Promise.all(
  ["Heidi", "Zach", "Pixel", "Byte", "Nova", "Sprig", "Kai", "Juniper"].map((n, i) => demoUser(n, 6_000 + i * 700)),
);
const demoIds = new Set([monger.id, monger2.id, ...traders.map((t) => t.id)]);

// ---------- retire old demo wheels ----------
if (refresh) {
  const old = await db
    .select()
    .from(wheels)
    .where(and(eq(wheels.creatorId, monger.id), inArray(wheels.status, ["open", "closed"])));
  for (const w of old) {
    const touched = (await db.execute(sql`
      SELECT DISTINCT user_id FROM (
        SELECT p.user_id FROM positions p JOIN wedges x ON x.id = p.wedge_id WHERE x.wheel_id = ${w.id} AND (p.yes_shares > 0 OR p.no_shares > 0)
        UNION SELECT o.user_id FROM orders o JOIN wedges x ON x.id = o.wedge_id WHERE x.wheel_id = ${w.id} AND o.status = 'open'
      ) t`)) as unknown as { rows: { user_id: string }[] };
    const outsiders = touched.rows.filter((r) => !demoIds.has(r.user_id));
    if (outsiders.length) {
      console.log(`Keeping "${w.title}": ${outsiders.length} real user(s) hold a position or order.`);
      continue;
    }
    const s = await proposeSettlement(db, { wheelId: w.id, proposerId: monger.id, outcome: "moldy", evidence: "Retired demo wheel." });
    await approveSettlement(db, { settlementId: s.id, reviewerId: monger2.id });
    console.log(`Retired "${w.title}" (Moldy).`);
  }
}

// ---------- new wheels ----------
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const specs: { title: string; category: string; outcomes: string[]; close: number; start?: number[] }[] = [
  { title: "Top Hackatime coder this week?", category: "Hackatime", outcomes: ["Heidi", "Zach", "Pixel", "Nova", "Someone else"], close: 4, start: [34, 24, 18, 12, 12] },
  { title: "Most-coded language on Hackatime this month?", category: "Hackatime", outcomes: ["TypeScript", "Python", "Rust", "Go", "Other"], close: 18, start: [44, 28, 12, 6, 10] },
  { title: "Will the next Hack Club hackathon sell out in a week?", category: "Events", outcomes: ["Yes"], close: 25, start: [41] },
  { title: "Will #ship get 1,000 posts in December?", category: "Slack", outcomes: ["Yes"], close: 48, start: [63] },
  { title: "Will a new YSWS program launch this week?", category: "YSWS", outcomes: ["Yes"], close: 6, start: [72] },
  { title: "Which YSWS gets the most ships this month?", category: "YSWS", outcomes: ["Sprig", "Onboard", "Cascade", "Other"], close: 17, start: [38, 27, 20, 15] },
  { title: "Will the Hack Club Slack pass 100k members this year?", category: "Slack", outcomes: ["Yes"], close: 48, start: [22] },
  { title: "Will Orpheus get a new plushie design this year?", category: "Fun", outcomes: ["Yes"], close: 48, start: [55] },
];

const ex = new Exchange(db);
const created: string[] = [];
const STEPS = 36;

for (const s of specs) {
  const p = await submitProposal(db, {
    proposerId: monger.id,
    title: s.title,
    category: s.category,
    resolutionCriteria:
      "Resolves using the official public numbers at the close time, as checked by a Cheesemonger. This is a demo wheel.",
    closesAt: days(s.close),
    outcomes: s.outcomes,
  });
  const { wheel, wedges } = await approveProposal(db, { proposalId: p.id, reviewerId: monger.id }, self);
  created.push(wheel.id);

  // Fair prices: a random walk on log-odds; multi-outcome wheels renormalise so they sum to ~100.
  let logits = (s.start ?? s.outcomes.map(() => 100 / s.outcomes.length)).map((v) => Math.log(v / (100 - v)));
  for (let step = 0; step < STEPS; step++) {
    logits = logits.map((l) => l + (rand() - 0.5) * 0.35);
    let probs = logits.map((l) => 100 / (1 + Math.exp(-l)));
    if (wedges.length > 1) {
      const total = probs.reduce((a, b) => a + b, 0);
      probs = probs.map((x) => (x * 100) / total);
    }
    for (let i = 0; i < wedges.length; i++) {
      const w = wedges[i]!;
      const fair = Math.max(2, Math.min(98, Math.round(probs[i]!)));
      const a = pick(traders);
      let b = pick(traders);
      if (b.id === a.id) b = traders[(traders.indexOf(a) + 3) % traders.length]!;
      const qty = 2 + Math.floor(rand() * 18);
      // Mostly new pairs (MINT); sometimes a holder sells YES to a buyer (TRANSFER).
      const [pos] = await db.select().from(positions).where(and(eq(positions.userId, a.id), eq(positions.wedgeId, w.id)));
      if (pos && pos.yesShares - pos.yesLocked >= qty && rand() < 0.3) {
        await ex.placeOrder({ userId: a.id, wedgeId: w.id, outcome: "YES", side: "SELL", price: fair, qty }).catch(() => {});
        await ex.placeOrder({ userId: b.id, wedgeId: w.id, outcome: "YES", side: "BUY", price: fair, qty }).catch(() => {});
      } else {
        await ex.placeOrder({ userId: a.id, wedgeId: w.id, outcome: "YES", side: "BUY", price: fair, qty }).catch(() => {});
        await ex.placeOrder({ userId: b.id, wedgeId: w.id, outcome: "NO", side: "BUY", price: 100 - fair, qty }).catch(() => {});
      }
      if (step === STEPS - 1) {
        // A resting book around the final price.
        for (let k = 1; k <= 3; k++) {
          await ex
            .placeOrder({ userId: traders[k]!.id, wedgeId: w.id, outcome: "YES", side: "BUY", price: Math.max(1, fair - k), qty: 6 * k })
            .catch(() => {});
          await ex
            .placeOrder({ userId: traders[k + 3]!.id, wedgeId: w.id, outcome: "NO", side: "BUY", price: Math.max(1, 100 - fair - k), qty: 5 * k })
            .catch(() => {});
        }
      }
    }
  }
}

// Spread the new wheels' history over the last two weeks (trades and wheels aren't append-only;
// the ledger is, and its timestamps are left alone).
await db.execute(sql`
  UPDATE wheels SET created_at = now() - interval '14 days' WHERE id IN (${sql.join(created.map((id) => sql`${id}`), sql`, `)})`);
await db.execute(sql`
  WITH ranked AS (
    SELECT t.id, row_number() OVER (PARTITION BY t.wedge_id ORDER BY t.id) AS n, count(*) OVER (PARTITION BY t.wedge_id) AS total
    FROM trades t JOIN wedges w ON w.id = t.wedge_id
    WHERE w.wheel_id IN (${sql.join(created.map((id) => sql`${id}`), sql`, `)})
  )
  UPDATE trades SET created_at = now() - interval '14 days' + (interval '14 days' - interval '20 minutes') * (ranked.n::float / ranked.total)
  FROM ranked WHERE trades.id = ranked.id`);

const openDemoOrders = await db.select({ n: sql<number>`COUNT(*)::int` }).from(orders).where(eq(orders.status, "open"));
const problems = await audit(db);
console.log(`Created ${created.length} demo wheels; ${openDemoOrders[0]?.n ?? 0} open orders on the books.`);
console.log(problems.length ? problems : "Audit clean.");
await client.close();
