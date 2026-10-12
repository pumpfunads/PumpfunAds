/**
 * The content engine: "we become your marketing team". A coin's budget (api/ledger.mjs, its creator fees) buys
 * content on the unlock ladder (lib/ladder.mjs): a launch card, memes, videos, a trailer and a site at graduation.
 *   planner.mjs   what is due, policy + caps, spend before generating, generate, moderate, review
 *   posting.mjs   approved content to our X (capped per day), our TikTok (admin download queue), creators' accounts
 *   higgsfield / llm / x / tiktok   the adapters, each with its own mock mode (on when its key is missing)
 *   routes.mjs    /api/feed, /api/media, coin content, social linking, the admin desk
 * Exports used by the rest of the app: routes, start, coinContent, feed, onLaunched, setGraduatedReader, tick.
 */
import { all, one } from '../db.mjs';
import { C } from './config.mjs';
import * as media from './media.mjs';
import * as socials from './socials.mjs';
import * as planner from './planner.mjs';
import * as posting from './posting.mjs';
import { register } from './routes.mjs';
import './schema.mjs';

export { setGraduatedReader, onLaunched } from './planner.mjs';
export { modes } from './config.mjs';
export { generateLogo } from './logo.mjs';

/** Registers the HTTP routes (server.mjs). */
export function routes(route, ctx) { register(route, ctx); }

export const assetView = (a) => ({
  id: a.id, kind: a.kind, url: media.urlOf(a.mint, a.path), thumb: media.urlOf(a.mint, a.thumb || a.path), mime: a.mime,
  width: a.width, height: a.height, duration: a.duration, caption: a.caption, mock: Boolean(a.mock), createdAt: a.created_at,
});
const postedTo = (jobId) => all("SELECT platform, url FROM posts WHERE job_id = ? AND status = 'posted' AND platform IN ('x', 'tiktok', 'creator_x')", jobId).map((p) => ({ platform: p.platform, url: p.url }));

/** A coin's public content: { gallery, socials, done }. Only approved or posted work is public. */
export function coinContent(mint) {
  const gallery = all("SELECT a.*, j.step, j.id AS jid FROM assets a JOIN jobs j ON j.id = a.job_id WHERE a.mint = ? AND j.status IN ('approved', 'posted') ORDER BY a.id DESC LIMIT 200", mint)
    .map((a) => ({ ...assetView(a), step: a.step, postedTo: postedTo(a.jid) }));
  return { gallery, socials: socials.view(mint), done: planner.doneCounts(mint) };
}

/** The coin's site copy + hero, once its site step is approved. Null before. */
export function siteFor(mint) {
  const j = one("SELECT * FROM jobs WHERE mint = ? AND step = 'site' AND status IN ('approved', 'posted') ORDER BY id DESC LIMIT 1", mint);
  if (!j) return null;
  let copy = {};
  try { copy = JSON.parse(j.result_json || '{}'); } catch {}
  const hero = one('SELECT * FROM assets WHERE job_id = ? ORDER BY idx LIMIT 1', j.id);
  return { ...copy, hero: hero ? assetView(hero) : null };
}

/** The public feed, newest first: { items, next }. `before` = the last item's id (cursor), never a timestamp. */
export function feed({ before = null, limit = 30, mint = null } = {}) {
  const n = Math.max(1, Math.min(60, Number(limit) || 30));
  const b = Number(before);
  const rows = all(`SELECT a.*, j.step, j.id AS jid, l.name, l.symbol, l.image AS logo FROM assets a JOIN jobs j ON j.id = a.job_id JOIN launches l ON l.mint = a.mint
    WHERE j.status IN ('approved', 'posted') AND j.step != 'site' AND l.hidden = 0 AND l.status = 'live'${Number.isSafeInteger(b) && b > 0 ? ' AND a.id < ?' : ''}${mint ? ' AND a.mint = ?' : ''}
    ORDER BY a.id DESC LIMIT ?`, ...[Number.isSafeInteger(b) && b > 0 ? b : null, mint || null].filter((v) => v !== null), n);
  const items = rows.map((a) => ({
    id: a.id, mint: a.mint, symbol: a.symbol, name: a.name, image: a.logo, kind: a.kind, url: media.urlOf(a.mint, a.path), thumb: media.urlOf(a.mint, a.thumb || a.path),
    mime: a.mime, step: a.step, caption: a.caption, mock: Boolean(a.mock), postedTo: postedTo(a.jid), createdAt: a.created_at,
  }));
  return { items, next: items.length === n ? items.at(-1).id : null };
}

let ticking = null;
/** One full pass: plan + start jobs, then post what is approved. Overlapping calls share the running pass. */
export function tick() {
  if (ticking) return ticking;
  ticking = (async () => {
    const plan = await planner.plan();
    const post = plan.coins ? await posting.postApproved() : { posted: 0 };
    return { ...plan, ...post };
  })().finally(() => { ticking = null; });
  return ticking;
}

let started = false;
/** Starts the planner timer (server.mjs). Quiet while no coin is live: the tick is then one SELECT. */
export function start() {
  if (started) return;
  started = true;
  planner.resume();
  const run = () => tick().catch((e) => console.error('content tick', e.message));
  setTimeout(run, 60_000).unref();
  setInterval(run, C.intervalMs).unref();
}

export { planner, posting };
