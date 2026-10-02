import { NextResponse } from "next/server";
import { cache } from "@/lib/cache";
import { errorResponse, rateLimit } from "@/lib/http";
import { chainPools, type ChainPool } from "@/lib/radar/chainwide";

export const runtime = "nodejs";
export const maxDuration = 60;

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
const WHALE_POOLS = 3;
const WHALE_MIN_USD = 1_000;

export interface SolWhaleTrade {
  id: string;
  token: string;
  symbol: string;
  logoUrl?: string;
  side: "buy" | "sell";
  usd: number;
  trader: string;
  tx: string;
  at: number;
}

export interface SolFlow {
  token: string;
  symbol: string;
  logoUrl?: string;
  launchpad: string;
  netUsd: number;
  volUsd: number;
  traders: number;
  mcapUsd: number | null;
  change1hPct: number | null;
}

export interface SolRadar {
  trades: SolWhaleTrade[];
  inflows: SolFlow[];
  outflows: SolFlow[];
  crowds: SolFlow[];
  totals: { volume30mUsd: number; buys30m: number; sells30m: number; tokens: number };
  updatedAt: number;
}

const flow = (p: ChainPool): SolFlow => ({
  token: p.token,
  symbol: p.symbol,
  logoUrl: p.logoUrl,
  launchpad: p.launchpad,
  netUsd: p.net30mUsd,
  volUsd: p.vol30mUsd,
  traders: p.traders30m,
  mcapUsd: p.mcapUsd,
  change1hPct: p.change1hPct,
});

/** Big trades in the busiest pools; a rate limit just means fewer trades this round. */
async function whaleTrades(pools: ChainPool[]): Promise<SolWhaleTrade[]> {
  const out: SolWhaleTrade[] = [];
  for (const p of pools) {
    const res = await fetch(`${GT}/pools/${p.pool}/trades?trade_volume_in_usd_greater_than=${WHALE_MIN_USD}`, {
      headers: { accept: "application/json;version=20230302" },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    }).catch(() => null);
    if (!res?.ok) break;
    const body = (await res.json()) as { data?: { id: string; attributes: { kind: string; volume_in_usd: string; tx_from_address: string; tx_hash: string; block_timestamp: string } }[] };
    for (const t of (body.data ?? []).slice(0, 15)) {
      const a = t.attributes;
      out.push({
        id: t.id,
        token: p.token,
        symbol: p.symbol,
        logoUrl: p.logoUrl,
        side: a.kind === "sell" ? "sell" : "buy",
        usd: Number(a.volume_in_usd),
        trader: a.tx_from_address,
        tx: a.tx_hash,
        at: Math.floor(Date.parse(a.block_timestamp) / 1000),
      });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 60);
}

async function build(): Promise<SolRadar> {
  const { pools } = await chainPools();
  const busy = [...pools].sort((a, b) => b.vol30mUsd - a.vol30mUsd);
  return {
    trades: await whaleTrades(busy.slice(0, WHALE_POOLS)).catch(() => []),
    inflows: pools.filter((p) => p.net30mUsd > 0).sort((a, b) => b.net30mUsd - a.net30mUsd).slice(0, 10).map(flow),
    outflows: pools.filter((p) => p.net30mUsd < 0).sort((a, b) => a.net30mUsd - b.net30mUsd).slice(0, 10).map(flow),
    crowds: [...pools].sort((a, b) => b.traders30m - a.traders30m).slice(0, 10).map(flow),
    totals: {
      volume30mUsd: pools.reduce((s, p) => s + p.vol30mUsd, 0),
      buys30m: pools.reduce((s, p) => s + p.buys30m, 0),
      sells30m: pools.reduce((s, p) => s + p.sells30m, 0),
      tokens: pools.length,
    },
    updatedAt: Date.now(),
  };
}

/** Solana whale radar: big trades in the hottest pools, and where money is flowing in and out. */
export async function GET(req: Request) {
  const limited = rateLimit(req, "sol-radar", 120);
  if (limited) return limited;
  try {
    const radar = await cache.get("sol:radar", 60_000, build, { swr: true });
    return NextResponse.json(radar, { headers: { "cache-control": "public, s-maxage=20, stale-while-revalidate=60" } });
  } catch (err) {
    return errorResponse(err, 503);
  }
}
