/**
 * Cheddar database schema.
 *
 * Money: every amount is an integer number of ticks (1 Latta = 100 ticks),
 * stored as Postgres BIGINT. Never floats.
 *
 * Ledger model (double entry):
 *   - `accounts`       one row per balance holder (user available, user locked,
 *                      per-wedge collateral, and the single churn issuance account).
 *   - `journal_entries` one row per business event (append-only).
 *   - `ledger_lines`   signed amounts against accounts (append-only). The lines of
 *                      each entry must sum to 0 (enforced at COMMIT by trigger).
 *   - `accounts.balance` is a cache maintained only by an insert trigger on
 *                      ledger_lines; the lines are the source of truth.
 *
 * Because everything sums to zero, total Latta held by users + collateral always
 * equals -(churn_issuance.balance): Latta only enters the system through Churn.
 *
 * Shares are not money and live in `positions`; `trades` / `trade_legs` are the
 * audit trail for share movements.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const money = (name: string) => bigint(name, { mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------- enums ----------

export const outcomeEnum = pgEnum("outcome", ["YES", "NO"]);
export const sideEnum = pgEnum("side", ["BUY", "SELL"]);
export const tifEnum = pgEnum("time_in_force", ["GTC", "IOC"]);
export const orderStatusEnum = pgEnum("order_status", ["open", "filled", "cancelled"]);
export const tradeKindEnum = pgEnum("trade_kind", ["TRANSFER_YES", "TRANSFER_NO", "MINT", "BURN"]);
export const accountKindEnum = pgEnum("account_kind", [
  "user_available",
  "user_locked",
  "wedge_collateral",
  "churn_issuance",
  /** Where The Mouse's house-backed Latta comes from once its own funds run out. Goes negative. */
  "house_issuance",
  /** Where referral rewards come from. Goes negative, like churn_issuance. */
  "referral_issuance",
  /** Where Latta granted by super admins comes from. Goes negative, like churn_issuance. */
  "grant_issuance",
]);
export const journalKindEnum = pgEnum("journal_kind", [
  "churn",
  "order_lock",
  "order_release",
  "trade",
  "payout",
  "moldy_refund",
  "mouse_sweep",
  /** House Latta lent to The Mouse when its own cash isn't enough to quote. */
  "house_backing",
  /** The Mouse paying house Latta back from spare cash. */
  "house_repay",
  /** Linked-outcome conversions and merges (pairs, full sets, No into Yes-on-the-rest). */
  "conversion",
  /** A referral reward paid to the person who invited someone and to the person they invited. */
  "referral",
  /** Latta a super admin granted to someone from the house. */
  "grant",
]);
export const wheelStatusEnum = pgEnum("wheel_status", ["open", "closed", "ripening", "resolved", "moldy"]);
export const wedgeStatusEnum = pgEnum("wedge_status", [
  "open",
  "halted",
  "resolved_yes",
  "resolved_no",
  "moldy",
]);export const reviewStatusEnum = pgEnum("review_status", ["pending", "approved", "rejected", "withdrawn"]);
/** wedge_wins: the named wedge resolves YES and every other wedge NO.
 *  all_no:     every wedge resolves NO (only valid for single-wedge / binary wheels).
 *  moldy:      the wheel is voided. */
export const settlementOutcomeEnum = pgEnum("settlement_outcome", ["wedge_wins", "all_no", "all_yes", "moldy", "date", "multi_yes"]);
export const churnStatusEnum = pgEnum("churn_status", ["credited", "no_change", "skipped_untrusted", "error"]);
export const oauthProviderEnum = pgEnum("oauth_provider", ["hca", "hackatime"]);

// ---------- people ----------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Hack Club Auth subject, e.g. "ident!abc123". Null for bots and unclaimed funder placeholders. */
    hcaSub: text("hca_sub").unique(),
    slackId: text("slack_id").unique(),
    name: text("name"),
    email: text("email"),
    verificationStatus: text("verification_status"),
    isCheesemonger: boolean("is_cheesemonger").notNull().default(false),
    /** Super admins run users, Mouse funders, logs and health. They're always Cheesemongers too. */
    isSuperAdmin: boolean("is_super_admin").notNull().default(false),
    isBot: boolean("is_bot").notNull().default(false),
    /** Identifies singleton bots, e.g. "mouse". */
    botRole: text("bot_role").unique(),
    hackatimeUserId: text("hackatime_user_id").unique(),
    hackatimeUsername: text("hackatime_username"),
    hackatimeLinkedAt: ts("hackatime_linked_at"),
    /** Set by a Cheesemonger: suspended users can look but not trade, propose or settle. */
    suspendedAt: ts("suspended_at"),
    suspendReason: text("suspend_reason"),
    /** When they ticked the fair-play rules (no insider trading etc). Null until they do. */
    fairPlayAcceptedAt: ts("fair_play_accepted_at"),
    /** When they finished or skipped the "How it works" tour. Null until they do. */
    tourSeenAt: ts("tour_seen_at"),
    /** When they ticked "I understand how the markets work". Null if they skipped. */
    tourConfirmedAt: ts("tour_confirmed_at"),
    /** Short code in this person's invite link (/r/<code>). Created the first time they need it. */
    referralCode: text("referral_code").unique(),
    /** Who invited them, set when they sign up through an invite link. */
    referredById: uuid("referred_by_id").references((): AnyPgColumn => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Humans sign in with HCA. The exception: Mouse funders added by Slack ID before they
    // ever sign up get a placeholder (hca_sub NULL), claimed by Slack ID on first login.
    // Display names are unique, ignoring case. NULL names (placeholders) don't collide.
    uniqueIndex("users_name_lower_uq").on(sql`lower(${t.name})`),
    check("users_identified", sql`${t.isBot} OR ${t.hcaSub} IS NOT NULL OR ${t.slackId} IS NOT NULL`),
    check("users_bot_role_only_for_bots", sql`${t.botRole} IS NULL OR ${t.isBot}`),
  ],
);

/**
 * HC staff / adults (19+) whose Churn funds The Mouse instead of themselves.
 * Added manually by Cheesemongers by Slack ID. Funders can view but never trade.
 */
export const mouseFunders = pgTable("mouse_funders", {
  slackId: text("slack_id").primaryKey(),
  addedById: uuid("added_by_id")
    .notNull()
    .references(() => users.id),
  active: boolean("active").notNull().default(true),
  note: text("note"),
  addedAt: ts("added_at").notNull().defaultNow(),
});

/** Login sessions. Only a SHA-256 hash of the cookie value is stored. */
export const sessions = pgTable(
  "sessions",
  {
    idHash: text("id_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** OAuth tokens, encrypted by the app before storage (never plaintext in the DB). */
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: oauthProviderEnum("provider").notNull(),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    expiresAt: ts("expires_at"),
    scope: text("scope"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.provider] })],
);

// ---------- markets ----------

/** The categories a wheel can be filed under. Super admins add and remove them; "Hack Club" is the fallback and can't be removed. */
export const categories = pgTable("categories", {
  name: text("name").primaryKey(),
  /** "img:<file>", "svg:<name>" or a small data:image URL. Null: the built-in glyph for the category. */
  icon: text("icon"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposerId: uuid("proposer_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    category: text("category"),
    resolutionCriteria: text("resolution_criteria").notNull(),
    /** Optional. Wheels normally stay open until someone asks to close them or a Cheesemonger does. */
    closesAt: ts("closes_at"),
    /** "svg:<name>" for a built-in icon, or a small data:image/... URL the proposer uploaded. */
    icon: text("icon"),
    /** Wedge labels. One label = a binary Yes/No wheel. */
    outcomes: jsonb("outcomes").$type<string[]>().notNull(),
    /** For date markets: the datetime for each outcome, parallel to outcomes. Null for non-date markets. */
    dateValues: jsonb("date_values").$type<string[] | null>(),
    /** Multi-outcome only: people may suggest new outcomes after launch, for a Cheesemonger to add. */
    allowAdditions: boolean("allow_additions").notNull().default(false),
    status: reviewStatusEnum("status").notNull().default("pending"),
    reviewerId: uuid("reviewer_id").references(() => users.id),
    reviewNote: text("review_note"),
    reviewedAt: ts("reviewed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("proposals_has_outcomes", sql`jsonb_array_length(${t.outcomes}) >= 1`),
    index("proposals_status_idx").on(t.status, t.createdAt),
  ],
);

export const wheels = pgTable(
  "wheels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    category: text("category"),
    resolutionCriteria: text("resolution_criteria").notNull(),
    /** Optional hard stop for trading. Null: open until a close request is approved or a Cheesemonger acts. */
    closesAt: ts("closes_at"),
    /** "svg:<name>" for a built-in icon, or a small data:image/... URL. Null: the category's icon. */
    icon: text("icon"),
    status: wheelStatusEnum("status").notNull().default("open"),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => users.id),
    proposalId: uuid("proposal_id")
      .unique()
      .references(() => proposals.id),
    resolvedAt: ts("resolved_at"),
    /** Moderation pause, independent of settlement: no new orders while set. */
    tradingPausedAt: ts("trading_paused_at"),
    pauseReason: text("pause_reason"),
    /**
     * The Mouse's LMSR liquidity parameter, in shares (0 = no market maker). Bigger is deeper:
     * near 50% it quotes about liquidity/25 shares per cent, and its worst-case loss is
     * about liquidity * ln(outcomes) ticks / 100 Latta.
     */
    liquidity: integer("liquidity").notNull().default(0),
    /** LMSR anchor per outcome (wedge id, or "YES"/"NO" for binary wheels); see exchange/mouse.ts. */
    mmAnchor: jsonb("mm_anchor").$type<Record<string, number>>(),
    /** Multi-outcome only: people may suggest new outcomes, which a Cheesemonger can add. */
    allowAdditions: boolean("allow_additions").notNull().default(false),
    /** Market type: 'standard' (binary/multi-choice) or 'date' (date-based options). */
    marketType: text("market_type").notNull().default("standard"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("wheels_status_idx").on(t.status, t.closesAt),
    check("wheels_liquidity_range", sql`${t.liquidity} BETWEEN 0 AND 1000000`),
    check("wheels_market_type_range", sql`${t.marketType} IN ('standard', 'date')`),
  ],
);

export const wedges = pgTable(
  "wedges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wheelId: uuid("wheel_id")
      .notNull()
      .references(() => wheels.id),
    label: text("label").notNull(),
    /** For date markets: the date/time this option represents. */
    dateValue: ts("date_value"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: wedgeStatusEnum("status").notNull().default("open"),
    /** Last traded YES price in ticks, for cards and charts. */
    lastYesPrice: smallint("last_yes_price"),
    /** Bumped on every book change; lets an engine detect a stale in-memory book. */
    bookVersion: bigint("book_version", { mode: "number" }).notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("wedges_wheel_label_uq").on(t.wheelId, t.label),
    check("wedges_last_price_range", sql`${t.lastYesPrice} IS NULL OR ${t.lastYesPrice} BETWEEN 1 AND 99`),
  ],
);

/** Someone asking for a new outcome on a live multi-outcome wheel (see wheels.allowAdditions). */
export const outcomeRequests = pgTable(
  "outcome_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wheelId: uuid("wheel_id")
      .notNull()
      .references(() => wheels.id),
    proposerId: uuid("proposer_id")
      .notNull()
      .references(() => users.id),
    label: text("label").notNull(),
    /** Why it should be added (for Cheesemongers). */
    note: text("note").notNull().default(""),
    status: reviewStatusEnum("status").notNull().default("pending"),
    reviewerId: uuid("reviewer_id").references(() => users.id),
    reviewNote: text("review_note"),
    reviewedAt: ts("reviewed_at"),
    /** The wedge it became, once approved. */
    wedgeId: uuid("wedge_id").references(() => wedges.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("outcome_requests_status_idx").on(t.status, t.createdAt),
    index("outcome_requests_wheel_idx").on(t.wheelId),
  ],
);

export const settlements = pgTable(
  "settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wheelId: uuid("wheel_id")
      .notNull()
      .references(() => wheels.id),
    proposerId: uuid("proposer_id")
      .notNull()
      .references(() => users.id),
    outcome: settlementOutcomeEnum("outcome").notNull(),
    winningWedgeId: uuid("winning_wedge_id").references(() => wedges.id),
    /** The close request's reasoning, for Cheesemongers only. */
    evidence: text("evidence").notNull(),
    /** For date markets: the event date that determines resolution. */
    eventDate: ts("event_date"),
    /** For multi-winner markets: array of winning wedge ids. */
    winningWedgeIds: jsonb("winning_wedge_ids").$type<string[] | null>(),
    status: reviewStatusEnum("status").notNull().default("pending"),
    reviewerId: uuid("reviewer_id").references(() => users.id),
    /** Private note from the reviewing Cheesemonger. */
    reviewNote: text("review_note"),
    /** Public proof of the result, written by the approving Cheesemonger and shown on the wheel. */
    proof: text("proof"),
    reviewedAt: ts("reviewed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "settlements_winner_iff_wedge_wins",
      sql`(${t.outcome} = 'wedge_wins') = (${t.winningWedgeId} IS NOT NULL)`,
    ),
    // At most one pending and one approved settlement per wheel.
    uniqueIndex("settlements_one_pending_uq").on(t.wheelId).where(sql`${t.status} = 'pending'`),
    uniqueIndex("settlements_one_approved_uq").on(t.wheelId).where(sql`${t.status} = 'approved'`),
  ],
);

// ---------- ledger ----------

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: accountKindEnum("kind").notNull(),
    userId: uuid("user_id").references(() => users.id),
    wedgeId: uuid("wedge_id").references(() => wedges.id),
    /** Cache of SUM(ledger_lines.amount); written only by the ledger trigger. */
    balance: money("balance").notNull().default(0),
  },
  (t) => [
    unique("accounts_owner_uq").on(t.kind, t.userId, t.wedgeId).nullsNotDistinct(),
    check(
      "accounts_owner_shape",
      sql`CASE ${t.kind}::text
            WHEN 'user_available' THEN ${t.userId} IS NOT NULL AND ${t.wedgeId} IS NULL
            WHEN 'user_locked' THEN ${t.userId} IS NOT NULL AND ${t.wedgeId} IS NULL
            WHEN 'wedge_collateral' THEN ${t.wedgeId} IS NOT NULL AND ${t.userId} IS NULL
            WHEN 'churn_issuance' THEN ${t.userId} IS NULL AND ${t.wedgeId} IS NULL
            WHEN 'house_issuance' THEN ${t.userId} IS NULL AND ${t.wedgeId} IS NULL
            WHEN 'referral_issuance' THEN ${t.userId} IS NULL AND ${t.wedgeId} IS NULL
            WHEN 'grant_issuance' THEN ${t.userId} IS NULL AND ${t.wedgeId} IS NULL
          END`,
    ),
    // Only the issuance accounts may go negative; this is the double-spend backstop.
    // (Compared as text so the migration that adds 'house_issuance' can create it in one transaction.)
    check("accounts_non_negative", sql`${t.kind}::text IN ('churn_issuance', 'house_issuance', 'referral_issuance', 'grant_issuance') OR ${t.balance} >= 0`),
  ],
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: journalKindEnum("kind").notNull(),
    /** Makes retries safe, e.g. "churn:<userId>:<targetTicks>". */
    idempotencyKey: text("idempotency_key").unique(),
    userId: uuid("user_id").references(() => users.id),
    wedgeId: uuid("wedge_id").references(() => wedges.id),
    orderId: uuid("order_id").references(() => orders.id),
    memo: text("memo"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("journal_user_idx").on(t.userId, t.createdAt)],
);

export const ledgerLines = pgTable(
  "ledger_lines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    entryId: bigint("entry_id", { mode: "number" })
      .notNull()
      .references(() => journalEntries.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    amount: money("amount").notNull(),
  },
  (t) => [
    check("ledger_lines_nonzero", sql`${t.amount} <> 0`),
    index("ledger_lines_account_idx").on(t.accountId),
    index("ledger_lines_entry_idx").on(t.entryId),
  ],
);

// ---------- trading ----------

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Global arrival order; used for time priority when rebuilding books. */
    seq: bigint("seq", { mode: "number" }).notNull().unique().generatedAlwaysAsIdentity(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    wedgeId: uuid("wedge_id")
      .notNull()
      .references(() => wedges.id),
    outcome: outcomeEnum("outcome").notNull(),
    side: sideEnum("side").notNull(),
    tif: tifEnum("tif").notNull().default("GTC"),
    /** Limit price in the order's own outcome, ticks 1..99. */
    price: smallint("price").notNull(),
    qty: integer("qty").notNull(),
    remaining: integer("remaining").notNull(),
    /** BUY: ticks still escrowed in user_locked for this order. */
    lockedTicks: money("locked_ticks").notNull().default(0),
    /** SELL: shares still reserved in positions for this order. */
    lockedShares: integer("locked_shares").notNull().default(0),
    status: orderStatusEnum("status").notNull().default("open"),
    cancelReason: text("cancel_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
    closedAt: ts("closed_at"),
  },
  (t) => [
    check("orders_price_range", sql`${t.price} BETWEEN 1 AND 99`),
    check("orders_qty_positive", sql`${t.qty} > 0`),
    check("orders_remaining_range", sql`${t.remaining} BETWEEN 0 AND ${t.qty}`),
    check("orders_locks_non_negative", sql`${t.lockedTicks} >= 0 AND ${t.lockedShares} >= 0`),
    check(
      "orders_lock_matches_side",
      sql`(${t.side} = 'BUY' AND ${t.lockedShares} = 0) OR (${t.side} = 'SELL' AND ${t.lockedTicks} = 0)`,
    ),
    index("orders_open_book_idx").on(t.wedgeId, t.seq).where(sql`${t.status} = 'open'`),
    index("orders_user_idx").on(t.userId, t.createdAt),
  ],
);

export const trades = pgTable(
  "trades",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    wedgeId: uuid("wedge_id")
      .notNull()
      .references(() => wedges.id),
    kind: tradeKindEnum("kind").notNull(),
    yesPrice: smallint("yes_price").notNull(),
    qty: integer("qty").notNull(),
    makerOrderId: uuid("maker_order_id")
      .notNull()
      .references(() => orders.id),
    takerOrderId: uuid("taker_order_id")
      .notNull()
      .references(() => orders.id),
    journalEntryId: bigint("journal_entry_id", { mode: "number" })
      .notNull()
      .references(() => journalEntries.id),
    /** Set by a Cheesemonger when reversing this trade (audit trail keeps the original). */
    undoneAt: ts("undone_at"),
    undoneBy: uuid("undone_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("trades_price_range", sql`${t.yesPrice} BETWEEN 1 AND 99`),
    check("trades_qty_positive", sql`${t.qty} > 0`),
    index("trades_wedge_time_idx").on(t.wedgeId, t.createdAt),
  ],
);

export const tradeLegs = pgTable(
  "trade_legs",
  {
    tradeId: bigint("trade_id", { mode: "number" })
      .notNull()
      .references(() => trades.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    outcome: outcomeEnum("outcome").notNull(),
    /** Signed share change of `outcome`. */
    shares: integer("shares").notNull(),
    /** Signed ticks received (+) or paid (-) at the execution price. */
    cash: money("cash").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tradeId, t.orderId] }), index("trade_legs_user_idx").on(t.userId)],
);

export const positions = pgTable(
  "positions",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    wedgeId: uuid("wedge_id")
      .notNull()
      .references(() => wedges.id),
    yesShares: integer("yes_shares").notNull().default(0),
    noShares: integer("no_shares").notNull().default(0),
    /** Shares reserved by resting SELL orders. */
    yesLocked: integer("yes_locked").notNull().default(0),
    noLocked: integer("no_locked").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.wedgeId] }),
    check("positions_non_negative", sql`${t.yesShares} >= 0 AND ${t.noShares} >= 0`),
    check(
      "positions_locked_range",
      sql`${t.yesLocked} BETWEEN 0 AND ${t.yesShares} AND ${t.noLocked} BETWEEN 0 AND ${t.noShares}`,
    ),
    index("positions_wedge_idx").on(t.wedgeId),
  ],
);

// ---------- audit log ----------

/**
 * Who did what, append-only (enforced by trigger). Written in the same transaction
 * as the action it records, so an action and its log entry commit or fail together.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    at: ts("at").notNull().defaultNow(),
    /** Null for system jobs (e.g. scheduled Churn). */
    actorId: uuid("actor_id").references(() => users.id),
    /** Dotted verb, e.g. "proposal.approve", "user.suspend". */
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index("audit_log_at_idx").on(t.at),
    index("audit_log_action_idx").on(t.action, t.at),
    index("audit_log_target_idx").on(t.targetType, t.targetId),
  ],
);

// ---------- grants ----------

/** Latta a super admin gave someone from the house. Every tick in grant_issuance is on a row here (see audit). */
export const grants = pgTable(
  "grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id),
    grantedById: uuid("granted_by_id")
      .notNull()
      .references(() => users.id),
    ticks: money("ticks").notNull(),
    reason: text("reason").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("grants_recipient_idx").on(t.recipientId, t.createdAt), check("grants_positive", sql`${t.ticks} > 0`)],
);

// ---------- referrals ----------

/**
 * One row per invited person. Created (pending) when they sign up through an invite link, paid
 * when they make their first real trade. Rewards come from referral_issuance, so every Latta is
 * accounted for (see audit).
 */
export const referrals = pgTable(
  "referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referrerId: uuid("referrer_id")
      .notNull()
      .references(() => users.id),
    /** Unique: a person can only ever be invited once. */
    refereeId: uuid("referee_id")
      .notNull()
      .unique()
      .references(() => users.id),
    status: text("status").notNull().default("pending"),
    referrerTicks: money("referrer_ticks").notNull().default(0),
    refereeTicks: money("referee_ticks").notNull().default(0),
    /** Why a reward was reduced or skipped, e.g. "referrer at the cap". */
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
    paidAt: ts("paid_at"),
  },
  (t) => [
    check("referrals_status", sql`${t.status} IN ('pending', 'paid', 'void')`),
    check("referrals_not_self", sql`${t.referrerId} <> ${t.refereeId}`),
    index("referrals_referrer_idx").on(t.referrerId, t.status),
  ],
);

// ---------- reports & rate limits ----------

/** Someone flagging a wheel or a user (name) for the Cheesemongers to look at. */
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => users.id),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    reason: text("reason").notNull(),
    /** open -> actioned (the Cheesemonger did something) or dismissed. */
    status: text("status").notNull().default("open"),
    resolverId: uuid("resolver_id").references(() => users.id),
    resolverNote: text("resolver_note"),
    resolvedAt: ts("resolved_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("reports_target_type", sql`${t.targetType} IN ('wheel', 'user')`),
    check("reports_status", sql`${t.status} IN ('open', 'actioned', 'dismissed')`),
    // One open report per person per target; they can report again once it's been handled.
    uniqueIndex("reports_one_open_uq").on(t.reporterId, t.targetType, t.targetId).where(sql`${t.status} = 'open'`),
    index("reports_status_idx").on(t.status, t.createdAt),
  ],
);

/** One row per rate-limited action, so "how many in the last N seconds" is a count. Pruned as it's read. */
export const rateEvents = pgTable(
  "rate_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    key: text("key").notNull(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index("rate_events_user_key_idx").on(t.userId, t.key, t.at)],
);

// ---------- Slack channel sync ----------

/**
 * People the auto-sync job has invited to the Cheddar Slack channel.
 * Presence here is also how the job notices someone later left the channel.
 */
export const slackChannelMembers = pgTable("slack_channel_members", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  addedAt: ts("added_at").notNull().defaultNow(),
});

/** People who were in the channel and left. The sync never re-adds them. */
export const slackChannelLeft = pgTable("slack_channel_left", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  leftAt: ts("left_at").notNull().defaultNow(),
});

// ---------- churn (Hackatime -> Latta) ----------

export const churnSyncs = pgTable(
  "churn_syncs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
    /** Lifetime non-AI coding seconds reported by Hackatime at fetch time. */
    lifetimeNonAiSeconds: bigint("lifetime_non_ai_seconds", { mode: "number" }),
    trustLevel: text("trust_level"),
    /** floor(lifetimeNonAiSeconds * 2500 / 3600): what the user should have earned in total. */
    targetTicks: money("target_ticks"),
    /** Amount credited by this sync (target minus everything credited before). */
    creditedTicks: money("credited_ticks").notNull().default(0),
    status: churnStatusEnum("status").notNull(),
    journalEntryId: bigint("journal_entry_id", { mode: "number" }).references(() => journalEntries.id),
    error: text("error"),
  },
  (t) => [index("churn_syncs_user_idx").on(t.userId, t.fetchedAt)],
);
