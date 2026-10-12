/**
 * A coin's linked creator accounts (X, TikTok), after graduation, by the launcher only. Tokens are stored encrypted
 * under ADS_MASTER_KEY (keys.mjs) and refreshed on use. The OAuth `state` is random, single use, 15 minutes, and bound
 * to the wallet that started it: a callback is accepted only from the same signed-in wallet.
 */
import crypto from 'node:crypto';
import { one, run, now } from '../db.mjs';
import { encrypt, decrypt } from '../keys.mjs';
import { ApiError } from '../errors.mjs';
import * as x from './x.mjs';
import * as tiktok from './tiktok.mjs';
import './schema.mjs';

export const PLATFORMS = ['x', 'tiktok'];
const STATE_TTL = 15 * 60_000;
const adapters = { x, tiktok };

const seal = (obj) => encrypt(Buffer.from(JSON.stringify(obj)));
const unseal = (s) => JSON.parse(decrypt(s).toString('utf8'));

/** Public view: { x:{handle}|null, tiktok:{handle}|null }. */
export function view(mint) {
  const out = { x: null, tiktok: null };
  for (const p of PLATFORMS) {
    const r = one('SELECT handle, linked_at FROM socials WHERE mint = ? AND platform = ?', mint, p);
    if (r) out[p] = { handle: r.handle, linkedAt: r.linked_at };
  }
  return out;
}

/** Starts a link: stores the state and returns the provider URL to redirect to. */
export function begin(mint, platform, wallet) {
  if (!adapters[platform]) throw new ApiError('Unknown platform', 404);
  run('DELETE FROM oauth_states WHERE created_at < ?', now() - STATE_TTL);
  const state = crypto.randomBytes(24).toString('base64url');
  const { verifier, challenge } = platform === 'x' ? x.pkce() : { verifier: null, challenge: null };
  run('INSERT INTO oauth_states (state, mint, platform, verifier, wallet, created_at) VALUES (?, ?, ?, ?, ?, ?)', state, mint, platform, verifier, wallet, now());
  return platform === 'x' ? x.authorizeUrl(state, challenge) : tiktok.authorizeUrl(state);
}

/** Validates and consumes a state (single use). Returns the row or throws. */
export function consume(state, platform, wallet) {
  const row = one('SELECT * FROM oauth_states WHERE state = ?', String(state || ''));
  if (!row || row.platform !== platform) throw new ApiError('This link request is not valid. Start again from your coin page.', 400);
  run('DELETE FROM oauth_states WHERE state = ?', row.state);
  if (now() - row.created_at > STATE_TTL) throw new ApiError('This link request expired. Start again from your coin page.', 400);
  if (!wallet || wallet !== row.wallet) throw new ApiError('Sign in with the wallet that launched this coin, then start again.', 403);
  return row;
}

/** Finishes a link: exchanges the code and stores the account. */
export async function complete(row, code) {
  const r = await adapters[row.platform].exchange(String(code || ''), row.verifier);
  run(`INSERT INTO socials (mint, platform, handle, user_id, tokens_enc, scopes, wallet, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mint, platform) DO UPDATE SET handle = excluded.handle, user_id = excluded.user_id, tokens_enc = excluded.tokens_enc, scopes = excluded.scopes, wallet = excluded.wallet, linked_at = excluded.linked_at`,
  row.mint, row.platform, r.handle, r.userId, seal(r.tokens), r.scopes || null, row.wallet, now());
  return { mint: row.mint, platform: row.platform, handle: r.handle };
}

export const unlink = (mint, platform) => run('DELETE FROM socials WHERE mint = ? AND platform = ?', mint, platform).changes > 0;

/** A usable token set for posting (refreshed and re-stored when needed), or null when not linked. */
export async function tokensFor(mint, platform) {
  const r = one('SELECT tokens_enc, handle FROM socials WHERE mint = ? AND platform = ?', mint, platform);
  if (!r) return null;
  const { tokens, changed } = await adapters[platform].fresh(unseal(r.tokens_enc));
  if (changed) run('UPDATE socials SET tokens_enc = ? WHERE mint = ? AND platform = ?', seal(tokens), mint, platform);
  return { tokens, handle: r.handle };
}
