import { NextResponse } from "next/server";
import { z } from "zod";
import { isSolanaAddress } from "@/lib/address";
import { cache } from "@/lib/cache";
import { errorResponse, rateLimit } from "@/lib/http";
import type { Candle } from "@/lib/types";

export const runtime = "nodejs";

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";

/** SAT timeframes → GeckoTerminal's period and aggregation. */
const FRAMES = {
  "1m": ["minute", 1],
  "5m": ["minute", 5],
  "15m": ["minute", 15],
  "1h": ["hour", 1],
  "4h": ["hour", 4],
  "1d": ["day", 1],
} as const;

const Query = z.object({
  pool: z.string().refine(isSolanaAddress),
  tf: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("5m"),
});

async function load(pool: string, tf: keyof typeof FRAMES): Promise<Candle[]> {
  const [period, aggregate] = FRAMES[tf];
  const res = await fetch(`${GT}/pools/${pool}/ohlcv/${period}?aggregate=${aggregate}&limit=300&currency=usd`, {
    headers: { accept: "application/json;version=20230302" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Chart data unavailable (${res.status})`);
  const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
  return (body.data?.attributes?.ohlcv_list ?? [])
    .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
    .sort((a, b) => a.time - b.time);
}

/** OHLCV candles for one Solana pool, in USD. */
export async function GET(req: Request) {
  const limited = rateLimit(req, "sol-candles", 120);
  if (limited) return limited;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Pass ?pool=<address>&tf=5m" }, { status: 400 });
  const { pool, tf } = parsed.data;
  try {
    const candles = await cache.get(`sol:candles:${pool}:${tf}`, tf === "1m" ? 20_000 : 45_000, () => load(pool, tf), { swr: true });
    return NextResponse.json({ candles }, { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" } });
  } catch (err) {
    return errorResponse(err, 502);
  }
}
