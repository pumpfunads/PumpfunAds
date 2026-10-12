/**
 * The fee keeper. Every 5 minutes, for every live coin:
 *   READ   in batches: the $ADS waiting for the coin's creator wallet (unswept on the curve / pool, in the creator vaults)
 *          and what already sits in the creator wallet's $ADS account.
 *   SPLIT  when worth it: ONE transaction: sweep the curve's (and pool's) waiting fee into the creator vaults, collect
 *          them into the creator wallet, then the creator wallet BURNS 20% (burnChecked: $ADS supply drops) and sends 80%
 *          to the treasury. The keeper pays the fee and (once per coin) the token-account rent; the creator wallet
 *          (a key Ads holds, api/keys.mjs) signs as the tokens' owner and never holds SOL.
 * The treasury sells what it received once a day (api/treasury.mjs) and credits each coin's ad budget.
 *
 * A missed or duplicated pass can only split later, never twice: the split moves exactly what the read saw, and anything
 * that arrived after the read stays in the creator wallet for the next pass. The recorded amount is the transaction's
 * own token balance change, read back after it lands.
 * KEEPER_DRY_RUN=1 simulates everything, records 'dry' rows and moves nothing.
 */
import { PublicKey } from '@solana/web3.js';
import { num, flag } from './env.mjs';
import { all, one, run, now, getKv, setKv } from './db.mjs';
import * as sol from './sol.mjs';
import * as lut from './lut.mjs';
import { feeWalletKeypair } from './keys.mjs';
import { usdPrice } from './quotes.mjs';
import { ata, bondingCurveAddress, coinPoolAddress, creatorVaultAddress, ammCreatorVaultAuthority, curveCreatorFee, poolCreatorFees, tokenAccountAmount, collectIxs, splitIxs } from '../lib/pump.mjs';

export const DRY = flag('KEEPER_DRY_RUN');
const INTERVAL_MS = num('KEEPER_INTERVAL_SECONDS', 300) * 1000;
/** A split is sent once the waiting $ADS is worth MIN_SPLIT_USD, or (price unknown, or a small coin) every MAX_WAIT_HOURS. */
const MIN_SPLIT_USD = num('MIN_SPLIT_USD', 0.1); // a pass costs the keeper ~$0.01: at most ~10% overhead
const MAX_WAIT_MS = num('MAX_WAIT_HOURS', 24) * 3_600_000;
const KEEPER_LOW = BigInt(Math.round(num('KEEPER_LOW_SOL', 0.02) * 1e9));

const keeper = sol.loadKeeper();
export const enabled = Boolean(keeper);
export const keeperAddress = () => keeper?.publicKey.toBase58() || null;
const log = (...a) => console.log(new Date().toISOString(), '[keeper]', ...a);
export const status = () => ({ ...(getKv('keeper', {}) || {}), enabled, dryRun: DRY, intervalMs: INTERVAL_MS, keeper: keeperAddress(), treasury: sol.treasuryAddress()?.toBase58() || null, minSplitUsd: MIN_SPLIT_USD });
const coinStatus = (mint, patch) => setKv(`ks:${mint}`, { ...(getKv(`ks:${mint}`, {}) || {}), ...patch, at: now() });
export const launchKeeperStatus = (mint) => getKv(`ks:${mint}`, null);

const quoteOf = (row) => JSON.parse(row.quote_json);

/** Batched: for each row, { waiting (to sweep / collect), inWallet (already in the creator wallet), graduated }. */
export async function readPending(rows) {
  const keysPer = 5;
  const list = rows.flatMap((r) => {
    const q = quoteOf(r), m = new PublicKey(r.mint), fw = new PublicKey(r.fee_wallet), Q = new PublicKey(q.mint), prog = new PublicKey(q.tokenProgram);
    return [bondingCurveAddress(m), coinPoolAddress(m, q), ata(creatorVaultAddress(fw), Q, prog), ata(ammCreatorVaultAuthority(fw), Q, prog), ata(fw, Q, prog)];
  });
  const infos = [];
  for (let i = 0; i < list.length; i += 100) infos.push(...(await sol.conn.getMultipleAccountsInfo(list.slice(i, i + 100), 'confirmed')));
  return rows.map((r, i) => {
    const [curve, pool, v1, v2, fw] = infos.slice(i * keysPer, i * keysPer + keysPer);
    const graduated = Boolean(pool && pool.data.length >= 200);
    const waiting = (curve ? curveCreatorFee(curve.data) : 0n) + (graduated ? poolCreatorFees(pool.data) : 0n) + (v1 ? tokenAccountAmount(v1.data) : 0n) + (v2 ? tokenAccountAmount(v2.data) : 0n);
    return { waiting, inWallet: fw ? tokenAccountAmount(fw.data) : 0n, graduated };
  });
}

const lastSplitAt = (mint) => one("SELECT MAX(created_at) AS t FROM fees WHERE mint = ? AND status IN ('ok', 'dry')", mint)?.t || 0;

/** Whether this much $ADS is worth a transaction now. */
async function worthIt(row, units, q) {
  if (units <= 0n) return false;
  const price = await usdPrice(q.mint).catch(() => null);
  if (price && (Number(units) / 10 ** q.decimals) * price >= MIN_SPLIT_USD) return true;
  const since = lastSplitAt(row.mint) || row.live_at || row.created_at;
  return now() - since >= MAX_WAIT_MS;
}

function record(row, q, { collected, burned, toTreasury }, { sig = null, lvbh = null, status }) {
  return run('INSERT INTO fees (mint, collected, burned, to_treasury, decimals, sig, lvbh, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    row.mint, String(collected), String(burned), String(toTreasury), q.decimals, sig, lvbh, DRY ? 'dry' : status, now());
}

/** One coin: sweep, collect into its creator wallet, burn 20%, send 80% to the treasury, in one transaction. */
async function splitCoin(row, p, treasury) {
  const q = quoteOf(row);
  const creator = feeWalletKeypair(row.mint);
  if (!creator || creator.publicKey.toBase58() !== row.fee_wallet) throw new Error('creator wallet key missing on this box');
  const amount = p.waiting + p.inWallet;
  const split = await splitIxs({ payer: keeper.publicKey, creator: creator.publicKey, treasury, quote: q, amount });
  const ixs = [...sol.budget(400_000), ...(await collectIxs(sol.conn, { mint: row.mint, payer: keeper.publicKey, creator: creator.publicKey, quote: q, graduated: p.graduated })), ...split.ixs];
  const built = await lut.v0WithTables(keeper.publicKey, ixs, [keeper, creator]);
  await sol.simulate(built.tx);
  const amounts = { collected: amount, burned: split.burn, toTreasury: split.toTreasury };
  if (DRY) { record(row, q, amounts, { status: 'dry' }); return `dry run: would burn ${split.burn} and fund ${split.toTreasury} units of $ADS`; }
  // ⛔ Recorded as pending BEFORE the send: a split that lands while the service restarts still has its row (and the
  // coin its credit); settlePending resolves it from the signature.
  const id = Number(record(row, q, amounts, { sig: sol.sigOf(built.tx), lvbh: built.lastValidBlockHeight, status: 'pending' }).lastInsertRowid);
  const r = await sol.send(built);
  run('UPDATE fees SET status = ? WHERE id = ?', r.result === 'ok' ? 'ok' : r.result === 'pending' ? 'pending' : 'failed', id);
  log(`${row.symbol}: split ${r.result}: burned ${split.burn}, treasury +${split.toTreasury} $ADS units (${r.sig})`);
  return r.result === 'ok' ? `split ${amount} units` : `split ${r.result}`;
}

/** Pending splits: final once the chain answers; 'failed' only once the blockhash has provably expired. */
async function settlePending() {
  for (const b of all("SELECT * FROM fees WHERE status = 'pending'")) {
    const st = await sol.txStatus(b.sig).catch(() => undefined);
    if (st === 'ok') run("UPDATE fees SET status = 'ok' WHERE id = ?", b.id);
    else if (st === 'failed') run("UPDATE fees SET status = 'failed' WHERE id = ?", b.id);
    else if (st === null && b.lvbh != null && (await sol.conn.getBlockHeight('finalized').catch(() => 0)) > b.lvbh + 150) run("UPDATE fees SET status = 'failed' WHERE id = ?", b.id);
  }
}

/** Whether a coin's pool exists (graduated), from the last pass. The content planner reads it. */
export const graduated = (mint) => Boolean(getKv(`ks:${mint}`, null)?.graduated);

let running = null;
export function tick() {
  if (!running) running = runTick().finally(() => { running = null; });
  return running;
}

async function runTick() {
  const startedAt = now();
  await settlePending().catch((e) => log(`settle: ${e.message}`));
  // Only coins launched HERE: $ADS itself (listed, origin 'external') pays its fees elsewhere.
  const rows = all("SELECT * FROM launches WHERE status = 'live' AND origin = 'ads' ORDER BY live_at ASC");
  const treasury = sol.treasuryAddress();
  const errors = [];
  let split = 0;
  const pending = rows.length ? await readPending(rows) : [];
  for (const [i, row] of rows.entries()) {
    const p = pending[i];
    coinStatus(row.mint, { graduated: p.graduated });
    try {
      if (one("SELECT 1 FROM fees WHERE mint = ? AND status = 'pending'", row.mint)) { coinStatus(row.mint, { note: 'A split is still confirming.', error: null }); continue; }
      if (!(await worthIt(row, p.waiting + p.inWallet, quoteOf(row)))) { coinStatus(row.mint, { note: null, error: null, waiting: String(p.waiting + p.inWallet) }); continue; }
      if (!keeper || !treasury) { coinStatus(row.mint, { note: 'Fees are waiting; no keeper or treasury on this box.', waiting: String(p.waiting + p.inWallet) }); continue; }
      const note = await splitCoin(row, p, treasury);
      if (/^split \d/.test(note)) split++;
      coinStatus(row.mint, { note, error: null, waiting: '0' });
    } catch (e) {
      errors.push(`${row.symbol}: ${e.message}`);
      coinStatus(row.mint, { error: e.message.slice(0, 300) });
      log(`${row.symbol} ${e.message}`);
    }
  }
  const keeperLamports = keeper ? await sol.lamports(keeper.publicKey).catch(() => null) : null;
  setKv('keeper', { lastRunAt: startedAt, nextRunAt: startedAt + INTERVAL_MS, launches: rows.length, split, lastError: errors.length ? errors.join(' | ').slice(0, 500) : null, keeperSol: keeperLamports == null ? null : Number(keeperLamports) / 1e9, lowGas: keeperLamports != null && keeperLamports < KEEPER_LOW });
}

export function start() {
  if (!keeper) log('no keeper key on this box: fees are NOT collected');
  else if (!sol.treasuryAddress()) log('no treasury on this box: fees are NOT collected');
  else log(`on as ${keeper.publicKey.toBase58()}${DRY ? ' (DRY RUN, sends nothing)' : ''}, every ${INTERVAL_MS / 1000}s, split at $${MIN_SPLIT_USD} or every ${MAX_WAIT_MS / 3_600_000} h, treasury ${sol.treasuryAddress().toBase58()}`);
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      log(`pass failed: ${e.message}`);
    }
    setTimeout(loop, INTERVAL_MS).unref();
  };
  setTimeout(loop, 10_000).unref();
}
