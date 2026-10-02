import { getConfig } from "../config";

/**
 * Server-side Solana JSON-RPC through Helius. The key stays on the server;
 * the browser only ever talks to SAT's own routes.
 */

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const LAMPORTS = 1_000_000_000;

function endpoint(): string {
  const key = getConfig().HELIUS_API_KEY;
  if (!key) throw new Error("HELIUS_API_KEY is not set");
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

export async function rpc<T>(method: string, params: unknown[] | Record<string, unknown> = []): Promise<T> {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`Solana ${method} failed: ${body.error.message ?? "unknown error"}`);
  return body.result as T;
}

export async function solBalance(owner: string): Promise<number> {
  const r = await rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
  return r.value / LAMPORTS;
}

/** A wallet's balance of one mint across its token accounts (SPL Token and Token-2022). */
export async function tokenBalance(owner: string, mint: string): Promise<{ raw: bigint; decimals: number; ui: number }> {
  const r = await rpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number; uiAmount: number | null } } } } } }[] }>(
    "getTokenAccountsByOwner",
    [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
  );
  let raw = 0n;
  let decimals = 0;
  for (const a of r.value) {
    const t = a.account.data.parsed.info.tokenAmount;
    raw += BigInt(t.amount);
    decimals = t.decimals;
  }
  if (!r.value.length) decimals = await mintDecimals(mint);
  return { raw, decimals, ui: Number(raw) / 10 ** decimals };
}

export async function mintDecimals(mint: string): Promise<number> {
  const r = await rpc<{ value: { decimals: number } }>("getTokenSupply", [mint]);
  return r.value.decimals;
}

export async function sendSigned(txBase64: string): Promise<string> {
  return rpc<string>("sendTransaction", [txBase64, { encoding: "base64", skipPreflight: false, preflightCommitment: "processed", maxRetries: 3 }]);
}

export type TxStatus = "pending" | "confirmed" | "failed";

export async function txStatus(signature: string): Promise<{ status: TxStatus; error?: string }> {
  const r = await rpc<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>("getSignatureStatuses", [[signature], { searchTransactionHistory: false }]);
  const s = r.value[0];
  if (!s) return { status: "pending" };
  if (s.err) return { status: "failed", error: JSON.stringify(s.err) };
  return { status: s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "confirmed" : "pending" };
}
