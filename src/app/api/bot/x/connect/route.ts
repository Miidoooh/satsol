import { NextResponse } from "next/server";
import { isBotAdmin } from "@/lib/bot/admin";
import { authorizeUrl } from "@/lib/bot/x";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

/** Start authorizing an X account for the bot: ?account=bot|main&secret=BOT_ADMIN_SECRET. */
export async function GET(req: Request) {
  if (!isBotAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const account = new URL(req.url).searchParams.get("account");
  if (account !== "bot" && account !== "main") return NextResponse.json({ error: "account must be bot or main" }, { status: 400 });
  try {
    return NextResponse.redirect(await authorizeUrl(account));
  } catch (err) {
    return errorResponse(err, 500);
  }
}
