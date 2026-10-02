import { NextResponse } from "next/server";
import { z } from "zod";
import { isSolanaAddress } from "@/lib/address";
import { getConfig } from "@/lib/config";
import { errorResponse, rateLimit } from "@/lib/http";
import { buildSwap, quoteSol, SolIntentSchema } from "@/lib/solana/jupiter";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  intent: SolIntentSchema,
  wallet: z.string().refine(isSolanaAddress).nullable().optional(),
  /** true: return the unsigned transaction too. */
  build: z.boolean().optional(),
});

/** Quote a Solana swap, and with build=true return the transaction for the wallet to sign. */
export async function POST(req: Request) {
  const limited = rateLimit(req, "sol-trade", 60);
  if (limited) return limited;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Bad trade" }, { status: 400 });
  const { intent, wallet, build } = parsed.data;
  if (build && !getConfig().SAT_ENABLE_TRADING) return NextResponse.json({ error: "Trading is switched off on this server." }, { status: 403 });
  if (build && !wallet) return NextResponse.json({ error: "Connect a wallet to trade." }, { status: 400 });
  try {
    const { quote, raw } = await quoteSol(intent, wallet ?? null);
    const tx = build && wallet ? await buildSwap(raw, wallet) : null;
    return NextResponse.json({ quote, tx });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cap|guardrail|Not enough|No route|Give an|Nothing to sell|Connect a wallet|Slippage/.test(msg)) return NextResponse.json({ error: msg }, { status: 400 });
    return errorResponse(err, 502);
  }
}
