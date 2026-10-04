import { NextResponse } from "next/server";
import { isSolanaAddress } from "@/lib/address";
import { errorResponse, rateLimit } from "@/lib/http";
import { scanLaunch } from "@/lib/solana/bundle";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Who bought in the launch block, and whether the creator still holds. */
export async function GET(req: Request) {
  const limited = rateLimit(req, "sol-bundle", 30);
  if (limited) return limited;
  const mint = new URL(req.url).searchParams.get("mint") ?? "";
  if (!isSolanaAddress(mint)) return NextResponse.json({ error: "Not a Solana mint" }, { status: 400 });
  try {
    const report = await scanLaunch(mint);
    return NextResponse.json(report, { headers: { "cache-control": "public, s-maxage=120, stale-while-revalidate=600" } });
  } catch (err) {
    return errorResponse(err, 502);
  }
}
