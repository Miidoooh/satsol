import { z } from "zod";
import { isSolanaAddress } from "../address";
import { getConfig } from "../config";
import { LAMPORTS, mintDecimals, SOL_MINT, solBalance, tokenBalance } from "./rpc";

/**
 * Trades on Solana go through Jupiter, which routes across every DEX and
 * launchpad (pump.fun curves included). SAT builds the transaction with
 * guardrails; the user's wallet signs it; SAT only broadcasts.
 */

const JUP = "https://lite-api.jup.ag";

export const SolIntentSchema = z
  .object({
    side: z.enum(["buy", "sell"]),
    mint: z.string().refine(isSolanaAddress, "not a Solana mint"),
    /** Buy: SOL to spend. Sell: tokens to sell. */
    amount: z.number().positive().optional(),
    /** Buy only: a dollar amount, converted to SOL at the live price. */
    usd: z.number().positive().max(1_000_000).optional(),
    /** Sell only: a share of the wallet's balance, 1 to 100. */
    pct: z.number().min(1).max(100).optional(),
    slippageBps: z.number().int().min(10).max(5000).optional(),
  })
  .refine((i) => i.amount || i.usd || i.pct, "Give an amount, a dollar size or a percent");

export type SolIntent = z.infer<typeof SolIntentSchema>;

interface JupQuote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: { swapInfo: { label?: string } }[];
  [k: string]: unknown;
}

export interface SolQuote {
  side: "buy" | "sell";
  mint: string;
  inUi: number;
  outUi: number;
  minOutUi: number;
  inSymbol: string;
  priceImpactPct: number | null;
  slippageBps: number;
  route: string[];
  warnings: string[];
}

/** Live USD prices from Jupiter; a mint it cannot price is missing from the map. */
export async function usdPrices(mints: string[]): Promise<Map<string, number>> {
  const res = await fetch(`${JUP}/price/v3?ids=${mints.join(",")}`, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as Record<string, { usdPrice?: number }>;
  return new Map(Object.entries(body).flatMap(([k, v]) => (v?.usdPrice ? [[k, v.usdPrice] as [string, number]] : [])));
}

export async function solUsd(): Promise<number> {
  const p = (await usdPrices([SOL_MINT])).get(SOL_MINT);
  if (!p) throw new Error("Could not read the SOL price");
  return p;
}

/**
 * Price impact in percent: how much worse the real trade's rate is than a
 * tiny probe's. Jupiter's own figure is not filled in for long-tail tokens
 * (it reports 100%), so it is measured this way instead.
 */
export function probeImpact(inAmount: bigint, outAmount: bigint, probeIn: bigint, probeOut: bigint): number | null {
  if (inAmount <= 0n || probeIn <= 0n || probeOut <= 0n) return null;
  const rate = Number(outAmount) / Number(inAmount);
  const spot = Number(probeOut) / Number(probeIn);
  return Math.max(0, (1 - rate / spot) * 100);
}

async function jupQuote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<JupQuote> {
  const q = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps), restrictIntermediateTokens: "true" });
  const res = await fetch(`${JUP}/swap/v1/quote?${q}`, { signal: AbortSignal.timeout(12_000), cache: "no-store" });
  const body = (await res.json()) as JupQuote & { error?: string; errorCode?: string };
  if (!res.ok || body.error) throw new Error(body.error === "Could not find any route" || body.errorCode === "COULD_NOT_FIND_ANY_ROUTE" ? "No route for this token right now." : `Jupiter quote failed: ${body.error ?? res.status}`);
  return body;
}

/** Resolve the intent to exact input units, check guardrails, and quote it. */
export async function quoteSol(intent: SolIntent, wallet?: string | null): Promise<{ quote: SolQuote; raw: JupQuote }> {
  const cfg = getConfig();
  const slippageBps = intent.slippageBps ?? cfg.SOL_DEFAULT_SLIPPAGE_BPS;
  if (slippageBps > cfg.SOL_MAX_SLIPPAGE_BPS) throw new Error(`Slippage ${slippageBps / 100}% is above the ${cfg.SOL_MAX_SLIPPAGE_BPS / 100}% cap.`);
  const warnings: string[] = [];
  let inAmount: bigint;
  let inUi: number;
  let outDecimals: number;

  if (intent.side === "buy") {
    const sol = intent.amount ?? (intent.usd ? intent.usd / (await solUsd()) : 0);
    if (!(sol > 0)) throw new Error("Give an amount of SOL to spend.");
    if (sol > cfg.SOL_MAX_TRADE_SOL) throw new Error(`${sol.toFixed(3)} SOL is above the ${cfg.SOL_MAX_TRADE_SOL} SOL per-trade cap.`);
    if (wallet) {
      const have = await solBalance(wallet);
      // Leave room for fees and a new token account's rent.
      if (have < sol + 0.003) throw new Error(`Not enough SOL: this wallet holds ${have.toFixed(4)} SOL.`);
    }
    inAmount = BigInt(Math.floor(sol * LAMPORTS));
    inUi = sol;
    outDecimals = await mintDecimals(intent.mint);
  } else {
    if (!wallet && !intent.amount) throw new Error("Connect a wallet to sell a share of your balance.");
    const bal = wallet ? await tokenBalance(wallet, intent.mint) : { raw: 0n, decimals: await mintDecimals(intent.mint), ui: 0 };
    const tokens = intent.amount ?? (bal.ui * (intent.pct ?? 100)) / 100;
    inAmount = intent.pct === 100 && wallet ? bal.raw : BigInt(Math.floor(tokens * 10 ** bal.decimals));
    if (wallet && inAmount > bal.raw) throw new Error(`Not enough tokens: this wallet holds ${bal.ui.toLocaleString("en-US")}.`);
    if (inAmount <= 0n) throw new Error("Nothing to sell.");
    inUi = Number(inAmount) / 10 ** bal.decimals;
    outDecimals = 9;
  }

  const [inputMint, outputMint] = intent.side === "buy" ? [SOL_MINT, intent.mint] : [intent.mint, SOL_MINT];
  // A probe 1/100th the size gives the market rate; the gap to the real size is the impact.
  const probeIn = inAmount / 100n > 0n ? inAmount / 100n : 1n;
  const [raw, probe] = await Promise.all([jupQuote(inputMint, outputMint, inAmount, slippageBps), jupQuote(inputMint, outputMint, probeIn, slippageBps).catch(() => null)]);
  const outUi = Number(raw.outAmount) / 10 ** outDecimals;
  const reported = Number(raw.priceImpactPct) * 100;
  const impact = probe ? probeImpact(inAmount, BigInt(raw.outAmount), probeIn, BigInt(probe.outAmount)) : reported < 100 ? reported : null;
  if (impact === null) warnings.push("No market price for this token yet, so price impact is unknown. Keep the size small.");
  else if (impact > cfg.SOL_MAX_PRICE_IMPACT_PCT) throw new Error(`Price impact ${impact.toFixed(1)}% is above the ${cfg.SOL_MAX_PRICE_IMPACT_PCT}% guardrail. Try a smaller size.`);
  else if (impact > 5) warnings.push(`High price impact: ${impact.toFixed(1)}%.`);
  if (slippageBps >= 1000) warnings.push(`Slippage is set to ${slippageBps / 100}%.`);
  return {
    raw,
    quote: {
      side: intent.side,
      mint: intent.mint,
      inUi,
      outUi,
      minOutUi: Number(raw.otherAmountThreshold) / 10 ** outDecimals,
      inSymbol: intent.side === "buy" ? "SOL" : "tokens",
      priceImpactPct: impact,
      slippageBps,
      route: [...new Set(raw.routePlan.map((r) => r.swapInfo.label ?? "?"))],
      warnings,
    },
  };
}

/** The unsigned swap transaction (base64) for the wallet to sign. */
export async function buildSwap(raw: JupQuote, wallet: string): Promise<string> {
  const res = await fetch(`${JUP}/swap/v1/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: raw,
      userPublicKey: wallet,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: false,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } },
    }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const body = (await res.json()) as { swapTransaction?: string; error?: string };
  if (!res.ok || !body.swapTransaction) throw new Error(`Jupiter could not build the swap: ${body.error ?? res.status}`);
  return body.swapTransaction;
}
