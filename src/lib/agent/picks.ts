import { cache } from "../cache";
import { ponsTokenDetail } from "../data/ponsToken";
import { getPonsProfiles } from "../data/ponsProfile";
import type { RobinhoodChainProvider } from "../data/robinhood";
import { exploreUniverse } from "../radar/explore";
import { buzzLine, getSocial } from "../social/radar";
import { fitScore, flagCopycats, matchPicks, rejectReason, type Candidate, type Pick, type Strategy } from "./strategy";

/** Launches checked for socials per request; profiles are one multicall per token. */
const PROFILE_WINDOW = 120;
const SAFETY_TTL_MS = 5 * 60_000;

export interface PicksResult {
  picks: Pick[];
  /** Launches that passed every filter that needs no extra reads. */
  matched: number;
  scanned: number;
  updatedAt: number;
}

async function safetyOf(provider: RobinhoodChainProvider, tokens: `0x${string}`[]): Promise<Map<string, { score: number; label: string }>> {
  const book = await provider.quoteBook();
  const out = new Map<string, { score: number; label: string }>();
  // A few at a time: each detail reads holders and recent trades.
  for (let i = 0; i < tokens.length; i += 4) {
    const batch = tokens.slice(i, i + 4);
    const results = await Promise.all(
      batch.map((t) =>
        cache
          .get(`agent:safety:${t.toLowerCase()}`, SAFETY_TTL_MS, async () => {
            const d = await ponsTokenDetail(t, book);
            return d ? { score: d.safety.score, label: d.safety.label } : null;
          })
          .catch(() => null),
      ),
    );
    batch.forEach((t, j) => {
      const r = results[j];
      if (r) out.set(t.toLowerCase(), r);
    });
  }
  return out;
}

/**
 * A basic check for tokens outside Pons, where holder and curve data are not
 * read: how deep the pool is, and how deep relative to the market cap.
 */
export function poolSafety(liquidityUsd: number, mcapUsd: number): { score: number; label: string } {
  const ratio = mcapUsd > 0 ? liquidityUsd / mcapUsd : 0;
  if (liquidityUsd >= 25_000 && ratio >= 0.05) return { score: 70, label: "Deep pool" };
  if (liquidityUsd >= 8_000) return { score: 58, label: "Pool OK" };
  if (liquidityUsd >= 2_000) return { score: 45, label: "Thin pool" };
  return { score: 25, label: "Very thin pool" };
}

/** The launches that fit a style right now, best first, each with its plan. */
export async function picksFor(provider: RobinhoodChainProvider, s: Strategy, limit = 8): Promise<PicksResult> {
  const { rows, scanned, updatedAt } = await exploreUniverse(provider);
  const now = Math.floor(Date.now() / 1000);
  const loose = { ...s, requireSocials: false };
  const pre = rows
    .filter((r) => rejectReason(loose, r, now) === null)
    .sort((a, b) => fitScore(s, b, now) - fitScore(s, a, now))
    .slice(0, PROFILE_WINDOW);
  const profiles = await getPonsProfiles(pre.filter((r) => !r.external).map((r) => r.token)).catch(() => new Map());
  const candidates: Candidate[] = pre.map((r) => {
    const p = profiles.get(r.token.toLowerCase());
    return { ...r, logoUrl: p?.logoUrl ?? r.logoUrl ?? undefined, socials: p?.socials };
  });

  const strictSafety = s.minSafety !== undefined;
  const shortlist = matchPicks(s, candidates, now, { limit: strictSafety ? limit * 2 : limit });
  const top = shortlist.slice(0, strictSafety ? limit * 2 : 6);
  const safety = await safetyOf(
    provider,
    top.filter((p) => !p.external).map((p) => p.token),
  ).catch(() => new Map<string, { score: number; label: string }>());
  const byToken = new Map(candidates.map((c) => [c.token.toLowerCase(), c]));
  for (const p of top) {
    const c = byToken.get(p.token.toLowerCase());
    if (p.external && c) safety.set(p.token.toLowerCase(), poolSafety(c.raisedUsd ?? 0, c.mcapUsd ?? 0));
  }
  const picks = flagCopycats(matchPicks(s, candidates, now, { limit, safety: strictSafety || safety.size ? safety : undefined }), rows);
  const social = await getSocial(provider, false).catch(() => null);
  const buzz = new Map((social?.tokens ?? []).map((b) => [b.token.toLowerCase(), b]));
  for (const p of picks) {
    const b = buzz.get(p.token.toLowerCase());
    if (b) p.reasons.push(`📣 ${buzzLine(b)}`);
  }
  return { picks, matched: pre.length, scanned, updatedAt };
}
