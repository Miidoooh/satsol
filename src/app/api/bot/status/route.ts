import { NextResponse } from "next/server";
import { isBotAdmin } from "@/lib/bot/admin";
import { botStatus, runBot } from "@/lib/bot/bot";
import { getProvider } from "@/lib/data/provider";
import { RobinhoodChainProvider } from "@/lib/data/robinhood";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Bot mode, connected accounts, recent drafts and calls. Admin only. */
export async function GET(req: Request) {
  if (!isBotAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    return NextResponse.json(await botStatus());
  } catch (err) {
    return errorResponse(err);
  }
}

/** Run one bot pass now instead of waiting for the worker. Admin only. */
export async function POST(req: Request) {
  if (!isBotAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const provider = getProvider();
  if (!(provider instanceof RobinhoodChainProvider)) return NextResponse.json({ error: "Live chain data needed" }, { status: 501 });
  try {
    return NextResponse.json({ run: await runBot(provider), status: await botStatus() });
  } catch (err) {
    return errorResponse(err, 502);
  }
}
