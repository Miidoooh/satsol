import { NextResponse } from "next/server";
import { getProvider } from "@/lib/data/provider";
import { RobinhoodChainProvider } from "@/lib/data/robinhood";
import { errorResponse, rateLimit } from "@/lib/http";
import { callerBoard } from "@/lib/social/leaderboard";

export const runtime = "nodejs";
export const maxDuration = 60;

/** How the accounts on X did after they named a Solana token. */
export async function GET(req: Request) {
  const limited = rateLimit(req, "leaderboard", 30);
  if (limited) return limited;
  const provider = getProvider();
  if (!(provider instanceof RobinhoodChainProvider)) return NextResponse.json({ error: "Live chain data needed" }, { status: 501 });
  try {
    const board = await callerBoard(provider);
    return NextResponse.json(board, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err, 503);
  }
}
