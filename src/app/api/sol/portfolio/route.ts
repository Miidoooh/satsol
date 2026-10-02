import { NextResponse } from "next/server";
import { isSolanaAddress } from "@/lib/address";
import { errorResponse, rateLimit } from "@/lib/http";
import { rpc } from "@/lib/solana/rpc";

export const runtime = "nodejs";

interface DasAsset {
  id: string;
  interface: string;
  content?: { metadata?: { name?: string; symbol?: string }; links?: { image?: string } };
  token_info?: { balance?: number; decimals?: number; symbol?: string; price_info?: { price_per_token?: number; total_price?: number } };
}

export interface SolHolding {
  mint: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  amount: number;
  priceUsd: number | null;
  valueUsd: number | null;
}

/** A Solana wallet's SOL and token holdings with USD values, from Helius DAS. */
export async function GET(req: Request) {
  const limited = rateLimit(req, "sol-portfolio", 60);
  if (limited) return limited;
  const owner = new URL(req.url).searchParams.get("owner") ?? "";
  if (!isSolanaAddress(owner)) return NextResponse.json({ error: "Not a Solana wallet" }, { status: 400 });
  try {
    const r = await rpc<{ items: DasAsset[]; nativeBalance?: { lamports: number; price_per_sol?: number; total_price?: number } }>("searchAssets", {
      ownerAddress: owner,
      tokenType: "fungible",
      displayOptions: { showNativeBalance: true },
      limit: 200,
    });
    const holdings: SolHolding[] = r.items
      .filter((a) => (a.token_info?.balance ?? 0) > 0)
      .map((a) => {
        const amount = (a.token_info?.balance ?? 0) / 10 ** (a.token_info?.decimals ?? 0);
        const price = a.token_info?.price_info?.price_per_token ?? null;
        return {
          mint: a.id,
          symbol: a.token_info?.symbol ?? a.content?.metadata?.symbol ?? "?",
          name: a.content?.metadata?.name ?? "",
          logoUrl: a.content?.links?.image ?? null,
          amount,
          priceUsd: price,
          valueUsd: price !== null ? price * amount : null,
        };
      })
      .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
    const sol = (r.nativeBalance?.lamports ?? 0) / 1e9;
    const solUsd = r.nativeBalance?.total_price ?? null;
    const total = (solUsd ?? 0) + holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0);
    return NextResponse.json({ owner, sol, solUsd, holdings, totalUsd: total });
  } catch (err) {
    return errorResponse(err, 502);
  }
}
