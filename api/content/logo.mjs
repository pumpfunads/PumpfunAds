/**
 * The launch form's "make me a logo": one square Higgsfield image from the coin's description, returned as a data URL
 * (the launch flow stores it like an upload). 3 per wallet per UTC day, counted on success (a failed generation is not
 * charged by Higgsfield either). Paid by Ads (there is no coin yet): the cost is logged in `decisions` and counts
 * against GENERATION_DAILY_USD_CAP (logo_requests is summed into planner.spentToday()).
 * Mock (no key): a real 512x512 PNG (a ring on a colour from the name, the launch flow only accepts raster images)
 * so the whole launch path works without a key. It is plainly a placeholder, never a real logo.
 */
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { one, run, now } from '../db.mjs';
import { ApiError } from '../errors.mjs';
import { imageType } from '../images.mjs';
import { C } from './config.mjs';
import * as hf from './higgsfield.mjs';
import * as credits from './credits.mjs';
import * as llm from './llm.mjs';
import { clean } from './copy.mjs';
import { decide, spentToday } from './planner.mjs';
import './schema.mjs';

export const LOGOS_PER_DAY = 3;
const LOGOS_ALL_PER_DAY = Number(process.env.LOGOS_ALL_PER_DAY || 150); // every wallet together: wallets are free to make
const dayStart = (t = now()) => t - (t % 86_400_000);
const usedToday = (wallet) => one('SELECT COUNT(*) AS n FROM logo_requests WHERE wallet = ? AND created_at >= ?', wallet, dayStart()).n;

/* a minimal PNG encoder (RGB, no filter) */
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
export function mockPng(seed, size = 512) {
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  const bg = [h[0], h[1], h[2]].map((v) => 40 + (v % 120));
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const c = size / 2, r1 = size * 0.28, r2 = size * 0.36;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const px = d > r1 && d < r2 ? [0x86, 0xef, 0xac] : bg; // a Pumpfun-green ring
      raw.set(px, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** { imageData, remaining, mock }. Throws ApiError 429 when the wallet used its 3 for today. */
export async function generateLogo({ description, name, symbol, style, wallet } = {}) {
  if (!wallet) throw new ApiError('Sign in first', 401);
  const used = usedToday(wallet);
  if (used >= LOGOS_PER_DAY) throw new ApiError(`You made ${LOGOS_PER_DAY} logos today. Upload your own, or try again tomorrow (UTC).`, 429);
  const desc = clean(description).slice(0, 300), nm = clean(name).slice(0, 32), sym = clean(symbol).slice(0, 10), st = clean(style).slice(0, 60);
  if (!desc && !nm) throw new ApiError('Describe your coin first', 400);
  if (!C.higgsfield.mock && one('SELECT COUNT(*) AS n FROM logo_requests WHERE created_at >= ?', dayStart()).n >= LOGOS_ALL_PER_DAY) throw new ApiError('Logo making is paused for today. Upload your own image.', 503);
  // ⛔ The slot is taken BEFORE the paid call: parallel requests from one wallet cannot all pass the 3-a-day check.
  const slot = Number(run('INSERT INTO logo_requests (wallet, cost_micros, mock, created_at) VALUES (?, 0, ?, ?)', wallet, C.higgsfield.mock ? 1 : 0, now()).lastInsertRowid);
  const prompt = `Logo for a memecoin called ${nm || 'the coin'}${sym ? ` (${sym})` : ''}: ${desc}. ${st ? `Style: ${st}. ` : ''}A single centered mascot or emblem, bold shapes, flat vivid colors, plain background, square, no text, no letters, no watermark.`;
  let bytes, cost = 0, mock = C.higgsfield.mock;
  if (mock) {
    bytes = mockPng(`${nm}|${sym}|${desc}|${used}`);
  } else {
    if (spentToday() >= C.globalDailyUsd * 1e6) { run('DELETE FROM logo_requests WHERE id = ?', slot); throw new ApiError('Logo making is paused for today. Upload your own image.', 503); }
    const m = await llm.moderate([{ text: prompt, kind: 'prompt' }]);
    if (!m.ok) throw new ApiError('That description cannot be made into a logo. Try different words (no real people or brands).', 400);
    cost = (await hf.estimate(hf.MODELS.image, { aspect_ratio: '1:1' })) + m.costMicros;
    const out = await hf.run(hf.MODELS.image, { prompt, aspect_ratio: '1:1' }, `ads-logo-${crypto.randomUUID()}`, { timeoutMs: 3 * 60_000 });
    credits.recordSpend(cost - m.costMicros, `logo ${out.request_id}`);
    run('UPDATE logo_requests SET cost_micros = ? WHERE id = ?', cost, slot); // charged now, even if the download below fails
    const url = out.images?.[0]?.url;
    if (!url) throw new ApiError('The logo did not come out. Try again.', 502);
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new ApiError('The logo did not come out. Try again.', 502);
    bytes = Buffer.from(await res.arrayBuffer());
  }
  const type = imageType(bytes);
  if (!type || bytes.length > 4 * 1024 * 1024) throw new ApiError('The logo did not come out. Try again.', 502);
  run('UPDATE logo_requests SET cost_micros = ? WHERE id = ?', cost, slot);
  decide(null, null, 'spend', `launch logo for ${wallet.slice(0, 6)}: platform pays $${(cost / 1e6).toFixed(4)}${mock ? ' (mock)' : ''}`);
  return { imageData: `data:${type};base64,${bytes.toString('base64')}`, remaining: LOGOS_PER_DAY - used - 1, mock };
}
