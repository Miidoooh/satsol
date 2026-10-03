"use client";

import type { SolSafety } from "@/lib/solana/safety";
import { usePoll } from "../usePoll";

/** The rug check for one token: a score ring and the plain-language reasons behind it. */
export default function SolSafetyPanel({ mint, liquidityUsd, launchedAt }: { mint: string; liquidityUsd: number | null; launchedAt: number | null }) {
  const q = new URLSearchParams({ mint });
  if (liquidityUsd) q.set("liq", String(Math.round(liquidityUsd)));
  if (launchedAt) q.set("launched", String(launchedAt));
  const { data, error } = usePoll<SolSafety>(`/api/sol/safety?${q}`, 120_000);
  const tone = !data ? "" : data.score >= 75 ? "good" : data.score >= 50 ? "warn" : "bad";
  return (
    <div className="sol-safety">
      <div className="sol-safety-head">
        <span className={`sol-ring ${tone}`} style={{ ["--s" as string]: data?.score ?? 0 }}>
          {data ? data.score : "…"}
        </span>
        <div>
          <div className="sol-label" style={{ marginTop: 0 }}>
            Rug check
          </div>
          <b className={`sol-safety-label ${tone}`}>{data ? data.label : error ? "Unavailable" : "Scanning the chain…"}</b>
        </div>
      </div>
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
      {data && (
        <p className="dim sol-fine" style={{ textAlign: "left" }}>
          Read from chain. Pools and bonding curves ({data.checks.poolPct.toFixed(0)}% of supply) are left out of the holder figures. A high score is not a promise.
        </p>
      )}
    </div>
  );
}
