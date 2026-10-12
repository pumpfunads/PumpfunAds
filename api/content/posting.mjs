/**
 * Distribution of approved content. One post per job per platform:
 *   x               our @pumpfunads, under X_POSTS_PER_DAY (and X_POSTS_PER_TICK, so a day's posts spread out), richest
 *                   coin first. A content pack is ONE post with its 4 images; a video is one post.
 *   tiktok          our TikTok: never by API (TikTok forbids it for team accounts): status 'download', admin queue.
 *   creator_x       the launcher's own X, once graduated and linked.
 *   creator_tiktok  the launcher's TikTok inbox (a draft THEY finish), once graduated and linked; videos only.
 * Text = the caption (copy.mjs rules: names the coin, never a CA, a price, "buy", emojis or hashtags).
 * ⛔ Mock media is never posted to a LIVE account: a job holding a mock asset only goes to mock adapters.
 * ⛔ The site step is never posted (it is a page, not a post).
 */
import { all, one, run, now } from '../db.mjs';
import * as ledger from '../ledger.mjs';
import { C } from './config.mjs';
import * as x from './x.mjs';
import * as tiktok from './tiktok.mjs';
import * as socials from './socials.mjs';
import * as media from './media.mjs';
import { coinRow, platformsOf, isGraduated, decide } from './planner.mjs';
import './schema.mjs';

const dayStart = (t = now()) => t - (t % 86_400_000);
export const xPostsToday = () => one("SELECT COUNT(*) AS n FROM posts WHERE platform = 'x' AND status = 'posted' AND posted_at >= ?", dayStart()).n;

const assetsOf = (jobId) => all('SELECT * FROM assets WHERE job_id = ? ORDER BY idx', jobId);
const has = (jobId, platform) => one('SELECT id FROM posts WHERE job_id = ? AND platform = ?', jobId, platform);
function record(job, platform, asset, fields) {
  const t = now();
  run(`INSERT INTO posts (job_id, asset_id, mint, platform, status, text, external_id, url, error, mock, created_at, updated_at, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, platform) DO UPDATE SET status = excluded.status, external_id = excluded.external_id, url = excluded.url, error = excluded.error, mock = excluded.mock, updated_at = excluded.updated_at, posted_at = excluded.posted_at`,
  job.id, asset?.id ?? null, job.mint, platform, fields.status, fields.text ?? null, fields.externalId ?? null, fields.url ?? null, fields.error ?? null, fields.mock ? 1 : 0, t, t, fields.status === 'posted' ? t : null);
  decide(job.mint, job.id, 'post', `${platform}: ${fields.status}${fields.error ? ` (${fields.error})` : ''}`.slice(0, 300));
}

/** The files a job posts: up to 4 images, or its video. */
function filesOf(assets) {
  const vids = assets.filter((a) => a.kind === 'video' && a.mime.startsWith('video/'));
  const list = vids.length ? vids.slice(0, 1) : assets.filter((a) => a.kind === 'image').slice(0, 4);
  return list.map((a) => ({ path: media.absPath(a.mint, a.path), mime: a.mime, asset: a }));
}

/** Posts one job everywhere it should go. Returns true when every target platform has a post row. */
async function distribute(job, budget) {
  const coin = coinRow(job.mint);
  if (!coin) return false;
  const assets = assetsOf(job.id);
  if (!assets.length) return false;
  const files = filesOf(assets);
  const anyMock = assets.some((a) => a.mock);
  const text = assets[0].caption || coin.name;
  const platforms = platformsOf(coin);
  const graduated = await isGraduated(job.mint);
  const targets = [...platforms];
  if (graduated && one("SELECT 1 FROM socials WHERE mint = ? AND platform = 'x'", job.mint)) targets.push('creator_x');
  if (graduated && one("SELECT 1 FROM socials WHERE mint = ? AND platform = 'tiktok'", job.mint) && files.some((f) => f.mime.startsWith('video/'))) targets.push('creator_tiktok');
  let complete = true;
  for (const p of targets) {
    if (has(job.id, p)) continue;
    try {
      if (p === 'tiktok') { record(job, p, assets[0], { status: 'download', text }); continue; }
      if (p === 'x') {
        if (budget.x <= 0) { complete = false; continue; }
        if (anyMock && !C.x.mock) throw new Error('mock media is never posted to a live account');
        if (files.some((f) => f.mime === 'image/svg+xml') && !C.x.mock) throw new Error('X does not take SVG');
        budget.x--;
        const r = await x.post(text, files);
        record(job, p, assets[0], { status: 'posted', text, externalId: r.id, url: r.url, mock: r.mock });
        if (C.xLinkReply && !r.mock) {
          // ⛔ a post with a URL costs ~$0.20: only when the operator turned the link reply on
          await x.post(C.xLinkReply.replace('{mint}', job.mint), [], { replyTo: r.id }).catch((e) => decide(job.mint, job.id, 'post', `x link reply failed: ${e.message}`));
        }
        continue;
      }
      if (p === 'creator_x') {
        if (anyMock && !C.x.oauthMock) throw new Error('mock media is never posted to a live account');
        const t = await socials.tokensFor(job.mint, 'x');
        if (!t) continue;
        const r = await x.post(text, files, { auth: { bearer: t.tokens.access_token }, handle: t.handle });
        record(job, p, assets[0], { status: 'posted', text, externalId: r.id, url: r.url, mock: r.mock });
        continue;
      }
      if (p === 'creator_tiktok') {
        if (anyMock && !C.tiktok.mock) throw new Error('mock media is never posted to a live account');
        const t = await socials.tokensFor(job.mint, 'tiktok');
        if (!t) continue;
        const v = files.find((f) => f.mime.startsWith('video/'));
        const r = await tiktok.uploadToInbox(v.path, v.mime, t.tokens);
        record(job, p, v.asset, { status: 'posted', text, externalId: r.publishId, url: null, mock: r.mock });
      }
    } catch (e) {
      record(job, p, assets[0], { status: 'failed', text, error: e.message.slice(0, 300) });
    }
  }
  return complete;
}

/**
 * One posting pass. Approved jobs, richest coin first. Returns { posted: jobs completed }.
 * ⛔ One pass at a time (an approve click and the timer can overlap): two passes would post the same job twice.
 */
let passing = null;
export function postApproved() {
  if (!passing) passing = postPass().finally(() => { passing = null; });
  return passing;
}
async function postPass() {
  const jobs = all("SELECT j.* FROM jobs j JOIN launches l ON l.mint = j.mint WHERE j.status = 'approved' AND j.step != 'site' AND l.status = 'live' AND l.hidden = 0 ORDER BY j.id")
    .map((j) => ({ j, life: ledger.lifetime(j.mint) }))
    .sort((a, b) => b.life - a.life || a.j.id - b.j.id)
    .map((r) => r.j);
  const budget = { x: Math.max(0, Math.min(C.xPostsPerTick, C.xPostsPerDay - xPostsToday())) };
  let posted = 0;
  for (const job of jobs) {
    if (await distribute(job, budget)) {
      run("UPDATE jobs SET status = 'posted', posted_at = ?, updated_at = ? WHERE id = ? AND status = 'approved'", now(), now(), job.id);
      posted++;
    }
  }
  // a site is done once approved: nothing to post
  run("UPDATE jobs SET status = 'posted', posted_at = ?, updated_at = ? WHERE step = 'site' AND status = 'approved'", now(), now());
  return { posted };
}

/** The admin marks a TikTok download as uploaded. */
export function markPosted(postId, url) {
  const p = one('SELECT * FROM posts WHERE id = ?', postId);
  if (!p) return null;
  run("UPDATE posts SET status = 'posted', url = ?, posted_at = ?, updated_at = ? WHERE id = ?", url || null, now(), now(), postId);
  decide(p.mint, p.job_id, 'post', `${p.platform}: marked posted by admin`);
  return one('SELECT * FROM posts WHERE id = ?', postId);
}
