import { cache } from "../cache";
import { blockClock, blockTime } from "../chain/logs";
import { ponsTokenUrl } from "../chain/constants";
import { listLaunches, quoteOf, recentGraduations, scanCurves, type CurveState, type PonsLaunch } from "../data/pons";
import { recentCurveTrades, type RawCurveTrade } from "../data/ponsFlow";
import { getPonsProfiles, type PonsSocials } from "../data/ponsProfile";
import type { RobinhoodChainProvider } from "../data/robinhood";
import { getTokenMeta } from "../data/tokenMeta";
import { chainPools, type ChainPool } from "./chainwide";
import { flowByCurve } from "./trenches";
import { unitsToNumber } from "./whales";

/**
 * The Pons explorer: every live curve SAT scans (the newest few thousand),
 * plus the last day of graduations, as one sortable, filterable table.
 */

export type ExploreTab = "all" | "new" | "trending" | "almost" | "graduated";
export type ExploreSort = "age" | "mcap" | "volume" | "progress" | "txns" | "net";

/** Every Pons launch mints one billion tokens. */
const SUPPLY = 1_000_000_000;
const BASE_TTL = 12 * 1000;
export const EXPLORE_PAGE = 50;

export interface ExploreRow {
  token: `0x${string}`;
  curve: `0x${string}` | null;
  symbol: string;
  name: string;
  logoUrl?: string;
  socials?: PonsSocials;
  deployer: `0x${string}` | null;
  launchedAt: number | null;
  graduatedAt: number | null;
  quoteSymbol: string;
  /** What a buy pays with, and its USD price: the curve's quote asset, or ETH once graduated. */
  paySymbol: string;
  payUsd: number;
  priceUsd: number | null;
  mcapUsd: number | null;
  raisedUsd: number;
  progressPct: number;
  vol30mUsd: number;
  net30mUsd: number;
  txns30m: number;
  traders30m: number;
  url: string;
  /** Where it launched or trades: "Pons", "Bankr", "Uniswap V4"… */
  launchpad?: string;
  /** True when SAT cannot route the trade itself; `url` then opens the pool to trade elsewhere. */
  external?: boolean;
}

export interface ExploreQuery {
  tab: ExploreTab;
  sort?: ExploreSort;
  q?: string;
  minMcap?: number;
  minVol?: number;
  socials?: boolean;
  offset?: number;
  limit?: number;
}

export interface ExplorePage {
  tab: ExploreTab;
  counts: Record<ExploreTab, number>;
  total: number;
  rows: ExploreRow[];
  scanned: number;
  updatedAt: number;
}

interface Base {
  curves: Omit<ExploreRow, "logoUrl" | "socials">[];
  graduated: Omit<ExploreRow, "logoUrl" | "socials">[];
  updatedAt: number;
}

async function buildBase(provider: RobinhoodChainProvider): Promise<Base> {
  const [clock, book] = await Promise.all([blockClock(), provider.quoteBook()]);
  const [launches, scan, trades, graduations] = await Promise.all([
    listLaunches().catch(() => [] as PonsLaunch[]),
    scanCurves(book).catch(() => [] as CurveState[]),
    recentCurveTrades().catch(() => [] as RawCurveTrade[]),
    recentGraduations().catch(() => []),
  ]);
  const flows = flowByCurve(trades, launches, book);
  const meta = await getTokenMeta([...scan.map((s) => s.launch.token), ...graduations.map((g) => g.token)]).catch(() => new Map());
  const launchByToken = new Map(launches.map((l) => [l.token.toLowerCase(), l]));

  const curves = scan.map((s) => {
    const m = meta.get(s.launch.token.toLowerCase());
    const f = flows.get(s.launch.curve.toLowerCase());
    return {
      token: s.launch.token,
      curve: s.launch.curve,
      symbol: m?.symbol ?? `${s.launch.token.slice(0, 6)}…`,
      name: m?.name ?? "",
      deployer: s.launch.deployer,
      launchedAt: blockTime(clock, s.launch.block),
      graduatedAt: null,
      quoteSymbol: s.quote.symbol,
      paySymbol: s.quote.symbol,
      payUsd: s.quote.usd,
      priceUsd: s.priceUsd,
      mcapUsd: s.priceUsd * SUPPLY,
      raisedUsd: s.raisedUsd,
      progressPct: Number((s.progress * 100).toFixed(2)),
      vol30mUsd: f ? f.buyUsd + f.sellUsd : 0,
      net30mUsd: f ? f.buyUsd - f.sellUsd : 0,
      txns30m: f?.trades ?? 0,
      traders30m: f?.traders ?? 0,
      url: ponsTokenUrl(s.launch.token),
    };
  });

  const graduated = graduations.map((g) => {
    const m = meta.get(g.token.toLowerCase());
    const launch = launchByToken.get(g.token.toLowerCase());
    const quote = launch ? quoteOf(launch.pairToken, book) : null;
    const seedUsd = quote ? unitsToNumber(g.pairTokenAmount, quote.decimals) * quote.usd : 0;
    // At graduation the pool is seeded at the curve's final price.
    const priceUsd = quote && g.tokenAmount > 0n ? seedUsd / unitsToNumber(g.tokenAmount, 18) : null;
    return {
      token: g.token,
      curve: launch?.curve ?? null,
      symbol: m?.symbol ?? `${g.token.slice(0, 6)}…`,
      name: m?.name ?? "",
      deployer: launch?.deployer ?? null,
      launchedAt: launch ? blockTime(clock, launch.block) : null,
      graduatedAt: blockTime(clock, g.block),
      quoteSymbol: quote?.symbol ?? "",
      paySymbol: "ETH",
      payUsd: book.ethUsd,
      priceUsd,
      mcapUsd: priceUsd !== null ? priceUsd * SUPPLY : null,
      raisedUsd: seedUsd,
      progressPct: 100,
      vol30mUsd: 0,
      net30mUsd: 0,
      txns30m: 0,
      traders30m: 0,
      url: ponsTokenUrl(g.token),
    };
  });

  return { curves, graduated, updatedAt: Date.now() };
}

async function base(provider: RobinhoodChainProvider): Promise<Base> {
  return cache.get("explore:base:v2", BASE_TTL, () => buildBase(provider), { swr: true });
}

type UniverseRow = Omit<ExploreRow, "socials">;

/** A pool from another launchpad or DEX, shaped like a graduated launch. */
function chainRow(p: ChainPool): UniverseRow {
  return {
    token: p.token,
    curve: null,
    symbol: p.symbol,
    name: p.name,
    logoUrl: p.logoUrl,
    deployer: null,
    launchedAt: p.launchedAt,
    graduatedAt: p.launchedAt ?? 0,
    quoteSymbol: p.quoteSymbol,
    paySymbol: p.quoteSymbol || "ETH",
    payUsd: p.quoteUsd,
    priceUsd: p.priceUsd,
    mcapUsd: p.mcapUsd,
    raisedUsd: p.liquidityUsd,
    progressPct: 100,
    vol30mUsd: p.vol30mUsd,
    net30mUsd: p.net30mUsd,
    txns30m: p.buys30m + p.sells30m,
    traders30m: p.traders30m,
    url: p.url,
    launchpad: p.launchpad,
    external: true,
  };
}

/** Pons rows, plus every other launchpad's pools for tokens Pons does not already cover. */
async function withChain(b: Base): Promise<{ pons: UniverseRow[]; chain: UniverseRow[] }> {
  const pons = [...b.curves, ...b.graduated].map((r) => ({ ...r, launchpad: "Pons" }));
  const known = new Set(pons.map((r) => r.token.toLowerCase()));
  const { pools } = await chainPools().catch(() => ({ pools: [] as ChainPool[] }));
  return { pons, chain: pools.filter((p) => !known.has(p.token)).map(chainRow) };
}

/** Every launch SAT sees: Pons curves and graduates, and pools from every other launchpad on the chain. */
export async function exploreUniverse(provider: RobinhoodChainProvider): Promise<{ rows: UniverseRow[]; scanned: number; updatedAt: number }> {
  const b = await base(provider);
  const { pons, chain } = await withChain(b);
  return { rows: [...pons, ...chain], scanned: pons.length + chain.length, updatedAt: b.updatedAt };
}

const DEFAULT_SORT: Record<ExploreTab, ExploreSort> = { all: "volume", new: "age", trending: "volume", almost: "progress", graduated: "age" };

function sortKey(row: UniverseRow, sort: ExploreSort, tab: ExploreTab): number {
  switch (sort) {
    case "age":
      return tab === "graduated" ? (row.graduatedAt ?? 0) : (row.launchedAt ?? 0);
    case "mcap":
      return row.mcapUsd ?? 0;
    case "volume":
      return row.vol30mUsd;
    case "progress":
      return row.progressPct;
    case "txns":
      return row.txns30m;
    case "net":
      return row.net30mUsd;
  }
}

/** Filter, sort and page the table, then attach logos and socials to the rows shown. */
export async function explore(provider: RobinhoodChainProvider, query: ExploreQuery): Promise<ExplorePage> {
  const b = await base(provider);
  const { chain } = await withChain(b);
  const almost = b.curves.filter((r) => r.progressPct < 100 && r.raisedUsd > 0);
  const trending = b.curves.filter((r) => r.txns30m > 0);
  const all = [...trending.map((r) => ({ ...r, launchpad: "Pons" })), ...b.graduated.map((r) => ({ ...r, launchpad: "Pons" })), ...chain];
  const pools: Record<ExploreTab, UniverseRow[]> = { all, new: b.curves, trending, almost, graduated: b.graduated };

  const q = query.q?.trim().toLowerCase().replace(/^\$/, "");
  const sort = query.sort ?? DEFAULT_SORT[query.tab];
  let rows = pools[query.tab].filter((r) => {
    if (q && !r.symbol.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q) && r.token.toLowerCase() !== q && !(r.launchpad ?? "").toLowerCase().includes(q)) return false;
    if (query.minMcap && (r.mcapUsd ?? 0) < query.minMcap) return false;
    if (query.minVol && r.vol30mUsd < query.minVol) return false;
    return true;
  });
  rows = [...rows].sort((x, y) => sortKey(y, sort, query.tab) - sortKey(x, sort, query.tab));

  // Socials live on chain per token; read them for the filter only when asked, and for the page always.
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(300, Math.max(1, query.limit ?? EXPLORE_PAGE));
  let candidates = rows;
  if (query.socials) {
    const window = rows.slice(0, offset + limit * 4);
    const profiles = await getPonsProfiles(window.map((r) => r.token)).catch(() => new Map());
    candidates = window.filter((r) => {
      const s = profiles.get(r.token.toLowerCase())?.socials;
      return !!s && Object.values(s).some(Boolean);
    });
  }
  const page = candidates.slice(offset, offset + limit);
  const profiles = await getPonsProfiles(page.filter((r) => !r.external).map((r) => r.token)).catch(() => new Map());

  return {
    tab: query.tab,
    counts: { all: all.length, new: b.curves.length, trending: trending.length, almost: almost.length, graduated: b.graduated.length },
    total: query.socials ? candidates.length : rows.length,
    rows: page.map((r) => {
      const p = profiles.get(r.token.toLowerCase());
      return { ...r, logoUrl: p?.logoUrl ?? r.logoUrl ?? undefined, socials: p?.socials };
    }),
    scanned: b.curves.length + chain.length,
    updatedAt: b.updatedAt,
  };
}