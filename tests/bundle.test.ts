import { describe, expect, it } from "vitest";
import { describeLaunch, type LaunchFacts } from "@/lib/solana/bundle";

const clean: LaunchFacts = { reach: "ok", buyers: 0, sniperPct: 0, devPct: 1.2, devSold: false, sameFunderWallets: 0 };

describe("launch scan", () => {
  it("calls a quiet launch clean", () => {
    const r = describeLaunch(clean);
    expect(r).toMatchObject({ label: "Clean launch", tone: "good", bundled: false });
    expect(r.flags.every((f) => f.tone === "good")).toBe(true);
  });

  it("flags a block full of buyers as bundled", () => {
    const r = describeLaunch({ ...clean, buyers: 8, sniperPct: 22 });
    expect(r).toMatchObject({ label: "Bundled", tone: "bad", bundled: true });
    expect(r.flags[0].text).toMatch(/8 wallets/);
    expect(r.flags[0].text).toMatch(/22%/);
  });

  it("flags wallets funded by one source even when the buyer count is small", () => {
    const r = describeLaunch({ ...clean, buyers: 3, sniperPct: 4, sameFunderWallets: 3 });
    expect(r.bundled).toBe(true);
    expect(r.flags.some((f) => /same wallet/.test(f.text) && f.tone === "bad")).toBe(true);
  });

  it("warns when the creator has sold", () => {
    const r = describeLaunch({ ...clean, devPct: 0, devSold: true });
    expect(r).toMatchObject({ label: "Watch the launch", tone: "warn", bundled: false });
    expect(r.flags.some((f) => /sold/.test(f.text))).toBe(true);
  });

  it("says so when the launch block is out of reach", () => {
    const r = describeLaunch({ ...clean, reach: "unreachable" });
    expect(r).toMatchObject({ label: "Not scanned", bundled: false });
  });
});
