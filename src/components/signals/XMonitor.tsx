"use client";

import { useWallet as useSolWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useEffect, useState } from "react";
import { fmtAgo, fmtUsd } from "@/lib/format";
import { compactCount, DEFAULT_WATCH, HANDLE, type XPost } from "@/lib/social/posts";
import { setMood } from "../brand/mood";
import { executeSolTrade } from "../solana/solTrade";
import { usePoll } from "../usePoll";
import { useSignalPrefs } from "./signalStore";

type Tab = "all" | "watched" | "tokens";
const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "watched", label: "Watchlist only" },
  { id: "tokens", label: "Mentions a token" },
];

/** X Monitor: what the accounts you watch are posting, with the tokens they name ready to chart and buy. */
export default function XMonitor({ onOpenToken }: { onOpenToken: (token: string) => void }) {
  const { prefs, update } = useSignalPrefs();
  const [tab, setTab] = useState<Tab>("all");
  const [handle, setHandle] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Record<string, string>>({});
  const { data } = usePoll<{ posts: XPost[]; enabled: boolean }>(`/api/social?limit=80&watched=${tab === "watched" ? "1" : "0"}`, 30_000);
  const { data: list } = usePoll<{ handles: string[] }>("/api/social/watch", 120_000);
  const wallet = useSolWallet();
  const { setVisible } = useWalletModal();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const mine = new Set(prefs.myHandles.map((h) => h.toLowerCase()));
  // Signal only: posts that name a token, or original posts from watched accounts. Replies without a token are noise.
  const posts = (data?.posts ?? []).filter((p) => {
    if (tab === "tokens") return p.tokens.length > 0;
    if (p.tokens.length > 0) return true;
    return (p.watched || mine.has(p.author.userName.toLowerCase())) && !/^@\w+/.test(p.text.trim());
  });

  async function add() {
    const h = handle.trim().replace(/^@/, "");
    if (!HANDLE.test(h)) return setNote("That is not a valid X handle.");
    const res = await fetch("/api/social/watch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handles: [h] }) });
    if (!res.ok) return setNote((await res.json().catch(() => ({}))).error ?? "Could not add that handle.");
    update({ myHandles: [...new Set([...prefs.myHandles, h])] });
    setHandle("");
    setNote(`Watching @${h}. New posts show up within a couple of minutes.`);
  }

  async function buy(p: XPost, token: string, symbol: string) {
    if (!wallet.publicKey) return setVisible(true);
    const key = `${p.id}:${token}`;
    setStatus((s) => ({ ...s, [key]: "Preparing…" }));
    try {
      await executeSolTrade({ side: "buy", mint: token, usd: prefs.buyUsd }, wallet, (text) => setStatus((s) => ({ ...s, [key]: text })));
      setStatus((s) => ({ ...s, [key]: `Bought $${prefs.buyUsd} of $${symbol}` }));
      setMood("pump");
    } catch (e) {
      const msg = (e as Error).message;
      setStatus((s) => ({ ...s, [key]: /reject|denied|cancel/i.test(msg) ? "Cancelled" : msg }));
    }
  }

  return (
    <div className="live xm">
      <section className="xm-head">
        <div>
          <div className="sat-kicker">X Monitor</div>
          <h1>Know what the callers post, the second they post it.</h1>
          <p className="muted">Every post from the accounts you watch, plus any big account naming a Solana token. Tokens come with their live market cap and a one-tap buy.</p>
        </div>
        <div className="xm-prefs">
          <b>Pop-up signals</b>
          {(
            [
              ["x", "X posts"],
              ["whales", "Whale buys"],
              ["grads", "Graduations"],
              ["sound", "Sound"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="xm-toggle">
              <input type="checkbox" checked={prefs[k]} onChange={(e) => update({ [k]: e.target.checked })} />
              {label}
            </label>
          ))}
          <label className="xm-toggle">
            Whale size
            <select value={prefs.whaleUsd} onChange={(e) => update({ whaleUsd: Number(e.target.value) })}>
              {[2_500, 5_000, 10_000, 25_000].map((v) => (
                <option key={v} value={v}>
                  {fmtUsd(v, { compact: true })}+
                </option>
              ))}
            </select>
          </label>
          <label className="xm-toggle">
            Quick buy
            <select value={prefs.buyUsd} onChange={(e) => update({ buyUsd: Number(e.target.value) })}>
              {[5, 10, 25, 50, 100].map((v) => (
                <option key={v} value={v}>
                  ${v}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="xm-watch">
        <div className="xm-add">
          <input value={handle} onChange={(e) => setHandle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} placeholder="Watch an X account, e.g. @blknoiz06" maxLength={16} />
          <button className="btn primary" onClick={() => void add()}>
            Watch
          </button>
          {note && <span className="dim">{note}</span>}
        </div>
        <div className="xm-chips">
          {(list?.handles ?? DEFAULT_WATCH).map((h) => (
            <a key={h} className={`xm-chip ${mine.has(h.toLowerCase()) ? "mine" : ""}`} href={`https://x.com/${h}`} target="_blank" rel="noreferrer noopener">
              @{h}
              {mine.has(h.toLowerCase()) && (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    update({ myHandles: prefs.myHandles.filter((x) => x.toLowerCase() !== h.toLowerCase()) });
                  }}
                  aria-label={`Stop highlighting @${h}`}
                >
                  ×
                </button>
              )}
            </a>
          ))}
        </div>
      </section>

      <div className="ex-tabs xm-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} className={`ex-tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <section className="xm-feed">
        {!data && <div className="dim live-empty is-loading">Listening to X…</div>}
        {data && !data.enabled && <div className="banner error">The X radar is off on this server (no twitterapi.io key).</div>}
        {data?.enabled && posts.length === 0 && <div className="dim live-empty">No posts yet. They land here within a couple of minutes of being posted.</div>}
        {posts.map((p) => (
          <article key={p.id} className={`xm-post ${p.watched ? "watched" : ""}`}>
            {p.author.avatar ? <img className="xm-av" src={p.author.avatar} alt="" width={40} height={40} /> : <span className="xm-av" />}
            <div className="xm-main">
              <div className="xm-meta">
                <b>{p.author.name}</b>
                <span className="dim">@{p.author.userName}</span>
                <span className={`sx-post-f ${p.author.followers >= 10_000 ? "big" : ""}`}>{compactCount(p.author.followers)}</span>
                {p.watched && <span className="xm-tag">watched</span>}
                <span className="dim">{fmtAgo(p.at, now)} ago</span>
                <a className="dim xm-open" href={p.url} target="_blank" rel="noreferrer noopener">
                  open ↗
                </a>
              </div>
              <p className="xm-text">{p.text}</p>
              {p.tokens.length > 0 && (
                <div className="xm-tokens">
                  {p.tokens.map((t) => {
                    const key = `${p.id}:${t.token}`;
                    return (
                      <span key={t.token} className="xm-token">
                        <button className="sig-token" onClick={() => onOpenToken(t.token)}>
                          ${t.symbol} <span className="mono">{t.mcapUsd ? fmtUsd(t.mcapUsd, { compact: true }) : "—"}</span>
                        </button>
                        <button className="btn sm primary" onClick={() => void buy(p, t.token, t.symbol)}>
                          ⚡ ${prefs.buyUsd}
                        </button>
                        {status[key] && <span className="dim xm-status">{status[key]}</span>}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
