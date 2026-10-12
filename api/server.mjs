// Ads (pumpfunads.com): HTTP API, fee keeper, treasury, content engine and the built site, in one Node process.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { env, num, PROD, ROOT } from './env.mjs';
import { ApiError } from './errors.mjs';
import * as sol from './sol.mjs';
import * as auth from './auth.mjs';
import * as launch from './launch.mjs';
import * as market from './market.mjs';
import * as keeper from './keeper.mjs';
import * as treasury from './treasury.mjs';
import { STEPS } from '../lib/ladder.mjs';
import * as images from './images.mjs';
import * as vanity from './vanity.mjs';
import * as health from './health.mjs';
import * as lut from './lut.mjs';
import { getKv, one } from './db.mjs';
import * as content from './content/index.mjs';

const PORT = num('PORT', 5420);
const DIST = path.join(ROOT, 'web', 'dist');
const COOKIE = 'ads_session';
const MAX_BODY = 7 * 1024 * 1024;

/* ───────────── rate limits (per IP, in memory) ───────────── */

const buckets = new Map();
function limit(ip, key, perWindow, windowMs) {
  const k = `${key}:${ip}`;
  const b = buckets.get(k);
  const t = Date.now();
  if (!b || t - b.start > windowMs) {
    buckets.set(k, { start: t, n: 1 });
    return;
  }
  if (++b.n > perWindow) throw new ApiError('Too many requests, slow down a little', 429);
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t - b.start > 3_600_000) buckets.delete(k); }, 600_000).unref();

/* ───────────── plumbing ───────────── */

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': json ? 'application/json; charset=utf-8' : headers['content-type'] || 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(json ? JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? String(v) : v)) : body);
}
async function readBody(req, max = MAX_BODY) {
  const parts = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new ApiError(`Request body is over ${Math.round(max / 1024 / 1024)} MB`, 413);
    parts.push(c);
  }
  const raw = Buffer.concat(parts);
  if (!raw.length) return {};
  let v;
  try {
    v = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError('Body must be JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ApiError('Body must be a JSON object');
  return v;
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return out;
}
const sessionCookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PROD ? '; Secure' : ''}`;
const sessionOf = (req) => auth.sessionWallet(cookies(req)[COOKIE]);
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PROD ? '; Secure' : ''}`;
// The private preview of the site's own token: a browser that opened /api/preview/<token> (kv previewToken) also sees
// rows with status 'preview'. Nobody else does. The token is random, made by scripts/ads.mjs preview on.
const PREVIEW_COOKIE = 'ads_preview';
const previewOf = (req) => { const t = getKv('previewToken', null); const c = cookies(req)[PREVIEW_COOKIE]; return Boolean(t && c && c.length === t.length && c === t); };
const redirect = (res, to) => { res.writeHead(302, { location: to, 'cache-control': 'no-store' }); res.end(); };

/* ───────────── routes ───────────── */

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });
const mintOf = (p) => sol.requireMint(p.mint).toBase58();

route('GET', '/api/config', async ({ req }) => ({
  brand: 'Pumpfun Ads', accent: '#86EFAC', explorer: sol.EXPLORER,
  feeRates: launch.FEE_RATES, maxDevBuySol: launch.MAX_DEV_BUY_SOL, ladder: STEPS, platforms: launch.PLATFORMS, vibes: launch.VIBES,
  keeper: { enabled: keeper.enabled, dryRun: keeper.DRY, intervalMinutes: keeper.status().intervalMs / 60_000 },
  launchesPerWalletDay: launch.LAUNCHES_PER_WALLET_DAY,
  vanity: { suffix: vanity.SUFFIX, required: vanity.REQUIRED, ready: vanity.ready() },
  launchReady: Boolean(await lut.launchTable().catch(() => null)) && (!vanity.REQUIRED || vanity.ready() > 0),
  launchOpen: launch.launchOpen() && Boolean(launch.adsMint()) && !getKv('ended', false),
  ended: Boolean(getKv('ended', false)), // operator 11 Oct: Pumpfun Ads wound down, the site stays up read-only
  socials: { x: env('X_HANDLE', '@pumpfunads'), tiktok: env('TIKTOK_HANDLE', '@pumpfunad') },
  // $ADS { mint, symbol }: the live one, or (preview cookie only) the preview's
  token: getKv('token', null) || (previewOf(req) ? getKv('previewTokenInfo', null) : null),
}));
route('GET', '/api/health', async () => { const r = await health.report(); return { ...r, problems: r.problems.map(({ level, text }) => ({ level, text })) }; });
route('GET', '/api/stats', async () => market.stats());
route('GET', '/api/coins', async ({ req, query, ip }) => { limit(ip, 'list', 120, 60_000); return market.list({ sort: query.get('sort') || 'new', q: query.get('q') || '', limit: query.get('limit'), preview: previewOf(req), graduated: query.get('graduated') === '1', platform: query.get('platform') || '' }); });
route('GET', '/api/coins/:mint', async ({ req, params }) => market.get(mintOf(params), { preview: previewOf(req) }));
route('GET', '/api/preview/:token', async ({ params, res, ip }) => {
  limit(ip, 'preview', 20, 600_000);
  const t = getKv('previewToken', null);
  if (!t || String(params.token) !== t) throw new ApiError('This preview link is not valid', 404);
  res.setHeader('set-cookie', cookie(PREVIEW_COOKIE, t, 7 * 86_400));
  redirect(res, '/');
});

route('GET', '/api/mine', async ({ req }) => {
  const w = sessionOf(req);
  if (!w) throw new ApiError('Sign in first', 401);
  return market.mine(w);
});
route('GET', '/api/nonce', async ({ ip }) => { limit(ip, 'nonce', 30, 60_000); return auth.newNonce(); });
route('GET', '/api/session', async ({ req }) => ({ wallet: sessionOf(req) }));
route('POST', '/api/session', async ({ body, ip, res }) => {
  limit(ip, 'signin', 20, 60_000);
  const s = auth.signIn(body);
  res.setHeader('set-cookie', sessionCookie(s.sid, s.maxAge));
  return { wallet: s.wallet };
});
route('DELETE', '/api/session', async ({ req, res }) => {
  auth.signOut(cookies(req)[COOKIE]);
  res.setHeader('set-cookie', sessionCookie('', 0));
  return { ok: true };
});

route('POST', '/api/launch/logo', async ({ req, body, ip }) => {
  limit(ip, 'logo', 10, 3_600_000);
  const w = sessionOf(req);
  if (!w) throw new ApiError('Sign in first', 401);
  if (!content.generateLogo) throw new ApiError('Logo generation is not available right now. Upload an image instead.', 503);
  return content.generateLogo({ description: String(body.description || '').slice(0, 500), name: String(body.name || '').slice(0, 32), symbol: String(body.symbol || '').slice(0, 10), style: String(body.style || '').slice(0, 60), wallet: w });
});
route('POST', '/api/launch/prepare', async ({ req, body, ip }) => { limit(ip, 'prepare', 10, 3_600_000); return launch.prepare(body, sessionOf(req)); });
route('POST', '/api/launch/submit', async ({ req, body }) => launch.submit(body, sessionOf(req)));
route('POST', '/api/launch/relock', async ({ req, body }) => launch.relock(String(body.mint || ''), sessionOf(req)));

/* the content engine's own routes (api/content) */
const isAdmin = (req) => { const t = env('ADMIN_TOKEN', ''); const c = cookies(req).ads_admin; return Boolean(t && c && c.length === t.length && c === t); };
content.routes(route, { sessionOf, limit, ApiError, isAdmin, cookie, redirect });

/* ───────────── static site ───────────── */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml' };
// Plain HTML pages (readable without JavaScript, as app reviewers like TikTok's fetch them).
const PAGES = { '/terms': 'terms.html', '/privacy': 'privacy.html' };
function serveStatic(res, url) {
  const page = PAGES[url.pathname.replace(/\/+$/, '')];
  if (page) url = new URL(`/${page}`, url);
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const file = path.join(DIST, rel);
  if (file.startsWith(DIST + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const hashed = rel.startsWith('assets/');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return;
  }
  // A missing hashed asset must 404, never fall back to index.html (a stale tab would render blank).
  if (rel.startsWith('assets/') || TYPES[path.extname(rel).toLowerCase()]) return send(res, 404, 'Not found');
  const index = path.join(DIST, 'index.html');
  if (!fs.existsSync(index)) return send(res, 404, 'Site not built. Run npm run build, or use npm run dev.');
  const coin = url.pathname.match(/^\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/);
  if (coin) {
    const html = coinPageHtml(fs.readFileSync(index, 'utf8'), coin[1]);
    if (html) { res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' }); res.end(html); return; }
  }
  res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
  fs.createReadStream(index).on('error', () => res.destroy()).pipe(res);
}

/**
 * A coin page's own share card: a /t/<mint> link posted on X shows the coin (name, pitch, its site hero or its logo),
 * not the generic Ads card. ⛔ twitter:card has no og equivalent: a square logo goes out as 'summary' (a large card
 * would crop it), a 16:9 site hero as 'summary_large_image'. Null (generic page) for an unknown coin.
 */
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function coinPageHtml(html, mint) {
  const row = one("SELECT name, symbol, image, brief_json, description FROM launches WHERE mint = ? AND status = 'live' AND hidden = 0", mint);
  if (!row) return null;
  const base = env('PUBLIC_URL', 'https://pumpfunads.com');
  let brief = {};
  try { brief = JSON.parse(row.brief_json || '{}'); } catch {}
  const site = content.siteFor?.(mint);
  const heroUrl = site?.hero?.url && !site.hero.mock && /^image\//.test(site.hero.mime || 'image/') ? site.hero.url : null;
  const title = `${row.name} ($${row.symbol})`;
  const desc = site?.tagline || brief.pitch || row.description || 'Launched on Pumpfun Ads. Its creator fees pay for its ads.';
  const image = new URL(heroUrl || row.image || '/og.png?v=5', base).toString();
  // Function replacers: a name holding `$'` or `$&` must stay text, not paste pieces of the template.
  const set = (attr, key, value) => { html = html.replace(new RegExp(`(<meta ${attr}="${key}" content=")[^"]*(")`), (_, a, b) => `${a}${esc(value)}${b}`); };
  // The tab always reads "Pumpfun Ads" (operator, 11 Oct): the coin's name goes in the share card, not the tab.
  set('name', 'description', desc);
  for (const [a, k] of [['property', 'og:title'], ['name', 'twitter:title']]) set(a, k, `${title} on Pumpfun Ads`);
  for (const [a, k] of [['property', 'og:description'], ['name', 'twitter:description']]) set(a, k, desc);
  for (const [a, k] of [['property', 'og:image'], ['name', 'twitter:image']]) set(a, k, image);
  set('property', 'og:image:alt', title);
  set('property', 'og:url', `${base}/t/${mint}`);
  set('name', 'twitter:card', heroUrl ? 'summary_large_image' : 'summary');
  if (!heroUrl) html = html.replace(/\s*<meta property="og:image:(width|height)" content="[^"]*" \/>/g, '');
  return html;
}

/* ───────────── server ───────────── */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    return send(res, 400, 'Bad request');
  }
  // Behind Caddy the LAST X-Forwarded-For entry is the one Caddy appended (the real client).
  const fwd = env('TRUST_PROXY') === '1' ? String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean) : [];
  const ip = fwd.at(-1) || String(req.socket.remoteAddress || '');
  try {
    if (url.pathname.startsWith('/api/logos/')) {
      if (!images.serveLogo(res, path.basename(url.pathname))) send(res, 404, { error: 'Not found' });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'POST') limit(ip, 'post', 60, 60_000);
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.re);
        if (!m) continue;
        const body = req.method === 'POST' ? await readBody(req) : null;
        const out = await r.fn({ req, res, params: m.groups || {}, query: url.searchParams, body, ip });
        if (res.writableEnded) return; // a redirect wrote the response itself
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'No such endpoint' });
    }
    return serveStatic(res, url);
  } catch (e) {
    if (e instanceof URIError) return send(res, 400, 'Bad request');
    if (!e.expose) console.error(req.method, url.pathname, e);
    return send(res, e.status || 500, { error: e.expose ? e.message : 'Something went wrong on pumpfunads.com. Try again in a minute.', stage: e.stage || undefined });
  }
});

keeper.start();
treasury.start();
content.setGraduatedReader?.(async (mint) => keeper.graduated(mint));
content.start();
vanity.start();
health.start();
setInterval(() => { try { const n = images.gc(market.allImages()); if (n) console.log(`removed ${n} orphaned logo(s)`); } catch (e) { console.error('logo gc', e.message); } }, 6 * 3_600_000).unref();
setInterval(() => launch.recycleAddresses().then((n) => n && console.log(`returned ${n} unused address(es) to the pool`)).catch((e) => console.error('recycle', e.message)), 30 * 60_000).unref();
setInterval(() => launch.reconcile().then((n) => n && console.log(`reconciled ${n} launch(es) found routed on chain`)).catch((e) => console.error('reconcile', e.message)), 60_000).unref();
server.listen(PORT, '127.0.0.1', () => console.log(`ads on http://127.0.0.1:${PORT} (rpc ${sol.RPC_URL.replace(/api-key=[^&]+/, 'api-key=***')})`));
