"use client";

import { useWallet as useSolWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SolRadar } from "@/app/api/sol/radar/route";
import { fmtUsd } from "@/lib/format";
import type { ExplorePage } from "@/lib/radar/explore";
import { compactCount, type XPost } from "@/lib/social/posts";
import { setMood } from "../brand/mood";
import { executeSolTrade } from "../solana/solTrade";
import { TokenAvatar } from "../TokenAvatar";
import { ping, useSignalPrefs } from "./signalStore";

export interface Signal {
  id: string;
  kind: "x" | "whale" | "grad";
  head: string;
  body: string;
  token?: string;
  symbol?: string;
  logoUrl?: string;
  mcapUsd?: number | null;
  avatar?: string;
  url?: string;
}

const SHOW_MS = 12_000;
const MAX_VISIBLE = 3;
const BIG_ACCOUNT = 10_000;
const GRAD_WINDOW_S = 15 * 60;
const money = (n: number | null | undefined) => (n ? fmtUsd(n, { compact: true }) : "—");

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export function xSignal(p: XPost): Signal {
  const t = p.tokens[0];
  return {
    id: `x:${p.id}`,
    kind: "x",
    head: `@${p.author.userName} · ${compactCount(p.author.followers)} followers${p.watched ? " · watched" : ""}`,
    body: p.text.replace(/\s+/g, " ").slice(0, 180),
    token: t?.token,
    symbol: t?.symbol,
    mcapUsd: t?.mcapUsd ?? null,
    avatar: p.author.avatar,
    url: p.url,
  };
}

/**
 * Live signals in the middle of the screen, GMGN style: big X accounts posting
 * about a token, whale buys, and pump.fun graduations, each with a one-tap buy.
 */
export default function SignalCenter({ onOpenToken }: { onOpenToken: (token: string) => void }) {
  const { prefs } = useSignalPrefs();
  const [shown, setShown] = useState<Signal[]>([]);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const seen = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const wallet = useSolWallet();
  const { setVisible } = useWalletModal();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setShown((s) => s.filter((x) => x.id !== id));
  }, []);
  const arm = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => dismiss(id), SHOW_MS));
  }, [dismiss]);

  const push = useCallback(
    (items: Signal[], first: boolean) => {
      const fresh = items.filter((s) => !seen.current.has(s.id));
      for (const s of fresh) seen.current.add(s.id);
      // The first poll only learns what already happened.
      if (first || fresh.length === 0) return;
      const latest = fresh.slice(0, MAX_VISIBLE);
      setShown((s) => [...latest, ...s].slice(0, MAX_VISIBLE));
      latest.forEach((s) => arm(s.id));
      setMood(latest.some((s) => s.kind === "whale") ? "whale" : "pump");
      if (prefs.sound) ping();
    },
    [arm, prefs.sound],
  );

  useEffect(() => {
    if (!prefs.x) return;
    let first = true;
    const poll = async () => {
      const d = await getJson<{ posts: XPost[] }>(`/api/social?limit=40&minFollowers=${BIG_ACCOUNT}`);
      if (!d) return;
      const mine = new Set(prefs.myHandles.map((h) => h.toLowerCase()));
      const posts = d.posts.filter((p) => (p.tokens.length && p.author.followers >= BIG_ACCOUNT) || p.watched || mine.has(p.author.userName.toLowerCase()));
      push(posts.map(xSignal), first);
      first = false;
    };
    void poll();
    const t = setInterval(poll, 30_000);
    return () => clearInterval(t);
  }, [prefs.x, prefs.myHandles, push]);

  useEffect(() => {
    if (!prefs.whales) return;
    let first = true;
    const poll = async () => {
      const d = await getJson<SolRadar>("/api/sol/radar");
      if (!d) return;
      const whales = d.trades.filter((t) => t.side === "buy" && t.usd >= prefs.whaleUsd);
      push(
        whales.map((t) => ({
          id: `w:${t.id}`,
          kind: "whale" as const,
          head: `🐋 Whale buy · ${money(t.usd)}`,
          body: `${t.trader.slice(0, 4)}…${t.trader.slice(-4)} just bought ${money(t.usd)} of $${t.symbol}`,
          token: t.token,
          symbol: t.symbol,
          logoUrl: t.logoUrl,
        })),
        first,
      );
      first = false;
    };
    void poll();
    const t = setInterval(poll, 15_000);
    return () => clearInterval(t);
  }, [prefs.whales, prefs.whaleUsd, push]);

  useEffect(() => {
    if (!prefs.grads) return;
    let first = true;
    const poll = async () => {
      const d = await getJson<ExplorePage>("/api/explore?tab=graduated&limit=20&sort=age");
      if (!d) return;
      const now = Math.floor(Date.now() / 1000);
      const grads = d.rows.filter((r) => /pumpswap/i.test(r.launchpad ?? "") && r.launchedAt && now - r.launchedAt <= GRAD_WINDOW_S);
      push(
        grads.map((r) => ({
          id: `g:${r.token}`,
          kind: "grad" as const,
          head: "🎓 Graduated to PumpSwap",
          body: `$${r.symbol} just left the pump.fun curve at ${money(r.mcapUsd)} market cap`,
          token: r.token,
          symbol: r.symbol,
          logoUrl: r.logoUrl,
          mcapUsd: r.mcapUsd,
        })),
        first,
      );
      first = false;
    };
    void poll();
    const t = setInterval(poll, 30_000);
    return () => clearInterval(t);
  }, [prefs.grads, push]);

  async function buy(s: Signal) {
    if (!s.token) return;
    if (!wallet.publicKey) return setVisible(true);
    clearTimeout(timers.current.get(s.id));
    setBusy((b) => ({ ...b, [s.id]: "Preparing…" }));
    try {
      await executeSolTrade({ side: "buy", mint: s.token, usd: prefs.buyUsd }, wallet, (text) => setBusy((b) => ({ ...b, [s.id]: text })));
      setBusy((b) => ({ ...b, [s.id]: `Bought $${prefs.buyUsd} of $${s.symbol}` }));
      setMood("pump");
    } catch (e) {
      const msg = (e as Error).message;
      setBusy((b) => ({ ...b, [s.id]: /reject|denied|cancel/i.test(msg) ? "Cancelled" : msg }));
    }
    arm(s.id);
  }

  if (!mounted || shown.length === 0) return null;
  return createPortal(
    <div className="sig-stack" role="status" aria-live="polite">
      {shown.map((s) => (
        <div key={s.id} className={`sig-card ${s.kind}`} onMouseEnter={() => clearTimeout(timers.current.get(s.id))} onMouseLeave={() => arm(s.id)}>
          <div className="sig-top">
            {s.avatar ? <img className="sig-av" src={s.avatar} alt="" width={30} height={30} /> : <TokenAvatar src={s.logoUrl} symbol={s.symbol ?? "?"} seed={s.token ?? s.id} size={30} />}
            <span className="sig-head">{s.head}</span>
            <button className="sig-x" onClick={() => dismiss(s.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
          <div className="sig-body">{s.body}</div>
          {s.token && (
            <div className="sig-actions">
              <button className="sig-token" onClick={() => onOpenToken(s.token!)}>
                ${s.symbol} <span className="mono">{money(s.mcapUsd)}</span>
              </button>
              <button className="btn sm primary" disabled={!!busy[s.id] && !/Bought|Cancelled|fail|Not enough|cap|guardrail/i.test(busy[s.id])} onClick={() => void buy(s)}>
                ⚡ Buy ${prefs.buyUsd}
              </button>
              {s.url && (
                <a className="btn sm ghost" href={s.url} target="_blank" rel="noreferrer noopener">
                  Tweet ↗
                </a>
              )}
            </div>
          )}
          {busy[s.id] && <div className="sig-status">{busy[s.id]}</div>}
        </div>
      ))}
    </div>,
    document.body,
  );
}
