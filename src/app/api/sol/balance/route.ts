import { NextResponse } from "next/server";
import { isSolanaAddress } from "@/lib/address";
import { errorResponse, rateLimit } from "@/lib/http";
import { solBalance, tokenBalance } from "@/lib/solana/rpc";

export const runtime = "nodejs";

/** A wallet's SOL, and optionally one token's balance: ?owner=&mint= */
export async function GET(req: Request) {
  const limited = rateLimit(req, "sol-balance", 120);
  if (limited) return limited;
  const q = new URL(req.url).searchParams;
  const owner = q.get("owner") ?? "";
  const mint = q.get("mint");
  if (!isSolanaAddress(owner) || (mint && !isSolanaAddress(mint))) return NextResponse.json({ error: "Bad address" }, { status: 400 });
  try {
    const [sol, token] = await Promise.all([solBalance(owner), mint ? tokenBalance(owner, mint) : Promise.resolve(null)]);
    return NextResponse.json({ sol, token: token ? { ui: token.ui, decimals: token.decimals } : null });
  } catch (err) {
    return errorResponse(err, 502);
  }
}
