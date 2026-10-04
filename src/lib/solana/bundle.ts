import { PublicKey } from "@solana/web3.js";
import { cache } from "../cache";
import { getConfig } from "../config";
import type { FlagTone } from "./safety";
import { rpc, tokenBalance } from "./rpc";

/**
 * Launch-block scan: who bought in the same slot the mint was created,
 * how much of the supply that was, whether those wallets share one funder,
 * and whether the creator still holds.
 */

const CACHE_MS = 10 * 60_000;
const MAX_PAGES = 5;
const MAX_PARSE = 40;

export type LaunchReach = "ok" | "unreachable" | "empty";

export interface LaunchFacts {
  reach: LaunchReach;
  /** Wallets, other than the creator, that received tokens in the launch slot. */
  buyers: number;
  /** Percent of supply those wallets received at launch. */
  sniperPct: number;
  /** Creator's share of supply right now. Null when we could not read it. */
  devPct: number | null;
  devSold: boolean;
  /** Launch buyers whose first SOL came from one wallet. */
  sameFunderWallets: number;
}

export interface LaunchReport {
  label: "Clean launch" | "Watch the launch" | "Bundled" | "Not scanned";
  tone: FlagTone;
  bundled: boolean;
  flags: { tone: FlagTone; text: string }[];
  dev: string | null;
  devPct: number | null;
  buyers: number;
  sniperPct: number;
  sameFunder: { wallet: string; count: number } | null;
  launchAt: number | null;
}

const pct = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)}%`;

/** Plain-language verdict from the launch facts. No chain calls. */
export function describeLaunch(f: LaunchFacts): Pick<LaunchReport, "label" | "tone" | "bundled" | "flags"> {
  if (f.reach === "empty") {
    return { label: "Not scanned", tone: "warn", bundled: false, flags: [{ tone: "warn", text: "No transactions on this mint yet" }] };
  }
  if (f.reach === "unreachable") {
    return {
      label: "Not scanned",
      tone: "warn",
      bundled: false,
      flags: [{ tone: "warn", text: "Too many trades to reach the launch block from here" }],
    };
  }

  const flags: LaunchReport["flags"] = [];
  const took = f.sniperPct >= 1 ? ` and took ${pct(f.sniperPct)} of the supply` : "";
  const heavy = f.buyers >= 4 || f.sniperPct >= 12;
  if (f.buyers === 0) flags.push({ tone: "good", text: "No extra wallets bought in the launch block" });
  else if (heavy) flags.push({ tone: "bad", text: `${f.buyers} wallets bought in the launch block${took}` });
  else flags.push({ tone: "warn", text: `${f.buyers} wallet${f.buyers === 1 ? "" : "s"} bought in the launch block${took}` });

  if (f.sameFunderWallets >= 3) flags.push({ tone: "bad", text: `${f.sameFunderWallets} of those wallets were funded by the same wallet` });

  if (f.devPct !== null && f.devPct >= 10) flags.push({ tone: "bad", text: `The creator still holds ${pct(f.devPct)}` });
  else if (f.devPct !== null && f.devPct >= 4) flags.push({ tone: "warn", text: `The creator still holds ${pct(f.devPct)}` });
  else if (f.devSold) flags.push({ tone: "warn", text: "The creator has sold their tokens" });
  else if (f.devPct !== null) flags.push({ tone: "good", text: `The creator holds ${pct(f.devPct)}` });

  const bundled = heavy || f.sameFunderWallets >= 3;
  const order: Record<FlagTone, number> = { bad: 0, warn: 1, good: 2 };
  const tone: FlagTone = bundled ? "bad" : flags.some((x) => x.tone === "warn") ? "warn" : "good";
  return {
    label: bundled ? "Bundled" : tone === "warn" ? "Watch the launch" : "Clean launch",
    tone,
    bundled,
    flags: flags.sort((a, b) => order[a.tone] - order[b.tone]),
  };
}

interface SigInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

interface EnhTx {
  signature: string;
  feePayer?: string;
  tokenTransfers?: { mint?: string; toUserAccount?: string; tokenAmount?: number }[];
  nativeTransfers?: { fromUserAccount?: string; toUserAccount?: string; amount?: number }[];
}

const isWallet = (owner: string) => {
  try {
    return PublicKey.isOnCurve(new PublicKey(owner).toBytes());
  } catch {
    return false;
  }
};

async function signatures(address: string, pages: number): Promise<{ sigs: SigInfo[]; reached: boolean }> {
  const sigs: SigInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < pages; page++) {
    const batch = await rpc<SigInfo[]>("getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}), commitment: "confirmed" }]);
    sigs.push(...batch);
    if (batch.length < 1000) return { sigs, reached: true };
    before = batch[batch.length - 1]?.signature;
    if (!before) break;
  }
  return { sigs, reached: false };
}

async function parseTxs(ids: string[]): Promise<EnhTx[]> {
  if (!ids.length) return [];
  const key = getConfig().HELIUS_API_KEY;
  if (!key) throw new Error("HELIUS_API_KEY is not set");
  const res = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactions: ids }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Launch scan failed (${res.status})`);
  const body = (await res.json()) as EnhTx[] | { error?: string };
  if (!Array.isArray(body)) throw new Error(body.error ?? "Launch scan failed");
  return body;
}

/** First wallet that sent this wallet SOL, when the history is short enough to reach. */
async function funderOf(wallet: string): Promise<string | null> {
  const { sigs, reached } = await signatures(wallet, 3);
  if (!reached || !sigs.length) return null;
  const oldest = sigs[sigs.length - 1];
  const [tx] = await parseTxs([oldest.signature]);
  const hit = tx?.nativeTransfers?.find((t) => t.toUserAccount === wallet && (t.amount ?? 0) > 0 && t.fromUserAccount && t.fromUserAccount !== wallet);
  return hit?.fromUserAccount && isWallet(hit.fromUserAccount) ? hit.fromUserAccount : null;
}

function blank(reach: LaunchReach, extra: Partial<LaunchReport> = {}): LaunchReport {
  const verdict = describeLaunch({ reach, buyers: 0, sniperPct: 0, devPct: null, devSold: false, sameFunderWallets: 0 });
  return { ...verdict, dev: null, devPct: null, buyers: 0, sniperPct: 0, sameFunder: null, launchAt: null, ...extra };
}

async function scan(mint: string): Promise<LaunchReport> {
  const { sigs, reached } = await signatures(mint, MAX_PAGES);
  if (!sigs.length) return blank("empty");
  if (!reached) return blank("unreachable");

  const launchSlot = sigs[sigs.length - 1].slot;
  const inSlot = sigs.filter((s) => !s.err && (s.slot === launchSlot || s.slot === launchSlot + 1));
  if (!inSlot.length) return blank("empty");
  const oldest = inSlot[inSlot.length - 1];
  const sample = [oldest, ...inSlot.filter((s) => s.signature !== oldest.signature)].slice(0, MAX_PARSE);
  const parsed = await parseTxs(sample.map((s) => s.signature));
  const bySig = new Map(parsed.map((t) => [t.signature, t]));
  const dev = bySig.get(oldest.signature)?.feePayer ?? null;

  const received = new Map<string, number>();
  for (const tx of parsed) {
    for (const t of tx.tokenTransfers ?? []) {
      if (t.mint !== mint || !t.toUserAccount || !isWallet(t.toUserAccount)) continue;
      const amount = t.tokenAmount ?? 0;
      if (amount <= 0) continue;
      received.set(t.toUserAccount, (received.get(t.toUserAccount) ?? 0) + amount);
    }
  }

  const supply = await rpc<{ value: { uiAmount: number | null } }>("getTokenSupply", [mint]).then((r) => r.value.uiAmount ?? 0);
  const buyers = [...received.keys()].filter((w) => w !== dev);
  const sniperRaw = buyers.reduce((sum, w) => sum + (received.get(w) ?? 0), 0);
  const sniperPct = supply > 0 ? Math.min(100, (sniperRaw / supply) * 100) : 0;

  let devPct: number | null = null;
  if (dev && isWallet(dev)) {
    const bal = await tokenBalance(dev, mint).catch(() => null);
    if (bal && supply > 0) devPct = Math.min(100, (bal.ui / supply) * 100);
  }
  const devReceived = dev ? (received.get(dev) ?? 0) : 0;
  const devSold = devReceived > supply * 0.001 && devPct !== null && devPct < 0.2;

  let sameFunder: LaunchReport["sameFunder"] = null;
  if (buyers.length >= 3) {
    const counts = new Map<string, number>();
    const slice = buyers.slice(0, 8);
    const funders = await Promise.all(slice.map((w) => funderOf(w).catch(() => null)));
    for (const f of funders) {
      if (!f || f === dev) continue;
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 3) sameFunder = { wallet: top[0], count: top[1] };
  }

  const facts: LaunchFacts = {
    reach: "ok",
    buyers: buyers.length,
    sniperPct,
    devPct,
    devSold,
    sameFunderWallets: sameFunder?.count ?? 0,
  };
  const verdict = describeLaunch(facts);
  if (inSlot.length > MAX_PARSE) {
    verdict.flags.unshift({ tone: "warn", text: "More wallets bought in that block than this scan could read" });
    if (verdict.tone === "good") {
      verdict.tone = "warn";
      verdict.label = "Watch the launch";
    }
  }
  return {
    ...verdict,
    dev: dev && isWallet(dev) ? dev : null,
    devPct,
    buyers: buyers.length,
    sniperPct,
    sameFunder,
    launchAt: oldest.blockTime,
  };
}

/** Bundle and insider read for one mint. Cached for ten minutes. */
export async function scanLaunch(mint: string): Promise<LaunchReport> {
  return cache.get(`sol:bundle:${mint}`, CACHE_MS, () => scan(mint));
}
