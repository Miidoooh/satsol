import { createHash, randomBytes } from "node:crypto";
import { getConfig } from "../config";
import { getKv } from "../store/kv";

/**
 * Posting to X through the official API (OAuth 2.0 with PKCE). Two accounts
 * authorize the same app once: the bot, which posts, and the main account,
 * which reposts. Refresh tokens rotate on every use, so the latest is stored.
 */

export type XAccount = "bot" | "main";

const API = "https://api.x.com/2";
const AUTHORIZE = "https://x.com/i/oauth2/authorize";
const SCOPES = "tweet.read tweet.write users.read offline.access";
const STATE_TTL_MS = 15 * 60_000;

interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number;
  userId: string;
  username: string;
}

const tokenKey = (a: XAccount) => `bot:x:${a}`;
const redirectUri = () => `${getConfig().SAT_SITE_URL.replace(/\/$/, "")}/api/bot/x/callback`;
const b64url = (b: Buffer) => b.toString("base64url");

function clientAuth(): Record<string, string> {
  const { X_CLIENT_ID: id, X_CLIENT_SECRET: secret } = getConfig();
  if (!id) throw new Error("X_CLIENT_ID is not set");
  return secret ? { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` } : {};
}

/** Where to send the account owner to authorize SAT. */
export async function authorizeUrl(account: XAccount): Promise<string> {
  const id = getConfig().X_CLIENT_ID;
  if (!id) throw new Error("X_CLIENT_ID is not set");
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  await getKv().set(`bot:x:state:${state}`, { verifier, account }, STATE_TTL_MS);
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({
    response_type: "code",
    client_id: id,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE}?${q}`;
}

async function tokenRequest(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...clientAuth() },
    body: new URLSearchParams({ client_id: getConfig().X_CLIENT_ID!, ...params }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`X token request failed: ${body.error_description ?? res.status}`);
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in ?? 7200 };
}

/** Finish the authorization: swap the code for tokens and remember which account it was. */
export async function completeAuthorization(state: string, code: string): Promise<{ account: XAccount; username: string }> {
  const kv = getKv();
  const pending = await kv.get<{ verifier: string; account: XAccount }>(`bot:x:state:${state}`);
  if (!pending) throw new Error("This authorization link expired. Start again.");
  await kv.del(`bot:x:state:${state}`);
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: pending.verifier });
  if (!t.refresh_token) throw new Error("X did not return a refresh token; the app needs the offline.access scope.");
  const me = (await (await fetch(`${API}/users/me`, { headers: { authorization: `Bearer ${t.access_token}` } })).json()) as { data?: { id: string; username: string } };
  if (!me.data) throw new Error("Could not read the authorized X account.");
  await kv.set(tokenKey(pending.account), {
    access: t.access_token,
    refresh: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    userId: me.data.id,
    username: me.data.username,
  } satisfies Tokens);
  return { account: pending.account, username: me.data.username };
}

async function tokens(account: XAccount): Promise<Tokens | null> {
  const kv = getKv();
  const t = await kv.get<Tokens>(tokenKey(account));
  if (!t) return null;
  if (Date.now() < t.expiresAt - 60_000) return t;
  const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh });
  const next: Tokens = { ...t, access: r.access_token, refresh: r.refresh_token ?? t.refresh, expiresAt: Date.now() + r.expires_in * 1000 };
  await kv.set(tokenKey(account), next);
  return next;
}

export async function connected(account: XAccount): Promise<string | null> {
  return (await getKv().get<Tokens>(tokenKey(account)))?.username ?? null;
}

/** Post from the account; returns the post id and its public URL. */
export async function postTweet(account: XAccount, text: string): Promise<{ id: string; url: string }> {
  const t = await tokens(account);
  if (!t) throw new Error(`The ${account} X account is not connected`);
  const res = await fetch(`${API}/tweets`, {
    method: "POST",
    headers: { authorization: `Bearer ${t.access}`, "content-type": "application/json" },
    body: JSON.stringify({ text }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { id: string }; detail?: string; title?: string };
  if (!res.ok || !body.data) throw new Error(`X post failed: ${body.detail ?? body.title ?? res.status}`);
  return { id: body.data.id, url: `https://x.com/${t.username}/status/${body.data.id}` };
}

/** Repost a post from the account (used by the main account to amplify the bot). */
export async function repost(account: XAccount, tweetId: string): Promise<void> {
  const t = await tokens(account);
  if (!t) throw new Error(`The ${account} X account is not connected`);
  const res = await fetch(`${API}/users/${t.userId}/retweets`, {
    method: "POST",
    headers: { authorization: `Bearer ${t.access}`, "content-type": "application/json" },
    body: JSON.stringify({ tweet_id: tweetId }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string; title?: string };
    throw new Error(`X repost failed: ${body.detail ?? body.title ?? res.status}`);
  }
}
