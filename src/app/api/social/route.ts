import { NextResponse } from "next/server";
import { z } from "zod";
import { isTokenAddress } from "@/lib/address";
import { getProvider } from "@/lib/data/provider";
import { RobinhoodChainProvider } from "@/lib/data/robinhood";
import { errorResponse, rateLimit } from "@/lib/http";
import { exploreUniverse } from "@/lib/radar/explore";
import { getSocial } from "@/lib/social/radar";

export const runtime = "nodejs";
export const maxDuration = 60;

const Query = z.object({
  token: z
    .string()
    .refine(isTokenAddress)
    .optional(),
  minFollowers: z.coerce.number().int().min(0).max(1e9).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** "1": only posts from watched accounts. */
  watched: z.enum(["0", "1"]).optional(),
});

/** Who on X is talking about Robinhood Chain tokens, newest first. */
export async function GET(req: Request) {
  const limited = rateLimit(req, "social", 120);
  if (limited) return limited;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Bad query" }, { status: 400 });
  const provider = getProvider();
  if (!(provider instanceof RobinhoodChainProvider)) return NextResponse.json({ error: "Live chain data needed" }, { status: 501 });
  try {
    const { token, minFollowers, limit, watched } = parsed.data;
    const snap = await getSocial(provider);
    const { rows } = await exploreUniverse(provider).catch(() => ({ rows: [] as { token: string; mcapUsd: number | null }[] }));
    const mcap = new Map(rows.map((r) => [r.token.toLowerCase(), r.mcapUsd]));
    const posts = snap.posts
      .filter((p) => (watched === "1" ? p.watched : p.watched || p.author.followers >= minFollowers))
      .filter((p) => !token || p.tokens.some((t) => t.token.toLowerCase() === token.toLowerCase()))
      .slice(0, limit)
      .map((p) => ({ ...p, tokens: p.tokens.map((t) => ({ ...t, mcapUsd: mcap.get(t.token.toLowerCase()) ?? null })) }));
    const tokens = token ? snap.tokens.filter((t) => t.token.toLowerCase() === token.toLowerCase()) : snap.tokens.slice(0, 20);
    return NextResponse.json({ ...snap, posts, tokens }, { headers: { "cache-control": "public, s-maxage=20, stale-while-revalidate=60" } });
  } catch (err) {
    return errorResponse(err, 503);
  }
}
