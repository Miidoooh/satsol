import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, rateLimit } from "@/lib/http";
import { sendSigned, txStatus } from "@/lib/solana/rpc";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({ tx: z.string().min(100).max(4000) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Broadcast a transaction the user's wallet already signed, and wait up to ~40s for confirmation. */
export async function POST(req: Request) {
  const limited = rateLimit(req, "sol-send", 30);
  if (limited) return limited;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Send a signed transaction" }, { status: 400 });
  try {
    const signature = await sendSigned(parsed.data.tx);
    for (let i = 0; i < 20; i++) {
      await sleep(2_000);
      const s = await txStatus(signature).catch(() => ({ status: "pending" as const }));
      if (s.status !== "pending") return NextResponse.json({ signature, ...s });
    }
    return NextResponse.json({ signature, status: "pending" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/slippage|0x1771|insufficient/i.test(msg)) return NextResponse.json({ error: "The price moved past your slippage. Try again or raise slippage." }, { status: 400 });
    return errorResponse(err, 502);
  }
}
