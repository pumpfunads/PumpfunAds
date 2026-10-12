// The content engine, entirely in mock mode against a temp DB: planner spends the ladder's amounts, refunds a failed
// job, respects the caps, review -> approve -> X post (mock) and TikTok -> download queue, social linking via OAuth state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-content-'));
Object.assign(process.env, {
  DB_PATH: path.join(TMP, 'ads.db'), MEDIA_DIR: path.join(TMP, 'media'),
  MOCK_GENERATION: '1', MOCK_LLM: '1', MOCK_X: '1', MOCK_TIKTOK: '1', AUTO_APPROVE: '0',
  ADMIN_TOKEN: 'test-admin-token-0123456789', GENERATION_DAILY_USD_CAP: '25', COIN_DAILY_USD_CAP: '10',
});
for (const k of ['HIGGSFIELD_API_KEY', 'ANTHROPIC_API_KEY', 'X_API_KEY', 'X_CLIENT_ID', 'TIKTOK_CLIENT_KEY']) delete process.env[k];

const { run, one, all, now } = await import('../api/db.mjs');
const ledger = await import('../api/ledger.mjs');
const content = await import('../api/content/index.mjs');
const { C } = await import('../api/content/config.mjs');
const hf = await import('../api/content/higgsfield.mjs');
const copy = await import('../api/content/copy.mjs');
const { planner } = content;

const MINT = 'AdsTestMint1111111111111111111111111111ads';
const LAUNCHER = 'Launcher11111111111111111111111111111111111';
run(`INSERT INTO launches (mint, launcher, fee_wallet, name, symbol, description, image, metadata_uri, quote_mint, quote_json, creator_fee_bps, status, created_at, live_at, updated_at, brief_json)
     VALUES (?, ?, ?, 'Gerald', 'GERALD', 'A frog who runs a bakery', NULL, 'ipfs://x', 'q', '{}', 100, 'live', ?, ?, ?, ?)`,
MINT, LAUNCHER, 'FeeWallet1111111111111111111111111111111ads', now(), now(), now(), JSON.stringify({ pitch: 'A frog who bakes bread for the whole pond', vibe: ['cozy', 'absurd'], audience: 'meme lovers', mascot: 'a green frog in a baker hat', platforms: ['x', 'tiktok'] }));

/* a tiny router like server.mjs, to drive the real route handlers */
const table = [];
const route = (method, pattern, fn) => table.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });
class Res extends Writable {
  constructor() { super(); this.headers = {}; this.status = 200; this.chunks = []; }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  writeHead(s, h = {}) { this.status = s; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; }
  _write(c, _e, cb) { this.chunks.push(Buffer.from(c)); cb(); }
}
const ctx = {
  sessionOf: (req) => req.wallet || null,
  limit: () => {},
  ApiError: (await import('../api/errors.mjs')).ApiError,
  isAdmin: (req) => req.admin === true,
  cookie: (n, v, a) => `${n}=${v}; Max-Age=${a}`,
  redirect: (res, to) => { res.writeHead(302, { location: to }); res.end(); },
};
content.routes(route, ctx);
async function call(method, url, { wallet, admin, body, headers = {} } = {}) {
  const u = new URL(url, 'http://x');
  const r = table.find((t) => t.method === method && u.pathname.match(t.re));
  assert.ok(r, `no route ${method} ${u.pathname}`);
  const res = new Res();
  try {
    const out = await r.fn({ req: { wallet, admin, headers, method }, res, params: u.pathname.match(r.re).groups || {}, query: u.searchParams, body, ip: '1.1.1.1' });
    return { status: res.status, headers: res.headers, body: out, raw: Buffer.concat(res.chunks) };
  } catch (e) { return { status: e.status || 500, error: e.message }; }
}

const usd = (m) => Math.round(ledger.toUsd(m) * 1e6) / 1e6;
const jobsOf = (step) => all('SELECT * FROM jobs WHERE mint = ? AND step = ? ORDER BY id', MINT, step);

test('copy rules: clean style, block CA / price / buy / promises', () => {
  assert.equal(copy.clean('gm #frogs \u{1F438} on pump.fun -- yes'), 'gm frogs on Pumpfun, yes');
  assert.equal(copy.check('Gerald bakes bread').ok, true);
  for (const bad of ['buy Gerald now', 'Gerald to 100x', 'price is $0.01', `CA ${MINT}`, 'see pumpfunads.com']) assert.equal(copy.check(bad).ok, false, bad);
  assert.match(copy.postText('bakes bread all night', { name: 'Gerald', symbol: 'GERALD' }), /^Gerald\. /);
});

test('quiet when idle: no live coin, no job, no spend', async () => {
  run("UPDATE launches SET status = 'prepared' WHERE mint = ?", MINT);
  const r = await planner.plan();
  assert.equal(r.coins, 0);
  assert.equal(one('SELECT COUNT(*) AS n FROM jobs').n, 0);
  run("UPDATE launches SET status = 'live' WHERE mint = ?", MINT);
});

test('launch card is paid by the platform, never by the budget', async () => {
  const id = await content.onLaunched(MINT);
  assert.ok(id);
  assert.equal(await content.onLaunched(MINT), null, 'second call is a no-op');
  await planner.drain();
  const job = one('SELECT * FROM jobs WHERE id = ?', id);
  assert.equal(job.status, 'review');
  assert.equal(job.paid_by, 'platform');
  assert.equal(usd(job.cost_estimate_micros), 0.02);
  assert.equal(one("SELECT usd_micros FROM ledger WHERE mint = ? AND kind = 'platform'", MINT).usd_micros, 20_000);
  assert.equal(ledger.balance(MINT), 0);
  const a = one('SELECT * FROM assets WHERE job_id = ?', id);
  assert.equal(a.mock, 1);
  assert.match(fs.readFileSync(path.join(C.mediaDir, MINT, a.path), 'utf8'), /MOCK/);
});

test('$5 credited: content pack then a video, the ladder amounts spent before generating', async () => {
  ledger.credit(MINT, ledger.toMicros(5), 'sale:1', 'test credit');
  let r = await planner.plan();
  assert.equal(r.queued.length, 1);
  assert.equal(one('SELECT step FROM jobs WHERE id = ?', r.queued[0]).step, 'meme_pack');
  assert.equal(usd(ledger.balance(MINT)), 4.85, 'spent at queue time, before generation');
  await planner.drain();
  assert.equal(one('SELECT COUNT(*) AS n FROM assets WHERE job_id = ?', r.queued[0]).n, 4);
  r = await planner.plan();
  const v = one('SELECT * FROM jobs WHERE id = ?', r.queued[0]);
  assert.equal(v.step, 'video');
  assert.equal(v.seq, 1);
  await planner.drain();
  assert.equal(usd(ledger.balance(MINT)), 4.25);
  const va = one('SELECT * FROM assets WHERE job_id = ?', v.id);
  assert.equal(va.kind, 'video');
  assert.ok(va.thumb, 'a video keeps its first frame as the thumb');
  r = await planner.plan();
  assert.equal(r.queued.length, 0, '$5 lifetime unlocks one video only');
  assert.deepEqual(planner.doneCounts(MINT), { launch_card: 1, meme_pack: 1, video: 1 });
  assert.ok(one("SELECT 1 FROM ledger WHERE mint = ? AND kind = 'spend' AND ref = ?", MINT, `job:${v.id}`));
});

test('a forced generation failure is refunded, the next tick retries', async () => {
  ledger.credit(MINT, ledger.toMicros(5), 'sale:2', 'test credit'); // lifetime $10 -> video 2 unlocked (a video every $5)
  const before = ledger.balance(MINT);
  hf.testing.failNext = 1;
  const r = await planner.plan();
  await planner.drain();
  const job = one('SELECT * FROM jobs WHERE id = ?', r.queued[0]);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /forced/);
  assert.equal(ledger.balance(MINT), before, 'refunded in full');
  assert.ok(one("SELECT 1 FROM ledger WHERE kind = 'refund' AND ref = ?", `job:${job.id}`));
  const r2 = await planner.plan();
  await planner.drain();
  const retry = one('SELECT * FROM jobs WHERE id = ?', r2.queued[0]);
  assert.equal(retry.step, 'video');
  assert.equal(retry.seq, 2);
  assert.equal(retry.attempt, 2);
  assert.equal(retry.status, 'review');
});

test('caps: per-coin daily cap, global daily cap, pause and kill switch', async () => {
  ledger.credit(MINT, ledger.toMicros(5), 'sale:3', 'test credit'); // lifetime $15 -> video 3
  planner.setPolicy(MINT, { dailyCapUsd: 1 });
  let r = await planner.plan();
  assert.equal(r.queued.length, 0);
  assert.match(one('SELECT reason FROM decisions WHERE mint = ? ORDER BY id DESC LIMIT 1', MINT).reason, /coin daily cap/);
  planner.setPolicy(MINT, { dailyCapUsd: 100 });
  const keep = C.globalDailyUsd;
  C.globalDailyUsd = ledger.toUsd(planner.spentToday()) + 0.1;
  r = await planner.plan();
  assert.equal(r.queued.length, 0, 'global cap holds');
  C.globalDailyUsd = keep;
  planner.setPolicy(MINT, { paused: true });
  assert.equal((await planner.plan()).queued.length, 0);
  planner.setPolicy(MINT, { paused: false });
  planner.setKilled(true);
  assert.equal((await planner.plan()).killed, true);
  planner.setKilled(false);
  r = await planner.plan();
  assert.equal(r.queued.length, 1);
  await planner.drain();
});

test('admin: login cookie, review -> approve -> X post (mock) + TikTok download queue; reject refunds', async () => {
  assert.equal((await call('GET', '/api/admin/review')).status, 401, 'admin only');
  assert.equal((await call('GET', '/api/admin/login/wrong-token-xxxxxxxxxxxx')).status, 404);
  const login = await call('GET', `/api/admin/login/${process.env.ADMIN_TOKEN}`);
  assert.equal(login.status, 302);
  assert.match(login.headers['set-cookie'], /^ads_admin=/);
  const q = await call('GET', '/api/admin/queue', { admin: true });
  const rv = await call('GET', '/api/admin/review', { admin: true });
  const item = rv.body.items.find((j) => j.step === 'meme_pack');
  for (const k of ['id', 'mint', 'symbol', 'name', 'kind', 'url', 'thumb', 'caption', 'step', 'moderation', 'createdAt']) assert.ok(k in item, k);
  const meme = q.body.jobs.find((j) => j.step === 'meme_pack');
  assert.ok(meme && meme.assets.length === 4 && item.id === meme.id);
  const ap = await call('POST', `/api/admin/review/${meme.id}/approve`, { admin: true });
  assert.equal(ap.body.job.status, 'approved');
  await content.posting.postApproved();
  const posts = all('SELECT * FROM posts WHERE job_id = ?', meme.id);
  const xp = posts.find((p) => p.platform === 'x');
  assert.equal(xp.status, 'posted');
  assert.equal(xp.mock, 1);
  assert.match(xp.url, /^https:\/\/x\.com\/pumpfunads\/status\/mock/);
  assert.doesNotMatch(xp.text, /buy|#|\$|\u{1F438}/u);
  assert.equal(posts.find((p) => p.platform === 'tiktok').status, 'download');
  assert.equal(one('SELECT status FROM jobs WHERE id = ?', meme.id).status, 'posted');
  const dl = await call('GET', '/api/admin/downloads', { admin: true });
  const d = dl.body.downloads.find((x) => x.jobId === meme.id);
  assert.equal(d.assets.length, 4);
  const tk = (await call('GET', '/api/admin/tiktok', { admin: true })).body.items.find((x) => x.id === d.id);
  for (const k of ['id', 'mint', 'symbol', 'name', 'url', 'thumb', 'caption', 'createdAt']) assert.ok(k in tk, k);
  const mp = await call('POST', `/api/admin/tiktok/${d.id}/posted`, { admin: true, body: { url: 'https://www.tiktok.com/@pumpfunad/video/1' } });
  assert.equal(mp.body.post.status, 'posted');
  // reject the last video: refunded
  const vid = q.body.jobs.find((j) => j.step === 'video');
  const bal = ledger.balance(MINT);
  const rj = await call('POST', `/api/admin/review/${vid.id}/reject`, { admin: true, body: { reason: 'off brand' } });
  assert.equal(rj.body.job.status, 'rejected');
  assert.equal(ledger.balance(MINT) - bal, ledger.toMicros(0.6));
  const ov = await call('GET', '/api/admin/overview', { admin: true });
  assert.equal(ov.body.modes.generation, 'mock');
  assert.equal(typeof ov.body.spendTodayUsd, 'number');
  assert.ok(Object.values(ov.body).every((v) => typeof v !== 'object' || (v && !Array.isArray(v))), 'flat: no arrays');
  assert.equal(ov.body.xPostsToday, 1);
});

test('X daily cap holds posting back', async () => {
  const card = one("SELECT id FROM jobs WHERE mint = ? AND step = 'launch_card'", MINT).id;
  const keep = C.xPostsPerDay;
  C.xPostsPerDay = 1; // one already posted today
  await call('POST', `/api/admin/jobs/${card}/approve`, { admin: true });
  await content.posting.postApproved();
  assert.equal(one("SELECT COUNT(*) AS n FROM posts WHERE job_id = ? AND platform = 'x'", card).n, 0);
  assert.equal(one('SELECT status FROM jobs WHERE id = ?', card).status, 'approved', 'waits for tomorrow');
  C.xPostsPerDay = keep;
  await content.posting.postApproved();
  assert.equal(one('SELECT status FROM jobs WHERE id = ?', card).status, 'posted');
});

test('public: feed, coin content, media served with ranges', async () => {
  const f = await call('GET', '/api/feed?limit=3');
  assert.equal(f.body.items.length, 3);
  const it = f.body.items[0];
  for (const k of ['id', 'mint', 'symbol', 'name', 'image', 'kind', 'url', 'thumb', 'caption', 'postedTo', 'createdAt']) assert.ok(k in it, k);
  assert.ok(f.body.next);
  const more = await call('GET', `/api/feed?before=${f.body.next}`);
  assert.ok(more.body.items.every((x) => x.id < f.body.next));
  const c = await call('GET', `/api/coins/${MINT}/content`);
  assert.ok(c.body.gallery.length >= 5);
  assert.equal(c.body.ladder.steps.find((s) => s.key === 'meme_pack').state, 'done');
  assert.deepEqual(c.body.socials, { x: null, tiktok: null });
  const m = await call('GET', it.url, { headers: { range: 'bytes=0-9' } });
  assert.equal(m.status, 206);
  assert.equal(m.raw.length, 10);
  assert.match(m.headers['cache-control'], /immutable/);
  assert.equal((await call('GET', `/api/media/${MINT}/..%2F..%2Fads.db`)).status, 404);
  // nothing in review is public
  assert.ok(!f.body.items.some((x) => one('SELECT j.status FROM assets a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?', x.id).status === 'review'));
});

test('social linking: launcher only, graduated only, OAuth state single use and wallet-bound', async () => {
  const connect = (wallet) => call('GET', `/api/coins/${MINT}/socials/x/connect`, { wallet });
  let r = await connect(LAUNCHER);
  assert.equal(r.status, 302);
  assert.match(r.headers.location, /error=.*graduates/);
  content.setGraduatedReader(async (m) => m === MINT);
  r = await connect('SomeoneElse1111111111111111111111111111111');
  assert.match(r.headers.location, /error=Only/);
  r = await connect(LAUNCHER);
  const loc = new URL(r.headers.location, 'http://x');
  assert.equal(loc.pathname, '/api/oauth/x/callback');
  const state = loc.searchParams.get('state');
  assert.ok(one('SELECT verifier FROM oauth_states WHERE state = ?', state).verifier, 'X keeps a PKCE verifier');
  const wrong = await call('GET', `/api/oauth/x/callback?state=${state}&code=mock`, { wallet: 'SomeoneElse1111111111111111111111111111111' });
  assert.match(wrong.headers.location, /error=Sign/);
  assert.equal(one('SELECT COUNT(*) AS n FROM oauth_states WHERE state = ?', state).n, 0, 'a used state is gone');
  r = await connect(LAUNCHER);
  const st2 = new URL(r.headers.location, 'http://x').searchParams.get('state');
  const ok = await call('GET', `/api/oauth/x/callback?state=${st2}&code=mock`, { wallet: LAUNCHER });
  assert.equal(ok.headers.location, `/t/${MINT}?social=x&linked=1`);
  const row = one("SELECT * FROM socials WHERE mint = ? AND platform = 'x'", MINT);
  assert.equal(row.handle, 'mock_creator');
  assert.doesNotMatch(row.tokens_enc, /mock/, 'tokens are encrypted');
  const replay = await call('GET', `/api/oauth/x/callback?state=${st2}&code=mock`, { wallet: LAUNCHER });
  assert.equal(replay.status, 400);
  // graduated + linked: approved video also goes to the creator's X
  const v = one("SELECT id FROM jobs WHERE mint = ? AND step = 'video' AND status = 'review' ORDER BY id LIMIT 1", MINT);
  await call('POST', `/api/admin/jobs/${v.id}/approve`, { admin: true });
  await content.posting.postApproved();
  assert.equal(one("SELECT status FROM posts WHERE job_id = ? AND platform = 'creator_x'", v.id).status, 'posted');
  const del = await call('DELETE', `/api/coins/${MINT}/socials/x`, { wallet: LAUNCHER });
  assert.deepEqual(del.body.socials, { x: null, tiktok: null });
});

test('graduation unlocks the trailer; the site only when the launcher claims it', async () => {
  ledger.credit(MINT, ledger.toMicros(10), 'sale:4', 'test credit');
  const steps = [];
  for (let i = 0; i < 6; i++) { const r = await planner.plan(); await planner.drain(); for (const id of r.queued) steps.push(one('SELECT step FROM jobs WHERE id = ?', id).step); }
  assert.ok(steps.includes('trailer'));
  assert.ok(!steps.includes('site'), 'the site is never made unasked');
  const t = jobsOf('trailer')[0];
  assert.equal(usd(t.cost_estimate_micros), 6);
  assert.equal(planner.siteStatus(MINT), 'none');
  assert.equal((await planner.claimSite(MINT)).status, 'making');
  await planner.drain();
  assert.equal((await planner.claimSite(MINT)).status, 'making', 'claiming twice queues nothing new');
  assert.equal(jobsOf('site').length, 1);
  const s = jobsOf('site')[0];
  await call('POST', `/api/admin/jobs/${s.id}/approve`, { admin: true });
  await content.posting.postApproved();
  const c = await call('GET', `/api/coins/${MINT}/content`);
  assert.equal(c.body.site.headline, 'Gerald');
  assert.ok(c.body.site.hero.url);
});

test('launch logo: a real PNG data URL in mock, 3 per wallet per day', async () => {
  const w = 'LogoWallet111111111111111111111111111111111';
  const { imageType } = await import('../api/images.mjs');
  for (let i = 0; i < 3; i++) {
    const r = await content.generateLogo({ description: 'a frog baker', name: 'Gerald', symbol: 'GERALD', style: 'flat', wallet: w });
    assert.match(r.imageData, /^data:image\/png;base64,/);
    assert.equal(imageType(Buffer.from(r.imageData.split(',')[1], 'base64')), 'image/png');
    assert.equal(r.remaining, 2 - i);
  }
  await assert.rejects(content.generateLogo({ description: 'again', name: 'G', symbol: 'G', wallet: w }), (e) => e.status === 429);
  await assert.rejects(content.generateLogo({ description: 'x', name: 'G' }), (e) => e.status === 401);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('videos: at most VIDEOS_PER_DAY per coin per UTC day, whatever the budget unlocks', async () => {
  const m = 'CapTest1111111111111111111111111111111111';
  const t = Date.now();
  for (let i = 1; i <= C.videosPerDay; i++) run("INSERT INTO jobs (mint, step, seq, status, paid_by, created_at, updated_at) VALUES (?, 'video', ?, 'posted', 'budget', ?, ?)", m, i, t, t);
  assert.ok(!planner.dueSteps(m, { lifetimeUsd: 500, graduated: false }).some((d) => d.step === 'video'), 'no sixth video today');
  run("UPDATE jobs SET created_at = ? WHERE mint = ?", t - 2 * 86_400_000, m);
  assert.ok(planner.dueSteps(m, { lifetimeUsd: 500, graduated: false }).some((d) => d.step === 'video'), 'tomorrow the next one is due');
});
