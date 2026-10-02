import { timingSafeEqual } from "node:crypto";
import { getConfig } from "../config";

/** True when the request carries BOT_ADMIN_SECRET in ?secret= or an x-bot-secret header. */
export function isBotAdmin(req: Request): boolean {
  const expected = getConfig().BOT_ADMIN_SECRET;
  if (!expected) return false;
  const given = new URL(req.url).searchParams.get("secret") ?? req.headers.get("x-bot-secret") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
