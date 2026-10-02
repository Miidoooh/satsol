"use client";

import { useEffect, useState } from "react";
import { ON_SOLANA, SHOW_SAT_TOKEN } from "@/lib/chainMode";
import { fmtPct, fmtPrice, fmtUsd } from "@/lib/format";
import { useSat } from "../sat";
import { LiveLaunches, LiveMarkets, LiveScan, LiveSocial, LiveTrending, LiveWhales } from "./LiveWidgets";
import Satellite, { type SatMood } from "./Satellite";
import { useMood } from "./mood";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Night watch" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Simple mode: what matters on Robinhood Chain right now, in four friendly cards. */
export default function HomeView({ onOpenToken, onExplore, onRadar, onAgent }: { onOpenToken: (token: string) => void; onExplore: () => void; onRadar: () => void; onAgent?: () => void }) {
  const { market: sat } = useSat();
  const live = useMood();
  const [hello, setHello] = useState("Hello");
  useEffect(() => setHello(greeting()), []);
  const mood: SatMood = live === "watching" ? "scanning" : live;
  return (
    <div className="live home">
      <section className="home-hero">
        <Satellite mood={mood} size={140} />
        <div>
          <h1>{hello}. SAT is watching the chain for you.</h1>
          <p>
            {ON_SOLANA
              ? "What is running on Solana right now: the hottest tokens, fresh pump.fun launches, who is talking about them on X, and what is about to graduate. Tap anything to open its chart and buy it."
              : "What is running right now: the hottest tokens, fresh launches, whale buys, and what is about to graduate. Tap anything to open its chart and trade it."}
          </p>
        </div>
      </section>
      <div className="home-grid">
        <div>
          <LiveTrending onOpen={onOpenToken} />
          <button className="more" onClick={onExplore} style={{ background: "none" }}>
            See every launch in Explore →
          </button>
        </div>
        <div>
          <LiveWhales onOpen={onOpenToken} />
          <button className="more" onClick={onRadar} style={{ background: "none" }}>
            Open the Whale Radar →
          </button>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <LiveSocial onOpen={onOpenToken} />
        </div>
        <LiveLaunches onOpen={onOpenToken} />
        <LiveScan onOpen={onOpenToken} />
        <div className="sx-card">
          <h3>
            <Satellite mood="scanning" size={34} orbit={false} /> Your agent
          </h3>
          <p className="dim" style={{ margin: "0 0 14px" }}>
            Pick a style or describe your own. SAT hunts around the clock and tells you what to buy, at what market cap, and exactly when to sell.
          </p>
          <button className="sx-btn primary" style={{ marginTop: 6 }} onClick={onAgent}>
            Open your agent →
          </button>
        </div>
        {SHOW_SAT_TOKEN && (
          <div className="sx-card">
            <h3>
              <Satellite mood="pump" size={34} orbit={false} /> $SAT
            </h3>
            <p className="dim" style={{ margin: "0 0 14px" }}>
              The token behind SAT. Holders get alerts first and more autopilot rules.
            </p>
            <div className="home-sat">
              <span className="big mono">{sat ? `$${fmtPrice(sat.priceUsd)}` : "···"}</span>
              {sat?.change24hPct != null && <span className={`mono ${sat.change24hPct >= 0 ? "up" : "down"}`}>{fmtPct(sat.change24hPct)} 24h</span>}
              <span className="dim mono">mcap {sat ? fmtUsd(sat.marketCapUsd, { compact: true }) : "···"}</span>
            </div>
            <button className="sx-btn primary" style={{ marginTop: 16 }} onClick={() => sat && onOpenToken(sat.address)}>
              Buy $SAT
            </button>
          </div>
        )}
        {!ON_SOLANA && <LiveMarkets limit={4} onOpen={onOpenToken} />}
      </div>
    </div>
  );
}
