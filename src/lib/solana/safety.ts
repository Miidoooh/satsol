import { PublicKey } from "@solana/web3.js";
import { cache } from "../cache";
import { rpc } from "./rpc";

/**
 * Rug check for a Solana token, read straight from chain through Helius:
 * who can still mint or freeze, how concentrated the holders are (pools and
 * bonding curves excluded), how deep the liquidity is, and whether the name
 * and logo can still change.
 */

const BURN = "1nc1nerator11111111111111111111111111111111";
const CACHE_MS = 5 * 60_000;

export type FlagTone = "good" | "warn" | "bad";

export interface SolSafety {
  score: number;
  label: "Lower risk" | "Caution" | "High risk";
  flags: { tone: FlagTone; text: string }[];
  checks: {
    mintRevoked: boolean;
    freezeRevoked: boolean;
    mutableMetadata: boolean;
    topHolderPct: number;
    top10Pct: number;
    poolPct: number;
    liquidityUsd: number | null;
    ageMin: number | null;
  };
}

export interface SafetyInput {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  mutableMetadata: boolean;
  /** Share of supply per holder, wallets only (pools and programs excluded), largest first. */
  walletPcts: number[];
  /** Share of supply sitting in pools, curves and other programs. */
  poolPct: number;
  liquidityUsd: number | null;
  ageMin: number | null;
}

const pct = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)}%`;

/** Score 0 to 100 and the plain-language reasons, from the raw on-chain facts. */
export function scoreSafety(i: SafetyInput): SolSafety {
  let score = 100;
  const flags: SolSafety["flags"] = [];
  const top = i.walletPcts[0] ?? 0;
  const top10 = i.walletPcts.slice(0, 10).reduce((s, v) => s + v, 0);

  if (i.mintAuthority) {
    score -= 30;
    flags.push({ tone: "bad", text: "The creator can still mint more tokens" });
  } else flags.push({ tone: "good", text: "Minting is switched off" });

  if (i.freezeAuthority) {
    score -= 25;
    flags.push({ tone: "bad", text: "The creator can freeze your tokens" });
  } else flags.push({ tone: "good", text: "No one can freeze your tokens" });

  if (top > 20) {
    score -= 25;
    flags.push({ tone: "bad", text: `One wallet holds ${pct(top)} of the supply` });
  } else if (top > 10) {
    score -= 12;
    flags.push({ tone: "warn", text: `Top wallet holds ${pct(top)}` });
  } else flags.push({ tone: "good", text: `No wallet holds over 10% (top ${pct(top)})` });

  if (top10 > 50) {
    score -= 20;
    flags.push({ tone: "bad", text: `Top 10 wallets hold ${pct(top10)}` });
  } else if (top10 > 30) {
    score -= 10;
    flags.push({ tone: "warn", text: `Top 10 wallets hold ${pct(top10)}` });
  } else flags.push({ tone: "good", text: `Top 10 wallets hold ${pct(top10)}` });

  if (i.liquidityUsd !== null) {
    if (i.liquidityUsd < 1_000) {
      score -= 40;
      flags.push({ tone: "bad", text: "Liquidity is almost gone: you may not be able to sell" });
    } else if (i.liquidityUsd < 5_000) {
      score -= 15;
      flags.push({ tone: "bad", text: "Very thin liquidity: hard to sell" });
    } else if (i.liquidityUsd < 20_000) {
      score -= 7;
      flags.push({ tone: "warn", text: "Thin liquidity" });
    }
  }

  if (i.mutableMetadata) {
    score -= 5;
    flags.push({ tone: "warn", text: "Name and logo can still be changed" });
  }

  if (i.ageMin !== null && i.ageMin < 10) {
    score -= 5;
    flags.push({ tone: "warn", text: "Brand new: under 10 minutes old" });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const order: Record<FlagTone, number> = { bad: 0, warn: 1, good: 2 };
  return {
    score,
    label: score >= 75 ? "Lower risk" : score >= 50 ? "Caution" : "High risk",
    flags: flags.sort((a, b) => order[a.tone] - order[b.tone]),
    checks: {
      mintRevoked: !i.mintAuthority,
      freezeRevoked: !i.freezeAuthority,
      mutableMetadata: i.mutableMetadata,
      topHolderPct: top,
      top10Pct: top10,
      poolPct: i.poolPct,
      liquidityUsd: i.liquidityUsd,
      ageMin: i.ageMin,
    },
  };
}

/** Wallets are keys on the ed25519 curve; pools, bonding curves and other program accounts are not. */
const isWallet = (owner: string) => {
  try {
    return PublicKey.isOnCurve(new PublicKey(owner).toBytes());
  } catch {
    return false;
  }
};

interface DasAsset {
  mutable?: boolean;
  token_info?: { supply?: number; decimals?: number; mint_authority?: string | null; freeze_authority?: string | null };
}

type ChainFacts = Omit<SafetyInput, "liquidityUsd" | "ageMin">;

/** The on-chain part of the check: authorities, metadata and holders. */
async function readChain(mint: string): Promise<ChainFacts> {
  const [asset, largest] = await Promise.all([
    rpc<DasAsset>("getAsset", { id: mint }),
    rpc<{ value: { address: string; uiAmount: number | null }[] }>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]),
  ]);
  const decimals = asset.token_info?.decimals ?? 0;
  const supply = (asset.token_info?.supply ?? 0) / 10 ** decimals;
  const accounts = largest.value.filter((a) => (a.uiAmount ?? 0) > 0);
  const owners = accounts.length
    ? await rpc<{ value: ({ data: { parsed?: { info?: { owner?: string } } } } | null)[] }>("getMultipleAccounts", [accounts.map((a) => a.address), { encoding: "jsonParsed" }])
    : { value: [] };
  const walletPcts: number[] = [];
  let poolPct = 0;
  accounts.forEach((a, i) => {
    const share = supply > 0 ? ((a.uiAmount ?? 0) / supply) * 100 : 0;
    const owner = owners.value[i]?.data.parsed?.info?.owner ?? "";
    if (owner === BURN) return;
    if (isWallet(owner)) walletPcts.push(share);
    else poolPct += share;
  });
  return {
    mintAuthority: asset.token_info?.mint_authority ?? null,
    freezeAuthority: asset.token_info?.freeze_authority ?? null,
    mutableMetadata: asset.mutable ?? false,
    walletPcts: walletPcts.sort((a, b) => b - a),
    poolPct,
  };
}

/** The rug check for one mint. Chain reads are cached for five minutes; liquidity and age are applied fresh each time. */
export async function solSafety(mint: string, market: { liquidityUsd: number | null; launchedAt: number | null } = { liquidityUsd: null, launchedAt: null }): Promise<SolSafety> {
  const chain = await cache.get(`sol:safety:chain:${mint}`, CACHE_MS, () => readChain(mint));
  return scoreSafety({
    ...chain,
    liquidityUsd: market.liquidityUsd,
    ageMin: market.launchedAt ? Math.max(0, Math.round((Date.now() / 1000 - market.launchedAt) / 60)) : null,
  });
}
