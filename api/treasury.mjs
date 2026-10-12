/**
 * The treasury: receives 80% of every coin's creator fees in $ADS (api/keeper.mjs) and, once a day (operator, 10 Oct
 * 2026: "sell everything each day"), sells them for SOL through Pumpfun itself (multi_hop_swap, one hop $ADS → SOL; no
 * Jupiter: it rate-limits the shared box). The SOL received, valued at that moment's SOL/USD, is credited to each coin's
 * ad budget in proportion to the $ADS that coin contributed and had not been sold yet.
 *
 *   ⛔ A sale never sells more than MAX_IMPACT_BPS of $ADS's reserves in one go: whatever is left waits for the next day
 *      (each fee row tracks `sold`, so a partial sale credits each coin its exact share).
 *   ⛔ Only $ADS the ledger knows about is sold: anything else in the treasury (a stranger's transfer) is never credited.
 *   ⛔ The credit is the SOL actually received (the wallet's balance change), never the quote.
 * SALE_DRY_RUN=1 (or KEEPER_DRY_RUN=1) simulates and records a 'dry' sale; no credits.
 *
 * PAYOUT (operator, 10 Oct 2026: "automate it"): Higgsfield and X only take card top-ups, so the SOL cannot pay them
 * from here. Right after each sale lands, everything above TREASURY_FLOOR_SOL is sent to TREASURY_PAYOUT_ADDRESS (set
 * once, in .env; no address = no sweep). `scripts/ads.mjs withdraw` does the same by hand. Every payout is a row.
 *   ⛔ The payout address must be an ON-CURVE wallet (a typo'd / PDA address once lost 1.05 SOL): checked every time.
 */
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { env, num, flag } from './env.mjs';
import { all, one, run, now, tx, getKv, setKv } from './db.mjs';
import * as sol from './sol.mjs';
import * as ledger from './ledger.mjs';
import { adsMint } from './launch.mjs';
import { ata, loadGlobal, quoteReserves, quoteSell, resolveQuote, sellQuoteIxs, tokenAccountAmount, WSOL, TOKEN_PROGRAM } from '../lib/pump.mjs';

const DRY = flag('SALE_DRY_RUN') || flag('KEEPER_DRY_RUN');
const SALE_HOUR_UTC = num('SALE_HOUR_UTC', 14);
const MAX_IMPACT_BPS = BigInt(num('SALE_MAX_IMPACT_BPS', 200)); // 2% of the reserves per sale
const SLIPPAGE_BPS = BigInt(num('SALE_SLIPPAGE_BPS', 500));
const MIN_SALE_USD = num('MIN_SALE_USD', 1);
const FLOOR_LAMPORTS = BigInt(Math.round(num('TREASURY_FLOOR_SOL', 0.02) * 1e9)); // the sale's fee and a token account's rent
const MIN_SWEEP_LAMPORTS = BigInt(Math.round(num('TREASURY_MIN_SWEEP_SOL', 0.05) * 1e9));
const payoutAddress = () => { const a = env('TREASURY_PAYOUT_ADDRESS', ''); return a && sol.isAddress(a) ? a : null; };
const log = (...a) => console.log(new Date().toISOString(), '[treasury]', ...a);

const treasury = sol.loadTreasury();
export const enabled = Boolean(treasury);
export const status = () => ({ ...(getKv('treasury', {}) || {}), enabled, dryRun: DRY, address: sol.treasuryAddress()?.toBase58() || null, saleHourUtc: SALE_HOUR_UTC, payoutTo: payoutAddress(), floorSol: Number(FLOOR_LAMPORTS) / 1e9 });

/**
 * Sends `lamports` (or everything above the floor when null) from the treasury to `to`. Refuses an off-curve or
 * malformed address, and never takes the balance under the floor. Returns { result, sig, lamports } or a reason.
 */
export async function payout({ to, lamports = null, kind = 'withdraw' }) {
  if (!treasury) return { result: 'refused', reason: 'no treasury key on this box' };
  if (!sol.isAddress(String(to || ''))) return { result: 'refused', reason: `not an on-curve wallet address: ${to}` };
  if (to === treasury.publicKey.toBase58()) return { result: 'refused', reason: 'that is the treasury itself' };
  if (one("SELECT 1 FROM payouts WHERE status = 'pending'")) return { result: 'refused', reason: 'a payout is still confirming' };
  const bal = await sol.lamports(treasury.publicKey);
  const room = bal - FLOOR_LAMPORTS - sol.feeFor(10_000); // the floor stays whole: this transaction's own fee comes out of the payout
  const amount = lamports == null ? room : BigInt(lamports);
  if (amount <= 0n || amount > room) return { result: 'refused', reason: `the treasury holds ${Number(bal) / 1e9} SOL; ${Number(FLOOR_LAMPORTS) / 1e9} stays for the daily sale` };
  const built = await sol.v0(treasury.publicKey, [...sol.budget(10_000), SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: new PublicKey(to), lamports: amount })], [treasury]);
  await sol.simulate(built.tx);
  // ⛔ The signature goes in WITH the row: a restart during send() must leave a row settlePending can resolve.
  const id = Number(run("INSERT INTO payouts (lamports, to_address, kind, sig, lvbh, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)", String(amount), to, kind, sol.sigOf(built.tx), built.lastValidBlockHeight, now()).lastInsertRowid);
  const r = await sol.send(built);
  run('UPDATE payouts SET sig = ?, status = ? WHERE id = ?', r.sig, r.result === 'ok' ? 'ok' : r.result === 'pending' ? 'pending' : 'failed', id);
  log(`${kind}: ${Number(amount) / 1e9} SOL → ${to} ${r.result} (${r.sig})`);
  return { result: r.result, sig: r.sig, lamports: String(amount) };
}

/** After a sale: sweep everything above the floor to the payout address, if one is set and it is worth a transaction. */
async function sweepAfterSale() {
  const to = payoutAddress();
  if (!to || DRY) return null;
  const bal = await sol.lamports(treasury.publicKey);
  if (bal - FLOOR_LAMPORTS < MIN_SWEEP_LAMPORTS) return null;
  return payout({ to, kind: 'sweep' });
}

/** Fee rows with $ADS (this mint) not sold yet: [{ id, mint, unsold }]. */
const unsoldRows = (adsMint_) => all("SELECT f.id, f.mint, f.to_treasury, f.sold FROM fees f JOIN launches l ON l.mint = f.mint WHERE f.status = 'ok' AND l.quote_mint = ?", adsMint_)
  .map((r) => ({ id: r.id, mint: r.mint, unsold: BigInt(r.to_treasury) - BigInt(r.sold) }))
  .filter((r) => r.unsold > 0n);

/**
 * Splits `sold` $ADS and `usdMicros` across the rows pro rata (largest-remainder, so the parts add up exactly) and
 * writes the credits, all in one database transaction.
 */
export function allocate(saleId, rows, sold, usdMicros) {
  const total = rows.reduce((a, r) => a + r.unsold, 0n);
  if (total <= 0n || sold <= 0n) return [];
  const parts = rows.map((r) => ({ ...r, take: (r.unsold * sold) / total }));
  let rest = sold - parts.reduce((a, p) => a + p.take, 0n);
  for (const p of [...parts].sort((a, b) => Number(b.unsold - a.unsold))) { if (rest <= 0n) break; if (p.take < p.unsold) { p.take++; rest--; } }
  const byMint = new Map();
  for (const p of parts) byMint.set(p.mint, (byMint.get(p.mint) || 0n) + p.take);
  // USD per coin from its share of the $ADS sold, integer micros, remainder to the biggest.
  const usd = BigInt(Math.round(usdMicros));
  const credits = [...byMint].map(([mint, units]) => ({ mint, units, micros: (usd * units) / sold }));
  let left = usd - credits.reduce((a, c) => a + c.micros, 0n);
  credits.sort((a, b) => Number(b.units - a.units));
  if (credits.length && left > 0n) credits[0].micros += left;
  tx(() => {
    for (const p of parts) if (p.take > 0n) run('UPDATE fees SET sold = ?, sale_id = ? WHERE id = ?', String(BigInt(one('SELECT sold FROM fees WHERE id = ?', p.id).sold) + p.take), saleId, p.id);
    for (const c of credits) if (c.micros > 0n) ledger.credit(c.mint, Number(c.micros), `sale:${saleId}`, 'Fees in');
  });
  return credits.map((c) => ({ mint: c.mint, units: String(c.units), usd: ledger.toUsd(Number(c.micros)) }));
}

/** One sale now. Returns a short note. */
export async function sell({ force = false } = {}) {
  if (!treasury) return 'no treasury key on this box';
  if (!adsMint()) return 'no $ADS yet';
  if (one("SELECT 1 FROM sales WHERE status = 'pending'")) return 'a sale is still confirming';
  const rows = unsoldRows(adsMint());
  const waiting = rows.reduce((a, r) => a + r.unsold, 0n);
  if (waiting <= 0n) return 'nothing to sell';
  const q = await resolveQuote(sol.conn, adsMint());
  if (!q.ok) throw new Error(`$ADS does not resolve: ${q.reason}`);
  const held = await sol.conn.getAccountInfo(ata(treasury.publicKey, new PublicKey(q.mint), new PublicKey(q.tokenProgram)), 'confirmed');
  const balance = held ? tokenAccountAmount(held.data) : 0n;
  const reserves = await quoteReserves(sol.conn, q);
  if (!reserves) throw new Error('$ADS reserves unreadable');
  const cap = (reserves.base * MAX_IMPACT_BPS) / 10_000n;
  const amount = [waiting, balance, cap].reduce((a, b) => (b < a ? b : a));
  if (amount <= 0n) return `nothing sellable (waiting ${waiting}, treasury holds ${balance})`;
  const solUsd = await sol.solUsd();
  const global = await loadGlobal(sol.conn);
  // ⛔ The reserve formula was 12% off a real PumpSwap sell on the local clone: the floor comes from a SIMULATION of the
  // very sale (minOut 1, the wSOL account left open so its balance can be read), never from the formula alone.
  const expected = (await simulatedOut(global, q, amount)) ?? quoteSell({ reserves, amountIn: amount });
  if (!force && solUsd && (Number(expected) / 1e9) * solUsd < MIN_SALE_USD) return `waiting: worth under $${MIN_SALE_USD}`;
  const minOut = (expected * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  const built = await sol.v0(treasury.publicKey, [...sol.budget(300_000), ...(await sellQuoteIxs(sol.conn, global, { user: treasury.publicKey, q, amountIn: amount, minOut }))], [treasury]);
  await sol.simulate(built.tx);
  if (DRY) {
    run("INSERT INTO sales (ads_in, lamports_out, sol_usd, usd_micros, status, created_at) VALUES (?, ?, ?, ?, 'dry', ?)", String(amount), String(expected), solUsd, solUsd ? Math.round((Number(expected) / 1e9) * solUsd * 1e6) : null, now());
    return `dry run: would sell ${amount} $ADS units for ~${Number(expected) / 1e9} SOL`;
  }
  const before = await sol.lamports(treasury.publicKey);
  const saleId = Number(run("INSERT INTO sales (ads_in, sol_usd, sig, lvbh, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)", String(amount), solUsd, sol.sigOf(built.tx), built.lastValidBlockHeight, now()).lastInsertRowid);
  const r = await sol.send(built);
  run('UPDATE sales SET sig = ? WHERE id = ?', r.sig, saleId);
  if (r.result !== 'ok') {
    run('UPDATE sales SET status = ?, error = ? WHERE id = ?', r.result === 'pending' ? 'pending' : 'failed', JSON.stringify(r.err || r.result).slice(0, 300), saleId);
    return `sale ${r.result} (${r.sig})`;
  }
  return settle(saleId, rows, amount, before, solUsd);
}

/**
 * Lamports the sale of `amount` would get right now, by SIMULATING the whole sale and reading the treasury's SOL balance
 * after it (null when the simulation cannot tell). ⛔ Not the wSOL account: while $ADS is on its Pumpfun curve the swap
 * pays NATIVE SOL straight to the treasury and wSOL stays 0 (11 Oct 2026: the first live check read "~0 SOL" for
 * ~0.12 SOL, and the daily sale would have skipped forever as "worth under $1"). The balance covers both routes.
 */
async function simulatedOut(global, q, amount) {
  const ixs = await sellQuoteIxs(sol.conn, global, { user: treasury.publicKey, q, amountIn: amount, minOut: 1n });
  const built = await sol.v0(treasury.publicKey, [...sol.budget(300_000), ...ixs], [treasury]);
  const sim = await sol.conn.simulateTransaction(built.tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: [treasury.publicKey.toBase58()] } }).catch(() => null);
  const after = sim?.value?.accounts?.[0];
  if (!sim || sim.value.err || !after) return null;
  const before = await sol.conn.getBalance(treasury.publicKey, 'confirmed').catch(() => null);
  if (before == null) return null;
  const gain = BigInt(after.lamports) - BigInt(before);
  return gain > 0n ? gain : null;
}

/** A landed sale: the SOL received (balance change + the transaction fee the treasury paid) → credits. */
async function settle(saleId, rows, amount, before, solUsd) {
  const s = one('SELECT * FROM sales WHERE id = ?', saleId);
  const t = await sol.conn.getTransaction(s.sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
  let lamportsOut;
  if (t?.meta) lamportsOut = BigInt(t.meta.postBalances[0]) - BigInt(t.meta.preBalances[0]) + BigInt(t.meta.fee);
  else if (before == null) return 'landed, not readable yet'; // settlePending tries again next pass
  else lamportsOut = (await sol.lamports(treasury.publicKey)) - before; // fallback: the fee is then counted against the sale
  const usdMicros = Math.max(0, Math.round((Number(lamportsOut) / 1e9) * (solUsd || 0) * 1e6));
  run("UPDATE sales SET status = 'ok', lamports_out = ?, usd_micros = ? WHERE id = ?", String(lamportsOut), usdMicros, saleId);
  const credits = allocate(saleId, rows, amount, usdMicros);
  log(`sale ${saleId}: ${amount} $ADS units → ${Number(lamportsOut) / 1e9} SOL ($${(usdMicros / 1e6).toFixed(2)}) credited to ${credits.length} coin(s) (${s.sig})`);
  const swept = await sweepAfterSale().catch((e) => ({ result: 'failed', reason: e.message }));
  if (swept && swept.result !== 'ok') setKv('treasury', { ...(getKv('treasury', {}) || {}), lastError: `payout: ${swept.reason || swept.result}`, lastErrorAt: now() });
  return `sold ${amount} units for ${Number(lamportsOut) / 1e9} SOL${swept?.result === 'ok' ? `, swept ${Number(swept.lamports) / 1e9} SOL to the payout wallet` : ''}`;
}

/** A sale whose outcome was unknown: settled once the chain answers ('failed' once its blockhash expired). */
async function settlePending() {
  for (const p of all("SELECT * FROM payouts WHERE status = 'pending' AND sig IS NOT NULL")) {
    const st = await sol.txStatus(p.sig).catch(() => undefined);
    if (st === 'ok') run("UPDATE payouts SET status = 'ok' WHERE id = ?", p.id);
    else if (st === 'failed' || (st === null && (await sol.conn.getBlockHeight('finalized').catch(() => 0)) > p.lvbh + 150)) run("UPDATE payouts SET status = 'failed' WHERE id = ?", p.id);
  }
  for (const s of all("SELECT * FROM sales WHERE status = 'pending' AND sig IS NOT NULL")) {
    const st = await sol.txStatus(s.sig).catch(() => undefined);
    if (st === 'ok') {
      const rows = unsoldRows(adsMint());
      await settle(s.id, rows, BigInt(s.ads_in), null, s.sol_usd).catch((e) => log(`settle ${s.id}: ${e.message}`));
    } else if (st === 'failed' || (st === null && (await sol.conn.getBlockHeight('finalized').catch(() => 0)) > s.lvbh + 150)) {
      run("UPDATE sales SET status = 'failed' WHERE id = ?", s.id);
    }
  }
}

const today = () => new Date().toISOString().slice(0, 10);
export function start() {
  if (!treasury) { log('no treasury key on this box: fees are not sold'); return; }
  log(`on as ${treasury.publicKey.toBase58()}${DRY ? ' (DRY RUN)' : ''}, daily sale at ${SALE_HOUR_UTC}:00 UTC, max ${Number(MAX_IMPACT_BPS) / 100}% of reserves per sale, ${payoutAddress() ? `then everything above ${Number(FLOOR_LAMPORTS) / 1e9} SOL to ${payoutAddress()}` : 'no payout address (SOL stays in the treasury)'}`);
  const loop = async () => {
    try {
      await settlePending();
      setKv('treasury', { ...(getKv('treasury', {}) || {}), sol: Number(await sol.lamports(treasury.publicKey)) / 1e9 });
      const st = getKv('treasury', {}) || {};
      if (new Date().getUTCHours() >= SALE_HOUR_UTC && st.lastSaleDay !== today()) {
        const note = await sell();
        setKv('treasury', { ...st, lastSaleDay: today(), lastSaleAt: now(), lastNote: note, lastError: null });
        log(note);
      }
    } catch (e) {
      setKv('treasury', { ...(getKv('treasury', {}) || {}), lastError: e.message.slice(0, 300), lastErrorAt: now() });
      log(`sale failed: ${e.message}`);
    }
    setTimeout(loop, 10 * 60_000).unref();
  };
  setTimeout(loop, 30_000).unref();
}
