import { NextResponse } from "next/server";
import { isSolanaAddress } from "@/lib/address";
import { errorResponse, rateLimit } from "@/lib/http";
import { solSafety } from "@/lib/solana/safety";

export const runtime = "nodejs";

/** Rug check for a Solana token: ?mint=&liq=&launched= (the last two optional, from the token page). */
export async function GET(req: Request) {
  const limited = rateLimit(req, "sol-safety", 60);
  if (limited) return limited;
  const q = new URL(req.url).searchParams;
  const mint = q.get("mint") ?? "";
  if (!isSolanaAddress(mint)) return NextResponse.json({ error: "Not a Solana mint" }, { status: 400 });
  const liq = Number(q.get("liq"));
  const launched = Number(q.get("launched"));
  try {
    const safety = await solSafety(mint, { liquidityUsd: Number.isFinite(liq) && liq > 0 ? liq : null, launchedAt: Number.isFinite(launched) && launched > 0 ? launched : null });
    return NextResponse.json(safety, { headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch (err) {
    return errorResponse(err, 502);
  }
}
