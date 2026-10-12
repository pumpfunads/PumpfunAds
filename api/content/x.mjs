/**
 * X API v2 (docs.x.com, read 10 Oct 2026).
 * OUR account (@pumpfunads): OAuth 1.0a user context from env (X_API_KEY/SECRET + X_ACCESS_TOKEN/SECRET).
 * CREATOR accounts (after graduation): OAuth 2.0 Authorization Code + PKCE (S256), scopes below, refresh tokens.
 * Media: the chunked v2 flow; the old `command=INIT/APPEND/FINALIZE` on /2/media/upload is RETIRED:
 *   POST /2/media/upload/initialize  JSON { media_type, total_bytes, media_category }   -> data.id
 *   POST /2/media/upload/{id}/append multipart { segment_index, media }                  (chunks <= 5 MB)
 *   POST /2/media/upload/{id}/finalize                                                  -> data.processing_info?
 *   GET  /2/media/upload?command=STATUS&media_id={id}                                   until succeeded | failed
 * Pay per use: a post is ~$0.015, a post containing a URL ~$0.20. So posts carry no link; the optional link reply
 * (X_LINK_REPLY_URL) is its own post and off by default.
 * ⛔ OAuth 1.0a signs query params only for JSON and multipart bodies (only form-urlencoded bodies join the base string).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { C, redirectUri } from './config.mjs';

const API = 'https://api.x.com';
export const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];
const CHUNK = 4 * 1024 * 1024;

/* ───────────── OAuth 1.0a (our account) ───────────── */

const pct = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export function oauth1Header(method, url, { consumerKey, consumerSecret, token, tokenSecret }, { nonce = crypto.randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const u = new URL(url);
  const oauth = { oauth_consumer_key: consumerKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(timestamp), oauth_token: token, oauth_version: '1.0' };
  const params = [...Object.entries(oauth), ...[...u.searchParams.entries()]].map(([k, v]) => [pct(k), pct(v)]).sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1));
  const base = [method.toUpperCase(), pct(`${u.origin}${u.pathname}`), pct(params.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  const sig = crypto.createHmac('sha1', `${pct(consumerSecret)}&${pct(tokenSecret)}`).update(base).digest('base64');
  return 'OAuth ' + Object.entries({ ...oauth, oauth_signature: sig }).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ');
}

const ours = () => ({ consumerKey: C.x.apiKey, consumerSecret: C.x.apiSecret, token: C.x.accessToken, tokenSecret: C.x.accessSecret });

/** auth = { oauth1: creds } | { bearer: token } */
async function xfetch(method, path, { auth, json, form, query } = {}) {
  const url = new URL(path, API);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const headers = { authorization: auth.bearer ? `Bearer ${auth.bearer}` : oauth1Header(method, url.toString(), auth.oauth1) };
  let body;
  if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form; // FormData sets its own content-type
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw Object.assign(new Error(`x ${method} ${url.pathname} ${res.status}: ${data?.detail || data?.title || data?.errors?.[0]?.message || text.slice(0, 160)}`), { status: res.status });
  return data;
}

/** Uploads a file (image or video) and waits until X has processed it. Returns the media id. */
export async function uploadMedia(filePath, mime, auth) {
  const total = fs.statSync(filePath).size;
  const category = mime.startsWith('video/') ? 'tweet_video' : mime === 'image/gif' ? 'tweet_gif' : 'tweet_image';
  const init = await xfetch('POST', '/2/media/upload/initialize', { auth, json: { media_type: mime, total_bytes: total, media_category: category } });
  const id = init?.data?.id;
  if (!id) throw new Error('x media initialize: no id');
  const fd = fs.openSync(filePath, 'r');
  try {
    for (let seg = 0, off = 0; off < total; seg++, off += CHUNK) {
      const buf = Buffer.alloc(Math.min(CHUNK, total - off));
      fs.readSync(fd, buf, 0, buf.length, off);
      const form = new FormData();
      form.set('segment_index', String(seg));
      form.set('media', new Blob([buf], { type: 'application/octet-stream' }), 'chunk');
      await xfetch('POST', `/2/media/upload/${id}/append`, { auth, form });
    }
  } finally { fs.closeSync(fd); }
  let info = (await xfetch('POST', `/2/media/upload/${id}/finalize`, { auth }))?.data?.processing_info;
  for (let i = 0; info && info.state !== 'succeeded'; i++) {
    if (info.state === 'failed') throw new Error(`x media processing failed: ${info.error?.message || ''}`);
    if (i > 60) throw new Error('x media processing timed out');
    await new Promise((r) => setTimeout(r, Math.min(30, info.check_after_secs || 3) * 1000));
    info = (await xfetch('GET', '/2/media/upload', { auth, query: { command: 'STATUS', media_id: id } }))?.data?.processing_info;
  }
  return id;
}

/**
 * Posts text + up to 4 images or 1 video. files = [{ path, mime }]. Returns { id, url, mock }.
 * auth: omitted = our account; { bearer } = a creator's OAuth 2 token.
 */
export async function post(text, files = [], { auth = null, replyTo = null, handle = null } = {}) {
  const useMock = auth ? C.x.oauthMock : C.x.mock;
  if (useMock) {
    const id = `mock${crypto.createHash('sha256').update(`${text}|${files.map((f) => f.path).join(',')}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 16)}`;
    return { id, url: `https://x.com/${handle || C.x.handle}/status/${id}`, mock: true };
  }
  const a = auth || { oauth1: ours() };
  const mediaIds = [];
  for (const f of files.slice(0, 4)) mediaIds.push(await uploadMedia(f.path, f.mime, a));
  const body = { text, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}), ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}) };
  const r = await xfetch('POST', '/2/tweets', { auth: a, json: body });
  const id = r?.data?.id;
  if (!id) throw new Error('x post: no id');
  return { id, url: `https://x.com/${handle || C.x.handle}/status/${id}`, mock: false };
}

/* ───────────── OAuth 2.0 + PKCE (creator accounts) ───────────── */

export const pkce = () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

export function authorizeUrl(state, challenge) {
  if (C.x.oauthMock) return `/api/oauth/x/callback?state=${encodeURIComponent(state)}&code=mock`;
  const u = new URL('https://x.com/i/oauth2/authorize');
  u.search = new URLSearchParams({ response_type: 'code', client_id: C.x.clientId, redirect_uri: redirectUri('x'), scope: SCOPES.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return u.toString();
}

async function tokenCall(params) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (C.x.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(C.x.clientId)}:${encodeURIComponent(C.x.clientSecret)}`).toString('base64')}`;
  const res = await fetch(`${API}/2/oauth2/token`, { method: 'POST', headers, body: new URLSearchParams({ client_id: C.x.clientId, ...params }), signal: AbortSignal.timeout(30_000) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.access_token) throw new Error(`x token ${res.status}: ${j?.error_description || j?.error || 'failed'}`);
  return { access_token: j.access_token, refresh_token: j.refresh_token || params.refresh_token || null, expires_at: Date.now() + (Number(j.expires_in) || 7200) * 1000, scope: j.scope || SCOPES.join(' ') };
}

/** Code -> tokens + who it is. Returns { tokens, handle, userId, scopes }. */
export async function exchange(code, verifier) {
  if (C.x.oauthMock) return { tokens: { access_token: 'mock', refresh_token: 'mock', expires_at: Date.now() + 7200_000 }, handle: 'mock_creator', userId: 'mock', scopes: SCOPES.join(' '), mock: true };
  const tokens = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri('x'), code_verifier: verifier });
  const me = await xfetch('GET', '/2/users/me', { auth: { bearer: tokens.access_token } });
  return { tokens, handle: me?.data?.username || null, userId: me?.data?.id || null, scopes: tokens.scope };
}

/** A fresh access token (refreshing 5 minutes early). Returns { tokens, changed }. */
export async function fresh(tokens) {
  if (C.x.oauthMock || tokens.expires_at - 300_000 > Date.now()) return { tokens, changed: false };
  if (!tokens.refresh_token) throw new Error('x token expired and there is no refresh token: relink');
  return { tokens: await tokenCall({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }), changed: true };
}
