import { describe, expect, it } from "vitest";
import { dedupeCalls, priceCall, rankCallers, type CallPoint } from "@/lib/social/leaderboard";

const call = (over: Partial<CallPoint>): CallPoint => ({
  handle: "alpha",
  name: "Alpha",
  followers: 1000,
  token: "MintA",
  symbol: "AAA",
  at: 1_000,
  entry: 1,
  now: 2,
  peak: 3,
  ...over,
});

describe("caller leaderboard", () => {
  it("keeps the earliest post when someone calls the same token twice", () => {
    const rows = dedupeCalls([call({ at: 500, entry: 1 }), call({ at: 100, entry: 0.4 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].at).toBe(100);
  });

  it("ranks a caller who hits 2x ahead of one who does not", () => {
    const ranks = rankCallers([
      call({ handle: "hot", token: "A", symbol: "A", entry: 1, peak: 4 }),
      call({ handle: "hot", token: "B", symbol: "B", entry: 1, peak: 3 }),
      call({ handle: "cold", token: "C", symbol: "C", entry: 1, peak: 1.1 }),
      call({ handle: "cold", token: "D", symbol: "D", entry: 1, peak: 0.8 }),
      call({ handle: "cold", token: "E", symbol: "E", entry: 1, peak: 1.2 }),
    ]);
    expect(ranks.map((r) => r.handle)).toEqual(["hot", "cold"]);
    expect(ranks[0].hit2x).toBe(1);
    expect(ranks[0].best).toMatchObject({ symbol: "A", multiple: 4 });
    expect(ranks[0].medianX).toBe(3.5);
    expect(ranks[1].hit2x).toBe(0);
  });

  it("leaves a one-call account below anyone with two", () => {
    const ranks = rankCallers([
      call({ handle: "once", token: "A", entry: 1, peak: 20 }),
      call({ handle: "steady", token: "B", entry: 1, peak: 2 }),
      call({ handle: "steady", token: "C", entry: 1, peak: 2 }),
    ]);
    expect(ranks.map((r) => r.handle)).toEqual(["steady", "once"]);
  });

  it("prices a call from the candle at that minute and the high after it", () => {
    const candles = [
      { time: 1000, open: 1, high: 1.2, close: 1.1 },
      { time: 1300, open: 1.1, high: 4, close: 3 },
      { time: 1600, open: 3, high: 3.2, close: 2 },
    ];
    expect(priceCall(candles, 1200, 2.5)).toEqual({ entry: 1.1, now: 2.5, peak: 4 });
    expect(priceCall(candles, 100, 2.5)).toEqual({ entry: 1, now: 2.5, peak: 4 });
    expect(priceCall(candles, 1000 - 86_400, 2.5)).toBeNull();
  });
});
