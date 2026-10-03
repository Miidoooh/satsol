import { NextResponse } from "next/server";
import { isSolanaAddress } from "@/lib/address";
import { cache } from "@/lib/cache";
import { errorResponse, rateLimit } from "@/lib/http";

export const runtime = "nodejs";

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
type W<T> = Partial<Record<"m5" | "m15" | "m30" | "h1" | "h6" | "h24", T>>;
const num = (v?: string | null) => (v ? Number(v) : null);

export interface SolTokenInfo {
  mint: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  vol24hUsd: number | null;
  pool: {
    address: string;
    name: string;
    launchpad: string;
    createdAt: number | null;
    change: W<number | null>;
    volume: W<number | null>;
    txns: W<{ buys?: number; sells?: number; buyers?: number; sellers?: number }>;
  } | null;
  chartUrl: string | null;
}

async function load(mint: string): Promise<SolTokenInfo> {
  const res = await fetch(`${GT}/tokens/${mint}?include=top_pools`, { headers: { accept: "application/json;version=20230302" }, signal: AbortSignal.timeout(12_000), cache: "no-store" });
  if (res.status === 404) throw new Error("Token not found on Solana");
  if (!res.ok) throw new Error(`Token data unavailable (${res.status})`);
  const body = (await res.json()) as {
    data: { attributes: Record<string, unknown> & { volume_usd?: { h24?: string } }; relationships?: { top_pools?: { data?: { id: string }[] } } };
    included?: { id: string; type: string; attributes: Record<string, unknown>; relationships?: { dex?: { data?: { id: string } } } }[];
  };
  const a = body.data.attributes;
  // GeckoTerminal's first "top pool" can be a dead one; the busiest pool by 24h volume is the real market.
  const pools = (body.included ?? []).filter((i) => i.type === "pool");
  const vol24 = (p: (typeof pools)[number]) => num((p.attributes.volume_usd as W<string> | undefined)?.h24) ?? 0;
  const top = [...pools].sort((x, y) => vol24(y) - vol24(x))[0];
  const pa = top?.attributes as
    | { address: string; name: string; pool_created_at?: string; price_change_percentage?: W<string>; volume_usd?: W<string>; transactions?: SolTokenInfo["pool"] extends infer P ? (P extends { txns: infer T } ? T : never) : never }
    | undefined;
  const dexId = top?.relationships?.dex?.data?.id ?? "";
  const mapW = (w?: W<string>) => Object.fromEntries(Object.entries(w ?? {}).map(([k, v]) => [k, num(v)])) as W<number | null>;
  return {
    mint,
    symbol: String(a.symbol ?? ""),
    name: String(a.name ?? ""),
    logoUrl: typeof a.image_url === "string" && !a.image_url.includes("missing") ? a.image_url : null,
    priceUsd: num(a.price_usd as string),
    mcapUsd: num(a.market_cap_usd as string) ?? num(a.fdv_usd as string),
    liquidityUsd: Math.max(num(a.total_reserve_in_usd as string) ?? 0, num(top?.attributes.reserve_in_usd as string) ?? 0) || null,
    vol24hUsd: num(a.volume_usd?.h24),
    pool: pa
      ? {
          address: pa.address,
          name: pa.name,
          launchpad: dexId.replace(/-solana$/, "").replace(/-/g, " "),
          createdAt: pa.pool_created_at ? Math.floor(Date.parse(pa.pool_created_at) / 1000) : null,
          change: mapW(pa.price_change_percentage),
          volume: mapW(pa.volume_usd),
          txns: pa.transactions ?? {},
        }
      : null,
    chartUrl: pa ? `https://www.geckoterminal.com/solana/pools/${pa.address}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0` : null,
  };
}

/** One Solana token: price, market cap, liquidity, its main pool and an embeddable live chart. */
export async function GET(req: Request) {
  const limited = rateLimit(req, "sol-token", 120);
  if (limited) return limited;
  const mint = new URL(req.url).searchParams.get("mint") ?? "";
  if (!isSolanaAddress(mint)) return NextResponse.json({ error: "Not a Solana mint" }, { status: 400 });
  try {
    const info = await cache.get(`sol:token:${mint}`, 30_000, () => load(mint));
    return NextResponse.json(info, { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" } });
  } catch (err) {
    return errorResponse(err, /not found/i.test(String(err)) ? 404 : 502);
  }
}
