/**
 * TikTok (developers.tiktok.com, read 10 Oct 2026).
 * ⛔ OUR account (@pumpfunads) is never posted by API: TikTok's Content Posting API rejects tools that post to
 *    team-managed / brand accounts and forbids auto-posting without the account owner confirming each post. Our TikTok
 *    posts get status 'download' and wait in the admin download queue (an operator uploads them in the app).
 * CREATOR accounts (after graduation): Login Kit OAuth (web: no PKCE) + Content Posting API "upload to inbox":
 *   POST /v2/post/publish/inbox/video/init/  { source_info:{ source:'FILE_UPLOAD', video_size, chunk_size, total_chunk_count } }
 *     -> data.publish_id, data.upload_url (valid 1 h)
 *   PUT upload_url, Content-Range bytes a-b/total, Content-Type video/mp4
 *   The video lands in the creator's TikTok inbox as a draft; THEY finish and post it in the app (tell them so).
 * Limits: 6 requests/min per user token, at most 5 pending inbox shares per 24 h (spam_risk_too_many_pending_share).
 * Scopes: user.info.basic (open_id, display name), video.upload (inbox). An unaudited app's uploads are private-only
 * and limited to test users: the app needs TikTok's audit before creators outside the sandbox can link.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { C, redirectUri } from './config.mjs';

const API = 'https://open.tiktokapis.com';
export const SCOPES = ['user.info.basic', 'video.upload'];
const MAX_SINGLE = 64 * 1024 * 1024; // a file up to 64 MB goes as one chunk; our 10-30 s 720p videos are far below

export function authorizeUrl(state) {
  if (C.tiktok.mock) return `/api/oauth/tiktok/callback?state=${encodeURIComponent(state)}&code=mock`;
  const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
  u.search = new URLSearchParams({ client_key: C.tiktok.clientKey, scope: SCOPES.join(','), response_type: 'code', redirect_uri: redirectUri('tiktok'), state }).toString();
  return u.toString();
}

async function tokenCall(params) {
  const res = await fetch(`${API}/v2/oauth/token/`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_key: C.tiktok.clientKey, client_secret: C.tiktok.clientSecret, ...params }), signal: AbortSignal.timeout(30_000) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.access_token) throw new Error(`tiktok token ${res.status}: ${j?.error_description || j?.error || 'failed'}`);
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (Number(j.expires_in) || 86_400) * 1000, refresh_expires_at: Date.now() + (Number(j.refresh_expires_in) || 0) * 1000, open_id: j.open_id, scope: j.scope };
}

export async function exchange(code) {
  if (C.tiktok.mock) return { tokens: { access_token: 'mock', refresh_token: 'mock', expires_at: Date.now() + 86_400_000 }, handle: 'mock_creator', userId: 'mock', scopes: SCOPES.join(','), mock: true };
  const tokens = await tokenCall({ code: decodeURIComponent(code), grant_type: 'authorization_code', redirect_uri: redirectUri('tiktok') });
  let handle = null;
  try {
    const r = await fetch(`${API}/v2/user/info/?fields=open_id,display_name`, { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15_000) });
    handle = (await r.json())?.data?.user?.display_name || null;
  } catch {}
  return { tokens, handle, userId: tokens.open_id, scopes: tokens.scope };
}

export async function fresh(tokens) {
  if (C.tiktok.mock || tokens.expires_at - 300_000 > Date.now()) return { tokens, changed: false };
  return { tokens: await tokenCall({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }), changed: true };
}

/** Sends a video to the creator's TikTok inbox as a draft. Returns { publishId, mock }. */
export async function uploadToInbox(filePath, mime, tokens) {
  if (C.tiktok.mock) return { publishId: `mock${crypto.randomBytes(8).toString('hex')}`, mock: true };
  const size = fs.statSync(filePath).size;
  if (size > MAX_SINGLE) throw new Error('tiktok: video over 64 MB, chunked upload not implemented');
  const init = await fetch(`${API}/v2/post/publish/inbox/video/init/`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 } }), signal: AbortSignal.timeout(30_000),
  });
  const j = await init.json().catch(() => null);
  if (!init.ok || j?.error?.code && j.error.code !== 'ok') throw new Error(`tiktok inbox init ${init.status}: ${j?.error?.code || ''} ${j?.error?.message || ''}`.trim());
  const put = await fetch(j.data.upload_url, { method: 'PUT', headers: { 'content-type': mime, 'content-length': String(size), 'content-range': `bytes 0-${size - 1}/${size}` }, body: fs.readFileSync(filePath), signal: AbortSignal.timeout(300_000) });
  if (!put.ok) throw new Error(`tiktok upload ${put.status}`);
  return { publishId: j.data.publish_id, mock: false };
}
