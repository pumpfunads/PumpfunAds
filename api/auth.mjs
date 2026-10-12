/**
 * Sign-in: the wallet signs a nonce message once; the session cookie is bound to that wallet.
 * The private key never leaves the wallet. Nonces are single use, burned on the first attempt.
 */
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { one, run, now } from './db.mjs';
import { ApiError, isAddress } from './sol.mjs';

const SESSION_TTL_MS = 30 * 24 * 3600_000;
const NONCE_TTL_MS = 10 * 60_000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function messageFor(wallet, nonce, issuedAt) {
  return [
    'pumpfunads.com wants to prove you own this wallet.',
    '',
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued at: ${issuedAt}`,
    '',
    'Signing this does not move funds or grant spend permission.',
  ].join('\n');
}

export function newNonce() {
  const nonce = crypto.randomBytes(18).toString('base64url');
  const issuedAt = new Date().toISOString();
  run('INSERT INTO nonces (nonce, issued_at, created_at) VALUES (?, ?, ?)', nonce, issuedAt, now());
  return { nonce, issuedAt, template: messageFor('YOUR_WALLET', nonce, issuedAt) };
}

function decodeSignature(s) {
  const str = String(s || '');
  try {
    const b = bs58.decode(str);
    if (b.length === 64) return b;
  } catch {}
  const b = Buffer.from(str, 'base64');
  if (b.length === 64) return new Uint8Array(b);
  throw new Error('bad signature');
}

/** Verifies the signature locally (no RPC) and opens a session. Returns { sid, wallet, maxAge }. */
export function signIn({ wallet, nonce, signature }) {
  if (!isAddress(wallet || '')) throw new ApiError('A Solana wallet address is required.', 400);
  const n = one('SELECT * FROM nonces WHERE nonce = ?', String(nonce || ''));
  if (!n || n.used_at || now() - n.created_at > NONCE_TTL_MS) throw new ApiError('That sign-in request expired. Try again.', 400);
  run('UPDATE nonces SET used_at = ? WHERE nonce = ?', now(), n.nonce);
  const message = new TextEncoder().encode(messageFor(wallet, n.nonce, n.issued_at));
  let ok = false;
  try {
    ok = ed25519.verify(decodeSignature(signature), message, new PublicKey(wallet).toBytes());
  } catch {}
  if (!ok) throw new ApiError('The signature does not match this wallet.', 401);
  const sid = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO sessions (id_hash, wallet, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(sid), wallet, now(), now() + SESSION_TTL_MS);
  return { sid, wallet, maxAge: SESSION_TTL_MS / 1000 };
}

/** The wallet of a session cookie value, or null. */
export function sessionWallet(sid) {
  if (!sid) return null;
  const s = one('SELECT wallet, expires_at FROM sessions WHERE id_hash = ?', sha256(sid));
  return s && s.expires_at > now() ? s.wallet : null;
}
export function signOut(sid) {
  if (sid) run('DELETE FROM sessions WHERE id_hash = ?', sha256(sid));
}
