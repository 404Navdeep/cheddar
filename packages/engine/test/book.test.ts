import { describe, expect, it } from "bun:test";
import { OrderBook, type OrderInput } from "../src/index";

let n = 0;
const o = (p: Partial<OrderInput> & Pick<OrderInput, "userId" | "outcome" | "side" | "price" | "qty">): OrderInput => ({
  id: `o${++n}`,
  ...p,
});

describe("OrderBook", () => {
  it("rests a non-crossing order and reports depth", () => {
    const b = new OrderBook();
    const r = b.place(o({ userId: "a", outcome: "YES", side: "BUY", price: 40, qty: 10 }));
    expect(r.trades).toHaveLength(0);
    expect(r.resting?.remaining).toBe(10);
    expect(b.depth().bids).toEqual([[40, 10]]);
    expect(b.bestBid()).toBe(40);
  });

  it("transfers YES at the resting price (maker price improvement for taker)", () => {
    const b = new OrderBook();
    b.place(o({ userId: "seller", outcome: "YES", side: "SELL", price: 55, qty: 10 }));
    const r = b.place(o({ userId: "buyer", outcome: "YES", side: "BUY", price: 60, qty: 4 }));
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t.kind).toBe("TRANSFER_YES");
    expect(t.yesPrice).toBe(55);
    expect(t.qty).toBe(4);
    expect(t.legs[0]).toMatchObject({ userId: "buyer", shares: 4, cash: -220 });
    expect(t.legs[1]).toMatchObject({ userId: "seller", shares: -4, cash: 220 });
    expect(b.depth().asks).toEqual([[55, 6]]);
  });

  it("mints a pair when BUY YES meets BUY NO (prices sum to >= 100)", () => {
    const b = new OrderBook();
    b.place(o({ userId: "yes", outcome: "YES", side: "BUY", price: 60, qty: 5 }));
    const r = b.place(o({ userId: "no", outcome: "NO", side: "BUY", price: 40, qty: 5 }));
    const t = r.trades[0]!;
    expect(t.kind).toBe("MINT");
    expect(t.yesPrice).toBe(60);
    // Collateral in = 100 per pair, exactly what the ledger must lock.
    const cashIn = t.legs.reduce((s, l) => s - l.cash, 0);
    expect(cashIn).toBe(100 * 5);
    expect(t.legs.find((l) => l.userId === "yes")).toMatchObject({ outcome: "YES", shares: 5 });
    expect(t.legs.find((l) => l.userId === "no")).toMatchObject({ outcome: "NO", shares: 5, cash: -200 });
  });

  it("does not match BUY YES 60 with BUY NO 30 (prices sum to 90)", () => {
    const b = new OrderBook();
    b.place(o({ userId: "yes", outcome: "YES", side: "BUY", price: 60, qty: 5 }));
    const r = b.place(o({ userId: "no", outcome: "NO", side: "BUY", price: 30, qty: 5 }));
    expect(r.trades).toHaveLength(0);
    expect(b.bestBid()).toBe(60);
    expect(b.bestAsk()).toBe(70);
  });

  it("burns a pair when SELL NO meets SELL YES and pays out 100 total", () => {
    const b = new OrderBook();
    b.place(o({ userId: "yesHolder", outcome: "YES", side: "SELL", price: 45, qty: 3 }));
    const r = b.place(o({ userId: "noHolder", outcome: "NO", side: "SELL", price: 55, qty: 3 }));
    const t = r.trades[0]!;
    expect(t.kind).toBe("BURN");
    expect(t.legs.reduce((s, l) => s + l.cash, 0)).toBe(100 * 3);
    expect(t.legs.reduce((s, l) => s + l.shares, 0)).toBe(-6);
  });

  it("transfers NO between a NO seller and a NO buyer", () => {
    const b = new OrderBook();
    b.place(o({ userId: "noSeller", outcome: "NO", side: "SELL", price: 30, qty: 2 }));
    const r = b.place(o({ userId: "noBuyer", outcome: "NO", side: "BUY", price: 35, qty: 2 }));
    const t = r.trades[0]!;
    expect(t.kind).toBe("TRANSFER_NO");
    expect(t.yesPrice).toBe(70); // maker's NO price 30 -> YES price 70
    expect(t.legs.find((l) => l.userId === "noBuyer")).toMatchObject({ outcome: "NO", shares: 2, cash: -60 });
    expect(t.legs.find((l) => l.userId === "noSeller")).toMatchObject({ outcome: "NO", shares: -2, cash: 60 });
  });

  it("respects price-time priority", () => {
    const b = new OrderBook();
    const first = o({ userId: "a", outcome: "YES", side: "SELL", price: 50, qty: 5 });
    const second = o({ userId: "b", outcome: "YES", side: "SELL", price: 50, qty: 5 });
    const better = o({ userId: "c", outcome: "YES", side: "SELL", price: 48, qty: 2 });
    b.place(first);
    b.place(second);
    b.place(better);
    const r = b.place(o({ userId: "z", outcome: "YES", side: "BUY", price: 50, qty: 8 }));
    expect(r.trades.map((t) => [t.makerOrderId, t.qty])).toEqual([
      [better.id, 2],
      [first.id, 5],
      [second.id, 1],
    ]);
  });

  it("IOC leftovers are reported as unfilled and never rest", () => {
    const b = new OrderBook();
    b.place(o({ userId: "a", outcome: "YES", side: "SELL", price: 50, qty: 3 }));
    const r = b.place(o({ userId: "z", outcome: "YES", side: "BUY", price: 99, qty: 10, tif: "IOC" }));
    expect(r.trades[0]!.qty).toBe(3);
    expect(r.unfilled).toBe(7);
    expect(r.resting).toBeUndefined();
    expect(b.bestBid()).toBeUndefined();
  });

  it("cancels the resting order on self-trade", () => {
    const b = new OrderBook();
    const mine = o({ userId: "me", outcome: "YES", side: "SELL", price: 50, qty: 5 });
    b.place(mine);
    const r = b.place(o({ userId: "me", outcome: "YES", side: "BUY", price: 50, qty: 5 }));
    expect(r.trades).toHaveLength(0);
    expect(r.cancelled.map((c) => c.id)).toEqual([mine.id]);
    expect(b.bestAsk()).toBeUndefined();
    expect(b.bestBid()).toBe(50);
  });

  it("cancel removes an order and unknown ids are a no-op", () => {
    const b = new OrderBook();
    const x = o({ userId: "a", outcome: "YES", side: "BUY", price: 20, qty: 1 });
    b.place(x);
    expect(b.cancel(x.id)?.id).toBe(x.id);
    expect(b.cancel(x.id)).toBeUndefined();
    expect(b.bestBid()).toBeUndefined();
  });

  it("rejects bad input", () => {
    const b = new OrderBook();
    expect(() => b.place(o({ userId: "a", outcome: "YES", side: "BUY", price: 0, qty: 1 }))).toThrow();
    expect(() => b.place(o({ userId: "a", outcome: "YES", side: "BUY", price: 100, qty: 1 }))).toThrow();
    expect(() => b.place(o({ userId: "a", outcome: "YES", side: "BUY", price: 50, qty: 0 }))).toThrow();
    expect(() => b.place(o({ userId: "a", outcome: "YES", side: "BUY", price: 50.5, qty: 1 }))).toThrow();
  });

  it("conserves value: cash legs always net to 0 or +/-100 per minted/burned pair", () => {
    const b = new OrderBook();
    const kinds = ["YES", "NO"] as const;
    const sides = ["BUY", "SELL"] as const;
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let i = 0; i < 500; i++) {
      const r = b.place({
        id: `r${i}`,
        userId: `u${Math.floor(rnd() * 8)}`,
        outcome: kinds[Math.floor(rnd() * 2)]!,
        side: sides[Math.floor(rnd() * 2)]!,
        price: 1 + Math.floor(rnd() * 99),
        qty: 1 + Math.floor(rnd() * 5),
      });
      for (const t of r.trades) {
        const cash = t.legs.reduce((s, l) => s + l.cash, 0);
        const shares = t.legs.reduce((s, l) => s + l.shares, 0);
        if (t.kind === "MINT") {
          expect(cash).toBe(-100 * t.qty);
          expect(shares).toBe(2 * t.qty);
        } else if (t.kind === "BURN") {
          expect(cash).toBe(100 * t.qty);
          expect(shares).toBe(-2 * t.qty);
        } else {
          expect(cash).toBe(0);
          expect(shares).toBe(0);
        }
      }
      const bid = b.bestBid();
      const ask = b.bestAsk();
      if (bid !== undefined && ask !== undefined) expect(bid).toBeLessThan(ask); // never crossed
    }
  });
});
