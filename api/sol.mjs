/**
 * The RPC connection and the plumbing every chain call shares: paced retries, prices, transaction
 * building, simulation and a send that never resends an unknown outcome.
 * ⛔ Base58 is case-sensitive: addresses are compared exactly, never lowercased.
 * ⛔ An RPC limit is a BURST limit: reads here are sequential where they can be, and every heavy read is
 *    cached and shared (one in flight at a time, stale-on-error).
 */
import fs from 'node:fs';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { env, num } from './env.mjs';
import { now } from './db.mjs';
import { ApiError } from './errors.mjs';

export { ApiError };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ⛔ An RPC rate limit is a BURST limit (pump.family's Helius key 429'd at an average of 4/s with 20 in flight).
   Every call goes through one pacer: at most RPC_CONCURRENCY in flight and RPC_MIN_GAP_MS between starts, so a
   busy page or a big keeper pass is spread out instead of spiking. Calls are counted per method for /api/health. */
const MAX_IN_FLIGHT = num('RPC_CONCURRENCY', 4);
const MIN_GAP_MS = num('RPC_MIN_GAP_MS', 40);
let inFlight = 0, lastStart = 0;
const waiters = [];
async function slot() {
  while (inFlight >= MAX_IN_FLIGHT) await new Promise((r) => waiters.push(r));
  inFlight++;
  const wait = lastStart + MIN_GAP_MS - Date.now();
  lastStart = Math.max(Date.now(), lastStart + MIN_GAP_MS);
  if (wait > 0) await sleep(wait);
}
function release() { inFlight--; waiters.shift()?.(); }

const counts = new Map(); // method → calls, in hour buckets
let hourStart = Date.now(), lastHour = null;
function count(body) {
  if (Date.now() - hourStart > 3_600_000) { lastHour = Object.fromEntries(counts); counts.clear(); hourStart = Date.now(); }
  let methods = [];
  try {
    const j = JSON.parse(typeof body === 'string' ? body : '');
    methods = (Array.isArray(j) ? j : [j]).map((x) => x.method);
  } catch {}
  for (const m of methods.length ? methods : ['?']) counts.set(m, (counts.get(m) || 0) + 1);
}
/** RPC calls this hour (and the last full hour), by method. */
export const rpcUsage = () => {
  const now_ = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
  return { sinceMinutes: Math.round((Date.now() - hourStart) / 60_000), total: [...counts.values()].reduce((a, b) => a + b, 0), byMethod: now_, lastHourTotal: lastHour ? Object.values(lastHour).reduce((a, b) => a + b, 0) : null };
};

async function retryFetch(url, init) {
  for (let i = 0; ; i++) {
    await slot();
    count(init?.body);
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
      if ((r.status === 429 || r.status >= 500) && i < 4) {
        release();
        await sleep(800 * 2 ** i); // back off harder on 429: retrying fast is what turns a spike into a storm
        continue;
      }
      release();
      return r;
    } catch (e) {
      release();
      if (i >= 4) throw e;
      await sleep(800 * 2 ** i);
    }
  }
}

export const RPC_URL = env('SOLANA_RPC', 'https://api.mainnet-beta.solana.com');
export const conn = new Connection(RPC_URL, { commitment: 'confirmed', fetch: retryFetch });
export const EXPLORER = 'https://solscan.io';
export const PRIORITY = num('PRIORITY_MICROLAMPORTS', 100_000);
/* A tiny transaction priced per CU pays almost nothing and is dropped under load (agents, 29 Sep 2026):
   every transaction pays at least MIN_PRIORITY_LAMPORTS in total. */
const MIN_PRIORITY_LAMPORTS = num('MIN_PRIORITY_LAMPORTS', 10_000);
/** What a transaction built with budget(units) costs in lamports: 5,000 per signature plus its priority fee. */
export const feeFor = (units, signatures = 1) => BigInt(5_000 * signatures) + BigInt(Math.max(MIN_PRIORITY_LAMPORTS, Math.ceil((units * PRIORITY) / 1e6)));
export const budget = (units) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(PRIORITY, Math.ceil((MIN_PRIORITY_LAMPORTS * 1e6) / units)) }),
];

export function isAddress(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    const pk = new PublicKey(s);
    return pk.toBase58() === s && PublicKey.isOnCurve(pk.toBytes());
  } catch {
    return false;
  }
}
/** Any valid key, on or off curve (a mint, a PDA). */
export function isKey(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}
export const requireMint = (s) => {
  if (!isKey(s)) throw new ApiError('That is not a Solana token address', 400);
  return new PublicKey(s);
};

/** The keeper's keypair (pays pump.fun distributions): KEEPER_SECRET_KEY (JSON bytes) or KEEPER_KEY_FILE. */
export function loadKeeper() {
  const raw = env('KEEPER_SECRET_KEY', '') || (env('KEEPER_KEY_FILE', '') && fs.existsSync(env('KEEPER_KEY_FILE')) ? fs.readFileSync(env('KEEPER_KEY_FILE'), 'utf8') : '');
  if (!raw) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/** The treasury's keypair (receives 80% of every coin's $ADS fees, sells them daily for SOL that pays for the ads):
 *  TREASURY_SECRET_KEY (JSON bytes) or TREASURY_KEY_FILE. Its address alone: TREASURY_ADDRESS (a box without the key). */
export function loadTreasury() {
  const raw = env('TREASURY_SECRET_KEY', '') || (env('TREASURY_KEY_FILE', '') && fs.existsSync(env('TREASURY_KEY_FILE')) ? fs.readFileSync(env('TREASURY_KEY_FILE'), 'utf8') : '');
  if (!raw) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}
export const treasuryAddress = () => { const t = loadTreasury(); return t ? t.publicKey : (isAddress(env('TREASURY_ADDRESS', '')) ? new PublicKey(env('TREASURY_ADDRESS')) : null); };

/* ───────────── shared reads ───────────── */

/**
 * ONE read in flight at a time, a result cached `ttl` ms, and a failure serving the last good answer
 * (retrying 10 s later). Launch traffic on a cold cache once stampeded an RPC into 429s.
 */
export function shared(read, ttl) {
  let cache = { at: 0, v: undefined }, inflight = null, failedAt = 0;
  const get = async ({ fresh = false } = {}) => {
    const t = now();
    if (!fresh && cache.v !== undefined && t - cache.at < ttl) return cache.v;
    if (cache.v !== undefined && t - failedAt < 10_000) return cache.v;
    if (!inflight) inflight = read().then((v) => { cache = { at: now(), v }; return v; }, (e) => { failedAt = now(); throw e; }).finally(() => { inflight = null; });
    try {
      return await inflight;
    } catch (e) {
      if (cache.v !== undefined) return cache.v;
      throw e;
    }
  };
  get.forget = () => { cache = { at: 0, v: undefined }; };
  return get;
}

/** Per-key shared reads (one cache per mint), bounded. */
export function sharedMap(read, ttl, max = 2000) {
  const m = new Map();
  return (key, opts) => {
    let g = m.get(key);
    if (!g) {
      if (m.size >= max) m.delete(m.keys().next().value);
      g = shared(() => read(key), ttl);
      m.set(key, g);
    }
    return g(opts);
  };
}

/* ───────────── prices ───────────── */

let solCache = { usd: 0, at: 0 };
/** SOL in USD from two sources; the last good price is kept through an outage. Null if never known. */
export async function solUsd() {
  if (now() - solCache.at < 60_000 && solCache.usd) return solCache.usd;
  const id = 'So11111111111111111111111111111111111111112';
  const sources = [
    async () => (await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${id}`, { signal: AbortSignal.timeout(5000) })).json())[id]?.usdPrice,
    async () => (await (await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { signal: AbortSignal.timeout(5000) })).json()).data?.amount,
  ];
  for (const s of sources) {
    try {
      const v = Number(await s());
      if (v > 0) {
        solCache = { usd: v, at: now() };
        return v;
      }
    } catch {}
  }
  return solCache.usd || null;
}

export const lamports = async (addr) => BigInt(await conn.getBalance(new PublicKey(addr), 'confirmed'));

/* ───────────── transactions ───────────── */

export async function v0(payer, ixs, signers = []) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  if (signers.length) tx.sign(signers);
  return { tx, blockhash, lastValidBlockHeight };
}
export const b64 = (tx) => Buffer.from(tx.serialize()).toString('base64');
export function parseTx(s, label = 'transaction') {
  try {
    return VersionedTransaction.deserialize(Buffer.from(String(s), 'base64'));
  } catch {
    throw new ApiError(`${label}: unreadable transaction`, 400);
  }
}

/** Throws with the program's own last log lines when the simulation fails. */
export async function simulate(tx) {
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    const tail = (sim.value.logs || []).filter((l) => /error|failed|insufficient|custom program/i.test(l)).slice(-2).join(' / ');
    throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}${tail ? ` (${tail.slice(0, 220)})` : ''}`);
  }
  return sim.value;
}

/**
 * Sends a signed transaction and waits for `confirmed`. Returns { result: 'ok' | 'failed' | 'expired' |
 * 'pending', sig }. ⛔ 'pending' means the outcome is UNKNOWN: the caller must settle it later and never
 * resend (a resend could pay twice).
 */
/** A signed transaction's id, known BEFORE it is sent: record it first, so a restart mid-send can still settle it. */
export const sigOf = (tx) => bs58.encode(tx.signatures[0]);

export async function send(built, { skipPreflight = true } = {}) {
  let sig;
  try {
    sig = await conn.sendTransaction(built.tx, { maxRetries: 3, skipPreflight });
  } catch (e) {
    // The RPC may have taken it before the error (a timeout after receipt): never "failed", which would pay again.
    if (skipPreflight) return { result: 'pending', sig: bs58.encode(built.tx.signatures[0]) };
    return { result: 'failed', sig: bs58.encode(built.tx.signatures[0]), err: { preflight: String(e.message).slice(0, 200) } };
  }
  // ⛔ An RPC can accept a transaction and drop it (the launch table expired twice on 10 Oct 2026 while its simulation
  // passed): the SAME signed bytes are re-broadcast every 2 s until it confirms or its blockhash provably expires.
  // Re-sending identical bytes can never pay twice (one signature, one transaction).
  const raw = built.tx.serialize();
  for (;;) {
    let st = null;
    try {
      st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: false })).value[0];
    } catch {}
    if (st?.err) return { result: 'failed', sig, err: st.err };
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return { result: 'ok', sig, err: null };
    let height = null;
    try {
      height = await conn.getBlockHeight('confirmed');
    } catch {}
    if (height != null && built.lastValidBlockHeight != null && height > built.lastValidBlockHeight) {
      try {
        st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      } catch {
        return { result: 'pending', sig };
      }
      if (st && !st.err) return { result: 'ok', sig };
      if (st?.err) return { result: 'failed', sig, err: st.err };
      return { result: 'expired', sig };
    }
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await sleep(2000);
  }
}

/** The status of a parked signature: 'ok' | 'failed' | null (never seen). */
export async function txStatus(sig) {
  const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
  if (!st) return null;
  return st.err ? 'failed' : 'ok';
}

/** Relays a browser-signed transaction and waits for it, re-broadcasting while it waits. */
export async function sendSigned(tx, label) {
  const sig = bs58.encode(tx.signatures[0]);
  const raw = tx.serialize();
  try {
    await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  } catch (e) {
    const logs = (e.logs || e.transactionLogs || []).slice(-4).join(' | ');
    const why = String(e.transactionMessage || e.message || e).replace(/\s+/g, ' ').replace(/^Simulation failed\.\s*/, '').slice(0, 240);
    if (/blockhash not found|block height exceeded/i.test(why)) throw new ApiError(`${label} expired before it was sent. Start again and approve promptly.`, 422, { stage: 'expired' });
    // ⛔ Only a SIMULATION refusal is definite. A timeout or a 5xx may come after the RPC took the transaction: keep
    // re-broadcasting and watching below, never call it refused (the launch row would be marked failed while it lands).
    if (logs || /simulation failed|custom program error|InstructionError|insufficient|already in use|signature verification|invalid transaction|too large/i.test(String(e.transactionMessage || e.message || e))) {
      throw new ApiError(`${label} was refused: ${why}${logs ? ` (${logs})` : ''}`, 422, { stage: 'refused' });
    }
  }
  const deadline = now() + 75_000;
  while (now() < deadline) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new ApiError(`${label} failed on chain: ${JSON.stringify(st.err)}`, 502, { stage: 'failed' });
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await sleep(1500);
  }
  throw new ApiError(`${label} did not confirm in time. It may still land.`, 504, { stage: 'unknown' });
}

/** Whether an account exists. An RPC error is thrown, never read as "absent". `waitMs` polls a lagging node. */
export async function exists(addr, waitMs = 0) {
  const pk = new PublicKey(addr);
  const end = now() + waitMs;
  for (;;) {
    let info;
    try {
      info = await conn.getAccountInfo(pk, 'confirmed');
    } catch {
      throw new ApiError('Could not read the chain just now. Nothing was lost: try again in a moment.', 503, { stage: 'unknown' });
    }
    if (info) return true;
    if (now() >= end) return false;
    await sleep(1000);
  }
}
