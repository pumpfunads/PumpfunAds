/**
 * The pools of keypairs whose address ends in `ads` (VANITY_SUFFIX), operator 10 Oct 2026: every Ads CA AND every
 * coin's creator wallet ends in `ads`. Two pools in one table, by role:
 *   mint     a coin's mint key (pump.fun's create_v2 needs the mint to sign)
 *   creator  a coin's creator wallet (its pump.fun creator: every creator fee is paid to it; Ads holds the key)
 * A 3-character suffix takes ~195k tries (58^3): ~20 s per key on one core in node (crypto ed25519, measured on the Mac
 * 10 Oct 2026). VANITY_WORKERS threads (default 2) keep each pool at VANITY_TARGET, only while one is short.
 * Secrets are stored encrypted under ADS_MASTER_KEY, like the creator wallets.
 *
 * ⛔⛔ A MINT key is ISSUED ONCE. Once a mint address has left this server (in a launch transaction the launcher may never
 * sign), anyone who saw it can pre-create the coin's accounts and make pump.fun's create fail for that address forever.
 * An issued key is never handed to anyone else, whether or not the launch landed. A retry by the SAME launcher within
 * RESERVATION_MS gets the same key back, so retries cannot drain the pool.
 */
import { Keypair } from '@solana/web3.js';
import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { env, num } from './env.mjs';
import { db, DB_PATH, now } from './db.mjs';
import { encrypt, decrypt } from './keys.mjs';

export const SUFFIX = env('VANITY_SUFFIX', 'ads');
export const INCOMING = env('VANITY_INCOMING', path.join(path.dirname(DB_PATH), 'vanity-incoming'));
export const RESERVATION_MS = 15 * 60_000;
/** Every Ads address ends in VANITY_SUFFIX. An empty pool refuses the launch; VANITY_REQUIRED=0 lets a dev machine launch with plain addresses. */
export const REQUIRED = env('VANITY_REQUIRED', '1') !== '0';
const TARGET = num('VANITY_TARGET', 12);
export const ROLES = ['mint', 'creator'];

db.exec(`CREATE TABLE IF NOT EXISTS vanity (
  pubkey TEXT PRIMARY KEY,
  secret_enc TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'mint',     -- mint | creator
  state TEXT NOT NULL DEFAULT 'fresh',   -- fresh | issued | launched
  launcher TEXT,
  issued_at INTEGER,
  created_at INTEGER NOT NULL
)`);

export function addKey(kp, role = 'mint') {
  const pk = kp.publicKey.toBase58();
  if (!pk.endsWith(SUFFIX)) throw new Error(`not a ${SUFFIX} key`);
  if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
  db.prepare('INSERT OR IGNORE INTO vanity (pubkey, secret_enc, role, created_at) VALUES (?, ?, ?, ?)').run(pk, encrypt(Buffer.from(kp.secretKey)), role, now());
}
const kpOf = (row) => Keypair.fromSecretKey(Uint8Array.from(decrypt(row.secret_enc)));

/** A fresh MINT key for `launcher`, marked issued in the same statement. The launcher's own recent key comes back first. */
export function issueKey(launcher) {
  const mine = db.prepare("SELECT secret_enc FROM vanity WHERE role = 'mint' AND state = 'issued' AND launcher = ? AND issued_at > ? ORDER BY issued_at DESC LIMIT 1").get(launcher, now() - RESERVATION_MS);
  if (mine) return kpOf(mine);
  const row = db.prepare(`UPDATE vanity SET state = 'issued', issued_at = ?, launcher = ?
    WHERE pubkey = (SELECT pubkey FROM vanity WHERE role = 'mint' AND state = 'fresh' ORDER BY created_at LIMIT 1) RETURNING secret_enc`).get(now(), launcher);
  return row ? kpOf(row) : null;
}
/** A fresh CREATOR wallet key, taken out of the pool for good (api/keys.mjs stores it as the coin's creator wallet). */
export function takeCreatorKey() {
  const row = db.prepare(`UPDATE vanity SET state = 'launched', issued_at = ?
    WHERE pubkey = (SELECT pubkey FROM vanity WHERE role = 'creator' AND state = 'fresh' ORDER BY created_at LIMIT 1) RETURNING secret_enc`).get(now());
  return row ? kpOf(row) : null;
}
export const markLaunched = (pubkey) => db.prepare("UPDATE vanity SET state = 'launched' WHERE pubkey = ?").run(pubkey);
export const freshCount = (role = 'mint') => db.prepare("SELECT count(*) AS n FROM vanity WHERE role = ? AND state = 'fresh'").get(role).n;
export const hasReservation = (launcher) => Boolean(db.prepare("SELECT 1 FROM vanity WHERE role = 'mint' AND state = 'issued' AND launcher = ? AND issued_at > ?").get(launcher, now() - RESERVATION_MS));
/** True when a launch can get its two addresses right now (a creator key, and stock or this launcher's reserved mint). */
export const available = (launcher = null) => freshCount('creator') > 0 && (freshCount('mint') > 0 || (launcher ? hasReservation(launcher) : false));
export const ready = () => Math.min(freshCount('mint'), freshCount('creator'));

/** Imports keypair files dropped into INCOMING (`<address>.json`, or `creator-<address>.json`), then deletes them. */
export function importIncoming() {
  if (!existsSync(INCOMING)) return 0;
  let n = 0;
  for (const f of readdirSync(INCOMING)) {
    if (!f.endsWith(`${SUFFIX}.json`)) continue;
    const role = f.startsWith('creator-') ? 'creator' : 'mint';
    const p = path.join(INCOMING, f);
    try {
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
      if (`${role === 'creator' ? 'creator-' : ''}${kp.publicKey.toBase58()}.json` !== f) throw new Error('name does not match the key');
      addKey(kp, role);
    } catch {
      continue; // still being written, or not a key: left for the next pass (a bad file never imports)
    }
    rmSync(p);
    n++;
  }
  return n;
}

/* ───────────── the grinder (a worker thread) ───────────── */

const GRINDER = new URL('./vanity-worker.mjs', import.meta.url);

const WORKERS = Math.max(1, num('VANITY_WORKERS', 2));
const shortest = () => ROLES.map((r) => ({ r, n: freshCount(r) })).filter((x) => x.n < TARGET).sort((a, b) => a.n - b.n)[0]?.r || null;
const workers = [];
/** Keeps up to WORKERS grinder threads busy while a pool is short; each key goes to whichever pool is shortest NOW. */
function grind(log) {
  while (workers.length < WORKERS && shortest()) {
    const w = { busy: false, thread: new Worker(GRINDER, { workerData: { suffix: SUFFIX }, execArgv: [] }) };
    w.thread.unref();
    w.thread.on('error', (e) => { log.error(`[vanity] grinder failed: ${e.message}`); workers.splice(workers.indexOf(w), 1); });
    w.thread.on('message', (secret) => {
      w.busy = false;
      const role = shortest();
      try {
        if (role) addKey(Keypair.fromSecretKey(Uint8Array.from(secret)), role);
      } catch (e) {
        log.error(`[vanity] bad key from the grinder: ${e.message}`);
      }
      setImmediate(() => grind(log));
    });
    workers.push(w);
  }
  for (const w of workers) if (!w.busy && shortest()) { w.busy = true; w.thread.postMessage('go'); }
}

export function start(log = console) {
  mkdirSync(INCOMING, { recursive: true, mode: 0o700 });
  const tick = () => {
    const n = importIncoming();
    if (n) log.log(`[vanity] +${n} ${SUFFIX} key${n === 1 ? '' : 's'} imported`);
    if (env('VANITY_GRIND', '1') !== '0') grind(log);
  };
  tick();
  log.log(`[vanity] ${freshCount('mint')} mint + ${freshCount('creator')} creator ${SUFFIX} keys ready (target ${TARGET} each)`);
  setInterval(tick, 60_000).unref();
}
