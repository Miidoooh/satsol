"use client";

import { useState } from "react";
import { fmtPct, fmtPrice, fmtUsd } from "@/lib/format";
import type { SolTokenInfo } from "@/app/api/sol/token/route";
import { TokenAvatar } from "../TokenAvatar";
import { usePoll } from "../usePoll";
import SolTradePanel from "./SolTradePanel";

const money = (n: number | null | undefined) => (n ? fmtUsd(n, { compact: true }) : "—");

/** A Solana token: live chart, the numbers that matter, and a Jupiter trade panel. */
export default function SolTokenView({ mint, onBack }: { mint: string; onBack: () => void }) {
  const { data, error } = usePoll<SolTokenInfo>(`/api/sol/token?mint=${mint}`, 15_000);
  const [copied, setCopied] = useState(false);
  const p = data?.pool;
  const h1 = p?.txns.h1;
  const ch = (k: "m5" | "h1" | "h6" | "h24") => p?.change[k] ?? null;

  return (
    <div className="live sol-token">
      <header className="sol-head">
        <button className="btn ghost sm" onClick={onBack}>
          ← Back
        </button>
        <TokenAvatar src={data?.logoUrl ?? undefined} symbol={data?.symbol ?? "?"} seed={mint} size={44} />
        <div className="sol-id">
          <h1>
            {data?.symbol ?? "…"} <span className="dim">{data?.name}</span>
          </h1>
          <button
            className="sol-ca mono"
            onClick={() =>
              void navigator.clipboard.writeText(mint).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
            }
            title="Copy contract address"
          >
            {copied ? "Copied" : `${mint.slice(0, 6)}…${mint.slice(-6)} ⧉`}
          </button>
          {p?.launchpad && <span className="ex-badge pad">{p.launchpad}</span>}
        </div>
        <div className="spacer" />
        <a className="btn ghost sm" href={`https://solscan.io/token/${mint}`} target="_blank" rel="noreferrer noopener">
          Solscan ↗
        </a>
      </header>

      {error && !data && <div className="banner error">{String(error)}</div>}

      <section className="sol-stats">
        <div className="sat-stat">
          <span className="k">Price</span>
          <span className="v mono">{data?.priceUsd ? `$${fmtPrice(data.priceUsd)}` : "—"}</span>
          <span className={`mono ${(ch("h24") ?? 0) >= 0 ? "up" : "down"}`}>{fmtPct(ch("h24"))} 24h</span>
        </div>
        <div className="sat-stat">
          <span className="k">Market cap</span>
          <span className="v mono">{money(data?.mcapUsd)}</span>
        </div>
        <div className="sat-stat">
          <span className="k">Liquidity</span>
          <span className="v mono">{money(data?.liquidityUsd)}</span>
        </div>
        <div className="sat-stat">
          <span className="k">Volume 24h</span>
          <span className="v mono">{money(data?.vol24hUsd)}</span>
        </div>
        <div className="sat-stat">
          <span className="k">1h trades</span>
          <span className="v mono">
            <span className="up">{h1?.buys ?? 0}</span> / <span className="down">{h1?.sells ?? 0}</span>
          </span>
          <span className="dim mono">{(h1?.buyers ?? 0) + (h1?.sellers ?? 0)} wallets</span>
        </div>
        <div className="sat-stat">
          <span className="k">Change</span>
          <span className="mono">
            5m <span className={(ch("m5") ?? 0) >= 0 ? "up" : "down"}>{fmtPct(ch("m5"))}</span> · 1h{" "}
            <span className={(ch("h1") ?? 0) >= 0 ? "up" : "down"}>{fmtPct(ch("h1"))}</span>
          </span>
        </div>
      </section>

      <div className="sol-grid">
        <div className="sol-chart">
          {data?.chartUrl ? (
            <iframe title={`${data.symbol} chart`} src={data.chartUrl} allow="clipboard-write" />
          ) : (
            <div className="dim live-empty is-loading">Loading the chart…</div>
          )}
        </div>
        <aside>
          <SolTradePanel mint={mint} symbol={data?.symbol || "token"} />
        </aside>
      </div>
    </div>
  );
}
