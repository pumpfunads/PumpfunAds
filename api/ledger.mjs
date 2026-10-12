/**
 * A coin's ad budget, in millionths of a dollar (usd_micros, integers only: no float ever touches a balance).
 *   credit   the coin's share of a daily treasury sale (its $ADS fees, after the 20% burn, sold for SOL)
 *   spend    content, posting or a boost paid from the budget (atomic: never below zero)
 *   refund   a spend whose job failed or was rejected
 *   platform paid by Ads itself (the launch card): shown on the public log, never deducted
 * Balance = credit + refund - spend. The log is public on every coin page.
 */
import { db, one, all, run, now, tx } from './db.mjs';
import { ApiError } from './errors.mjs';

export const USD = 1_000_000;
export const toMicros = (usd) => Math.round(Number(usd) * USD);
export const toUsd = (micros) => Number(micros || 0) / USD;

const sumOf = (mint, kinds) => one(`SELECT COALESCE(SUM(usd_micros), 0) AS s FROM ledger WHERE mint = ? AND kind IN (${kinds.map(() => '?').join(',')})`, mint, ...kinds).s;

/** Spendable now. */
export const balance = (mint) => sumOf(mint, ['credit', 'refund']) - sumOf(mint, ['spend']);
/** Everything ever credited from fees (what the unlock ladder counts). */
export const lifetime = (mint) => sumOf(mint, ['credit']);
/** $ADS (base units) this coin sent to the treasury that the daily sale has not converted yet. */
export const pendingAds = (mint) => all("SELECT to_treasury, sold FROM fees WHERE mint = ? AND status = 'ok'", mint).reduce((a, r) => a + BigInt(r.to_treasury) - BigInt(r.sold), 0n);

function insert(mint, kind, usdMicros, ref, note) {
  const n = Math.round(Number(usdMicros));
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`ledger: bad amount ${usdMicros}`);
  return Number(run('INSERT INTO ledger (mint, kind, usd_micros, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', mint, kind, n, ref ?? null, note ?? null, now()).lastInsertRowid);
}

/** Spends from the budget, or throws (409) when the balance is short. Check and write in one transaction. */
export function spend(mint, usdMicros, ref, note) {
  return tx(() => {
    if (balance(mint) < usdMicros) throw new ApiError('Not enough budget yet', 409);
    return insert(mint, 'spend', usdMicros, ref, note);
  });
}
export const refund = (mint, usdMicros, ref, note) => insert(mint, 'refund', usdMicros, ref, note);
export const platform = (mint, usdMicros, ref, note) => insert(mint, 'platform', usdMicros, ref, note);
/** Credits used by the daily sale only (api/treasury.mjs), inside its own transaction. */
export const credit = (mint, usdMicros, ref, note) => insert(mint, 'credit', usdMicros, ref, note);

/** The public log, newest first. */
export const entries = (mint, { limit = 50 } = {}) =>
  all('SELECT id, kind, usd_micros, ref, note, created_at FROM ledger WHERE mint = ? ORDER BY id DESC LIMIT ?', mint, Math.min(200, Number(limit) || 50))
    .map((r) => ({ id: r.id, kind: r.kind, usd: toUsd(r.usd_micros), ref: r.ref, note: r.note, createdAt: r.created_at }));

export const summary = (mint) => ({ balanceUsd: toUsd(balance(mint)), lifetimeUsd: toUsd(lifetime(mint)), pendingAds: String(pendingAds(mint)) });

export { db };
