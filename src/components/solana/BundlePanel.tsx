"use client";

import type { LaunchReport } from "@/lib/solana/bundle";
import { usePoll } from "../usePoll";

const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(n < 10 ? 1 : 0)}%`);

/** Launch-block bundle check: snipers, shared funding, and the creator's bag. */
export default function BundlePanel({ mint }: { mint: string }) {
  const { data, error } = usePoll<LaunchReport>(`/api/sol/bundle?mint=${encodeURIComponent(mint)}`, 180_000);
  const tone = data?.tone ?? "";
  return (
    <div className="sol-safety">
      <div className="sol-safety-head">
        <div>
          <div className="sol-label" style={{ marginTop: 0 }}>
            Launch scan
          </div>
          <b className={`sol-safety-label ${tone}`}>{data ? data.label : error ? "Unavailable" : "Reading the launch block…"}</b>
        </div>
      </div>
      {data && data.label !== "Not scanned" && (
        <div className="sol-bundle-stats">
          <div>
            <b>{data.buyers}</b>
            <span>block-0 wallets</span>
          </div>
          <div>
            <b>{pct(data.sniperPct)}</b>
            <span>sniped supply</span>
          </div>
          <div>
            <b>{pct(data.devPct)}</b>
            <span>creator holds</span>
          </div>
        </div>
      )}
      {data && (
        <ul className="sol-flags">
          {data.flags.map((f) => (
            <li key={f.text} className={f.tone}>
              <span aria-hidden>{f.tone === "good" ? "✓" : f.tone === "warn" ? "!" : "✕"}</span>
              {f.text}
            </li>
          ))}
        </ul>
      )}
      {data?.dev && (
        <p className="dim sol-fine" style={{ textAlign: "left" }}>
          Creator{" "}
          <a href={`https://solscan.io/account/${data.dev}`} target="_blank" rel="noreferrer noopener">
            {data.dev.slice(0, 4)}…{data.dev.slice(-4)}
          </a>
        </p>
      )}
    </div>
  );
}
