"use client";

import { useEffect, useState } from "react";
import { fmtAgo } from "@/lib/format";
import { compactCount } from "@/lib/social/posts";
import type { CallerBoard as Board, CallPoint, CallerRank } from "@/lib/social/leaderboard";
import { usePoll } from "../usePoll";

const mult = (n: number) => (n >= 100 ? `${Math.round(n)}×` : `${n.toFixed(n >= 10 ? 1 : 2)}×`);
const tone = (n: number) => (n >= 2 ? "up" : n < 1 ? "down" : "");

/** Who on X called a Solana token, and what the price did after they posted. */
export default function CallerBoard({ onOpenToken }: { onOpenToken: (token: string) => void }) {
  const { data, error } = usePoll<Board>("/api/social/leaderboard", 15_000);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="live xm">
      <section className="xm-head" style={{ gridTemplateColumns: "1fr" }}>
        <div>
          <div className="sat-kicker">Caller leaderboard</div>
          <h1>See who called it before it ran.</h1>
          <p className="muted">Every post the X Monitor catches that names a token. The multiple is the best price after they posted, against the price at that minute. Two calls minimum to rank.</p>
        </div>
      </section>

      {!data && !error && <div className="dim">Pricing the calls…</div>}
      {error && !data && <div className="dim">{error}</div>}
      {data && data.callers.length === 0 && (
        <div className="dim">{data.pending > 0 ? `Pricing ${data.pending} tokens from the latest posts. The board fills in as each price comes back.` : "No calls with a live price yet. They show up when a post names a token that is trading."}</div>
      )}

      {data && data.callers.length > 0 && (
        <div className="cb-card">
          <table className="cb-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Caller</th>
                <th>Calls</th>
                <th>Hit 2×</th>
                <th>Median</th>
                <th>Best</th>
              </tr>
            </thead>
            <tbody>
              {data.callers.map((c: CallerRank, i) => (
                <tr key={c.handle} onClick={() => onOpenToken(c.best.token)}>
                  <td className="dim">{i + 1}</td>
                  <td>
                    <b>@{c.handle}</b>
                    <div className="dim">{compactCount(c.followers)} followers{c.calls < 2 ? " · needs one more call to rank" : ""}</div>
                  </td>
                  <td className="mono">{c.calls}</td>
                  <td className="mono">{Math.round(c.hit2x * 100)}%</td>
                  <td className={`mono ${tone(c.medianX)}`}>{mult(c.medianX)}</td>
                  <td className={`mono ${tone(c.best.multiple)}`}>
                    ${c.best.symbol} {mult(c.best.multiple)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.recent.length > 0 && (
        <div className="cb-card">
          <div className="sat-kicker">Latest calls</div>
          {data.recent.map((c: CallPoint) => {
            const x = c.entry > 0 ? c.peak / c.entry : 0;
            return (
              <button key={`${c.handle}:${c.token}:${c.at}`} className="cb-recent" onClick={() => onOpenToken(c.token)}>
                <span>
                  <b>@{c.handle}</b> called <b>${c.symbol}</b>
                  <div className="dim">{fmtAgo(c.at, now)} ago</div>
                </span>
                <span className={`mono ${tone(x)}`}>{mult(x)}</span>
              </button>
            );
          })}
        </div>
      )}
      {data && data.pending > 0 && data.callers.length > 0 && <p className="dim">Still pricing {data.pending} more token{data.pending === 1 ? "" : "s"}.</p>}
      <p className="dim sol-fine">Past posts are not a promise. A contract in the post is the token; a ticker alone maps to the most traded match.</p>
    </div>
  );
}
