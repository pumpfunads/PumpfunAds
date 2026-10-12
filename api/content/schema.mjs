/**
 * The content engine's own tables (created on import). Money never lives here: every dollar is in `ledger` (api/ledger.mjs),
 * referenced as `job:<id>`. A job is one ladder step for one coin (seq counts repeats: video 1, 2, 3...).
 *   jobs      queued -> generating -> review -> approved -> posted, or rejected / failed (both refunded)
 *   assets    files on disk under data/media/<mint>/ (mock = 1 for placeholders, never shown as real media)
 *   posts     one per job per platform. Our TikTok is never posted by API: status 'download' = the admin queue.
 *   socials   a coin's linked X / TikTok (launcher's own accounts, after graduation); tokens encrypted (keys.mjs)
 *   decisions every planner decision worth reading later (queued, skipped by a cap, refunded, failed)
 */
import { db } from '../db.mjs';

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  step TEXT NOT NULL,              -- ladder key: launch_card | meme_pack | video | trailer | site
  seq INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,            -- queued | generating | review | approved | posted | rejected | failed
  paid_by TEXT NOT NULL DEFAULT 'budget', -- budget | platform
  cost_estimate_micros INTEGER NOT NULL DEFAULT 0,
  cost_actual_micros INTEGER,      -- what the providers charged (completed requests only)
  refunded_micros INTEGER NOT NULL DEFAULT 0,
  ledger_ref TEXT,
  brief_json TEXT,                 -- the LLM's shots + captions
  result_json TEXT,                -- step output that is not a file (site copy)
  moderation_json TEXT,
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  posted_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_mint ON jobs(mint, step, seq);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  mint TEXT NOT NULL,
  idx INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,              -- image | video
  path TEXT NOT NULL,              -- file name inside data/media/<mint>/
  thumb TEXT,                      -- file name inside data/media/<mint>/ (a video's first frame)
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration REAL,
  caption TEXT,
  mock INTEGER NOT NULL DEFAULT 0,
  provider_ref TEXT,               -- Higgsfield request id
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_job ON assets(job_id);
CREATE INDEX IF NOT EXISTS assets_mint ON assets(mint, id);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  asset_id INTEGER,                -- the first asset (a content pack posts its 4 images as one X post)
  mint TEXT NOT NULL,
  platform TEXT NOT NULL,          -- x | tiktok | creator_x | creator_tiktok
  status TEXT NOT NULL,            -- queued | posted | failed | download
  text TEXT,
  external_id TEXT,
  url TEXT,
  error TEXT,
  mock INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  posted_at INTEGER,
  UNIQUE (job_id, platform)
);
CREATE INDEX IF NOT EXISTS posts_status ON posts(platform, status, posted_at);
CREATE TABLE IF NOT EXISTS socials (
  mint TEXT NOT NULL,
  platform TEXT NOT NULL,          -- x | tiktok
  handle TEXT,
  user_id TEXT,
  tokens_enc TEXT NOT NULL,        -- keys.mjs encrypt(JSON { access_token, refresh_token, expires_at })
  scopes TEXT,
  wallet TEXT,                     -- the launcher that linked it
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (mint, platform)
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  platform TEXT NOT NULL,
  verifier TEXT,
  wallet TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS content_policy (
  mint TEXT PRIMARY KEY,
  daily_cap_micros INTEGER,        -- NULL = COIN_DAILY_USD_CAP
  max_job_micros INTEGER,          -- NULL = MAX_JOB_USD
  paused INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT,
  job_id INTEGER,
  action TEXT NOT NULL,            -- queue | skip | spend | refund | fail | reject | approve | post | cap
  reason TEXT,
  created_at INTEGER NOT NULL
);
-- launch-form logos (no coin yet, paid by Ads): 3 per wallet per UTC day, cost counted in the global daily cap
CREATE TABLE IF NOT EXISTS logo_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  mock INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS logo_requests_wallet ON logo_requests(wallet, created_at);
CREATE INDEX IF NOT EXISTS decisions_mint ON decisions(mint, id);
`);

export { db };
