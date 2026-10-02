import { completeAuthorization } from "@/lib/bot/x";

export const runtime = "nodejs";

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;background:#070a14;color:#eef0ff;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="color:#ccff00">${title}</h1><p>${body}</p></div></body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** X sends the account owner back here after they authorize the app. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state) return page("Not connected", esc(q.get("error_description") ?? q.get("error") ?? "X did not return an authorization code."));
  try {
    const { account, username } = await completeAuthorization(state, code);
    return page("Connected", `@${esc(username)} is now the ${account === "bot" ? "Satellites Bot posting account" : "main account that reposts the bot"}. You can close this tab.`);
  } catch (err) {
    return page("Not connected", esc(err instanceof Error ? err.message : String(err)));
  }
}
