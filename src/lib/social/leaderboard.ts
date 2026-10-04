import { addrKey, isSolanaAddress } from "../address";
import type { RobinhoodChainProvider } from "../data/robinhood";
import { chainPools, type ChainPool } from "../radar/chainwide";
import { getSocial } from "./radar";

/**
 * Caller leaderboard. Every X post that names a Solana token is a call.
 * The price at that moment comes from the pool's candles; the multiple is
 * the best price after the call, divided by the price when they posted.
 */

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
/** How many tokens to price. One new candle request per refresh, so the board fills without tripping the rate limit. */
const TOP = 12;
const CANDLE_MS = 5 * 60_000;

interface Mention {
  handle: string;
  name: string;
  followers: number;
  avatar?: string;
  token: string;
  symbol: string;
  at: number;
}

/** Contract addresses written in a post. */
function mintsIn(text: string): string[] {
  const mints = new Set<string>();
  for (const m of text.matchAll(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)) {
    if (isSolanaAddress(m[0])) mints.add(m[0]);
  }
  return [...mints];
}

export interface CallPoint {
  handle: string;
  name: string;
  followers: number;
  avatar?: string;
  token: string;
  symbol: string;
  at: number;
  entry: number;
  now: number;
  peak: number;
}

export interface CallerRank {
  handle: string;
  name: string;
  followers: number;
  avatar?: string;
  calls: number;
  /** Share of calls whose peak was at least 2x the price at the post. */
  hit2x: number;
  /** Median peak multiple. */
  medianX: number;
  best: { symbol: string; token: string; multiple: number };
}

export interface CallerBoard {
  callers: CallerRank[];
  recent: CallPoint[];
  pricedTokens: number;
  /** Tokens people called that do not have a candle read yet. */
  pending: number;
}

interface Candle {
  time: number;
  open: number;
  high: number;
  close: number;
}

const multiple = (p: CallPoint) => (p.entry > 0 ? p.peak / p.entry : 0);

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** One call per caller per token: the earliest post. */
export function dedupeCalls(points: CallPoint[]): CallPoint[] {
  const out = new Map<string, CallPoint>();
  for (const p of points) {
    const key = `${p.handle.toLowerCase()}:${p.token}`;
    const prev = out.get(key);
    if (!prev || p.at < prev.at) out.set(key, p);
  }
  return [...out.values()];
}

/** Rank callers with at least two priced calls ahead of everyone else. */
export function rankCallers(points: CallPoint[]): CallerRank[] {
  const by = new Map<string, CallPoint[]>();
  for (const p of dedupeCalls(points)) {
    const key = p.handle.toLowerCase();
    const list = by.get(key) ?? [];
    list.push(p);
    by.set(key, list);
  }
  const ranks: CallerRank[] = [];
  for (const calls of by.values()) {
    const xs = calls.map(multiple).filter((n) => n > 0);
    if (!xs.length) continue;
    const best = calls.reduce((a, b) => (multiple(b) > multiple(a) ? b : a));
    const head = calls[0];
    ranks.push({
      handle: head.handle,
      name: head.name,
      followers: Math.max(...calls.map((c) => c.followers)),
      avatar: head.avatar,
      calls: calls.length,
      hit2x: xs.filter((n) => n >= 2).length / xs.length,
      medianX: median(xs),
      best: { symbol: best.symbol, token: best.token, multiple: multiple(best) },
    });
  }
  return ranks.sort((a, b) => {
    const aReady = a.calls >= 2;
    const bReady = b.calls >= 2;
    if (aReady !== bReady) return aReady ? -1 : 1;
    return b.hit2x - a.hit2x || b.medianX - a.medianX || b.calls - a.calls;
  });
}

/** Entry, latest and peak price for a call, from candles. Null when the call is older than the candles. */
export function priceCall(candles: Candle[], at: number, live: number): { entry: number; now: number; peak: number } | null {
  if (!candles.length || !(live > 0)) return null;
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  // A call a little before the first candle still counts: they posted as it launched.
  if (at < sorted[0].time - 1800) return null;
  const before = [...sorted].reverse().find((c) => c.time <= at);
  const entry = before?.close || sorted[0].open;
  if (!(entry > 0)) return null;
  const from = before?.time ?? sorted[0].time;
  const peak = Math.max(live, ...sorted.filter((c) => c.time >= from).map((c) => c.high));
  return { entry, now: live, peak };
}

const savedCandles = new Map<string, { rows: Candle[]; at: number }>();
const savedMarkets = new Map<string, { symbol: string; pool: string; priceUsd: number | null; at: number }>();
let limitedUntil = 0;

function freshCandles(pool: string): Candle[] | null {
  const hit = savedCandles.get(pool);
  if (!hit || Date.now() - hit.at > CANDLE_MS) return null;
  return hit.rows;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One pool's candles. A 429 waits out the gap and tries once more, instead of caching a blank board. */
async function loadCandles(pool: string): Promise<Candle[] | null> {
  const hit = freshCandles(pool);
  if (hit) return hit;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (Date.now() < limitedUntil) await sleep(Math.min(3_000, limitedUntil - Date.now()));
    const res = await fetch(`${GT}/pools/${pool}/ohlcv/minute?aggregate=5&limit=300&currency=usd`, {
      headers: { accept: "application/json;version=20230302" },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    if (res.status === 429) {
      limitedUntil = Date.now() + 2_500;
      continue;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const rows = (body.data?.attributes?.ohlcv_list ?? []).map(([time, open, high, , close]) => ({
      time: time > 1e12 ? Math.floor(time / 1000) : time,
      open,
      high,
      close,
    }));
    if (!rows.length) return null;
    savedCandles.set(pool, { rows, at: Date.now() });
    return rows;
  }
  return null;
}

function remember(map: Map<string, Mention>, m: Mention) {
  if (!isSolanaAddress(m.token)) return;
  const key = `${m.handle.toLowerCase()}:${addrKey(m.token)}`;
  const prev = map.get(key);
  if (!prev || m.at < prev.at) map.set(key, m);
}

function callsFrom(posts: { author: { userName: string; name: string; followers: number; avatar?: string }; at: number; text: string; tokens: { token: string; symbol: string }[] }[]): Mention[] {
  const earliest = new Map<string, Mention>();
  for (const post of posts) {
    const who = { handle: post.author.userName, name: post.author.name, followers: post.author.followers, avatar: post.author.avatar, at: post.at };
    for (const t of post.tokens) remember(earliest, { ...who, token: t.token, symbol: t.symbol });
    for (const mint of mintsIn(post.text)) {
      if ([...earliest.keys()].some((k) => k.endsWith(`:${addrKey(mint)}`) && k.startsWith(`${post.author.userName.toLowerCase()}:`))) continue;
      remember(earliest, { ...who, token: mint, symbol: `${mint.slice(0, 4)}…` });
    }
  }
  return [...earliest.values()];
}

async function build(provider: RobinhoodChainProvider): Promise<CallerBoard> {
  const snap = await getSocial(provider);
  const calls = callsFrom(snap.posts);
  const { pools } = await chainPools().catch(() => ({ pools: [] as ChainPool[] }));
  const byMint = new Map(pools.map((p) => [addrKey(p.token), p]));

  const counts = new Map<string, number>();
  for (const c of calls) counts.set(addrKey(c.token), (counts.get(addrKey(c.token)) ?? 0) + 1);
  const spelling = new Map<string, string>();
  for (const c of calls) if (!spelling.has(addrKey(c.token))) spelling.set(addrKey(c.token), c.token);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([token]) => token);
  const extra = new Map<string, { symbol: string; pool: string; priceUsd: number | null }>();
  const marketOf = (token: string) => {
    const known = byMint.get(token);
    if (known) return { symbol: known.symbol, pool: known.pool, priceUsd: known.priceUsd };
    const saved = savedMarkets.get(token);
    if (saved && Date.now() - saved.at < CANDLE_MS) return saved;
    return extra.get(token) ?? null;
  };

  const queued = ranked.find((t) => {
    const m = marketOf(t);
    return m && !freshCandles(m.pool);
  });
  if (queued) await loadCandles(marketOf(queued)!.pool);
  else {
    const stray = ranked.find((t) => !marketOf(t));
    const mint = stray ? spelling.get(stray) : undefined;
    if (mint && Date.now() >= limitedUntil) {
      const found = await lookupPool(mint);
      if (found) {
        const row = { ...found, at: Date.now() };
        savedMarkets.set(stray!, row);
        extra.set(stray!, row);
        await loadCandles(found.pool);
      }
    }
  }

  const points: CallPoint[] = [];
  const read = new Set<string>();
  for (const call of calls) {
    const key = addrKey(call.token);
    const market = marketOf(key);
    const rows = market ? freshCandles(market.pool) : null;
    if (!market || !rows) continue;
    read.add(key);
    const latest = rows.reduce((a, b) => (a.time > b.time ? a : b));
    const live = market.priceUsd || latest.close;
    const pricedCall = priceCall(rows, call.at, live);
    if (!pricedCall) continue;
    points.push({ ...call, symbol: call.symbol.includes("…") ? market.symbol : call.symbol, ...pricedCall });
  }
  const recent = dedupeCalls(points).sort((a, b) => b.at - a.at).slice(0, 12);
  return { callers: rankCallers(points), recent, pricedTokens: read.size, pending: ranked.filter((t) => !read.has(t)).length };
}

/** Pool and price for a mint that is not on the trending list. One request; a 429 just waits. */
async function lookupPool(mint: string): Promise<{ symbol: string; pool: string; priceUsd: number | null } | null> {
  const res = await fetch(`${GT}/tokens/${mint}?include=top_pools`, {
    headers: { accept: "application/json;version=20230302" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (res.status === 429) {
    limitedUntil = Date.now() + 12_000;
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json()) as {
    data?: { attributes?: { symbol?: string; price_usd?: string } };
    included?: { type: string; attributes: { address?: string; volume_usd?: { h24?: string } } }[];
  };
  const price = Number(body.data?.attributes?.price_usd);
  const pools = (body.included ?? []).filter((i) => i.type === "pool" && i.attributes.address);
  const pool = [...pools].sort((a, b) => Number(b.attributes.volume_usd?.h24 ?? 0) - Number(a.attributes.volume_usd?.h24 ?? 0))[0];
  if (!pool?.attributes.address) return null;
  return { symbol: body.data?.attributes?.symbol || mint.slice(0, 4), pool: pool.attributes.address, priceUsd: price > 0 ? price : null };
}

let flight: Promise<CallerBoard> | null = null;
let last: { board: CallerBoard; at: number } | null = null;

/** The leaderboard. Each call prices one more token, so a refresh never sits on an empty cached miss. */
export function callerBoard(provider: RobinhoodChainProvider): Promise<CallerBoard> {
  if (last && Date.now() - last.at < 8_000) return Promise.resolve(last.board);
  if (!flight) {
    flight = build(provider)
      .then((board) => {
        last = { board, at: Date.now() };
        return board;
      })
      .finally(() => {
        flight = null;
      });
  }
  return flight;
}
