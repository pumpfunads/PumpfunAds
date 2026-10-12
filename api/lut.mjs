/**
 * Address lookup tables, so a paired launch fits ONE transaction (and the keeper's fee passes stay small):
 *   - the launch table (kv launchLut): every account the same for every launch, made once by scripts/make-lut.mjs;
 *   - pair tables (kv pairLuts): a Q's own accounts (mint, curve, pool, vaults), appended the first time a launch against
 *     that Q does not fit without them (a Q on PumpSwap: ~1,255 B → ~1,120 B). A table holds 256 addresses; a full one
 *     is followed by a new one. The keeper wallet is the authority and pays the rent (~0.0011 SOL per Q, once).
 * ⛔ Entries are usable only from the slot AFTER they were added: ensureQuote waits until the table shows them.
 * ⛔ Extending costs the keeper SOL, so it is capped per hour (a swarm of prepares against random tokens cannot drain it).
 */
import { AddressLookupTableProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { num } from './env.mjs';
import { getKv, setKv, now } from './db.mjs';
import * as sol from './sol.mjs';
import { ApiError } from './errors.mjs';
import { loadLookupTable, quoteAccounts } from '../lib/pump.mjs';

export const MAX_TX_BYTES = 1232;
const EXTENDS_PER_HOUR = num('PAIR_TABLE_EXTENDS_PER_HOUR', 6);
const TABLE_CAP = 256;

const keeper = sol.loadKeeper();
const tableCache = sol.sharedMap((addr) => loadLookupTable(sol.conn, addr), 300_000, 50);

export const launchLutAddress = () => getKv('launchLut', null);
export const pairLuts = () => getKv('pairLuts', []) || [];

/** Every table Ads owns, loaded (cached 5 minutes): the launch table first. */
export async function allTables({ fresh = false } = {}) {
  const addrs = [launchLutAddress(), ...pairLuts().map((t) => t.address)].filter(Boolean);
  const out = [];
  for (const a of addrs) {
    const t = await tableCache(a, { fresh }).catch(() => null);
    if (t) out.push(t);
  }
  return out;
}
export const launchTable = async () => (launchLutAddress() ? (await allTables())[0] || null : null);

/** The tables a launch against `q` should reference: the launch table, plus the pair table holding q (if any). */
export async function tablesFor(q) {
  const tables = await allTables();
  const pairAddr = pairLuts().find((t) => t.quotes.includes(q.mint))?.address;
  return tables.filter((t, i) => i === 0 || t.key.toBase58() === pairAddr);
}

/** Bytes a transaction would take with these tables (signatures included), or Infinity when it cannot even serialize. */
export function sizeWith(payer, ixs, tables, signatures = 2) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message(tables);
  try {
    return new VersionedTransaction(msg).serialize().length + Math.max(0, signatures - msg.header.numRequiredSignatures) * 64;
  } catch {
    return Infinity;
  }
}

/** A v0 transaction over all of Ads' tables (the keeper's own transactions). */
export async function v0WithTables(payer, ixs, signers = []) {
  const { blockhash, lastValidBlockHeight } = await sol.conn.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(await allTables()));
  if (signers.length) tx.sign(signers);
  return { tx, blockhash, lastValidBlockHeight };
}

async function keeperSend(ixs) {
  const built = await sol.v0(keeper.publicKey, [...sol.budget(60_000), ...ixs], [keeper]);
  const r = await sol.send(built, { skipPreflight: false });
  if (r.result !== 'ok') throw new Error(`lookup table transaction ${r.result}: ${JSON.stringify(r.err || '')}`);
  return r.sig;
}

/** Waits until `table` lists every one of `addrs` and the chain has moved past the slot they were added in. */
async function waitActive(table, addrs) {
  const want = new Set(addrs.map((a) => a.toBase58()));
  for (let i = 0; i < 40; i++) {
    const t = await loadLookupTable(sol.conn, table).catch(() => null);
    if (t && [...want].every((a) => t.state.addresses.some((x) => x.toBase58() === a))) {
      const slot = await sol.conn.getSlot('confirmed');
      if (slot > Number(t.state.lastExtendedSlot)) return t;
    }
    await sol.sleep(500);
  }
  throw new Error('the lookup table did not activate in time');
}

let extending = null;
/**
 * Makes sure q's own accounts are in a pair table, extending one (or making a new one) when needed. Serialized: one
 * extension at a time. Returns the table's address.
 */
export async function ensureQuote(q, staticKeys) {
  const have = pairLuts().find((t) => t.quotes.includes(q.mint));
  if (have) return have.address;
  if (!keeper) throw new ApiError('Launching against this pair is being set up. Try again in a few minutes.', 503);
  while (extending) await extending.catch(() => {});
  const again = pairLuts().find((t) => t.quotes.includes(q.mint));
  if (again) return again.address;
  const hour = Math.floor(now() / 3_600_000), used = getKv('pairLutExtends', { hour, n: 0 });
  if (used.hour === hour && used.n >= EXTENDS_PER_HOUR) throw new ApiError('Many new pairs were set up this hour. Try this pair again in a little while.', 503);
  extending = (async () => {
    const addrs = await quoteAccounts(sol.conn, q, staticKeys);
    const tables = pairLuts();
    let target = tables[tables.length - 1];
    if (!target || target.count + addrs.length > TABLE_CAP) {
      const slot = await sol.conn.getSlot('finalized');
      const [create, address] = AddressLookupTableProgram.createLookupTable({ authority: keeper.publicKey, payer: keeper.publicKey, recentSlot: slot });
      await keeperSend([create]);
      target = { address: address.toBase58(), quotes: [], count: 0 };
      tables.push(target);
      setKv('pairLuts', tables);
    }
    await keeperSend([AddressLookupTableProgram.extendLookupTable({ lookupTable: new PublicKey(target.address), authority: keeper.publicKey, payer: keeper.publicKey, addresses: addrs })]);
    await waitActive(new PublicKey(target.address), addrs);
    target.quotes.push(q.mint);
    target.count += addrs.length;
    setKv('pairLuts', tables);
    setKv('pairLutExtends', { hour, n: (used.hour === hour ? used.n : 0) + 1 });
    tableCache(target.address, { fresh: true }).catch(() => {});
    return target.address;
  })();
  try {
    return await extending;
  } finally {
    extending = null;
  }
}
