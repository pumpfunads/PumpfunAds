/**
 * The planner: turns a coin's budget into content, one ladder step at a time.
 * Every tick (10 min, or on demand): for each live Ads coin, richest first, find the next due step (lib/ladder.mjs),
 * check the policy (kill switch, coin paused, max per job, coin daily cap, GLOBAL daily cap), SPEND from the ledger
 * BEFORE generating (ref `job:<id>`), then generate -> moderate -> review. A failed or rejected job is refunded.
 * ⛔ Operator rule: never waste paid API credits. Nothing runs while no coin is live (the tick is one SELECT), at most
 *    GENERATION_CONCURRENCY (<= 4) jobs run at once, and GENERATION_DAILY_USD_CAP bounds all coins together.
 * ⛔ A restart re-runs jobs left 'generating': every provider call carries an Idempotency-Key per job+shot, so the
 *    re-run picks up the same Higgsfield requests instead of paying twice.
 */
import crypto from 'node:crypto';
import { all, one, run, now, getKv, setKv } from '../db.mjs';
import * as ledger from '../ledger.mjs';
import { STEPS, ladderFor, videosUnlocked } from '../../lib/ladder.mjs';
import { C } from './config.mjs';
import { ApiError } from '../errors.mjs';
import * as hf from './higgsfield.mjs';
import * as llm from './llm.mjs';
import { clean, postText } from './copy.mjs';
import * as media from './media.mjs';
import './schema.mjs';

const STEP = Object.fromEntries(STEPS.map((s) => [s.key, s]));
const LIVE = new Set(['queued', 'generating', 'review', 'approved', 'posted']); // a job that counts (not failed/rejected)
const MADE = ['review', 'approved', 'posted'];
const dayStart = (t = now()) => t - (t % 86_400_000); // UTC midnight

/* ───────────── graduation (wired by the lead) ───────────── */

let graduatedReader = (mint) => Boolean(getKv(`graduated:${mint}`, false));
/** fn(mint) -> boolean | Promise<boolean>. Default reads kv `graduated:<mint>` (false). */
export function setGraduatedReader(fn) { graduatedReader = fn; }
export const isGraduated = async (mint) => { if (coinRow(mint)?.status === 'demo') return true; try { return Boolean(await graduatedReader(mint)); } catch { return false; } };

/* ───────────── reads ───────────── */

export const liveCoins = () => all("SELECT mint, launcher, name, symbol, description, image, brief_json, live_at FROM launches WHERE status = 'live' AND origin = 'ads' AND hidden = 0");
export const coinRow = (mint) => one('SELECT mint, launcher, name, symbol, description, image, brief_json, status, origin, hidden FROM launches WHERE mint = ?', mint);
export const briefOf = (row) => { try { return JSON.parse(row?.brief_json || '{}') || {}; } catch { return {}; } };
export const platformsOf = (row) => { const p = briefOf(row).platforms; const v = (Array.isArray(p) ? p : ['x', 'tiktok']).filter((x) => x === 'x' || x === 'tiktok'); return v.length ? v : ['x', 'tiktok']; };

/** { [step]: count made (review, approved or posted) } */
export function doneCounts(mint) {
  const out = {};
  for (const r of all(`SELECT step, COUNT(*) AS n FROM jobs WHERE mint = ? AND status IN (${MADE.map(() => '?').join(',')}) GROUP BY step`, mint, ...MADE)) out[r.step] = r.n;
  return out;
}
/** Videos started for `mint` since UTC midnight (failed / rejected ones do not count: their cost came back). */
export const videosToday = (mint) => one(`SELECT COUNT(*) AS n FROM jobs WHERE mint = ? AND step = 'video' AND created_at >= ? AND status IN (${[...LIVE].map(() => '?').join(',')})`, mint, dayStart(), ...LIVE).n;
const countLive = (mint, step) => one(`SELECT COUNT(*) AS n FROM jobs WHERE mint = ? AND step = ? AND status IN (${[...LIVE].map(() => '?').join(',')})`, mint, step, ...LIVE).n;
const attempts = (mint, step, seq) => one("SELECT COUNT(*) AS n FROM jobs WHERE mint = ? AND step = ? AND seq = ? AND status IN ('failed', 'rejected')", mint, step, seq).n;
const inFlight = (mint) => one("SELECT id FROM jobs WHERE mint = ? AND status IN ('queued', 'generating')", mint);

/** What a job holds against the caps: its reservation, less what was refunded (failed jobs keep provider cost only). */
const CHARGED = "CASE WHEN status IN ('failed', 'rejected') THEN COALESCE(cost_actual_micros, 0) ELSE cost_estimate_micros - refunded_micros END";
export const spentToday = () => one(`SELECT COALESCE(SUM(${CHARGED}), 0) AS s FROM jobs WHERE created_at >= ?`, dayStart()).s
  + one('SELECT COALESCE(SUM(cost_micros), 0) AS s FROM logo_requests WHERE created_at >= ?', dayStart()).s;
export const coinSpentToday = (mint) => one(`SELECT COALESCE(SUM(${CHARGED}), 0) AS s FROM jobs WHERE mint = ? AND paid_by = 'budget' AND created_at >= ?`, mint, dayStart()).s;

export function policy(mint) {
  const p = one('SELECT * FROM content_policy WHERE mint = ?', mint) || {};
  return {
    dailyCapMicros: p.daily_cap_micros ?? ledger.toMicros(C.coinDailyUsd),
    maxJobMicros: p.max_job_micros ?? ledger.toMicros(C.maxJobUsd),
    paused: Boolean(p.paused), note: p.note || null,
  };
}
export function setPolicy(mint, { dailyCapUsd, maxJobUsd, paused, note } = {}) {
  const cur = one('SELECT * FROM content_policy WHERE mint = ?', mint) || {};
  run(`INSERT INTO content_policy (mint, daily_cap_micros, max_job_micros, paused, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(mint) DO UPDATE SET daily_cap_micros = excluded.daily_cap_micros, max_job_micros = excluded.max_job_micros, paused = excluded.paused, note = excluded.note, updated_at = excluded.updated_at`,
  mint, dailyCapUsd !== undefined ? ledger.toMicros(dailyCapUsd) : cur.daily_cap_micros ?? null, maxJobUsd !== undefined ? ledger.toMicros(maxJobUsd) : cur.max_job_micros ?? null,
  paused !== undefined ? (paused ? 1 : 0) : cur.paused ?? 0, note !== undefined ? note : cur.note ?? null, now());
  decide(mint, null, 'policy', JSON.stringify({ dailyCapUsd, maxJobUsd, paused, note }));
}
export const killed = () => Boolean(getKv('content.killed', false));
export const setKilled = (on) => { setKv('content.killed', Boolean(on)); decide(null, null, 'policy', on ? 'kill switch ON' : 'kill switch off'); };

/** Logs a decision. Skips repeat the last identical line for the same coin (a waiting coin does not log every tick). */
export function decide(mint, jobId, action, reason) {
  if (action === 'skip' || action === 'cap') {
    const last = one('SELECT action, reason FROM decisions WHERE mint IS ? ORDER BY id DESC LIMIT 1', mint);
    if (last && last.action === action && last.reason === reason) return;
  }
  run('INSERT INTO decisions (mint, job_id, action, reason, created_at) VALUES (?, ?, ?, ?, ?)', mint, jobId, action, reason ?? null, now());
}

/* ───────────── estimates ───────────── */

/** USD micros a step will cost. Mock: the ladder's figure. Live: Higgsfield /estimate + the LLM + one X post. */
export async function estimate(step, coin) {
  if (C.higgsfield.mock) return ledger.toMicros(STEP[step].costUsd);
  let m = (await hf.estimateStep(step)) + ledger.toMicros(C.llmJobUsd);
  if (step !== 'site' && platformsOf(coin).includes('x')) m += ledger.toMicros(C.xPostUsd);
  return m;
}

/* ───────────── queueing ───────────── */

/**
 * Creates a job and pays for it (budget spend, or platform for the launch card). Returns the job id, or null when the
 * spend was refused (balance moved under us).
 */
export function queue(coin, step, seq, costMicros, { paidBy = 'budget' } = {}) {
  const t = now();
  const id = Number(run('INSERT INTO jobs (mint, step, seq, status, paid_by, cost_estimate_micros, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    coin.mint, step, seq, 'queued', paidBy, costMicros, attempts(coin.mint, step, seq) + 1, t, t).lastInsertRowid);
  const ref = `job:${id}`;
  const label = `${STEP[step].label}${step === 'video' ? ` ${seq}` : ''}`;
  try {
    if (paidBy === 'platform') ledger.platform(coin.mint, costMicros, ref, label);
    else ledger.spend(coin.mint, costMicros, ref, label);
  } catch (e) {
    run('DELETE FROM jobs WHERE id = ?', id);
    decide(coin.mint, null, 'skip', `${step}: ${e.message}`);
    return null;
  }
  run('UPDATE jobs SET ledger_ref = ? WHERE id = ?', ref, id);
  decide(coin.mint, id, 'queue', `${label}, ${paidBy} pays $${ledger.toUsd(costMicros).toFixed(4)}`);
  return id;
}

/** The steps due for a coin now, in ladder order: [{ step, seq, paidBy }]. */
export function dueSteps(mint, { lifetimeUsd, graduated }) {
  const due = [];
  if (countLive(mint, 'launch_card') === 0 && attempts(mint, 'launch_card', 1) < C.maxAttempts) due.push({ step: 'launch_card', seq: 1, paidBy: 'platform' });
  if (lifetimeUsd >= STEP.meme_pack.atUsd && countLive(mint, 'meme_pack') === 0 && attempts(mint, 'meme_pack', 1) < C.maxAttempts) due.push({ step: 'meme_pack', seq: 1 });
  const videos = countLive(mint, 'video');
  if (videos < videosUnlocked(lifetimeUsd) && attempts(mint, 'video', videos + 1) < C.maxAttempts && videosToday(mint) < C.videosPerDay) due.push({ step: 'video', seq: videos + 1 });
  // The site is NOT automatic (operator 11 Oct): the launcher claims it on the coin page after bonding (claimSite).
  if (graduated && countLive(mint, 'trailer') === 0 && attempts(mint, 'trailer', 1) < C.maxAttempts) due.push({ step: 'trailer', seq: 1 });
  return due.map((d) => ({ paidBy: 'budget', ...d }));
}

/** Plans one coin: queues at most one job. Returns the job id or null. */
export async function planCoin(coin) {
  const mint = coin.mint;
  if (inFlight(mint)) return null;
  const pol = policy(mint);
  if (pol.paused) { decide(mint, null, 'skip', `paused${pol.note ? `: ${pol.note}` : ''}`); return null; }
  const lifetimeUsd = ledger.toUsd(ledger.lifetime(mint));
  const graduated = await isGraduated(mint);
  for (const d of dueSteps(mint, { lifetimeUsd, graduated })) {
    let cost;
    try { cost = await estimate(d.step, coin); } catch (e) { decide(mint, null, 'skip', `${d.step}: estimate failed: ${e.message}`); return null; }
    if (cost > pol.maxJobMicros) { decide(mint, null, 'cap', `${d.step}: $${ledger.toUsd(cost)} is over the per-job cap $${ledger.toUsd(pol.maxJobMicros)}`); continue; }
    if (spentToday() + cost > ledger.toMicros(C.globalDailyUsd)) { decide(mint, null, 'cap', `${d.step}: global daily cap $${C.globalDailyUsd} reached`); setKv('content:capHit', { day: new Date().toISOString().slice(0, 10), capUsd: C.globalDailyUsd }); return null; }
    if (d.paidBy === 'budget') {
      if (coinSpentToday(mint) + cost > pol.dailyCapMicros) { decide(mint, null, 'cap', `${d.step}: coin daily cap $${ledger.toUsd(pol.dailyCapMicros)} reached`); continue; }
      const bal = ledger.balance(mint);
      if (bal < cost) { decide(mint, null, 'skip', `${d.step}: balance $${ledger.toUsd(bal).toFixed(2)} < $${ledger.toUsd(cost).toFixed(2)}`); continue; }
    }
    return queue(coin, d.step, d.seq, cost, { paidBy: d.paidBy });
  }
  return null;
}

/* ───────────── running ───────────── */

const running = new Map(); // job id -> promise

function settleRefund(job, reason) {
  const owed = job.paid_by === 'budget' ? job.cost_estimate_micros - job.refunded_micros : 0;
  if (owed > 0) {
    ledger.refund(job.mint, owed, `job:${job.id}`, reason.slice(0, 120));
    run('UPDATE jobs SET refunded_micros = refunded_micros + ? WHERE id = ?', owed, job.id);
    decide(job.mint, job.id, 'refund', `$${ledger.toUsd(owed)}: ${reason}`.slice(0, 300));
  }
}

/** Marks a job failed (or rejected) and refunds what the coin paid. */
export function failJob(id, error, status = 'failed') {
  const job = one('SELECT * FROM jobs WHERE id = ?', id);
  if (!job || ['failed', 'rejected', 'posted'].includes(job.status)) return;
  run('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?', status, String(error).slice(0, 500), now(), id);
  decide(job.mint, id, status === 'rejected' ? 'reject' : 'fail', String(error).slice(0, 300));
  settleRefund(job, status === 'rejected' ? `rejected: ${error}` : `failed: ${error}`);
}

const addCost = (id, micros) => { if (micros > 0) run('UPDATE jobs SET cost_actual_micros = COALESCE(cost_actual_micros, 0) + ? WHERE id = ?', Math.round(micros), id); };
const idemKey = (job, shot, part) => `ads-job${job.id}-a${job.attempt}-s${shot}-${part}`;

/** Checks the coin's own brief once (cached per brief hash). Returns null when fine, else the reason. */
async function briefProblem(coin, job) {
  const b = briefOf(coin);
  const text = [coin.name, coin.symbol, coin.description, b.pitch, (b.vibe || []).join(', '), b.audience, b.mascot].filter(Boolean).join('\n');
  const key = `content.briefOk:${coin.mint}`;
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  if (getKv(key, null) === hash) return null;
  const m = await llm.moderate([{ text, kind: 'brief' }]);
  addCost(job.id, m.costMicros);
  if (!m.ok) return m.issues.map((i) => i.reason).join('; ') || 'brief flagged';
  setKv(key, hash);
  return null;
}

async function makeBrief(job, coin) {
  const previous = all("SELECT caption FROM assets WHERE mint = ? AND caption IS NOT NULL ORDER BY id DESC LIMIT 12", coin.mint).map((r) => r.caption);
  let last;
  for (let i = 0; i < 2; i++) {
    const b = await llm.brief(job.step, coin, briefOf(coin), { previous, seq: job.seq });
    addCost(job.id, b.costMicros);
    b.shots = b.shots.map((s) => ({ ...s, caption: postText(s.caption, coin) }));
    const items = [...b.shots.map((s) => ({ text: s.caption, kind: 'caption' })), ...b.shots.flatMap((s) => [s.image_prompt, s.motion_prompt].filter(Boolean).map((text) => ({ text, kind: 'prompt' })))];
    if (b.site) items.push({ text: [b.site.headline, b.site.tagline, ...b.site.paragraphs].join('\n'), kind: 'caption' });
    const m = await llm.moderate(items);
    addCost(job.id, m.costMicros);
    run('UPDATE jobs SET brief_json = ?, moderation_json = ? WHERE id = ?', JSON.stringify(b), JSON.stringify(m), job.id);
    if (m.ok) return b;
    last = m.issues.map((x) => `${items[x.index]?.kind || 'item'} ${x.index}: ${x.reason}`).join('; ');
  }
  throw Object.assign(new Error(`moderation: ${last}`), { rejected: true });
}

function addAsset(job, idx, a) {
  return Number(run('INSERT INTO assets (job_id, mint, idx, kind, path, thumb, mime, width, height, duration, caption, mock, provider_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    job.id, job.mint, idx, a.kind, a.path, a.thumb ?? null, a.mime, a.width ?? null, a.height ?? null, a.duration ?? null, a.caption ?? null, a.mock ? 1 : 0, a.ref ?? null, now()).lastInsertRowid);
}

/** Generates one job end to end. Never throws: a failure is recorded and refunded. */
export async function runJob(id) {
  const job = one('SELECT * FROM jobs WHERE id = ?', id);
  if (!job || !['queued', 'generating'].includes(job.status)) return;
  const coin = coinRow(job.mint);
  try {
    if (!coin) throw new Error('coin not found');
    run("UPDATE jobs SET status = 'generating', updated_at = ? WHERE id = ?", now(), id);
    run('DELETE FROM assets WHERE job_id = ?', id); // a resumed job rebuilds its assets (provider calls are idempotent)
    const problem = await briefProblem(coin, job);
    if (problem) {
      setPolicy(job.mint, { paused: true, note: `brief flagged: ${problem}`.slice(0, 200) });
      throw Object.assign(new Error(`brief flagged: ${problem}`), { rejected: true });
    }
    const b = await makeBrief(job, coin);
    const title = `${coin.name} (${coin.symbol})`;
    const label = STEP[job.step].label;
    for (const [i, s] of b.shots.entries()) {
      const base = media.fileName(job.id, i, 'x').replace(/\.x$/, '');
      if (job.step === 'video' || job.step === 'trailer') {
        const frame = await hf.image(job.mint, `${base}f`, s.image_prompt, { aspect: '9:16', idem: idemKey(job, i, 'frame'), title, subtitle: `${label} first frame` });
        addCost(id, frame.costMicros);
        const v = await hf.video(job.mint, `${base}v`, s.motion_prompt || s.image_prompt, { imageUrl: frame.sourceUrl, kind: job.step, idem: idemKey(job, i, 'video') });
        addCost(id, v.costMicros);
        addAsset(job, i, { kind: 'video', path: v.file || frame.file, thumb: frame.file, mime: v.file ? v.mime : frame.mime, duration: v.duration, width: frame.width, height: frame.height, caption: s.caption, mock: v.mock || frame.mock, ref: v.requestId });
      } else {
        const aspect = job.step === 'site' ? '16:9' : '1:1';
        const img = await hf.image(job.mint, base, s.image_prompt, { aspect, idem: idemKey(job, i, 'image'), title, subtitle: label });
        addCost(id, img.costMicros);
        addAsset(job, i, { kind: 'image', path: img.file, thumb: img.file, mime: img.mime, width: img.width, height: img.height, caption: s.caption, mock: img.mock, ref: img.requestId });
      }
    }
    if (b.site) run('UPDATE jobs SET result_json = ? WHERE id = ?', JSON.stringify({ ...b.site, headline: clean(b.site.headline), tagline: clean(b.site.tagline), paragraphs: b.site.paragraphs.map(clean) }), id);
    const done = one('SELECT * FROM jobs WHERE id = ?', id);
    // live: return what the estimate over-reserved (mock costs are 0 and keep the ladder figure)
    const unused = done.cost_estimate_micros - done.refunded_micros - (done.cost_actual_micros || 0);
    if (!C.higgsfield.mock && done.paid_by === 'budget' && done.cost_actual_micros > 0 && unused > 0) {
      ledger.refund(job.mint, unused, `job:${id}`, 'Unused estimate');
      run('UPDATE jobs SET refunded_micros = refunded_micros + ? WHERE id = ?', unused, id);
    }
    const status = C.autoApprove ? 'approved' : 'review';
    run('UPDATE jobs SET status = ?, error = NULL, updated_at = ?, reviewed_at = ? WHERE id = ?', status, now(), C.autoApprove ? now() : null, id);
    decide(job.mint, id, status === 'approved' ? 'approve' : 'review', `${label} made${C.higgsfield.mock ? ' (mock media)' : ''}`);
  } catch (e) {
    console.error(`content job ${id} (${job.step} ${job.mint}):`, e.message);
    failJob(id, e.message, e.rejected ? 'rejected' : 'failed');
  }
}

/** Starts queued jobs up to the concurrency cap, oldest first. Returns the promises started. */
/** 'none' | 'making' | 'ready': where a coin's claimable site stands. */
export function siteStatus(mint) {
  const j = one(`SELECT status FROM jobs WHERE mint = ? AND step = 'site' AND status IN (${[...LIVE].map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`, mint, ...LIVE);
  return !j ? 'none' : ['approved', 'posted'].includes(j.status) ? 'ready' : 'making';
}

/** The launcher claims the coin's free site (after bonding). Ads pays; it shows at the top of the coin's page once approved. */
export async function claimSite(mint) {
  const coin = coinRow(mint);
  if (!coin) throw new ApiError('No such coin', 404);
  if (!(await isGraduated(mint))) throw new ApiError('The website can be claimed once the coin bonds', 409);
  if (siteStatus(mint) !== 'none') return { status: siteStatus(mint) };
  if (attempts(mint, 'site', 1) >= C.maxAttempts) throw new ApiError('The website could not be made. Contact us on X.', 409);
  const id = queue(coin, 'site', 1, await estimate('site', coin), { paidBy: 'platform' });
  if (!id) throw new ApiError('The website could not be queued just now. Try again later.', 503);
  pump();
  return { status: 'making' };
}

export function pump() {
  const started = [];
  if (killed()) return started;
  const free = C.concurrency - running.size;
  if (free <= 0) return started;
  const ids = all("SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT ?", free + running.size).map((r) => r.id).filter((i) => !running.has(i)).slice(0, free);
  for (const jid of ids) {
    const p = runJob(jid).finally(() => { running.delete(jid); pump(); });
    running.set(jid, p);
    started.push(p);
  }
  return started;
}
/** Resolves when every running job is done (tests, shutdown). */
export async function drain() { while (running.size) await Promise.allSettled([...running.values()]); }
export const runningCount = () => running.size;

/** After a restart: jobs left 'generating' go back to the queue (their provider calls are idempotent). */
export function resume() {
  const n = run("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'generating'", now()).changes;
  if (n) decide(null, null, 'queue', `${n} job(s) resumed after restart`);
  return n;
}

/** The ladder of one coin, for the coin page. */
export async function ladderOf(mint) {
  return ladderFor({ lifetimeUsd: ledger.toUsd(ledger.lifetime(mint)), graduated: await isGraduated(mint), done: doneCounts(mint) });
}

/**
 * The launch card, paid by Ads: the lead calls this right after a launch goes live. Safe to call twice.
 * Returns the job id or null (already made, kill switch, global cap).
 */
export async function onLaunched(mint) {
  const coin = coinRow(mint);
  if (!coin || coin.hidden || killed()) return null; // a hidden coin (the operator's rehearsal) gets no paid card
  if (countLive(mint, 'launch_card') > 0) return null;
  const cost = await estimate('launch_card', coin).catch(() => ledger.toMicros(STEP.launch_card.costUsd));
  if (spentToday() + cost > ledger.toMicros(C.globalDailyUsd)) { decide(mint, null, 'cap', 'launch_card: global daily cap reached'); return null; }
  const id = queue(coin, 'launch_card', 1, cost, { paidBy: 'platform' });
  if (id) pump();
  return id;
}

/** One planner pass over every live coin. Returns { coins, queued:[ids], started }. */
export async function plan() {
  if (killed()) return { coins: 0, queued: [], started: 0, killed: true };
  const coins = liveCoins();
  if (!coins.length) return { coins: 0, queued: [], started: 0 }; // quiet when idle: no estimate, no API call
  const ranked = coins.map((c) => ({ c, life: ledger.lifetime(c.mint) })).sort((a, b) => b.life - a.life).map((x) => x.c);
  const queued = [];
  for (const coin of ranked) {
    if (spentToday() >= ledger.toMicros(C.globalDailyUsd)) break;
    const id = await planCoin(coin);
    if (id) queued.push(id);
  }
  return { coins: coins.length, queued, started: pump().length };
}
