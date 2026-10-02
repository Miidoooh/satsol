import { cache } from "../cache";
import { sharedSnapshot } from "../store/snapshots";

/**
 * Every launchpad and DEX on Robinhood Chain, from GeckoTerminal's public
 * API: Pons, Bankr, Virtuals, Clanker, Pools.trade, Uniswap v2/v3/v4 and the
 * rest. A refresh is a handful of calls (new, trending and top-volume pools),
 * well inside the free 30-calls-a-minute limit.
 */

const API = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const KEY = "chainwide:pools:v1";
const FRESH_MS = 90_000;
const PAGES: { path: string; pages: number }[] = [
  { path: "new_pools", pages: 4 },
  { path: "trending_pools?duration=1h", pages: 2 },
  { path: "pools?sort=h24_volume_usd_desc", pages: 2 },
];

type Windowed<T> = Partial<Record<"m5" | "m15" | "m30" | "h1" | "h6" | "h24", T>>;

interface GtPool {
  id: string;
  attributes: {
    address: string;
    name: string;
    base_token_price_usd?: string | null;
    quote_token_price_usd?: string | null;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    reserve_in_usd?: string | null;
    pool_created_at?: string | null;
    volume_usd?: Windowed<string | null>;
    transactions?: Windowed<{ buys?: number; sells?: number; buyers?: number; sellers?: number }>;
    price_change_percentage?: Windowed<string | null>;
  };
  relationships?: {
    base_token?: { data?: { id: string } };
    quote_token?: { data?: { id: string } };
    dex?: { data?: { id: string } };
  };
}

interface GtIncluded {
  id: string;
  type: string;
  attributes: { address?: string; name?: string; symbol?: string; image_url?: string | null };
}

/** One token's most active pool, anywhere on the chain. */
export interface ChainPool {
  token: `0x${string}`;
  symbol: string;
  name: string;
  logoUrl?: string;
  pool: string;
  /** GeckoTerminal's DEX id and its display name, e.g. "uniswap-v4-robinhood", "Bankr". */
  dexId: string;
  launchpad: string;
  quoteSymbol: string;
  quoteToken: `0x${string}`;
  quoteUsd: number;
  launchedAt: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  liquidityUsd: number;
  vol30mUsd: number;
  vol24hUsd: number;
  /** Net buying estimated from the buy/sell count split; GeckoTerminal does not split volume by side. */
  net30mUsd: number;
  traders30m: number;
  buys30m: number;
  sells30m: number;
  change1hPct: number | null;
  url: string;
}

const num = (v: string | number | null | undefined) => {
  const n = typeof v === "number" ? v : v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** "uniswap-v4-robinhood" → "Uniswap V4", "pons-v2-dex" → "Pons V2 Dex" when the name is not included. */
const prettyDex = (id: string) =>
  id
    .replace(/-robinhood$/, "")
    .split("-")
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");

const addressOf = (id?: string) => (id?.split("_")[1] ?? "").toLowerCase() as `0x${string}`;

export function toChainPool(p: GtPool, included: Map<string, GtIncluded>): ChainPool | null {
  const a = p.attributes;
  const baseId = p.relationships?.base_token?.data?.id;
  const token = addressOf(baseId);
  if (!/^0x[0-9a-f]{40}$/.test(token)) return null;
  const base = baseId ? included.get(baseId) : undefined;
  const quoteId = p.relationships?.quote_token?.data?.id;
  const quote = quoteId ? included.get(quoteId) : undefined;
  const dexId = p.relationships?.dex?.data?.id ?? "unknown";
  const dex = included.get(dexId);
  const t30 = a.transactions?.m30 ?? {};
  const buys = t30.buys ?? 0;
  const sells = t30.sells ?? 0;
  const vol30 = num(a.volume_usd?.m30) ?? 0;
  const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
  return {
    token,
    symbol: base?.attributes.symbol ?? a.name.split(" / ")[0],
    name: base?.attributes.name ?? "",
    logoUrl: base?.attributes.image_url && !base.attributes.image_url.includes("missing") ? base.attributes.image_url : undefined,
    pool: a.address,
    dexId,
    launchpad: dex?.attributes.name?.replace(/\s*\(Robinhood\)$/, "") ?? prettyDex(dexId),
    quoteSymbol: quote?.attributes.symbol ?? a.name.split(" / ")[1]?.split(" ")[0] ?? "",
    quoteToken: addressOf(quoteId),
    quoteUsd: num(a.quote_token_price_usd) ?? 0,
    launchedAt: Number.isFinite(created) ? Math.floor(created / 1000) : null,
    priceUsd: num(a.base_token_price_usd),
    mcapUsd: num(a.market_cap_usd) ?? num(a.fdv_usd),
    liquidityUsd: num(a.reserve_in_usd) ?? 0,
    vol30mUsd: vol30,
    vol24hUsd: num(a.volume_usd?.h24) ?? 0,
    net30mUsd: buys + sells > 0 ? (vol30 * (buys - sells)) / (buys + sells) : 0,
    traders30m: (t30.buyers ?? 0) + (t30.sellers ?? 0),
    buys30m: buys,
    sells30m: sells,
    change1hPct: num(a.price_change_percentage?.h1),
    url: `https://www.geckoterminal.com/robinhood/pools/${a.address}`,
  };
}

async function page(path: string, n: number): Promise<{ data: GtPool[]; included: GtIncluded[] } | null> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${API}/${path}${sep}include=base_token,quote_token,dex&page=${n}`, {
    headers: { accept: "application/json;version=20230302" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (res.status === 429) return null;
  if (!res.ok) throw new Error(`GeckoTerminal ${path} ${res.status}`);
  return (await res.json()) as { data: GtPool[]; included: GtIncluded[] };
}

async function build(): Promise<{ pools: ChainPool[]; updatedAt: number }> {
  const byToken = new Map<string, ChainPool>();
  outer: for (const { path, pages } of PAGES) {
    for (let n = 1; n <= pages; n++) {
      const body = await page(path, n).catch(() => null);
      if (!body) break outer;
      const included = new Map((body.included ?? []).map((i) => [i.id, i]));
      for (const p of body.data ?? []) {
        const row = toChainPool(p, included);
        if (!row) continue;
        // A token can trade in several pools; keep the busiest one.
        const prev = byToken.get(row.token);
        if (!prev || row.vol24hUsd > prev.vol24hUsd) byToken.set(row.token, row);
      }
    }
  }
  return { pools: [...byToken.values()], updatedAt: Date.now() };
}

/** Every token with a live pool on Robinhood Chain that GeckoTerminal lists as new, trending or top volume. */
export async function chainPools(): Promise<{ pools: ChainPool[]; updatedAt: number }> {
  return cache.get(KEY, FRESH_MS, () => sharedSnapshot(KEY, FRESH_MS, build), { swr: true });
}
