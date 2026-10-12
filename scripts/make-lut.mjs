/**
 * Creates the launch lookup table ONCE (keeper pays ~0.003 SOL of rent and is its authority), fills it with every
 * launch-independent account, waits a slot so it is usable, and records its address in the database (kv launchLut).
 * Run on the server: cd <app dir> && KEEPER_KEY_FILE=… DB_PATH=… node scripts/make-lut.mjs   (idempotent)
 * Also used by e2e/api.mjs against the local validator. Pair tables (a Q's own accounts) are made on demand: api/lut.mjs.
 */
import '../api/env.mjs';
import { AddressLookupTableProgram, PublicKey } from '@solana/web3.js';
import * as sol from '../api/sol.mjs';
import { getKv, setKv } from '../api/db.mjs';
import { launchStaticAccounts, loadLookupTable, readQuoteControl, resolveQuote } from '../lib/pump.mjs';

/**
 * What every paired launch shares: what launches against two tokens on pump.fun's own list have in common, minus the
 * tokens themselves. Uses the first two that resolve (one is enough: the same token twice, its mint removed).
 */
export async function staticAccounts() {
  const listed = await readQuoteControl(sol.conn);
  const ok = [];
  // $ADS first when it is known (the local e2e's clone has no listed token's mint), then pump.fun's own list.
  const ads = getKv('token', null)?.mint || process.env.ADS_MINT || null;
  for (const m of [...(ads ? [ads] : []), ...listed]) {
    const q = await resolveQuote(sol.conn, m, { listed });
    if (q.ok) ok.push(q);
    if (ok.length === 2) break;
  }
  if (!ok.length) throw new Error('no pair token resolves ($ADS or pump.fun\'s custom pair list)');
  const skip = new Set(ok.map((q) => q.mint));
  return (await launchStaticAccounts(sol.conn, ok[0], ok[1] || ok[0])).filter((k) => !skip.has(k.toBase58()));
}

export async function ensureLaunchLut({ log = console.log } = {}) {
  const keeper = sol.loadKeeper();
  if (!keeper) throw new Error('no keeper key (KEEPER_KEY_FILE / KEEPER_SECRET_KEY)');
  const wanted = await staticAccounts();
  const existing = getKv('launchLut', null);
  if (existing) {
    const t = await loadLookupTable(sol.conn, existing).catch(() => null);
    const have = new Set((t?.state.addresses || []).map((k) => k.toBase58()));
    const missing = wanted.filter((k) => !have.has(k.toBase58()));
    if (t && !missing.length) { log(`launch lookup table ${existing}: ${have.size} accounts, complete`); return existing; }
    if (t && t.state.authority?.equals(keeper.publicKey)) {
      const b = await sol.v0(keeper.publicKey, [...sol.budget(50_000), AddressLookupTableProgram.extendLookupTable({ lookupTable: new PublicKey(existing), authority: keeper.publicKey, payer: keeper.publicKey, addresses: missing })], [keeper]);
      const r = await sol.send(b, { skipPreflight: false });
      if (r.result !== 'ok') throw new Error(`extend ${r.result}`);
      log(`extended ${existing} with ${missing.length} accounts`);
      return existing;
    }
    log(`recorded table ${existing} is unusable; making a new one`);
  }
  const slot = await sol.conn.getSlot('finalized');
  const [createIx, address] = AddressLookupTableProgram.createLookupTable({ authority: keeper.publicKey, payer: keeper.publicKey, recentSlot: slot });
  const extendIx = AddressLookupTableProgram.extendLookupTable({ lookupTable: address, authority: keeper.publicKey, payer: keeper.publicKey, addresses: wanted });
  const b = await sol.v0(keeper.publicKey, [...sol.budget(80_000), createIx, extendIx], [keeper]);
  const r = await sol.send(b, { skipPreflight: false });
  if (r.result !== 'ok') throw new Error(`create ${r.result} ${JSON.stringify(r.err)} (${r.sig})`);
  // A table is usable from the slot AFTER the one it was extended in.
  const started = await sol.conn.getSlot();
  while ((await sol.conn.getSlot()) <= started + 1) await sol.sleep(400);
  setKv('launchLut', address.toBase58());
  log(`launch lookup table ${address.toBase58()}: ${wanted.length} accounts (tx ${r.sig})`);
  return address.toBase58();
}

if (process.argv[1] && process.argv[1].endsWith('make-lut.mjs')) {
  ensureLaunchLut().then(() => process.exit(0), (e) => { console.error('⛔', e.message); process.exit(1); });
}
