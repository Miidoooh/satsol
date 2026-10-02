import { getLlm, jsonCompletion } from "../agent/llm";
import { picksFor } from "../agent/picks";
import { STYLE_PRESETS, type Pick } from "../agent/strategy";
import { getConfig } from "../config";
import type { RobinhoodChainProvider } from "../data/robinhood";
import { exploreUniverse } from "../radar/explore";
import { buzzLine, getSocial } from "../social/radar";
import { getKv } from "../store/kv";
import { sendButtons, sendMessage, telegramConfig } from "../telegram/telegram";
import { factsOf, recapDue, recapText, scorecardText, templateCall, validCall, writerPrompt, type BotCall } from "./compose";
import { connected, postTweet, repost } from "./x";

/**
 * Satellites Bot: turns the agent's strongest picks into posts on X, follows
 * each call with recaps, and posts an honest daily scorecard. In "approve"
 * mode every draft waits for a tap in the admin Telegram chat.
 */

export type DraftKind = "call" | "recap" | "scorecard";
export type DraftStatus = "pending" | "approved" | "skipped" | "posted" | "failed";

export interface Draft {
  id: string;
  kind: DraftKind;
  text: string;
  createdAt: number;
  status: DraftStatus;
  repost: boolean;
  token?: `0x${string}`;
  symbol?: string;
  score?: number;
  entryMcap?: number;
  stopMcap?: number;
  reviewSent?: boolean;
  tweetUrl?: string;
  error?: string;
}

const DRAFTS = "bot:drafts:v1";
const CALLS = "bot:calls:v1";
const DAY_S = 24 * 3600;
/** A call draft is stale after an hour; the market has moved on. */
const CALL_DRAFT_TTL_S = 3600;
const OTHER_DRAFT_TTL_S = 6 * 3600;
const MIN_SCORE = 80;
const REPOST_SCORE = 90;
const REPOST_RECAP_X = 3;
const STYLES = ["momentum", "whale", "sniper", "graduation"] as const;

const nowS = () => Math.floor(Date.now() / 1000);
const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function load<T>(key: string): Promise<T[]> {
  return (await getKv().get<T[]>(key).catch(() => null)) ?? [];
}

async function save(drafts: Draft[], calls: BotCall[]) {
  const now = nowS();
  await getKv().set(DRAFTS, drafts.filter((d) => now - d.createdAt <= 3 * DAY_S).slice(-200));
  await getKv().set(CALLS, calls.filter((c) => now - c.at <= 3 * DAY_S).slice(-300));
}

/** The writer's version when it passes every check, otherwise the template. */
export async function writeCall(p: Pick, buzz: string | null): Promise<string> {
  const f = factsOf(p, buzz);
  const llm = getLlm("low");
  if (llm) {
    try {
      const { system, user } = writerPrompt(f);
      const out = (await jsonCompletion(llm, system, user)) as { text?: string };
      const text = out.text?.trim();
      if (text && validCall(text, f)) return text;
    } catch {
      // Fall through to the template.
    }
  }
  return templateCall(f);
}

/** The strongest pick across every preset that the bot has not called today. */
async function bestCandidate(provider: RobinhoodChainProvider, called: Set<string>): Promise<Pick | null> {
  const results = await Promise.all(STYLES.map((s) => picksFor(provider, STYLE_PRESETS[s], 6).catch(() => null)));
  let best: Pick | null = null;
  for (const r of results) {
    for (const p of r?.picks ?? []) {
      if (p.score < MIN_SCORE || p.warnings.length || p.mcapUsd < 5_000 || called.has(p.token.toLowerCase())) continue;
      if (p.safety && p.safety.score < 50) continue;
      if (!best || p.score > best.score) best = p;
    }
  }
  return best;
}

async function notifyAdmin(html: string) {
  const tg = telegramConfig();
  const chat = getConfig().BOT_ADMIN_CHAT_ID;
  if (tg && chat) await sendMessage(tg, chat, html).catch(() => undefined);
}

async function publish(d: Draft, calls: BotCall[]) {
  try {
    const posted = await postTweet("bot", d.text);
    d.status = "posted";
    d.tweetUrl = posted.url;
    if (d.kind === "call" && d.token && d.entryMcap) {
      calls.push({
        id: d.id,
        token: d.token,
        symbol: d.symbol ?? "",
        at: nowS(),
        entryMcap: d.entryMcap,
        peakMcap: d.entryMcap,
        lastMcap: d.entryMcap,
        stopMcap: d.stopMcap ?? 0,
        recapped: [],
        stoppedOut: false,
        tweetUrl: posted.url,
      });
    }
    if (d.repost) {
      const ok = (await connected("main")) ? await repost("main", posted.id).then(() => true, () => false) : false;
      if (!ok) await notifyAdmin(`Repost this from the main account: ${posted.url}`);
    }
  } catch (err) {
    d.status = "failed";
    d.error = err instanceof Error ? err.message : String(err);
    await notifyAdmin(`⚠️ Bot post failed: ${d.error}`);
  }
}

async function sendForReview(d: Draft) {
  const tg = telegramConfig();
  const chat = getConfig().BOT_ADMIN_CHAT_ID;
  if (!tg || !chat) return;
  const head = d.kind === "call" ? `🛰 Bot draft · call · fit ${d.score ?? "?"}${d.repost ? " · will repost" : ""}` : `🛰 Bot draft · ${d.kind}${d.repost ? " · will repost" : ""}`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  await sendButtons(tg, chat, `<b>${head}</b>\n\n${esc(d.text)}`, [
    [
      { text: "✅ Post", data: `bot:post:${d.id}` },
      { text: "⏭ Skip", data: `bot:skip:${d.id}` },
    ],
  ]);
  d.reviewSent = true;
}

export interface BotRun {
  mode: string;
  created: DraftKind[];
  posted: number;
}

/** One pass of the bot. Safe to run every few minutes. */
export async function runBot(provider: RobinhoodChainProvider): Promise<BotRun> {
  const cfg = getConfig();
  const run: BotRun = { mode: cfg.BOT_MODE, created: [], posted: 0 };
  if (cfg.BOT_MODE === "off") return run;
  const kv = getKv();
  const now = nowS();
  const drafts = await load<Draft>(DRAFTS);
  const calls = await load<BotCall>(CALLS);
  const add = (d: Omit<Draft, "id" | "createdAt" | "status">) => {
    drafts.push({ ...d, id: id(), createdAt: now, status: "pending" });
    run.created.push(d.kind);
  };

  // Mark every live call and celebrate new multiples.
  const { rows } = await exploreUniverse(provider);
  const marks = new Map(rows.filter((r) => r.mcapUsd).map((r) => [r.token.toLowerCase(), r.mcapUsd as number]));
  for (const c of calls) {
    const m = marks.get(c.token.toLowerCase());
    if (!m) continue;
    c.lastMcap = m;
    c.peakMcap = Math.max(c.peakMcap, m);
    if (c.stopMcap && m <= c.stopMcap) c.stoppedOut = true;
    const x = c.stoppedOut ? null : recapDue(c);
    if (x) {
      c.recapped.push(x);
      add({ kind: "recap", text: recapText(c, x), token: c.token, symbol: c.symbol, repost: x >= REPOST_RECAP_X });
    }
  }

  // A new call, within the daily cap and the minimum gap.
  const recentCalls = drafts.filter((d) => d.kind === "call" && now - d.createdAt <= DAY_S && d.status !== "skipped" && d.status !== "failed");
  const lastAt = Math.max(0, ...recentCalls.map((d) => d.createdAt));
  if (recentCalls.length < cfg.BOT_MAX_CALLS_PER_DAY && now - lastAt >= cfg.BOT_MIN_GAP_MIN * 60) {
    const called = new Set(drafts.filter((d) => d.kind === "call" && now - d.createdAt <= DAY_S && d.token).map((d) => d.token!.toLowerCase()));
    const pick = await bestCandidate(provider, called);
    if (pick) {
      const social = await getSocial(provider, false).catch(() => null);
      const b = social?.tokens.find((t) => t.token.toLowerCase() === pick.token.toLowerCase());
      add({
        kind: "call",
        text: await writeCall(pick, b ? buzzLine(b) : null),
        token: pick.token,
        symbol: pick.symbol,
        score: pick.score,
        entryMcap: pick.mcapUsd,
        stopMcap: pick.plan.stop.mcap,
        repost: pick.score >= REPOST_SCORE,
      });
    }
  }

  // The daily scorecard, once, in the evening UTC.
  const dayKey = `bot:scorecard:${new Date().toISOString().slice(0, 10)}`;
  if (new Date().getUTCHours() >= 20 && !(await kv.get(dayKey))) {
    const text = scorecardText(calls, now);
    if (text) add({ kind: "scorecard", text, repost: true });
    await kv.set(dayKey, 1, 2 * DAY_S * 1000);
  }

  for (const d of drafts) {
    if (d.status !== "pending") continue;
    if (now - d.createdAt > (d.kind === "call" ? CALL_DRAFT_TTL_S : OTHER_DRAFT_TTL_S)) d.status = "skipped";
    else if (cfg.BOT_MODE === "auto") d.status = "approved";
    else if (!d.reviewSent) await sendForReview(d).catch(() => undefined);
  }
  for (const d of drafts) {
    if (d.status !== "approved") continue;
    await publish(d, calls);
    if ((d.status as DraftStatus) === "posted") run.posted++;
  }
  await save(drafts, calls);
  return run;
}

/** A tap on a review button in the admin chat. */
export async function reviewDraft(draftId: string, decision: "post" | "skip"): Promise<string> {
  const drafts = await load<Draft>(DRAFTS);
  const calls = await load<BotCall>(CALLS);
  const d = drafts.find((x) => x.id === draftId);
  if (!d) return "That draft is gone.";
  if (d.status !== "pending") return `Already ${d.status}.`;
  if (decision === "skip") {
    d.status = "skipped";
  } else if (d.kind === "call" && nowS() - d.createdAt > CALL_DRAFT_TTL_S) {
    d.status = "skipped";
    await save(drafts, calls);
    return "Too late: this call is over an hour old, so it was skipped.";
  } else {
    d.status = "approved";
    await publish(d, calls);
  }
  await save(drafts, calls);
  const status = d.status as DraftStatus;
  return status === "posted" ? `✅ Posted: ${d.tweetUrl}` : status === "skipped" ? "⏭ Skipped." : `⚠️ ${d.error ?? status}`;
}

export async function botStatus() {
  const cfg = getConfig();
  const drafts = await load<Draft>(DRAFTS);
  const calls = await load<BotCall>(CALLS);
  return {
    mode: cfg.BOT_MODE,
    accounts: { bot: await connected("bot"), main: await connected("main") },
    limits: { callsPerDay: cfg.BOT_MAX_CALLS_PER_DAY, minGapMin: cfg.BOT_MIN_GAP_MIN },
    drafts: drafts.slice(-30).reverse(),
    calls: calls.slice(-30).reverse(),
  };
}
