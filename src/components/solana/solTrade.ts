"use client";

import { VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { SolIntent, SolQuote } from "@/lib/solana/jupiter";

type Log = (text: string, href?: string) => void;

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;

/** Quote only: what the trade would get, without building it. */
export async function quoteSolTrade(intent: SolIntent, wallet: string | null): Promise<SolQuote> {
  const res = await fetch("/api/sol/trade", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent, wallet }) });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error ?? "Could not quote this trade");
  return d.quote as SolQuote;
}

/**
 * Build the swap on SAT's server (Jupiter route, guardrails checked), have the
 * user's wallet sign it, then broadcast and wait for confirmation. The wallet
 * is the only thing that can sign; SAT never holds a key.
 */
export async function executeSolTrade(intent: SolIntent, wallet: WalletContextState, log: Log): Promise<{ signature: string; quote: SolQuote }> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Connect a Solana wallet first.");
  log("Finding the best route on Jupiter…");
  const res = await fetch("/api/sol/trade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, wallet: wallet.publicKey.toBase58(), build: true }),
  });
  const built = await res.json();
  if (!res.ok || !built.tx) throw new Error(built.error ?? "Could not build this trade");
  log("Approve the trade in your wallet…");
  const signed = await wallet.signTransaction(VersionedTransaction.deserialize(fromB64(built.tx)));
  log("Sending to Solana…");
  const sent = await fetch("/api/sol/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: toB64(signed.serialize()) }) });
  const out = await sent.json();
  if (!sent.ok) throw new Error(out.error ?? "The network rejected the trade");
  if (out.status === "failed") throw new Error("The trade failed on chain. Nothing was spent except the network fee.");
  log(out.status === "confirmed" ? "Confirmed on Solana." : "Sent. Still confirming…", solscanTx(out.signature));
  return { signature: out.signature, quote: built.quote as SolQuote };
}
