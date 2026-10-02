"use client";

import { useWallet as useSolWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useCallback, useEffect, useState } from "react";
import type { SolQuote } from "@/lib/solana/jupiter";
import { setMood } from "../brand/mood";
import { executeSolTrade, quoteSolTrade } from "./solTrade";

const BUY_PRESETS = [0.05, 0.1, 0.25, 0.5, 1];
const SELL_PRESETS = [25, 50, 100];
const SLIPPAGES = [100, 300, 500, 1000];
const fmt = (n: number, d = 4) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : d });

interface Line {
  text: string;
  href?: string;
  tone?: "ok" | "bad";
}

/** Buy or sell a Solana token through Jupiter, signed in the user's own wallet. */
export default function SolTradePanel({ mint, symbol }: { mint: string; symbol: string }) {
  const wallet = useSolWallet();
  const { setVisible } = useWalletModal();
  const owner = wallet.publicKey?.toBase58() ?? null;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [sol, setSol] = useState(0.1);
  const [pct, setPct] = useState(100);
  const [slippage, setSlippage] = useState(300);
  const [quote, setQuote] = useState<SolQuote | null>(null);
  const [quoteErr, setQuoteErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Line[]>([]);
  const [bal, setBal] = useState<{ sol: number; token: number } | null>(null);

  const intent = side === "buy" ? { side, mint, amount: sol, slippageBps: slippage } : { side, mint, pct, slippageBps: slippage };

  const loadBalances = useCallback(() => {
    if (!owner) return setBal(null);
    void fetch(`/api/sol/balance?owner=${owner}&mint=${mint}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setBal({ sol: d.sol, token: d.token?.ui ?? 0 }))
      .catch(() => undefined);
  }, [owner, mint]);
  useEffect(loadBalances, [loadBalances]);

  const key = JSON.stringify([intent, owner]);
  useEffect(() => {
    if (side === "sell" && !owner) {
      setQuote(null);
      setQuoteErr("Connect a wallet to sell.");
      return;
    }
    let alive = true;
    setQuoteErr("");
    const t = setTimeout(() => {
      quoteSolTrade(intent, owner)
        .then((q) => alive && setQuote(q))
        .catch((e: Error) => {
          if (!alive) return;
          setQuote(null);
          setQuoteErr(e.message);
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // The intent is captured by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  async function submit() {
    if (!owner) return setVisible(true);
    setBusy(true);
    setLog([]);
    try {
      await executeSolTrade(intent, wallet, (text, href) => setLog((l) => [...l, { text, href }]));
      setLog((l) => [...l, { text: side === "buy" ? `Bought ${symbol}.` : `Sold ${symbol}.`, tone: "ok" }]);
      setMood("pump");
      setTimeout(loadBalances, 1500);
    } catch (e) {
      const msg = (e as Error).message;
      setLog((l) => [...l, { text: /reject|denied|cancel/i.test(msg) ? "Cancelled in wallet." : msg, tone: "bad" }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sol-trade">
      <div className="sol-tabs">
        <button className={side === "buy" ? "on buy" : ""} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button className={side === "sell" ? "on sell" : ""} onClick={() => setSide("sell")}>
          Sell
        </button>
      </div>

      {side === "buy" ? (
        <>
          <div className="sol-label">Spend</div>
          <div className="sol-presets">
            {BUY_PRESETS.map((v) => (
              <button key={v} className={`chip ${sol === v ? "on" : ""}`} onClick={() => setSol(v)}>
                {v} SOL
              </button>
            ))}
          </div>
          <input className="sol-input" type="number" min={0.001} step={0.01} value={sol} onChange={(e) => setSol(Math.max(0, Number(e.target.value)))} />
        </>
      ) : (
        <>
          <div className="sol-label">Sell share of your {symbol}</div>
          <div className="sol-presets">
            {SELL_PRESETS.map((v) => (
              <button key={v} className={`chip ${pct === v ? "on" : ""}`} onClick={() => setPct(v)}>
                {v}%
              </button>
            ))}
          </div>
        </>
      )}

      <div className="sol-label">Slippage</div>
      <div className="sol-presets">
        {SLIPPAGES.map((v) => (
          <button key={v} className={`chip ${slippage === v ? "on" : ""}`} onClick={() => setSlippage(v)}>
            {v / 100}%
          </button>
        ))}
      </div>

      <div className="sol-quote">
        {quote ? (
          <>
            <div>
              <span className="dim">You get ≈</span>{" "}
              <b className="mono">
                {fmt(quote.outUi)} {side === "buy" ? symbol : "SOL"}
              </b>
            </div>
            <div className="dim mono">
              min {fmt(quote.minOutUi)} · impact {quote.priceImpactPct === null ? "unknown" : `${quote.priceImpactPct.toFixed(2)}%`} · via {quote.route.join(" › ")}
            </div>
            {quote.warnings.map((w) => (
              <div key={w} className="sol-warn">
                ⚠ {w}
              </div>
            ))}
          </>
        ) : (
          <div className={quoteErr ? "sol-warn" : "dim"}>{quoteErr || "Getting a quote…"}</div>
        )}
      </div>

      <button className={`btn primary sol-go ${side}`} disabled={busy || (!!owner && !quote)} onClick={() => void submit()}>
        {!owner ? "Connect wallet" : busy ? "Working…" : side === "buy" ? `Buy ${symbol} with ${sol} SOL` : `Sell ${pct}% of ${symbol}`}
      </button>
      {bal && (
        <div className="dim mono sol-bal">
          Wallet: {fmt(bal.sol)} SOL · {fmt(bal.token, 2)} {symbol}
        </div>
      )}
      {log.length > 0 && (
        <div className="sol-log">
          {log.map((l, i) => (
            <div key={i} className={l.tone ?? ""}>
              {l.href ? (
                <a href={l.href} target="_blank" rel="noreferrer noopener">
                  {l.text} ↗
                </a>
              ) : (
                l.text
              )}
            </div>
          ))}
        </div>
      )}
      <p className="dim sol-fine">Routed by Jupiter. You sign every trade in your own wallet. Memecoins are extremely risky.</p>
    </div>
  );
}
