"use client";

import { useCallback, useEffect, useState } from "react";

const KEY = "sat:signals";
const EVENT = "sat:signals-changed";

export interface SignalPrefs {
  /** Pop up when a watched or big X account posts about a token. */
  x: boolean;
  /** Pop up on whale buys at or above whaleUsd. */
  whales: boolean;
  /** Pop up when a pump.fun token graduates to PumpSwap. */
  grads: boolean;
  sound: boolean;
  whaleUsd: number;
  /** Dollar size of the one-tap buy on a signal. */
  buyUsd: number;
  /** Handles this user added to the X Monitor. */
  myHandles: string[];
}

export const DEFAULT_PREFS: SignalPrefs = { x: true, whales: true, grads: true, sound: false, whaleUsd: 5_000, buyUsd: 10, myHandles: [] };

function read(): SignalPrefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<SignalPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function useSignalPrefs() {
  const [prefs, setPrefs] = useState<SignalPrefs>(DEFAULT_PREFS);
  useEffect(() => {
    const sync = () => setPrefs(read());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const update = useCallback((patch: Partial<SignalPrefs>) => {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), ...patch }));
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { prefs, update };
}

/** A short two-tone ping, made on the fly so there is no audio file to load. */
export function ping() {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.09 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.18);
    }
    setTimeout(() => void ctx.close(), 600);
  } catch {
    // Audio can be blocked until the user interacts with the page.
  }
}
