/**
 * Files on disk: data/media/<mint>/<job>-<n>-<random>.<ext>. The random part keeps an unreviewed asset unguessable
 * (the route serves any file that exists; only approved ones are ever linked publicly).
 * Mock media: an SVG card that says MOCK in big letters, and (when ffmpeg is installed) a 1 second green mp4 so the
 * video player path is exercised too. Neither can pass for real content.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { C } from './config.mjs';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FILE_RE = /^[A-Za-z0-9_-]{1,80}\.(svg|png|jpg|jpeg|webp|gif|mp4|mov|webm)$/;
export const MIME = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const EXT_OF = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m, e]));
const MAX_DOWNLOAD = 300 * 1024 * 1024;

export const dirOf = (mint) => {
  if (!MINT_RE.test(mint)) throw new Error(`bad mint ${mint}`);
  const d = path.join(C.mediaDir, mint);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
export const fileName = (jobId, n, ext) => `${jobId}-${n}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
export const urlOf = (mint, file) => (file ? `/api/media/${mint}/${file}` : null);
export const absPath = (mint, file) => path.join(C.mediaDir, mint, file);

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);
function wrap(text, width, lines) {
  const out = [];
  let cur = '';
  for (const w of String(text).split(/\s+/)) {
    if ((cur + ' ' + w).trim().length > width) { out.push(cur.trim()); cur = w; } else cur += ' ' + w;
    if (out.length >= lines) break;
  }
  if (out.length < lines && cur.trim()) out.push(cur.trim());
  return out.slice(0, lines);
}

/** A labelled placeholder card. aspect '1:1' | '9:16' | '16:9'. */
export function mockSvg({ title, subtitle, prompt, aspect = '1:1', seed = '' }) {
  const [w, h] = aspect === '9:16' ? [720, 1280] : aspect === '16:9' ? [1280, 720] : [1024, 1024];
  const hue = parseInt(crypto.createHash('sha256').update(String(seed || title)).digest('hex').slice(0, 2), 16);
  const lines = wrap(prompt || '', Math.floor(w / 22), 6);
  return {
    w, h,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="100%" height="100%" fill="#0A0A0B"/>
<circle cx="${w * 0.78}" cy="${h * 0.25}" r="${Math.min(w, h) * 0.3}" fill="hsl(${hue} 60% 45%)" opacity="0.35"/>
<rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="none" stroke="#86EFAC" stroke-width="4" stroke-dasharray="16 12"/>
<text x="48" y="110" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-size="84" font-weight="700" fill="#86EFAC">MOCK</text>
<text x="48" y="190" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-size="56" font-weight="700" fill="#FAFAFA">${esc(title)}</text>
<text x="48" y="240" font-family="Geist, Arial, sans-serif" font-size="28" fill="#A1A1AA">${esc(subtitle)}</text>
${lines.map((l, i) => `<text x="48" y="${h - 60 - (lines.length - 1 - i) * 36}" font-family="Geist, Arial, sans-serif" font-size="24" fill="#71717A">${esc(l)}</text>`).join('\n')}
</svg>`,
  };
}

/** A stored file's path on disk (base name only: never leaves the coin's folder). */
export const pathOf = (mint, file) => path.join(dirOf(mint), path.basename(file));

export function writeFile(mint, name, data) {
  const p = path.join(dirOf(mint), name);
  fs.writeFileSync(p, data);
  return name;
}

let ffmpegOk;
const hasFfmpeg = () => {
  if (ffmpegOk === undefined) ffmpegOk = new Promise((resolve) => execFile('ffmpeg', ['-version'], { timeout: 5000 }, (e) => resolve(!e)));
  return ffmpegOk;
};
/** A 1 s solid green 180x320 mp4 (mock video). Null when ffmpeg is not installed: the poster is then the asset. */
export async function mockMp4(mint, name) {
  if (!(await hasFfmpeg())) return null;
  const out = path.join(dirOf(mint), name);
  return new Promise((resolve) => execFile('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x86EFAC:s=180x320:d=1:r=12', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { timeout: 20_000 }, (e) => resolve(e ? null : name)));
}

/** Downloads a provider output URL to the coin's folder. Returns { file, mime, bytes }. */
export async function download(mint, url, base, fallbackMime) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD) throw new Error('download too large');
  const mime = (res.headers.get('content-type') || fallbackMime || '').split(';')[0].trim();
  const ext = EXT_OF[mime] || (String(new URL(url).pathname).match(/\.(\w{3,4})$/)?.[1] || '').toLowerCase();
  if (!MIME[ext]) throw new Error(`unexpected media type ${mime || ext}`);
  const file = `${base}.${ext}`;
  const p = path.join(dirOf(mint), file);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(p));
  const bytes = fs.statSync(p).size;
  if (bytes > MAX_DOWNLOAD || bytes === 0) { fs.rmSync(p, { force: true }); throw new Error('bad download size'); }
  return { file, mime: MIME[ext], bytes };
}

/**
 * Streams /api/media/<mint>/<file>. Names are checked against a strict pattern (no path can escape the folder),
 * content-addressed by randomness so cached forever. Single byte ranges are honoured: Safari will not play a video
 * from a server that ignores Range.
 */
export async function serve(req, res, mint, file) {
  if (!MINT_RE.test(mint) || !FILE_RE.test(file)) return false;
  const p = path.join(C.mediaDir, mint, file);
  let st;
  try { st = fs.statSync(p); } catch { return false; }
  if (!st.isFile()) return false;
  const type = MIME[file.split('.').pop().toLowerCase()];
  const headers = { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" };
  const m = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  let start = 0, end = st.size - 1, status = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), end) : end; } else { start = Math.max(0, st.size - Number(m[2])); }
    if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return true; }
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['content-length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  await pipeline(fs.createReadStream(p, { start, end }), res).catch(() => res.destroy());
  return true;
}
