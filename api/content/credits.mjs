/**
 * The prepaid provider balances Ads pays OFF CHAIN (operator, 10 Oct 2026: "we pay Higgsfield off chain, make sure it
 * always has enough credits"):
 *   higgsfield  NO balance API (docs.higgsfield.ai, checked 10 Oct): kept here as a running ledger. The operator records
 *               every top-up (`scripts/ads.mjs higgsfield topup <usd>`) and sets the true figure from the Console now and
 *               then (`higgsfield set <usd>`); every completed live generation subtracts its /estimate cost. A request
 *               Higgsfield refuses for credit (402, or a message about balance / credits) is the hard signal: it turns
 *               the content kill switch ON at once (queued jobs wait, nothing is charged to coins) and alerts.
 *   openrouter  read live from GET https://openrouter.ai/api/v1/credits (total_credits - total_usage). Shared key
 *               (usetokens, pumpbook): its balance is everyone's.
 * api/health.mjs turns these into Discord alerts: under HIGGSFIELD_LOW_USD (default 10) or under ~3 days of spend.
 */
import { db, one, all, run, now, getKv, setKv } from '../db.mjs';
import { env, num } from '../env.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS provider_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,          -- higgsfield
  kind TEXT NOT NULL,              -- topup | set | spend
  usd_micros INTEGER NOT NULL,     -- topup / spend: the amount; set: the balance it was set to
  ref TEXT,
  created_at INTEGER NOT NULL
)`);

export const LOW_USD = num('HIGGSFIELD_LOW_USD', 10);
const DAYS_WANTED = num('PROVIDER_DAYS_WANTED', 3);

/** Higgsfield balance as Ads knows it: the last 'set' (or 0) plus top-ups since, minus spend since. */
export function higgsfield() {
  const base = one("SELECT id, usd_micros, created_at FROM provider_ledger WHERE provider = 'higgsfield' AND kind = 'set' ORDER BY id DESC LIMIT 1");
  const since = base?.id || 0;
  const sum = (kind) => one("SELECT COALESCE(SUM(usd_micros), 0) AS s FROM provider_ledger WHERE provider = 'higgsfield' AND kind = ? AND id > ?", kind, since).s;
  const balance = (base?.usd_micros || 0) + sum('topup') - sum('spend');
  const day = one("SELECT COALESCE(SUM(usd_micros), 0) AS s FROM provider_ledger WHERE provider = 'higgsfield' AND kind = 'spend' AND created_at > ?", now() - 86_400_000).s;
  const week = one("SELECT COALESCE(SUM(usd_micros), 0) AS s FROM provider_ledger WHERE provider = 'higgsfield' AND kind = 'spend' AND created_at > ?", now() - 7 * 86_400_000).s;
  const perDay = Math.max(day, week / 7);
  const known = Boolean(base) || Boolean(one("SELECT 1 FROM provider_ledger WHERE provider = 'higgsfield' AND kind = 'topup'"));
  return {
    known, balanceUsd: balance / 1e6, spent24hUsd: day / 1e6, perDayUsd: perDay / 1e6,
    daysLeft: perDay > 0 ? balance / perDay : null,
    low: known && (balance / 1e6 < LOW_USD || (perDay > 0 && balance / perDay < DAYS_WANTED)),
    outOfCredits: getKv('hf:outOfCredits', null),
    lastSetAt: base?.created_at || null,
  };
}
export const recordSpend = (micros, ref) => { if (micros > 0) run("INSERT INTO provider_ledger (provider, kind, usd_micros, ref, created_at) VALUES ('higgsfield', 'spend', ?, ?, ?)", Math.round(micros), ref || null, now()); };
export const topup = (usd, note = null) => { run("INSERT INTO provider_ledger (provider, kind, usd_micros, ref, created_at) VALUES ('higgsfield', 'topup', ?, ?, ?)", Math.round(usd * 1e6), note, now()); setKv('hf:outOfCredits', null); return higgsfield(); };
export const setBalance = (usd) => { run("INSERT INTO provider_ledger (provider, kind, usd_micros, ref, created_at) VALUES ('higgsfield', 'set', ?, 'console', ?)", Math.round(usd * 1e6), now()); setKv('hf:outOfCredits', null); return higgsfield(); };
export const history = (limit = 20) => all("SELECT kind, usd_micros, ref, created_at FROM provider_ledger WHERE provider = 'higgsfield' AND kind <> 'spend' ORDER BY id DESC LIMIT ?", limit);

/** Higgsfield refused for credit: stop generating NOW (the kill switch) and remember why, for the alert. */
export function outOfCredits(detail) {
  if (getKv('hf:outOfCredits', null)) return;
  setKv('hf:outOfCredits', { at: now(), detail: String(detail).slice(0, 200) });
  setKv('content.killed', true);
  console.error(`[credits] Higgsfield refused for credit: content generation PAUSED (kill switch on). ${detail}`);
}
/** Whether an error from Higgsfield means "no credit". */
export const isCreditError = (e) => e?.status === 402 || /insufficient|balance|credit|top.?up|payment required/i.test(String(e?.message || ''));

/** OpenRouter's live balance (USD), cached 10 minutes. Null without a key or when it does not answer. */
let orCache = { at: 0, v: null };
export async function openrouter() {
  const key = env('OPENROUTER_API_KEY', '');
  if (!key) return null;
  if (Date.now() - orCache.at < 600_000) return orCache.v;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/credits', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    const j = await r.json();
    const v = j?.data ? { balanceUsd: Number(j.data.total_credits) - Number(j.data.total_usage), totalCredits: Number(j.data.total_credits) } : null;
    orCache = { at: Date.now(), v };
    return v;
  } catch {
    return orCache.v;
  }
}
