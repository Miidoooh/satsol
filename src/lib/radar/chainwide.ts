import { addrKey, isTokenAddress } from "../address";
import { cache } from "../cache";
import { getConfig } from "../config";
import { sharedSnapshot } from "../store/snapshots";

/**
 * Every launchpad and DEX on the chain SAT watches, from GeckoTerminal's
 * public API. On Solana that is pump.fun, PumpSwap, Raydium, Meteora, Orca
 * and the rest. A refresh is a dozen calls (new, trending and top-volume
 * pools), well inside the free 30-calls-a-minute limit.
 */

export const GT_NETWORK = () => (getConfig().SAT_CHAIN === "solana" ? "solana" : "robinhood");
const api = () => `https://api.geckoterminal.com/api/v2/networks/${GT_NETWORK()}`;
const KEY = () => `chainwide:pools:v2:${GT_NETWORK()}`;
const FRESH_MS = 150_000;
/** The free API rate-limits bursts, so pages are fetched a couple of seconds apart. */
const PAGE_GAP_MS = 2_200;
/** Pools missing from one refresh (rate limit, page churn) stay listed this long. */
const KEEP_SEEN_MS = 30 * 60_000;
/** Busiest pools first: they feed Momentum and Whale; new pools feed Sniper. */
const PAGES: Record<string, { path: string; pages: number }[]> = {
  solana: [
    { path: "trending_pools?duration=1h", pages: 1 },
    { path: "pools?sort=h24_volume_usd_desc", pages: 1 },
    { path: "new_pools", pages: 3 },
    { path: "trending_pools?duration=5m", pages: 1 },
  ],
  robinhood: [
    { path: "new_pools", pages: 4 },
    { path: "trending_pools?duration=1h", pages: 2 },
    { path: "pools?sort=h24_volume_usd_desc", pages: 2 },
  ],
};

/**
 * pump.fun's bonding curve, whose graduation point is known well enough to
 * estimate progress. Other launchpad curves (Meteora DBC, LaunchLab) migrate
 * at thresholds each launch sets, so they are listed as ordinary pools.
 */
const CURVE_DEX = /^pump-fun$/;
/** Majors, stablecoins and wrapped assets: real pools, but not launches. */
const NOT_LAUNCHES = new Set(["sol", "wsol", "usdc", "usdt", "pyusd", "usds", "usd1", "eurc", "jitosol", "msol", "bsol", "jupsol", "wbtc", "cbbtc", "weth", "eth", "btc"]);
/** Market caps where a pump.fun-style curve starts and completes, for an estimated progress. */
const CURVE_START_USD = 4_000;
const CURVE_DONE_USD = 69_000;

export function curveProgress(mcapUsd: number | null): number {
  if (!mcapUsd) return 0;
  return Math.max(0, Math.min(99, ((mcapUsd - CURVE_START_USD) / (CURVE_DONE_USD - CURVE_START_USD)) * 100));
}

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
  token: string;
  symbol: string;
  name: string;
  logoUrl?: string;
  pool: string;
  /** GeckoTerminal's DEX id and its display name, e.g. "uniswap-v4-robinhood", "Bankr". */
  dexId: string;
  launchpad: string;
  /** Still on a launchpad bonding curve (pump.fun and similar), not yet in a DEX pool. */
  onCurve: boolean;
  quoteSymbol: string;
  quoteToken: string;
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
    .replace(/-(robinhood|solana)$/, "")
    .split("-")
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");

/** "solana_<mint>" → the mint, spelled exactly as GeckoTerminal gives it. */
const addressOf = (id?: string) => (id ? id.slice(id.indexOf("_") + 1) : "");

export function toChainPool(p: GtPool, included: Map<string, GtIncluded>): ChainPool | null {
  const a = p.attributes;
  const baseId = p.relationships?.base_token?.data?.id;
  const token = addressOf(baseId);
  if (!isTokenAddress(token)) return null;
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
    launchpad: dex?.attributes.name?.replace(/\s*\((Robinhood|Solana)\)$/, "") ?? prettyDex(dexId),
    onCurve: CURVE_DEX.test(dexId),
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
    url: `https://www.geckoterminal.com/${GT_NETWORK()}/pools/${a.address}`,
  };
}

async function page(path: string, n: number): Promise<{ data: GtPool[]; included: GtIncluded[] } | null> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${api()}/${path}${sep}include=base_token,quote_token,dex&page=${n}`, {
    headers: { accept: "application/json;version=20230302" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (res.status === 429) return null;
  if (!res.ok) throw new Error(`GeckoTerminal ${path} ${res.status}`);
  return (await res.json()) as { data: GtPool[]; included: GtIncluded[] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Last refresh's pools with when each was last seen, carried into the next refresh. */
let seen = new Map<string, { pool: ChainPool; at: number }>();
let refreshes = 0;

async function build(): Promise<{ pools: ChainPool[]; updatedAt: number }> {
  const byToken = new Map<string, ChainPool>();
  let first = true;
  // Alternate which half goes first, so a rate limit late in one refresh is not always the same pages.
  const order = PAGES[GT_NETWORK()];
  const half = Math.ceil(order.length / 2);
  const sequence = refreshes++ % 2 === 0 ? order : [...order.slice(half), ...order.slice(0, half)];
  outer: for (const { path, pages } of sequence) {
    for (let n = 1; n <= pages; n++) {
      if (!first) await sleep(PAGE_GAP_MS);
      first = false;
      const body = await page(path, n).catch(() => null);
      if (!body) break outer;
      const included = new Map((body.included ?? []).map((i) => [i.id, i]));
      for (const p of body.data ?? []) {
        const row = toChainPool(p, included);
        if (!row || NOT_LAUNCHES.has(row.symbol.toLowerCase()) || (row.mcapUsd ?? 0) > 2e9) continue;
        // A token can trade in several pools; keep the busiest one.
        const prev = byToken.get(addrKey(row.token));
        if (!prev || row.vol24hUsd > prev.vol24hUsd) byToken.set(addrKey(row.token), row);
      }
    }
  }
  const now = Date.now();
  const next = new Map<string, { pool: ChainPool; at: number }>();
  for (const [k, v] of seen) if (now - v.at <= KEEP_SEEN_MS) next.set(k, v);
  for (const [k, pool] of byToken) next.set(k, { pool, at: now });
  seen = next;
  return { pools: [...next.values()].map((v) => v.pool), updatedAt: now };
}

/** Price and market cap for specific tokens, up to 30 per call, spelled exactly (Solana mints are case-sensitive). */
export async function tokenMarks(tokens: string[]): Promise<Map<string, { mcapUsd: number; priceUsd: number }>> {
  const out = new Map<string, { mcapUsd: number; priceUsd: number }>();
  for (let i = 0; i < tokens.length; i += 30) {
    const res = await fetch(`${api()}/tokens/multi/${tokens.slice(i, i + 30).join(",")}`, {
      headers: { accept: "application/json;version=20230302" },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    }).catch(() => null);
    if (!res?.ok) continue;
    const body = (await res.json()) as { data?: { attributes: { address: string; price_usd?: string | null; market_cap_usd?: string | null; fdv_usd?: string | null } }[] };
    for (const t of body.data ?? []) {
      const price = num(t.attributes.price_usd);
      const mcap = num(t.attributes.market_cap_usd) ?? num(t.attributes.fdv_usd);
      if (price && mcap) out.set(addrKey(t.attributes.address), { mcapUsd: mcap, priceUsd: price });
    }
  }
  return out;
}

/** Every token with a live pool on the chain that GeckoTerminal lists as new, trending or top volume. */
export async function chainPools(): Promise<{ pools: ChainPool[]; updatedAt: number }> {
  return cache.get(KEY(), FRESH_MS, () => sharedSnapshot(KEY(), FRESH_MS, build), { swr: true });
}
