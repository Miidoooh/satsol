import { describe, expect, it } from "vitest";
import { matchPicks, STYLE_PRESETS, type Candidate } from "@/lib/agent/strategy";
import { poolSafety } from "@/lib/agent/picks";
import { factsOf, recapDue, recapText, scorecardText, templateCall, TWEET_MAX, validCall, type BotCall } from "@/lib/bot/compose";
import { toChainPool } from "@/lib/radar/chainwide";

const NOW = 1_800_000_000;
const TOKEN = "0x3458e003f6ed93df0f537b8acac6fbe08e41247f" as const;

const launch = (over: Partial<Candidate> = {}): Candidate => ({
  token: TOKEN,
  symbol: "ROO",
  name: "Roo",
  launchedAt: NOW - 20 * 60,
  graduatedAt: NOW - 20 * 60,
  priceUsd: 0.00002,
  mcapUsd: 200_000,
  progressPct: 100,
  vol30mUsd: 80_000,
  net30mUsd: 10_000,
  traders30m: 200,
  url: "https://www.geckoterminal.com/robinhood/pools/0xabc",
  launchpad: "Uniswap V4",
  external: true,
  ...over,
});

const call = (over: Partial<BotCall> = {}): BotCall => ({
  id: "c1",
  token: TOKEN,
  symbol: "ROO",
  at: NOW - 3600,
  entryMcap: 10_000,
  peakMcap: 10_000,
  lastMcap: 10_000,
  stopMcap: 7_000,
  recapped: [],
  stoppedOut: false,
  ...over,
});

describe("chain-wide pools", () => {
  it("reads a GeckoTerminal pool into one launch row", () => {
    const row = toChainPool(
      {
        id: "robinhood_0xpool",
        attributes: {
          address: "0xpool",
          name: "ROO / WETH",
          base_token_price_usd: "0.0001",
          quote_token_price_usd: "2750",
          fdv_usd: "136933",
          reserve_in_usd: "40000",
          pool_created_at: "2026-10-02T18:41:18Z",
          volume_usd: { m30: "9000", h24: "50000" },
          transactions: { m30: { buys: 30, sells: 10, buyers: 25, sellers: 8 } },
        },
        relationships: {
          base_token: { data: { id: `robinhood_${TOKEN}` } },
          quote_token: { data: { id: "robinhood_0x0000000000000000000000000000000000000000" } },
          dex: { data: { id: "bankr-robinhood" } },
        },
      },
      new Map([
        [`robinhood_${TOKEN}`, { id: `robinhood_${TOKEN}`, type: "token", attributes: { symbol: "ROO", name: "Roo", image_url: "https://img/roo.png" } }],
        ["bankr-robinhood", { id: "bankr-robinhood", type: "dex", attributes: { name: "Bankr (Robinhood)" } }],
      ]),
    )!;
    expect(row).toMatchObject({ token: TOKEN, symbol: "ROO", launchpad: "Bankr", mcapUsd: 136_933, liquidityUsd: 40_000, vol30mUsd: 9_000, traders30m: 33, quoteUsd: 2750 });
    // 30 buys and 10 sells of $9K: an estimated $4.5K net in.
    expect(row.net30mUsd).toBe(4_500);
  });

  it("gives tokens outside Pons a basic pool-depth check", () => {
    expect(poolSafety(40_000, 200_000)).toEqual({ score: 70, label: "Deep pool" });
    expect(poolSafety(1_000, 50_000).score).toBeLessThan(50);
  });

  it("lets the agent pick them, marked as external with their launchpad", () => {
    const [p] = matchPicks(STYLE_PRESETS.momentum, [launch()], NOW);
    expect(p).toMatchObject({ launchpad: "Uniswap V4", external: true, stage: "graduated" });
    expect(p.reasons).toContain("trades on Uniswap V4");
  });
});

describe("bot posts", () => {
  const [pick] = matchPicks(STYLE_PRESETS.momentum, [launch()], NOW);
  const facts = factsOf(pick, "12 posts on X in 24h");

  it("writes a template call that always fits and passes its own checks", () => {
    const text = templateCall(facts);
    expect(text.length).toBeLessThanOrEqual(TWEET_MAX);
    expect(text).toContain("$ROO");
    expect(text).toContain(`CA: ${TOKEN}`);
    expect(validCall(text, facts)).toBe(true);
  });

  it("rejects writer output with invented numbers, links, mentions or promises", () => {
    const base = `$ROO is cooking on Uniswap V4 at $200.0K mcap.\nCA: ${TOKEN}\nNFA`;
    expect(validCall(base, facts)).toBe(true);
    expect(validCall(base.replace("$200.0K", "$900K"), facts)).toBe(false);
    expect(validCall(`${base}\nhttps://sathood.xyz`, facts)).toBe(false);
    expect(validCall(`${base} @someone`, facts)).toBe(false);
    expect(validCall(`${base} guaranteed`, facts)).toBe(false);
    expect(validCall(base.replace(TOKEN, "0x0000000000000000000000000000000000000001"), facts)).toBe(false);
  });

  it("recaps each new multiple once, celebrating the biggest", () => {
    expect(recapDue(call({ peakMcap: 15_000 }))).toBeNull();
    expect(recapDue(call({ peakMcap: 32_000 }))).toBe(3);
    expect(recapDue(call({ peakMcap: 32_000, recapped: [2, 3] }))).toBeNull();
    expect(recapText(call({ lastMcap: 30_000 }), 3)).toContain("Called at $10.0K mcap.");
  });

  it("scores the day honestly, misses included", () => {
    const text = scorecardText([call({ peakMcap: 42_000 }), call({ id: "c2", symbol: "RUG", stoppedOut: true }), call({ id: "old", at: NOW - 3 * 86_400 })], NOW)!;
    expect(text).toContain("2 calls · 1 hit 2× · 1 hit the stop");
    expect(text).toContain("Best: $ROO 4.2×");
    expect(scorecardText([], NOW)).toBeNull();
  });
});
