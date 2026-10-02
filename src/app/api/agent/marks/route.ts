import { NextResponse } from "next/server";
import { z } from "zod";
import { getProvider } from "@/lib/data/provider";
import { RobinhoodChainProvider } from "@/lib/data/robinhood";
import { errorResponse, rateLimit } from "@/lib/http";
import { addrKey, isTokenAddress } from "@/lib/address";
import { getConfig } from "@/lib/config";
import { tokenMarks } from "@/lib/radar/chainwide";
import { exploreUniverse } from "@/lib/radar/explore";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Every Pons launch has a fixed one-billion supply. */
const SUPPLY = 1_000_000_000;
const MAX_LOOKUPS = 6;

const Query = z.object({
  tokens: z
    .string()
    .transform((v) => [...new Set(v.split(",").map((t) => t.trim()))].filter(isTokenAddress))
    .pipe(z.array(z.string()).min(1).max(40)),
});

/** Current market cap and price for the tokens a user is tracking against their plan. */
export async function GET(req: Request) {
  const limited = rateLimit(req, "agent-marks", 120);
  if (limited) return limited;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Pass up to 40 token addresses in ?tokens=" }, { status: 400 });
  const provider = getProvider();
  if (!(provider instanceof RobinhoodChainProvider)) return NextResponse.json({ error: "Live chain data needed" }, { status: 501 });
  try {
    const { rows } = await exploreUniverse(provider);
    const byToken = new Map(rows.map((r) => [r.token.toLowerCase(), r]));
    const marks: Record<string, { mcapUsd: number; priceUsd: number }> = {};
    const missing: string[] = [];
    for (const t of parsed.data.tokens) {
      const r = byToken.get(addrKey(t));
      if (r?.mcapUsd && r.priceUsd) marks[addrKey(t)] = { mcapUsd: r.mcapUsd, priceUsd: r.priceUsd };
      else missing.push(t);
    }
    // Tokens that fell out of the scan are read directly.
    if (getConfig().SAT_CHAIN === "solana") {
      for (const [k, v] of await tokenMarks(missing)) marks[k] = v;
      return NextResponse.json({ marks, at: Date.now() });
    }
    await Promise.all(
      missing.slice(0, MAX_LOOKUPS).map(async (t) => {
        const m = await provider.findToken(t).catch(() => null);
        if (m && m.priceUsd > 0) marks[addrKey(t)] = { mcapUsd: m.priceUsd * SUPPLY, priceUsd: m.priceUsd };
      }),
    );
    return NextResponse.json({ marks, at: Date.now() });
  } catch (err) {
    return errorResponse(err, 503);
  }
}
