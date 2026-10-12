/**
 * HTTP routes of the content engine, registered through server.mjs: routes(route, ctx), ctx = { sessionOf, limit,
 * ApiError, isAdmin, cookie, redirect }. Public reads, the launcher's social linking, and the admin desk.
 * Admin endpoints answer 401 without the cookie (the admin page shows its sign-in hint on it).
 * ⛔ Browser navigations (connect, OAuth callback) never end on a JSON error: they redirect back to the coin page with
 *    ?social=<platform>&error=<message>.
 */
import crypto from 'node:crypto';
import { all, one, run, now } from '../db.mjs';
import * as ledger from '../ledger.mjs';
import { env } from '../env.mjs';
import { C, modes } from './config.mjs';
import * as media from './media.mjs';
import * as socials from './socials.mjs';
import * as planner from './planner.mjs';
import * as posting from './posting.mjs';
import * as tiktok from './tiktok.mjs';
import { feed, coinContent, siteFor, assetView, tick } from './index.mjs';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ADMIN_COOKIE = 'ads_admin';
const COIN_PAGE = (mint) => `/t/${mint}`; // the site's coin route (as Shill, Switch, Hooker)

export function register(route, ctx) {
  const { sessionOf, limit, ApiError, isAdmin, cookie, redirect } = ctx;
  const mintOf = (p) => { if (!MINT_RE.test(String(p.mint || ''))) throw new ApiError('Not a valid coin address', 400); return p.mint; };
  const coinOf = (mint) => { const c = planner.coinRow(mint); if (!c || c.origin !== 'ads' || c.hidden || !['live', 'demo'].includes(c.status)) throw new ApiError('No such coin', 404); return c; };
  const admin = (req) => { if (!isAdmin(req)) throw new ApiError('Admin sign-in required: open /api/admin/login/<token>', 401); };
  const back = (res, mint, platform, params) => redirect(res, `${COIN_PAGE(mint)}?${new URLSearchParams({ social: platform, ...params })}`);

  /* ───── public ───── */

  route('GET', '/api/feed', async ({ query, ip }) => { limit(ip, 'feed', 120, 60_000); return feed({ before: query.get('before'), limit: query.get('limit'), mint: query.get('mint') }); });

  route('GET', '/api/media/:mint/:file', async ({ req, res, params, ip }) => {
    limit(ip, 'media', 600, 60_000);
    if (!(await media.serve(req, res, params.mint, params.file))) throw new ApiError('Not found', 404);
  });

  route('GET', '/api/coins/:mint/content', async ({ params, ip }) => {
    limit(ip, 'content', 120, 60_000);
    const mint = mintOf(params);
    coinOf(mint);
    const c = coinContent(mint);
    return { gallery: c.gallery, ladder: await planner.ladderOf(mint), socials: c.socials, site: siteFor(mint) };
  });

  /* ───── the launcher links their own accounts (after graduation) ───── */

  route('GET', '/api/coins/:mint/socials/:platform/connect', async ({ req, res, params, ip }) => {
    limit(ip, 'connect', 20, 600_000);
    const mint = mintOf(params), platform = String(params.platform);
    try {
      if (!socials.PLATFORMS.includes(platform)) throw new ApiError('Unknown platform', 404);
      const coin = coinOf(mint);
      const wallet = sessionOf(req);
      if (!wallet) throw new ApiError('Sign in with the wallet that launched this coin first', 401);
      if (wallet !== coin.launcher) throw new ApiError('Only the wallet that launched this coin can link accounts', 403);
      if (!(await planner.isGraduated(mint))) throw new ApiError('Accounts can be linked once the coin graduates', 409);
      redirect(res, socials.begin(mint, platform, wallet));
    } catch (e) {
      if (!e.expose) throw e;
      back(res, mint, platform, { error: e.message });
    }
  });

  route('GET', '/api/oauth/:platform/callback', async ({ req, res, params, query, ip }) => {
    limit(ip, 'oauth', 30, 600_000);
    const platform = String(params.platform);
    if (!socials.PLATFORMS.includes(platform)) throw new ApiError('Unknown platform', 404);
    const row = one('SELECT mint FROM oauth_states WHERE state = ?', String(query.get('state') || ''));
    try {
      const st = socials.consume(query.get('state'), platform, sessionOf(req));
      if (query.get('error')) throw new ApiError(platform === 'x' ? 'X did not authorize the link' : 'TikTok did not authorize the link', 400);
      if (!query.get('code')) throw new ApiError('The link came back without a code. Try again.', 400);
      const r = await socials.complete(st, query.get('code'));
      planner.decide(r.mint, null, 'policy', `${platform} linked: ${r.handle || 'account'}`);
      back(res, r.mint, platform, { linked: '1' });
    } catch (e) {
      if (!row) throw e.expose ? e : new ApiError('This link request is not valid', 400);
      back(res, row.mint, platform, { error: e.expose ? e.message : 'Linking failed. Try again in a minute.' });
      if (!e.expose) console.error('oauth callback', platform, e.message);
    }
  });

  /* The launcher sends one of their coin's videos to their TikTok inbox as a draft (they post it in TikTok). */
  route('POST', '/api/coins/:mint/socials/tiktok/send', async ({ req, params, body, ip }) => {
    limit(ip, 'tiktok-send', 10, 3_600_000);
    const mint = mintOf(params);
    const coin = coinOf(mint);
    const wallet = sessionOf(req);
    if (!wallet) throw new ApiError('Sign in first', 401);
    if (wallet !== coin.launcher) throw new ApiError('Only the wallet that launched this coin can send its videos', 403);
    if (!(await planner.isGraduated(mint))) throw new ApiError('Videos can be sent once the coin bonds', 409);
    const t = await socials.tokensFor(mint, 'tiktok');
    if (!t) throw new ApiError('Link your TikTok first', 409);
    const a = one("SELECT a.* FROM assets a JOIN jobs j ON j.id = a.job_id WHERE a.id = ? AND a.mint = ? AND a.kind = 'video' AND j.status IN ('approved', 'posted')", Number(body.assetId), mint);
    if (!a) throw new ApiError('No such video', 404);
    if (a.mock && !C.tiktok.mock) throw new ApiError('Sample videos are not sent to TikTok', 409);
    // TikTok allows 5 pending drafts per account per 24 h.
    if (one("SELECT COUNT(*) AS n FROM posts WHERE mint = ? AND platform = 'creator_tiktok' AND status = 'posted' AND posted_at > ?", mint, now() - 86_400_000).n >= 5) throw new ApiError('TikTok takes 5 drafts a day. Try again tomorrow.', 429);
    let r;
    try {
      r = await tiktok.uploadToInbox(media.pathOf(mint, a.path), a.mime, t.tokens);
    } catch (e) {
      throw new ApiError(`TikTok did not take the video: ${String(e.message).slice(0, 160)}`, 502);
    }
    const n = now();
    run(`INSERT INTO posts (job_id, asset_id, mint, platform, status, text, external_id, url, error, mock, created_at, updated_at, posted_at) VALUES (?, ?, ?, 'creator_tiktok', 'posted', NULL, ?, NULL, NULL, ?, ?, ?, ?)
         ON CONFLICT(job_id, platform) DO UPDATE SET status = 'posted', external_id = excluded.external_id, mock = excluded.mock, updated_at = excluded.updated_at, posted_at = excluded.posted_at`,
    a.job_id, a.id, mint, r.publishId, r.mock ? 1 : 0, n, n, n);
    planner.decide(mint, a.job_id, 'post', `creator_tiktok: draft sent by the launcher (${r.publishId})`);
    return { ok: true, publishId: r.publishId, mock: Boolean(r.mock) };
  });

  route('POST', '/api/coins/:mint/site/claim', async ({ req, params, ip }) => {
    limit(ip, 'site-claim', 10, 3_600_000);
    const mint = mintOf(params);
    const coin = coinOf(mint);
    const wallet = sessionOf(req);
    if (!wallet) throw new ApiError('Sign in first', 401);
    if (wallet !== coin.launcher) throw new ApiError('Only the wallet that launched this coin can claim its website', 403);
    return planner.claimSite(mint);
  });

  route('DELETE', '/api/coins/:mint/socials/:platform', async ({ req, params }) => {
    const mint = mintOf(params), platform = String(params.platform);
    if (!socials.PLATFORMS.includes(platform)) throw new ApiError('Unknown platform', 404);
    const coin = coinOf(mint);
    const wallet = sessionOf(req);
    if (!wallet) throw new ApiError('Sign in first', 401);
    if (wallet !== coin.launcher) throw new ApiError('Only the wallet that launched this coin can unlink accounts', 403);
    socials.unlink(mint, platform);
    planner.decide(mint, null, 'policy', `${platform} unlinked`);
    return { ok: true, socials: socials.view(mint) };
  });

  /* ───── admin ───── */

  route('GET', '/api/admin/login/:token', async ({ res, params, ip }) => {
    limit(ip, 'adminlogin', 10, 600_000);
    const want = env('ADMIN_TOKEN', '');
    const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
    if (!want || want.length < 16 || !crypto.timingSafeEqual(h(params.token), h(want))) throw new ApiError('No such endpoint', 404);
    res.setHeader('set-cookie', cookie(ADMIN_COOKIE, want, 30 * 86_400));
    redirect(res, '/admin');
  });

  const jobsList = async ({ req, query }) => {
    admin(req);
    const status = ['review', 'approved', 'failed', 'rejected', 'queued', 'generating', 'posted'].includes(query.get('status')) ? query.get('status') : 'review';
    const jobs = all('SELECT * FROM jobs WHERE status = ? ORDER BY id DESC LIMIT 100', status);
    return { status, jobs: jobs.map(jobView) };
  };
  route('GET', '/api/admin/queue', jobsList);
  route('GET', '/api/admin/jobs', jobsList);

  const approve = async ({ req, params }) => {
    admin(req);
    const job = one('SELECT * FROM jobs WHERE id = ?', Number(params.id));
    if (!job) throw new ApiError('No such job', 404);
    if (job.status !== 'review') throw new ApiError(`Job is ${job.status}, not in review`, 409);
    run("UPDATE jobs SET status = 'approved', reviewed_at = ?, updated_at = ? WHERE id = ?", now(), now(), job.id);
    planner.decide(job.mint, job.id, 'approve', 'approved by admin');
    posting.postApproved().catch((e) => console.error('content posting', e.message));
    return { job: jobView(one('SELECT * FROM jobs WHERE id = ?', job.id)) };
  };
  route('POST', '/api/admin/jobs/:id/approve', approve);
  route('POST', '/api/admin/review/:id/approve', approve);

  const reject = async ({ req, params, body }) => {
    admin(req);
    const job = one('SELECT * FROM jobs WHERE id = ?', Number(params.id));
    if (!job) throw new ApiError('No such job', 404);
    if (!['review', 'approved'].includes(job.status)) throw new ApiError(`Job is ${job.status}, it cannot be rejected`, 409);
    planner.failJob(job.id, `admin: ${String(body?.reason || 'rejected').slice(0, 200)}`, 'rejected');
    return { job: jobView(one('SELECT * FROM jobs WHERE id = ?', job.id)) };
  };
  route('POST', '/api/admin/jobs/:id/reject', reject);
  route('POST', '/api/admin/review/:id/reject', reject);

  // the site's review list: one item per job (id = job id), its first asset as url/thumb, every asset in `assets`
  route('GET', '/api/admin/review', async ({ req }) => {
    admin(req);
    return { items: all("SELECT * FROM jobs WHERE status = 'review' ORDER BY id LIMIT 200").map((j) => {
      const v = jobView(j), a = v.assets[0] || {};
      return { id: j.id, mint: j.mint, symbol: v.symbol, name: v.name, kind: a.kind || null, url: a.url || null, thumb: a.thumb || null, caption: a.caption || null, step: j.step, seq: j.seq, moderation: v.moderation, createdAt: j.created_at, costUsd: v.costEstimateUsd, assets: v.assets, site: v.site };
    }) };
  });

  const downloads = () => all("SELECT p.*, l.name, l.symbol FROM posts p JOIN launches l ON l.mint = p.mint WHERE p.platform = 'tiktok' AND p.status = 'download' ORDER BY p.id LIMIT 200")
    .map((p) => ({ id: p.id, jobId: p.job_id, mint: p.mint, name: p.name, symbol: p.symbol, text: p.text, createdAt: p.created_at, assets: all('SELECT * FROM assets WHERE job_id = ? ORDER BY idx', p.job_id).map(assetView) }));
  route('GET', '/api/admin/downloads', async ({ req }) => { admin(req); return { downloads: downloads() }; });
  // the site's TikTok queue: id = post id, url = the file to download (the video, else the first image)
  route('GET', '/api/admin/tiktok', async ({ req }) => {
    admin(req);
    return { items: downloads().map((d) => { const a = d.assets.find((x) => x.mime.startsWith('video/')) || d.assets[0] || {}; return { id: d.id, mint: d.mint, symbol: d.symbol, name: d.name, url: a.url || null, thumb: a.thumb || null, caption: d.text, createdAt: d.createdAt, assets: d.assets }; }) };
  });

  const markPosted = async ({ req, params, body }) => {
    admin(req);
    const url = body?.url ? String(body.url) : null;
    if (url && !/^https:\/\/(www\.)?(tiktok\.com|x\.com|twitter\.com)\//.test(url)) throw new ApiError('Give the post URL (tiktok.com or x.com)', 400);
    const p = posting.markPosted(Number(params.id), url);
    if (!p) throw new ApiError('No such post', 404);
    return { post: p };
  };
  route('POST', '/api/admin/posts/:id/posted', markPosted);
  route('POST', '/api/admin/tiktok/:id/posted', markPosted);

  route('GET', '/api/admin/overview', async ({ req }) => {
    admin(req);
    const counts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').map((r) => [r.status, r.n]));
    const live = planner.liveCoins();
    const boost = live.map((c) => ({ mint: c.mint, symbol: c.symbol, balanceUsd: ledger.toUsd(ledger.balance(c.mint)) })).filter((c) => c.balanceUsd > 25).sort((a, b) => b.balanceUsd - a.balanceUsd);
    // flat: numbers and booleans are tiles, objects are key/value cards (the admin page renders it as is)
    return {
      spendTodayUsd: ledger.toUsd(planner.spentToday()), globalDailyCapUsd: C.globalDailyUsd, coinDailyCapUsd: C.coinDailyUsd, maxJobUsd: C.maxJobUsd,
      xPostsToday: posting.xPostsToday(), xPostsPerDay: C.xPostsPerDay, concurrency: C.concurrency, running: planner.runningCount(),
      liveCoins: live.length, inReview: counts.review || 0, tiktokDownloads: one("SELECT COUNT(*) AS n FROM posts WHERE platform = 'tiktok' AND status = 'download'").n,
      killed: planner.killed(), autoApprove: C.autoApprove,
      modes: modes(), jobs: counts,
      // balance > $25: DexScreener / paid boost of our best post (manual), symbol -> balance USD
      boostCandidates: Object.fromEntries(boost.map((c) => [`${c.symbol} ${c.mint.slice(0, 4)}`, c.balanceUsd])),
    };
  });

  /* Ad campaigns (operator 11 Oct): every coin makes at most C.videosPerDay videos a day; the rest of its budget is for
     paid campaigns of OUR content on X and TikTok (bonded coins first). The operator runs them in the ad managers and
     records each spend here, so it shows on the coin's spend log. The SOL itself reaches the operator through the
     treasury payout (automatic after each daily sale, or Withdraw now below). */
  route('GET', '/api/admin/campaigns', async ({ req }) => {
    admin(req);
    const coins = [];
    for (const c of planner.liveCoins()) {
      const balanceUsd = ledger.toUsd(ledger.balance(c.mint));
      if (balanceUsd < 1) continue;
      coins.push({ mint: c.mint, symbol: c.symbol, name: c.name, balanceUsd, lifetimeUsd: ledger.toUsd(ledger.lifetime(c.mint)), bonded: await planner.isGraduated(c.mint), videosToday: planner.videosToday(c.mint) });
    }
    coins.sort((a, b) => Number(b.bonded) - Number(a.bonded) || b.balanceUsd - a.balanceUsd);
    const t = (await import('../treasury.mjs')).status();
    return { coins, videosPerDay: C.videosPerDay, treasury: { sol: t.sol ?? null, payoutTo: t.payoutTo, floorSol: t.floorSol, dryRun: t.dryRun, enabled: t.enabled } };
  });
  route('POST', '/api/admin/coins/:mint/adspend', async ({ req, params, body }) => {
    admin(req);
    const mint = mintOf(params);
    const usd = Number(body?.usd);
    if (!(usd > 0 && usd <= 10_000)) throw new ApiError('Enter the amount in dollars, like 25', 400);
    const note = String(body?.note || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'paid campaign';
    ledger.spend(mint, ledger.toMicros(usd), `ad:${now()}`, `Ad campaign: ${note}`);
    planner.decide(mint, null, 'spend', `ad campaign $${usd.toFixed(2)}: ${note}`);
    return { ok: true, balanceUsd: ledger.toUsd(ledger.balance(mint)) };
  });
  route('POST', '/api/admin/treasury/withdraw', async ({ req }) => {
    admin(req);
    const treasury = await import('../treasury.mjs');
    const to = treasury.status().payoutTo;
    if (!to) throw new ApiError('No payout wallet set (TREASURY_PAYOUT_ADDRESS)', 409);
    const r = await treasury.payout({ to, kind: 'withdraw' });
    if (r.result === 'refused') throw new ApiError(r.reason, 409);
    return r;
  });

  route('GET', '/api/admin/decisions', async ({ req, query }) => { admin(req); return { items: all('SELECT * FROM decisions WHERE (? IS NULL OR mint = ?) ORDER BY id DESC LIMIT 200', query.get('mint'), query.get('mint')) }; });

  route('POST', '/api/admin/content/kill', async ({ req, body }) => { admin(req); planner.setKilled(Boolean(body?.on)); return { killed: planner.killed() }; });
  route('POST', '/api/admin/content/tick', async ({ req }) => { admin(req); return tick(); });
  route('POST', '/api/admin/coins/:mint/policy', async ({ req, params, body }) => {
    admin(req);
    const mint = mintOf(params);
    const num = (v) => (v === undefined || v === null ? undefined : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : (() => { throw new ApiError('Caps are dollar amounts', 400); })());
    planner.setPolicy(mint, { dailyCapUsd: num(body.dailyCapUsd), maxJobUsd: num(body.maxJobUsd), paused: body.paused === undefined ? undefined : Boolean(body.paused), note: body.note === undefined ? undefined : String(body.note).slice(0, 200) });
    return { policy: planner.policy(mint) };
  });
}

function jobView(j) {
  const coin = one('SELECT name, symbol, image FROM launches WHERE mint = ?', j.mint) || {};
  let brief = null, moderation = null, result = null;
  try { brief = JSON.parse(j.brief_json || 'null'); } catch {}
  try { moderation = JSON.parse(j.moderation_json || 'null'); } catch {}
  try { result = JSON.parse(j.result_json || 'null'); } catch {}
  return {
    id: j.id, mint: j.mint, name: coin.name, symbol: coin.symbol, image: coin.image, step: j.step, seq: j.seq, status: j.status, paidBy: j.paid_by,
    costEstimateUsd: ledger.toUsd(j.cost_estimate_micros), costActualUsd: j.cost_actual_micros == null ? null : ledger.toUsd(j.cost_actual_micros), refundedUsd: ledger.toUsd(j.refunded_micros),
    error: j.error, brief, moderation, site: result, createdAt: j.created_at, updatedAt: j.updated_at,
    assets: all('SELECT * FROM assets WHERE job_id = ? ORDER BY idx', j.id).map(assetView),
    posts: all('SELECT id, platform, status, url, error, mock FROM posts WHERE job_id = ?', j.id),
  };
}
