// One SQLite file (node:sqlite, no native build). Every write is a single statement unless marked. Ads (pumpfunads.com).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, env } from './env.mjs';

export const DB_PATH = env('DB_PATH', path.join(ROOT, 'data', 'ads.db'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  issued_at TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- One launch = one coin = one creator wallet (its pump.fun creator; Ads holds the key). Paired with $ADS: creator fees
-- arrive in $ADS, 20% is burned and 80% funds the coin's ads.
CREATE TABLE IF NOT EXISTS launches (
  mint TEXT PRIMARY KEY,
  launcher TEXT NOT NULL,          -- the pump.fun creator (signed the launch)
  fee_wallet TEXT NOT NULL UNIQUE, -- the coin's pump.fun creator: every creator fee is paid to it; Ads holds its key
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  description TEXT,
  image TEXT,                      -- our own copy: /api/logos/<hash>.<ext>
  metadata_uri TEXT NOT NULL,
  socials_json TEXT NOT NULL DEFAULT '{}',
  quote_mint TEXT NOT NULL,        -- Q, the pair
  quote_json TEXT NOT NULL,        -- the resolved quote at launch: kind, token program, decimals, curve/pool accounts
  quote_symbol TEXT,
  creator_fee_bps INTEGER NOT NULL,-- 0 = pump.fun's standard schedule
  dev_buy_currency TEXT,           -- sol | quote | NULL (none)
  dev_buy_amount TEXT NOT NULL DEFAULT '0', -- lamports or Q units
  status TEXT NOT NULL,            -- prepared | created | live | failed | rejected
  sig TEXT,
  buy_sig TEXT,
  tx_hash TEXT,                    -- sha256 of the prepared launch message: submit relays only that transaction
  buy_tx_hash TEXT,                -- same for the first buy
  error TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  live_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS launches_launcher ON launches(launcher);
CREATE INDEX IF NOT EXISTS launches_status ON launches(status, live_at);
CREATE INDEX IF NOT EXISTS launches_quote ON launches(quote_mint, status);
-- The creator wallet keys, encrypted under ADS_MASTER_KEY.
CREATE TABLE IF NOT EXISTS fee_wallets (
  pubkey TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'fee',
  created_at INTEGER NOT NULL,
  UNIQUE (mint, role)
);
-- One keeper pass of one coin: everything collected into its creator wallet, 20% burned, 80% sent to the treasury.
-- Units are $ADS base units. sale_id is set once the treasury sold this coin's share (then it is in the ledger).
CREATE TABLE IF NOT EXISTS fees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  collected TEXT NOT NULL,
  burned TEXT NOT NULL,
  to_treasury TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  sig TEXT,
  lvbh INTEGER,
  status TEXT NOT NULL,            -- ok | pending | failed | dry
  sale_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fees_mint ON fees(mint, created_at);
CREATE INDEX IF NOT EXISTS fees_unsold ON fees(status, sale_id);
-- The daily treasury sale: all its $ADS -> SOL. usd_micros = lamports_out x SOL/USD at the sale.
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ads_in TEXT NOT NULL,
  lamports_out TEXT,
  sol_usd REAL,
  usd_micros INTEGER,
  sig TEXT,
  lvbh INTEGER,
  status TEXT NOT NULL,            -- ok | pending | failed | dry
  error TEXT,
  created_at INTEGER NOT NULL
);
-- A coin's budget, in millionths of a dollar. Balance = credit + refund - spend; 'platform' is paid by Ads (shown, never deducted).
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  kind TEXT NOT NULL,              -- credit | spend | refund | platform
  usd_micros INTEGER NOT NULL,
  ref TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_mint ON ledger(mint, created_at);
-- SOL leaving the treasury: the automatic sweep after each sale, or a manual withdraw (scripts/ads.mjs).
CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lamports TEXT NOT NULL,
  to_address TEXT NOT NULL,
  kind TEXT NOT NULL,              -- sweep | withdraw
  sig TEXT,
  lvbh INTEGER,
  status TEXT NOT NULL,            -- ok | pending | failed
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

// Columns added after the first deploy. An 'external' launch is the site's own token, launched on another platform and
// listed here (official 1): never part of the keeper's burns. status 'preview' = visible only to the preview cookie.
const addColumn = (table, col, type) => { if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); };
addColumn('launches', 'origin', "TEXT NOT NULL DEFAULT 'ads'");
addColumn('launches', 'official', 'INTEGER NOT NULL DEFAULT 0');
addColumn('launches', 'brief_json', "TEXT NOT NULL DEFAULT '{}'");
// A daily sale may sell only part of what is waiting (price impact cap): each fee row tracks how much of it is sold.
addColumn('fees', 'sold', "TEXT NOT NULL DEFAULT '0'");

export const now = () => Date.now();
export const one = (sql, ...params) => db.prepare(sql).get(...params);
export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);
/** Runs fn inside one transaction (all or nothing). */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getKv(k, fallback = null) {
  const row = one('SELECT v FROM kv WHERE k = ?', k);
  if (!row) return fallback;
  try {
    return JSON.parse(row.v);
  } catch {
    return fallback;
  }
}
export function setKv(k, v) {
  run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));
}

export const HOUR = 3_600_000;

setInterval(() => {
  run('DELETE FROM nonces WHERE created_at < ?', now() - 60 * 60_000);
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  // A launch prepared but never sent keeps its fee wallet; it is simply never shown.
  run("UPDATE launches SET status = 'failed', updated_at = ? WHERE status = 'prepared' AND created_at < ?", now(), now() - 30 * 60_000);
}, 60_000).unref();
