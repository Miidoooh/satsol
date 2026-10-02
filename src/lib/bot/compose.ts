import { fmtUsd } from "../format";
import type { Pick } from "../agent/strategy";

/**
 * What the bot says. Every number in a post comes from these facts; the
 * writer may only rephrase around them, and anything it adds is rejected.
 */

export const TWEET_MAX = 280;

export interface CallFacts {
  symbol: string;
  token: `0x${string}`;
  launchpad: string;
  mcap: string;
  age: string | null;
  buyers: string;
  net: string | null;
  targetX: string;
  targetMcap: string;
  stopPct: string;
  safety: string | null;
  buzz: string | null;
}

export interface BotCall {
  id: string;
  token: `0x${string}`;
  symbol: string;
  at: number;
  entryMcap: number;
  peakMcap: number;
  lastMcap: number;
  stopMcap: number;
  /** Multiples already celebrated in a recap. */
  recapped: number[];
  stoppedOut: boolean;
  tweetUrl?: string;
}

const money = (n: number) => fmtUsd(n, { compact: true });
const age = (min: number | null) => (min === null ? null : min < 120 ? `${min}m` : `${Math.round(min / 60)}h`);

export function factsOf(p: Pick, buzz?: string | null): CallFacts {
  const t = p.plan.targets[0];
  return {
    symbol: p.symbol,
    token: p.token,
    launchpad: p.launchpad,
    mcap: money(p.mcapUsd),
    age: age(p.ageMin),
    buyers: String(p.buyers30m),
    net: p.net30mUsd > 0 ? money(p.net30mUsd) : null,
    targetX: `${t.atX}×`,
    targetMcap: money(t.mcap),
    stopPct: `${p.plan.stop.pct}%`,
    safety: p.safety ? `${p.safety.score}` : null,
    buzz: buzz ?? null,
  };
}

/** The plain version, always within the limit. */
export function templateCall(f: CallFacts): string {
  const lines = [
    `🛰 New call: $${f.symbol}`,
    "",
    `${f.launchpad} · ${f.mcap} mcap${f.age ? ` · ${f.age} old` : ""}`,
    `${f.buyers} wallets in 30m${f.net ? ` · ${f.net} net buying` : ""}${f.safety ? ` · safety ${f.safety}` : ""}`,
    `Plan: half out at ${f.targetX} (${f.targetMcap}), stop −${f.stopPct}`,
    "",
    `CA: ${f.token}`,
    "NFA",
  ];
  return lines.join("\n");
}

const NUMBER = /\d+(?:[.,]\d+)*/g;

/** Every number a call may contain, normalised. */
function allowedNumbers(f: CallFacts): Set<string> {
  const pool = [f.mcap, f.age, f.buyers, f.net, f.targetX, f.targetMcap, f.stopPct, f.safety, f.buzz, f.token, f.symbol, f.launchpad, "30", "24"].filter(Boolean).join(" ");
  return new Set((pool.match(NUMBER) ?? []).map((n) => n.replace(/,/g, "")));
}

/** Accept the writer's text only when it is safe to post as-is. */
export function validCall(text: string, f: CallFacts): boolean {
  if (!text || text.length > TWEET_MAX) return false;
  if (!text.includes(`$${f.symbol}`) || !text.includes(f.token)) return false;
  if (/https?:\/\/|www\.|@\w/i.test(text)) return false;
  if (/guarantee|100x|can'?t lose|risk.?free|moon\s*soon/i.test(text)) return false;
  const allowed = allowedNumbers(f);
  const withoutCa = text.replace(f.token, "");
  return (withoutCa.match(NUMBER) ?? []).every((n) => allowed.has(n.replace(/,/g, "")));
}

/** A recap when a posted call reaches a new multiple. */
export function recapText(c: BotCall, x: number): string {
  return [`📈 $${c.symbol} update`, "", `Called at ${money(c.entryMcap)} mcap.`, `Now ${money(c.lastMcap)}: ${x}× from the call.`, "", "Plan said take some off. NFA"].join("\n");
}

/** The next multiple worth a recap, if the peak just crossed one. */
export function recapDue(c: BotCall): number | null {
  const x = c.peakMcap / c.entryMcap;
  const due = [2, 3, 5, 10, 20].filter((m) => x >= m && !c.recapped.includes(m));
  return due.length ? Math.max(...due) : null;
}

/** The honest daily scorecard: hits and misses. */
export function scorecardText(calls: BotCall[], now: number): string | null {
  const day = calls.filter((c) => now - c.at <= 24 * 3600);
  if (day.length === 0) return null;
  const xs = day.map((c) => ({ c, x: c.peakMcap / c.entryMcap })).sort((a, b) => b.x - a.x);
  const hit2 = xs.filter((v) => v.x >= 2).length;
  const stopped = day.filter((c) => c.stoppedOut).length;
  const best = xs[0];
  return [
    "🛰 Satellites scorecard, last 24h",
    "",
    `${day.length} call${day.length === 1 ? "" : "s"} · ${hit2} hit 2× · ${stopped} hit the stop`,
    best && best.x > 1 ? `Best: $${best.c.symbol} ${best.x.toFixed(1)}× from the call` : "No call is up yet",
    "",
    "Every call is logged, wins and losses. NFA",
  ].join("\n");
}

export function writerPrompt(f: CallFacts): { system: string; user: string } {
  return {
    system: `You write posts for Satellites Bot, an automated X account that calls memecoins on Robinhood Chain.
Voice: confident, short, crypto-native, no cringe. Plain words.
Hard rules:
- Use ONLY the facts given. Every number must appear exactly as written in the facts. Never invent numbers, targets or claims.
- Include the cashtag $${f.symbol} and the full contract address on its own line starting with "CA: ".
- No links, no @mentions, no hashtags, no promises of profit.
- End with "NFA".
- At most 260 characters in total.
Reply with JSON: {"text": "..."}`,
    user: JSON.stringify(f),
  };
}
