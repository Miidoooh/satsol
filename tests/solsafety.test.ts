import { describe, expect, it } from "vitest";
import { scoreSafety, type SafetyInput } from "@/lib/solana/safety";

const clean: SafetyInput = {
  mintAuthority: null,
  freezeAuthority: null,
  mutableMetadata: false,
  walletPcts: [3, 2.5, 2, 1.5, 1, 1, 0.8, 0.7, 0.6, 0.5],
  poolPct: 80,
  liquidityUsd: 60_000,
  ageMin: 90,
};

describe("Solana rug check", () => {
  it("rates a clean token as lower risk with only good reasons", () => {
    const s = scoreSafety(clean);
    expect(s).toMatchObject({ score: 100, label: "Lower risk" });
    expect(s.flags.every((f) => f.tone === "good")).toBe(true);
    expect(s.checks.top10Pct).toBeCloseTo(13.6, 5);
  });

  it("calls out a token whose creator can still mint and freeze", () => {
    const s = scoreSafety({ ...clean, mintAuthority: "Creator111", freezeAuthority: "Creator111" });
    expect(s.score).toBe(45);
    expect(s.label).toBe("High risk");
    expect(s.flags.slice(0, 2).map((f) => f.text)).toEqual(["The creator can still mint more tokens", "The creator can freeze your tokens"]);
  });

  it("penalises concentrated holders, thin liquidity, editable metadata and brand-new launches", () => {
    const s = scoreSafety({ ...clean, walletPcts: [28, 12, 9, 5, 2], mutableMetadata: true, liquidityUsd: 3_000, ageMin: 4 });
    expect(s.flags.filter((f) => f.tone === "bad").map((f) => f.text)).toEqual([
      "One wallet holds 28% of the supply",
      "Top 10 wallets hold 56%",
      "Very thin liquidity: hard to sell",
    ]);
    expect(s.score).toBe(100 - 25 - 20 - 15 - 5 - 5);
    expect(s.label).toBe("High risk");
    // A drained pool alone is enough to flag a token as high risk.
    expect(scoreSafety({ ...clean, liquidityUsd: 400 })).toMatchObject({ score: 60, label: "Caution" });
    expect(scoreSafety({ ...clean, liquidityUsd: 400, walletPcts: [16] }).label).toBe("High risk");
    // One wallet over 20% (−25) and the top 10 over 30% (−10): 65.
    expect(scoreSafety({ ...clean, walletPcts: [22, 10, 8, 5] })).toMatchObject({ score: 65, label: "Caution" });
  });
});
