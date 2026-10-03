import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, rateLimit } from "@/lib/http";
import { HANDLE } from "@/lib/social/posts";
import { addWatched, watchedHandles } from "@/lib/social/radar";

export const runtime = "nodejs";

const Body = z.object({
  handles: z
    .array(
      z
        .string()
        .trim()
        .transform((h) => h.replace(/^@/, ""))
        .pipe(z.string().regex(HANDLE)),
    )
    .min(1)
    .max(10),
});

/** The X Monitor watchlist the radar searches. */
export async function GET() {
  try {
    return NextResponse.json({ handles: await watchedHandles() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Add X handles to the watchlist so the radar picks up their posts. */
export async function POST(req: Request) {
  const limited = rateLimit(req, "social-watch", 20);
  if (limited) return limited;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Send up to 10 X handles (letters, numbers and _ only)" }, { status: 400 });
  try {
    return NextResponse.json({ handles: await addWatched(parsed.data.handles) });
  } catch (err) {
    return errorResponse(err);
  }
}
