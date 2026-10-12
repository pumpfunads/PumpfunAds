/**
 * Every token image the site shows is served from our own folder (ported from EARN, where it works).
 *
 * ⛔ pump.fun's upload returns an `ipfs.io` image link, and ipfs.io now blocks pump.fun CIDs (403
 *    "blocked" outside a browser, interstitials inside), so a coin could launch fine on pump.fun and show
 *    a broken image here. So:
 *  - an image uploaded through the launch form is stored here, from the bytes, before it goes to pump.fun;
 *  - an image that arrives as a URL (a coin read from chain) is fetched ONCE through the gateways that do
 *    serve pump.fun CIDs, checked to be a real PNG/JPEG/GIF/WebP by its bytes, and stored.
 * Files are named by content hash (idempotent) and shown as a 512×512 WebP square made with ImageMagick.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './db.mjs';

export const LOGO_DIR = path.join(path.dirname(DB_PATH), 'logos');
fs.mkdirSync(LOGO_DIR, { recursive: true });

// Measured 27 Sep 2026 on a fresh pump.fun upload (EARN): pump.mypinata.cloud 200 in 1.6 s,
// gateway.pinata.cloud 200 in 5 s, ipfs.filebase.io timed out on the image, dweb.link 403, ipfs.io 403.
export const GATEWAYS = ['https://pump.mypinata.cloud/ipfs', 'https://gateway.pinata.cloud/ipfs', 'https://ipfs.filebase.io/ipfs'];
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const MAX_BYTES = 8 * 1024 * 1024;

/** The real type from the bytes, never from a header or a data-URL prefix. */
export function imageType(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export function ipfsPath(url) {
  // ipfs://<cid>, …/ipfs/<cid>[/path], or a subdomain gateway: https://<cid>.ipfs.<host>/[path] (nftstorage, w3s, dweb)
  const sub = String(url).match(/^https:\/\/(baf[a-z0-9]{40,}|Qm[1-9A-HJ-NP-Za-km-z]{44})\.ipfs\.[a-z0-9.-]+(\/[A-Za-z0-9._\-/]*)?/);
  if (sub) return `${sub[1]}${sub[2] && sub[2] !== '/' ? sub[2] : ''}`;
  const m = String(url).match(/^ipfs:\/\/(.+)$/) ?? String(url).match(/\/ipfs\/([A-Za-z0-9][A-Za-z0-9._\-/]*)/);
  return m ? m[1].replace(/[?#].*$/, '') : null;
}

/** Stores bytes under their hash; returns the site path (`/api/logos/<hash>.<ext>`). Idempotent. */
export function storeImage(bytes) {
  const type = imageType(bytes);
  if (!type) throw new Error('not an image');
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}${EXT[type]}`;
  const file = path.join(LOGO_DIR, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  squareLogo(name); // started now, in the background (never blocks the process); the original is served until it is done
  return `/api/logos/${name}`;
}

async function fetchImage(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0 (Ads image cache)' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('too large');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES || !imageType(bytes)) throw new Error('not an image');
  return bytes;
}

const failed = new Map(); // url → time of the last failed attempt, so a dead image is retried hourly, not per request
/** Our own copy of `url` (a site path), or null if nothing served it. Never throws. */
export async function cacheImage(url, { timeoutMs = 8000 } = {}) {
  const u = String(url ?? '').trim();
  if (!u) return null;
  if (u.startsWith('/api/logos/')) return u;
  if (!/^https:\/\//.test(u) && !u.startsWith('ipfs://')) return null;
  if (Date.now() - (failed.get(u) || 0) < 3_600_000) return null;
  const cid = ipfsPath(u);
  const candidates = cid ? [...GATEWAYS.map((g) => `${g}/${cid}`), ...(GATEWAYS.some((g) => u.startsWith(g)) || u.startsWith('ipfs://') ? [] : [u])] : [u];
  for (const c of candidates) {
    try {
      return storeImage(await fetchImage(c, timeoutMs));
    } catch {}
  }
  failed.set(u, Date.now());
  return null;
}

/** The 512×512 WebP square shown for a stored logo (made once, beside it in sq/). Runs ImageMagick ASYNCHRONOUSLY: a
 *  synchronous convert of a large upload stalled the whole process (keeper included) for up to 15 s. Not made for a GIF
 *  (it would lose its animation), without ImageMagick, or after a failure: the original is served instead. */
const MAGICK_IN = { '.png': 'png', '.jpg': 'jpeg', '.webp': 'webp' };
const failedSquares = new Set();
const making = new Map(); // name → the promise of the square being made (a second caller waits on the same one)
/** Starts the square in the background; the returned promise settles when it is done (a short-lived script awaits it,
 *  the server never does). */
export function squareLogo(name) {
  if (making.has(name)) return making.get(name);
  const job = new Promise((done) => {
  const ext = name.slice(name.lastIndexOf('.'));
  if (!MAGICK_IN[ext] || failedSquares.has(name)) return done();
  const out = path.join(LOGO_DIR, 'sq', `${name.slice(0, name.lastIndexOf('.'))}.webp`);
  if (fs.existsSync(out)) return done();
  if (fs.existsSync(`${out}.failed`)) { failedSquares.add(name); return done(); }
  fs.rmSync(`${out}.tmp`, { force: true }); // left by a process that exited mid-convert
  fs.mkdirSync(path.join(LOGO_DIR, 'sq'), { recursive: true });
  // The explicit input coder: ImageMagick reads only that format, whatever the bytes claim. [0] = first frame.
  // ⛔ Hard limits: a 4 MB PNG can declare 60,000×60,000 pixels.
  execFile('convert', ['-limit', 'width', '8000', '-limit', 'height', '8000', '-limit', 'area', '64MP', '-limit', 'memory', '256MiB', '-limit', 'map', '256MiB', '-limit', 'disk', '0', `${MAGICK_IN[ext]}:${path.join(LOGO_DIR, name)}[0]`, '-resize', '512x512^', '-gravity', 'center', '-extent', '512x512', '-strip', '-quality', '86', `webp:${out}.tmp`], { timeout: 15_000 }, (err) => {
    making.delete(name);
    try {
      if (err) throw err;
      fs.renameSync(`${out}.tmp`, out);
    } catch {
      fs.rmSync(`${out}.tmp`, { force: true });
      try { fs.writeFileSync(`${out}.failed`, ''); } catch {}
      failedSquares.add(name); // never retried: the original is served instead
    }
    done();
  });
  }).finally(() => making.delete(name));
  making.set(name, job);
  return job;
}

/** GET /api/logos/<name>: the square made at store time if there is one, else the original. Never converts here:
 *  a public GET must not be able to start a 15 s synchronous job. Long-cached (content-hashed). */
export function serveLogo(res, name) {
  if (!/^[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(name)) return false;
  const orig = path.join(LOGO_DIR, name);
  if (!fs.existsSync(orig)) return false;
  const sqPath = path.join(LOGO_DIR, 'sq', `${name.slice(0, name.lastIndexOf('.'))}.webp`);
  const sq = fs.existsSync(sqPath) ? sqPath : null;
  const file = sq || orig;
  const type = sq ? 'image/webp' : EXT_TYPE[name.slice(name.lastIndexOf('.'))];
  res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res); // deleted between the check and the read: no crash
  return true;
}
const EXT_TYPE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** Removes stored logos that no launch references and that are older than a day (prepares that never went live). */
export function gc(referenced) {
  const keep = new Set(referenced.map((p) => String(p || '').split('/').pop()).filter(Boolean));
  let n = 0;
  for (const f of fs.readdirSync(LOGO_DIR)) {
    if (!/^[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(f) || keep.has(f)) continue;
    const p = path.join(LOGO_DIR, f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs < 86_400_000) continue;
      fs.rmSync(p);
      const base = f.slice(0, f.lastIndexOf('.'));
      for (const x of [`${base}.webp`, `${base}.webp.failed`]) fs.rmSync(path.join(LOGO_DIR, 'sq', x), { force: true });
      n++;
    } catch {}
  }
  return n;
}
