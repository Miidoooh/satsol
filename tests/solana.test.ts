import { describe, expect, it } from "vitest";
import { isSolanaAddress, isTokenAddress, sameAddress } from "@/lib/address";
import { curveProgress, toChainPool } from "@/lib/radar/chainwide";
import { probeImpact } from "@/lib/solana/jupiter";
import { looksLikeSpam, tokensIn } from "@/lib/social/radar";

const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const PUMP = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";

describe("Solana addresses", () => {
  it("accepts base58 mints and EVM addresses, rejects junk", () => {
    expect(isSolanaAddress(MINT)).toBe(true);
    expect(isTokenAddress(PUMP)).toBe(true);
    expect(isTokenAddress("0x3458e003f6ed93df0f537b8acac6fbe08e41247f")).toBe(true);
    expect(isTokenAddress("0OIl-not-base58")).toBe(false);
    expect(sameAddress(MINT, MINT.toLowerCase())).toBe(true);
  });

  it("keeps a mint's exact spelling and spots pump.fun curves", () => {
    const row = toChainPool(
      {
        id: "solana_poolAddr",
        attributes: { address: "poolAddr", name: "CATE / SOL", fdv_usd: "52000", pool_created_at: "2026-10-02T20:00:00Z", volume_usd: { m30: "8000" }, transactions: { m30: { buys: 60, sells: 20, buyers: 50, sellers: 15 } } },
        relationships: {
          base_token: { data: { id: `solana_${PUMP}` } },
          quote_token: { data: { id: "solana_So11111111111111111111111111111111111111112" } },
          dex: { data: { id: "pump-fun" } },
        },
      },
      new Map([["pump-fun", { id: "pump-fun", type: "dex", attributes: { name: "Pump.fun" } }]]),
    )!;
    expect(row.token).toBe(PUMP);
    expect(row).toMatchObject({ launchpad: "Pump.fun", onCurve: true, traders30m: 65 });
    expect(row.url).toBe("https://www.geckoterminal.com/solana/pools/poolAddr");
    expect(Math.round(curveProgress(52_000))).toBe(74);
    expect(curveProgress(500_000)).toBe(99);
  });

  it("drops scam posts that hide invisible or look-alike characters", () => {
    expect(looksLikeSpam("Anyone watching $ANON needs to\u200b see\u200b this.")).toBe(true);
    expect(looksLikeSpam("They just op\u0435ned \u0430 new pool")).toBe(true);
    expect(looksLikeSpam("$CATE just graduated, 400 holders, CA below")).toBe(false);
    expect(looksLikeSpam("Привет, это русский пост")).toBe(false);
  });

  it("measures price impact against a tiny probe trade", () => {
    // The probe gets 100 tokens per SOL; the real size gets 95 per SOL: 5% impact.
    expect(probeImpact(1_000_000_000n, 95_000_000n, 10_000_000n, 1_000_000n)).toBeCloseTo(5, 6);
    expect(probeImpact(1_000n, 1_000n, 10n, 10n)).toBe(0);
    expect(probeImpact(1_000n, 1_000n, 10n, 0n)).toBeNull();
  });

  it("finds Solana contract addresses in tweets", () => {
    const known = new Map([[PUMP.toLowerCase(), { token: PUMP, symbol: "CATE" }]]);
    expect(tokensIn(`aping this one\nCA: ${PUMP}`, known, new Map()).map((t) => t.symbol)).toEqual(["CATE"]);
  });
});
