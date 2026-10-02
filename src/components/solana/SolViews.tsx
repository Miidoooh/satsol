"use client";

import { useWallet as useSolWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useEffect, useState } from "react";
import type { SolHolding } from "@/app/api/sol/portfolio/route";
import type { SolFlow, SolRadar } from "@/app/api/sol/radar/route";
import { fmtAgo, fmtPrice, fmtUsd } from "@/lib/format";
import type { ExplorePage, ExploreRow } from "@/lib/radar/explore";
import { Flash } from "../Flash";
import { TokenAvatar } from "../TokenAvatar";
import { usePoll } from "../usePoll";
import SolTokenView from "./SolTokenView";

type Open = (token: string) => void;
const money = (n: number | null | undefined) => (n ? fmtUsd(n, { compact: true }) : "—");
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Rows({ n = 6 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skel-row" aria-hidden>
          <span className="skeleton skel-dot" />
          <span className="skeleton skel-line" />
          <span className="skeleton skel-line short" />
        </div>
      ))}
    </>
  );
}

function LaunchList({ title, tab, sort, onOpen }: { title: string; tab: string; sort?: string; onOpen: Open }) {
  const { data } = usePoll<ExplorePage>(`/api/explore?tab=${tab}&limit=15${sort ? `&sort=${sort}` : ""}`, 10_000);
  const now = useNow();
  return (
    <div className="sx-card">
      <div className="sx-card-head">
        <span>{title}</span>
        <span className="sx-live-tag">
          <span className="dot live" /> live
        </span>
      </div>
      {!data && <Rows />}
      {data && data.rows.length === 0 && <div className="dim">Nothing here right now.</div>}
      {data?.rows.map((r: ExploreRow) => (
        <div key={r.token} className="sx-row" role="button" onClick={() => onOpen(r.token)} style={{ cursor: "pointer" }}>
          <span className="sx-row-id">
            <TokenAvatar src={r.logoUrl} symbol={r.symbol} seed={r.token} size={28} />
            <span style={{ minWidth: 0 }}>
              <b>{r.symbol}</b>
              <div className="dim">
                {r.launchpad} · {r.launchedAt ? `${fmtAgo(r.launchedAt, now)} old` : ""}
              </div>
            </span>
          </span>
          <span className="mono" style={{ textAlign: "right" }}>
            <Flash value={r.mcapUsd}>{money(r.mcapUsd)}</Flash>
            <div className="dim" style={{ fontSize: 11 }}>
              {r.vol30mUsd ? `${money(r.vol30mUsd)} vol` : "mcap"}
            </div>
          </span>
          {r.graduatedAt === null ? (
            <span className="sx-bond" title={`≈${r.progressPct.toFixed(0)}% bonded`}>
              <span style={{ width: `${Math.min(100, Math.max(2, r.progressPct))}%` }} />
            </span>
          ) : (
            <span className={`mono ${r.net30mUsd >= 0 ? "up" : "down"}`} style={{ minWidth: 60, textAlign: "right" }}>
              {r.net30mUsd ? `${r.net30mUsd > 0 ? "+" : "−"}${money(Math.abs(r.net30mUsd))}` : "—"}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Trenches: pump.fun and every other launchpad, from birth to graduation. */
export function SolTrenches({ onOpen }: { onOpen: Open }) {
  return (
    <div className="live home">
      <div className="home-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <LaunchList title="🆕 New launches" tab="new" onOpen={onOpen} />
        <LaunchList title="🎓 About to graduate" tab="almost" sort="progress" onOpen={onOpen} />
        <LaunchList title="🔥 Hot right now" tab="trending" onOpen={onOpen} />
      </div>
    </div>
  );
}

function FlowCard({ title, rows, tone, onOpen }: { title: string; rows?: SolFlow[]; tone: "up" | "down" | "crowd"; onOpen: Open }) {
  return (
    <div className="sx-card">
      <div className="sx-card-head">
        <span>{title}</span>
      </div>
      {!rows && <Rows n={5} />}
      {rows?.map((f) => (
        <div key={f.token} className="sx-row" role="button" onClick={() => onOpen(f.token)} style={{ cursor: "pointer" }}>
          <span className="sx-row-id">
            <TokenAvatar src={f.logoUrl} symbol={f.symbol} seed={f.token} size={26} />
            <span>
              <b>{f.symbol}</b>
              <div className="dim">
                {f.traders} wallets · {money(f.mcapUsd)} mcap
              </div>
            </span>
          </span>
          <span className={`mono ${tone === "crowd" ? "" : tone}`} style={{ fontWeight: 700 }}>
            {tone === "crowd" ? money(f.volUsd) : `${f.netUsd > 0 ? "+" : "−"}${money(Math.abs(f.netUsd))}`}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Whale radar on Solana: big trades in the hottest pools and where the money is moving. */
export function SolWhaleRadar({ onOpen }: { onOpen: Open }) {
  const { data } = usePoll<SolRadar>("/api/sol/radar", 15_000);
  const now = useNow();
  const buyShare = data && data.totals.buys30m + data.totals.sells30m > 0 ? (data.totals.buys30m / (data.totals.buys30m + data.totals.sells30m)) * 100 : null;
  return (
    <div className="live home">
      <section className="sol-stats" style={{ maxWidth: 1200, margin: "0 auto 16px", gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        <div className="sat-stat">
          <span className="k">Volume 30m</span>
          <span className="v mono">{money(data?.totals.volume30mUsd)}</span>
        </div>
        <div className="sat-stat">
          <span className="k">Trades 30m</span>
          <span className="v mono">{data ? (data.totals.buys30m + data.totals.sells30m).toLocaleString("en-US") : "—"}</span>
        </div>
        <div className="sat-stat">
          <span className="k">Buy share</span>
          <span className={`v mono ${(buyShare ?? 50) >= 50 ? "up" : "down"}`}>{buyShare === null ? "—" : `${buyShare.toFixed(0)}%`}</span>
        </div>
        <div className="sat-stat">
          <span className="k">Tokens watched</span>
          <span className="v mono">{data?.totals.tokens ?? "—"}</span>
        </div>
      </section>
      <div className="home-grid">
        <div className="sx-card" style={{ gridRow: "span 2" }}>
          <div className="sx-card-head">
            <span>🐋 Whale trades · $1K+</span>
            <span className="sx-live-tag">
              <span className="dot live" /> live
            </span>
          </div>
          {!data && <Rows n={10} />}
          {data && data.trades.length === 0 && <div className="dim">Waiting for the next big trade…</div>}
          {data?.trades.map((t) => (
            <div key={t.id} className="sx-row" role="button" onClick={() => onOpen(t.token)} style={{ cursor: "pointer" }}>
              <span className="sx-row-id">
                <TokenAvatar src={t.logoUrl} symbol={t.symbol} seed={t.token} size={26} />
                <span>
                  <b>{t.symbol}</b>
                  <div className="dim">
                    <a href={`https://solscan.io/account/${t.trader}`} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
                      {short(t.trader)}
                    </a>{" "}
                    {t.side === "buy" ? "bought" : "sold"} · {fmtAgo(t.at, now)} ago
                  </div>
                </span>
              </span>
              <a className={`mono ${t.side === "buy" ? "up" : "down"}`} style={{ fontWeight: 700 }} href={`https://solscan.io/tx/${t.tx}`} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
                {t.side === "buy" ? "+" : "−"}
                {money(t.usd)}
              </a>
            </div>
          ))}
        </div>
        <FlowCard title="🟢 Net money in · 30m" rows={data?.inflows} tone="up" onOpen={onOpen} />
        <FlowCard title="🔴 Net money out · 30m" rows={data?.outflows} tone="down" onOpen={onOpen} />
        <FlowCard title="👥 Most wallets trading · 30m" rows={data?.crowds} tone="crowd" onOpen={onOpen} />
      </div>
    </div>
  );
}

/** Pro terminal on Solana: the hottest tokens on the left, chart and Jupiter trading on the right. */
export function SolTerminal({ onHome }: { onHome: () => void }) {
  const { data } = usePoll<ExplorePage>("/api/explore?tab=trending&limit=40", 12_000);
  const [mint, setMint] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const rows = (data?.rows ?? []).filter((r) => !q || r.symbol.toLowerCase().includes(q.toLowerCase()) || r.token === q.trim());
  const active = mint ?? data?.rows[0]?.token ?? null;
  return (
    <div className="sol-terminal">
      <aside className="sol-term-list">
        <input className="sol-input" placeholder="Filter or paste a contract address" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && q.trim().length >= 32 && setMint(q.trim())} />
        {!data && <Rows n={12} />}
        {rows.map((r) => (
          <button key={r.token} className={`sol-term-row ${r.token === active ? "on" : ""}`} onClick={() => setMint(r.token)}>
            <TokenAvatar src={r.logoUrl} symbol={r.symbol} seed={r.token} size={26} />
            <span className="sol-term-sym">
              <b>{r.symbol}</b>
              <span className="dim">{r.launchpad}</span>
            </span>
            <span className="mono">
              <Flash value={r.mcapUsd}>{money(r.mcapUsd)}</Flash>
            </span>
          </button>
        ))}
      </aside>
      <div className="sol-term-main">{active ? <SolTokenView key={active} mint={active} onBack={onHome} /> : <div className="dim live-empty is-loading">Loading Solana tokens…</div>}</div>
    </div>
  );
}

/** Your Solana holdings with live USD values. */
export function SolPortfolio({ onOpen }: { onOpen: Open }) {
  const wallet = useSolWallet();
  const { setVisible } = useWalletModal();
  const owner = wallet.publicKey?.toBase58() ?? null;
  const { data } = usePoll<{ sol: number; solUsd: number | null; holdings: SolHolding[]; totalUsd: number }>(owner ? `/api/sol/portfolio?owner=${owner}` : "", 30_000);
  if (!owner) {
    return (
      <div className="live home">
        <div className="sx-card" style={{ maxWidth: 520, margin: "40px auto", textAlign: "center" }}>
          <h3 style={{ justifyContent: "center" }}>Your Solana portfolio</h3>
          <p className="dim">Connect a Solana wallet to see every token you hold, valued live.</p>
          <button className="sx-btn primary" onClick={() => setVisible(true)}>
            Connect Solana wallet
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="live home">
      <section className="sol-stats" style={{ maxWidth: 1200, margin: "0 auto 16px", gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <div className="sat-stat">
          <span className="k">Total value</span>
          <span className="v mono">{money(data?.totalUsd)}</span>
        </div>
        <div className="sat-stat">
          <span className="k">SOL</span>
          <span className="v mono">{data ? data.sol.toFixed(4) : "—"}</span>
          <span className="dim mono">{money(data?.solUsd)}</span>
        </div>
        <div className="sat-stat">
          <span className="k">Tokens</span>
          <span className="v mono">{data?.holdings.length ?? "—"}</span>
        </div>
      </section>
      <div className="sx-card" style={{ maxWidth: 1200, margin: "0 auto" }}>
        {!data && <Rows n={8} />}
        {data?.holdings.map((h) => (
          <div key={h.mint} className="sx-row" role="button" onClick={() => onOpen(h.mint)} style={{ cursor: "pointer" }}>
            <span className="sx-row-id">
              <TokenAvatar src={h.logoUrl ?? undefined} symbol={h.symbol} seed={h.mint} size={28} />
              <span>
                <b>{h.symbol}</b>
                <div className="dim">{h.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}</div>
              </span>
            </span>
            <span className="mono dim">{h.priceUsd ? `$${fmtPrice(h.priceUsd)}` : "—"}</span>
            <span className="mono" style={{ fontWeight: 700, minWidth: 80, textAlign: "right" }}>
              {money(h.valueUsd)}
            </span>
          </div>
        ))}
      </div>
      <p className="dim" style={{ textAlign: "center", marginTop: 12 }}>
        Values from Helius. Tap a token to chart and trade it.
      </p>
    </div>
  );
}
