/**
 * Launching: a pump.fun coin PAIRED WITH $ADS (pump.fun custom pairs; $ADS is the operator's own pump.fun coin, kv
 * token) whose pump.fun CREATOR is the coin's own creator wallet: an `…ads` key Ads holds (api/vanity.mjs, api/keys.mjs).
 * pump.fun pays every creator fee to it, in $ADS; the keeper collects them, burns 20% and sends 80% to the treasury,
 * which funds the coin's ads. The launcher picks the creator fee rate, describes the coin (the brief its ads are made
 * from) and signs; the first buy's tokens are the launcher's.
 *
 * ONE transaction, like pump.fun's own launch: paired create_v2 (creator = the creator wallet) + the launcher's optional
 * first buy (PumpSwap multi_hop_swap, SOL → $ADS → coin). Nothing can land between the creation and that buy, so it
 * cannot be front-run, and the coin cannot exist for one slot with its fees going anywhere else. Fits 1,232 bytes through
 * the lookup tables (api/lut.mjs). The whole transaction, first buy included, is simulated before anyone signs.
 * Every mint is an `…ads` key from Ads' own pool, so only the prepared transaction can create it.
 */
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createHash, createPublicKey, verify as verifySig } from 'node:crypto';
import { env, num } from './env.mjs';
import { one, all, run, now, getKv } from './db.mjs';
import * as sol from './sol.mjs';
import { ApiError } from './errors.mjs';
import * as images from './images.mjs';
import * as vanity from './vanity.mjs';
import * as lut from './lut.mjs';
import * as quotes from './quotes.mjs';
import { staticAccounts } from '../scripts/make-lut.mjs';
import { storeWallet } from './keys.mjs';
import { launchIxs, quoteFirstBuy, quoteReserves, loadGlobal, resolveQuote, coinCreator } from '../lib/pump.mjs';

/** $ADS, the token every coin pairs with: the live one (kv token, set by scripts/ads.mjs golive), or ADS_MINT on a dev
 *  machine / the local e2e. Null until the operator launches it. */
export const adsMint = () => getKv('token', null)?.mint || env('ADS_MINT', '') || null;

/** ⛔ Launching is closed until the operator opens it (scripts/ads.mjs golive / open). */
export const launchOpen = () => Boolean(getKv('launchOpen', false));

export const NAME_MAX = 32;
export const DESCRIPTION_MAX = 500;
export const VIBES = ['Meme', 'Cinematic', 'Anime', 'Mascot', 'Cartoon', 'Realistic', 'Tech', 'Viral', 'Retro', 'Lo-fi', 'Chaotic'];
export const PLATFORMS = ['x', 'tiktok'];
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_DEV_BUY_SOL = num('MAX_DEV_BUY_SOL', 10);
/** Fixed slippage floor for the first buy: the opening price is known exactly; only the pair's own price can move
 *  in the second before the launch lands. */
export const DEV_BUY_SLIPPAGE_PCT = num('DEV_BUY_SLIPPAGE_PCT', 15);
/** The creator fee rates the form offers (bps); 0 = pump.fun's standard schedule. Capped by Global on chain too. */
export const FEE_RATES = [0, 30, 100, 200, 300];
export const LAUNCHES_PER_WALLET_DAY = num('LAUNCHES_PER_WALLET_DAY', 10);
const PREPARES_PER_HOUR = num('PREPARES_PER_HOUR', 12);
const PRIORITY = num('LAUNCH_PRIORITY_MICROLAMPORTS', 200_000);

const budget = (units) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY })];

/* ───────────── validation ───────────── */

export const cleanUrl = (u, hosts = null) => {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new ApiError(`Not a link: ${s.slice(0, 60)}`);
  }
  if (url.protocol !== 'https:') throw new ApiError('Links must start with https://');
  if (hosts && !hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) throw new ApiError(`That link must be on ${hosts.join(' or ')}`);
  return url.toString().slice(0, 200);
};

/** A decimal amount ("1.5") in units of `decimals`, exactly (no float). */
export function toUnits(s, decimals) {
  // "0.5", ".5" and "5." are all numbers a person types.
  const m = String(s ?? '').trim().match(/^(\d{0,12})(?:\.(\d*))?$/);
  if (!m || !(m[1] || m[2])) return null;
  const frac = (m[2] || '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

export function validate(body) {
  const name = String(body.name || '').trim();
  const symbol = String(body.symbol || '').trim().toUpperCase();
  if (!name || name.length > NAME_MAX) throw new ApiError(`A name of 1 to ${NAME_MAX} characters is required`);
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new ApiError('The ticker is 1 to 10 letters or numbers, no spaces');
  const description = String(body.description || '').trim().slice(0, DESCRIPTION_MAX);
  const brief = validateBrief(body.brief || {});
  const creatorFeeBps = Number(body.creatorFeeBps ?? 0);
  if (!FEE_RATES.includes(creatorFeeBps)) throw new ApiError(`The creator fee is one of ${FEE_RATES.map((b) => `${b / 100}%`).join(', ')}`);
  // The first buy is always in SOL (operator, 9 Oct); its slippage is fixed here, never the launcher's.
  const devBuy = { currency: null, amount: '0' };
  if (body.devBuy && String(body.devBuy.amount || '').trim() && Number(body.devBuy.amount) > 0) {
    devBuy.currency = 'sol';
    devBuy.amount = String(body.devBuy.amount).trim();
    if (!(Number(devBuy.amount) <= MAX_DEV_BUY_SOL)) throw new ApiError(`The first buy is at most ${MAX_DEV_BUY_SOL} SOL`);
  }
  const slippagePct = DEV_BUY_SLIPPAGE_PCT;
  const socials = {
    website: cleanUrl(body.website),
    twitter: cleanUrl(body.twitter, ['x.com', 'twitter.com']),
    telegram: cleanUrl(body.telegram, ['t.me', 'telegram.me']),
  };
  return { name, symbol, description, brief, creatorFeeBps, devBuy, slippagePct, socials };
}

/** The Describe step: what every ad for this coin is made from. */
export function validateBrief(b) {
  const pitch = String(b.pitch || '').trim().slice(0, 500);
  if (pitch.length < 3) throw new ApiError('Describe your coin in a sentence');
  const vibe = [...new Set((Array.isArray(b.vibe) ? b.vibe : []).map(String))].filter((v) => VIBES.includes(v)); // as many as the form offers
  const audience = String(b.audience || '').trim().slice(0, 120);
  const mascot = String(b.mascot || '').trim().slice(0, 500);
  const platforms = [...new Set((Array.isArray(b.platforms) ? b.platforms : PLATFORMS).map(String))].filter((p) => PLATFORMS.includes(p));
  if (!platforms.length) throw new ApiError('Pick at least one place to post: X or TikTok');
  return { pitch, vibe, audience, mascot, platforms };
}

/** An uploaded image (base64 data URL). The type comes from the bytes, never from the label. */
export function readImage(body) {
  const m = String(body.imageData || '').match(/^data:[a-z0-9.+/-]*;base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) throw new ApiError('pump.fun needs an image for every coin: upload a PNG, JPG, WebP or GIF');
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length > IMAGE_MAX_BYTES) throw new ApiError('The image is over 4 MB');
  const type = images.imageType(bytes);
  if (!type) throw new ApiError('The image must be a PNG, JPG, WebP or GIF file');
  return { bytes, type };
}

/** pump.fun's own metadata upload. Returns the URI create_v2 records. */
export async function uploadMetadata({ image, form }) {
  const f = new FormData();
  f.append('file', new Blob([image.bytes], { type: image.type }), 'image');
  f.append('name', form.name);
  f.append('symbol', form.symbol);
  f.append('description', form.description || `${form.brief.pitch} Launched on pumpfunads.com, paired with $ADS: its creator fees pay for its ads.`);
  if (form.socials.website) f.append('website', form.socials.website);
  if (form.socials.twitter) f.append('twitter', form.socials.twitter);
  if (form.socials.telegram) f.append('telegram', form.socials.telegram);
  f.append('showName', 'true');
  const r = await fetch(env('PUMP_IPFS_URL', 'https://pump.fun/api/ipfs'), { method: 'POST', body: f, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new ApiError(`pump.fun refused the metadata upload (${r.status})`, 502);
  const out = await r.json();
  if (typeof out.metadataUri !== 'string' || !/^https:\/\/\S+$/.test(out.metadataUri) || out.metadataUri.length > 200) throw new ApiError('pump.fun returned no usable metadata address', 502);
  return { uri: out.metadataUri };
}

/* ───────────── the transactions ───────────── */

const msgHash = (tx) => createHash('sha256').update(tx.message.serialize()).digest('hex');
const staticKeysShared = sol.shared(() => staticAccounts(), 3_600_000);

function compile(payer, ixs, blockhash, tables) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables));
}

/**
 * The launch, in one transaction, signed here by the mint key. With a first buy, its slippage floor is quoted from the
 * coin's opening reserves (known before it exists) and the launcher's slippage. Extends a pair table first when the
 * transaction does not fit without one.
 */
export async function buildLaunchTx({ mint, launcher, creator, uri, name, symbol, quote, creatorFeeBps, devBuy, slippagePct, blockhash }) {
  const l = new PublicKey(launcher), m = mint.publicKey;
  let firstBuy = null, estimate = null, minOut = null;
  if (devBuy) {
    const global = await loadGlobal(sol.conn);
    estimate = quoteFirstBuy({ global, q: quote, entries: await quotes.listedEntries(), reserves: await quoteReserves(sol.conn, quote), currency: devBuy.currency, amountIn: devBuy.units });
    minOut = (estimate * BigInt(100 - slippagePct)) / 100n;
    if (minOut <= 0n) throw new ApiError('That first buy is too small to buy any tokens');
    firstBuy = { global, currency: devBuy.currency, amountIn: devBuy.units, minOut };
  }
  const ixs = [...budget(devBuy ? 900_000 : 300_000), ...(await launchIxs(sol.conn, { mint: m, user: l, name, symbol, uri, creator, quote, creatorFeeBps, firstBuy }))];
  let tables = await lut.tablesFor(quote);
  if (!tables.length) throw new ApiError('Launching is being set up. Try again in a few minutes.', 503);
  if (lut.sizeWith(l, ixs, tables) > lut.MAX_TX_BYTES) {
    await lut.ensureQuote(quote, await staticKeysShared());
    tables = await lut.tablesFor(quote);
  }
  if (lut.sizeWith(l, ixs, tables) > lut.MAX_TX_BYTES) throw new ApiError('This launch does not fit in one transaction. Try a shorter name.', 400);
  const tx = compile(l, ixs, blockhash, tables);
  tx.sign([mint]);
  return { tx, hash: msgHash(tx), estimate, minOut };
}

/** The submitted transaction must be THE prepared one: same message bytes, paid by the launcher, signed. */
export function checkSigned(tx, row, hash, { mintSigned = false } = {}) {
  const keys_ = tx.message.staticAccountKeys.map((k) => k.toBase58());
  if (keys_[0] !== row.launcher) throw new ApiError('Not paid by the launching wallet', 400, { stage: 'launch' });
  if (!hash || msgHash(tx) !== hash) throw new ApiError('Not the transaction this launch prepared', 400, { stage: 'launch' });
  if (!tx.signatures[0] || tx.signatures[0].every((b) => b === 0)) throw new ApiError('Not signed by the wallet', 400, { stage: 'launch' });
  if (mintSigned && (!tx.signatures[1] || tx.signatures[1].every((b) => b === 0))) throw new ApiError('The coin signature is missing', 400, { stage: 'launch' });
  // The signatures are VERIFIED, not just present: a bad one used to sit 'created' forever and keep its `…ads` address.
  const msg = tx.message.serialize();
  const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex'); // DER header of a raw Ed25519 public key
  const ok = (i) => { try { return verifySig(null, Buffer.from(msg), createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(tx.message.staticAccountKeys[i].toBytes())]), format: 'der', type: 'spki' }), Buffer.from(tx.signatures[i])); } catch { return false; } };
  if (!ok(0)) throw new ApiError('The wallet signature does not match this launch. Sign again.', 400, { stage: 'launch' });
  if (mintSigned && !ok(1)) throw new ApiError('The coin signature does not match this launch. Start again.', 400, { stage: 'launch' });
}

/** True once the coin exists on chain with its fee wallet as its pump.fun creator (the one creator fees are paid to). */
export async function lockedTo(mint, feeWallet, quote) {
  return (await coinCreator(sol.conn, mint, quote)) === feeWallet;
}

/* ───────────── prepare / submit ───────────── */

/** `closedOk`: the operator's rehearsal (scripts/ads.mjs rehearse) may launch while launching is still closed to the public. */
export async function prepare(body, sessionWallet, { closedOk = false } = {}) {
  if (getKv('ended', false)) throw new ApiError('Ads has ended. Launching is closed.', 503);
  if (!launchOpen() && !closedOk) throw new ApiError('Launching opens soon.', 503);
  if (!sessionWallet) throw new ApiError('Sign in with the wallet that launches.', 401);
  const form = validate(body);
  const launcher = new PublicKey(sessionWallet);
  const image = readImage(body);
  // Optional reference image for the look (Details): stored like a logo, handed to the brief writer with every brief.
  const ref = body.refImageData ? readImage({ imageData: body.refImageData }) : null;
  if (ref) form.brief.refImage = images.storeImage(ref.bytes);

  // $ADS, fresh from the chain (never from a cache): pump.fun's rules at this moment.
  if (!adsMint()) throw new ApiError('Launching opens soon.', 503);
  const quote = await resolveQuote(sol.conn, adsMint(), { listed: (await quotes.listedEntries({ fresh: true })).map((e) => e.mint) });
  if (!quote.ok) throw new ApiError(`Pumpfun does not accept $ADS as a pair right now (${quote.reason || 'refused'}). Try again in a minute.`, 503);
  const qMeta = { symbol: getKv('token', null)?.symbol || 'ADS' };

  let devBuy = null;
  if (form.devBuy.currency) {
    if (quote.kind === 'listed') throw new ApiError('A first buy needs a pump.fun coin pair. Launch this one without a first buy.');
    const units = toUnits(form.devBuy.amount, form.devBuy.currency === 'sol' ? 9 : quote.decimals);
    if (!units || units <= 0n) throw new ApiError('Enter the first buy as a number, like 0.5');
    devBuy = { currency: form.devBuy.currency, units };
  }
  const balance = BigInt(await sol.conn.getBalance(launcher));
  const neededSol = 50_000_000n + (devBuy?.currency === 'sol' ? devBuy.units : 0n); // rent + fees, with room
  if (balance < neededSol) throw new ApiError(`This wallet holds ${(Number(balance) / 1e9).toFixed(4)} SOL; the launch needs about ${(Number(neededSol) / 1e9).toFixed(3)} SOL`);

  const recent = one('SELECT COUNT(*) AS n FROM launches WHERE launcher = ? AND created_at > ?', sessionWallet, now() - 86_400_000).n;
  if (recent >= LAUNCHES_PER_WALLET_DAY) throw new ApiError('This wallet has prepared enough launches for today', 429);
  // ⛔ The `…ads` pools are scarce (~4..20 s of box CPU per address): a global hourly cap stops a swarm of wallets draining them.
  const poolBusy = one('SELECT COUNT(*) AS n FROM launches WHERE created_at > ?', now() - 3_600_000).n >= PREPARES_PER_HOUR && !vanity.hasReservation(sessionWallet);
  if (poolBusy) throw new ApiError('Launching is busy right now. Try again in a little while.', 503);
  if (vanity.REQUIRED && !vanity.available(sessionWallet)) throw new ApiError('Launching is busy: no address is ready right now. Try again in a minute.', 503);
  if (!(await lut.launchTable())) throw new ApiError('Launching is being set up. Try again in a few minutes.', 503);

  const shownImage = images.storeImage(image.bytes);
  const meta = await uploadMetadata({ image, form });
  const mint = vanity.issueKey(sessionWallet) || (vanity.REQUIRED ? null : Keypair.generate());
  if (!mint) throw new ApiError('Launching is busy: no address is ready right now. Try again in a minute.', 503);
  const m = mint.publicKey.toBase58();

  // The same launcher retrying within the reservation gets the same address back: reuse its unsent row and fee wallet.
  const prior = one('SELECT status, launcher, fee_wallet FROM launches WHERE mint = ?', m);
  if (prior && (prior.launcher !== sessionWallet || !['prepared', 'failed'].includes(prior.status))) throw new ApiError('This launch is already in progress. Use Finish launch, or start again in 15 minutes.', 409);
  if (prior) {
    // The earlier transaction for this same address may have landed anyway (the wallet broadcast it, or a send we
    // could not read): never delete a row whose coin exists. It goes live instead.
    const lp = one('SELECT * FROM launches WHERE mint = ?', m);
    const landed = await lockedTo(m, lp.fee_wallet, JSON.parse(lp.quote_json)).catch(() => { throw new ApiError('Could not read the chain just now. Nothing was lost: try again in a moment.', 503); });
    if (landed) { markLive(m); throw new ApiError('This coin already launched. Open My coins.', 409); }
    run('DELETE FROM launches WHERE mint = ?', m);
  }
  // The coin's creator wallet: an `…ads` key Ads holds, made once per mint (a retry of the same mint keeps it).
  let feeWallet = one("SELECT pubkey FROM fee_wallets WHERE mint = ? AND role = 'fee'", m)?.pubkey;
  if (!feeWallet) {
    const kp = vanity.takeCreatorKey() || (vanity.REQUIRED ? null : Keypair.generate());
    if (!kp) throw new ApiError('Launching is busy: no address is ready right now. Try again in a minute.', 503);
    feeWallet = storeWallet(m, kp, 'fee');
  }

  const { blockhash } = await sol.conn.getLatestBlockhash('confirmed');
  const launchTx = await buildLaunchTx({ mint, launcher: sessionWallet, creator: feeWallet, uri: meta.uri, name: form.name, symbol: form.symbol, quote, creatorFeeBps: form.creatorFeeBps, devBuy, slippagePct: form.slippagePct, blockhash });
  // Simulated BEFORE the launcher is asked to sign, first buy included: whatever pump.fun would refuse is refused here.
  const sim = await sol.conn.simulateTransaction(launchTx.tx, { sigVerify: false, replaceRecentBlockhash: true }).catch(() => null);
  if (!sim || sim.value?.err) {
    const why = sim ? JSON.stringify(sim.value.err) : 'no answer';
    console.error(`[launch] prepare simulation failed for ${m}: ${why} ${(sim?.value?.logs || []).slice(-3).join(' | ').slice(0, 300)}`);
    const text = `${why} ${(sim?.value?.logs || []).join(' ')}`;
    throw new ApiError(/InsufficientFunds|insufficient lamports|insufficient funds/i.test(text) ? 'This launch would be refused on chain: the wallet does not hold enough for the launch and first buy, or pump.fun cannot fit this name and ticker. Try a smaller first buy or a slightly different name.'
      : /slippage|TooLittle|6002|6042/i.test(text) ? 'The first buy would get fewer tokens than your slippage allows. Raise the slippage or lower the amount.'
      : /610[0-7]|6063/.test(text) ? 'Pumpfun refused the $ADS pair just now. Try again in a minute.'
      : `This launch would be refused on chain (${why.slice(0, 120)}). Nothing was sent.`, 400);
  }

  run(`INSERT INTO launches (mint, launcher, fee_wallet, name, symbol, description, image, metadata_uri, socials_json, brief_json, quote_mint, quote_json, quote_symbol, creator_fee_bps, dev_buy_currency, dev_buy_amount, tx_hash, buy_tx_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
  m, sessionWallet, feeWallet, form.name, form.symbol, form.description, shownImage, meta.uri, JSON.stringify(form.socials), JSON.stringify(form.brief), quote.mint,
  JSON.stringify({ kind: quote.kind, mint: quote.mint, tokenProgram: quote.tokenProgram, decimals: quote.decimals, curve: quote.curve, pool: quote.pool, quoteOfQ: quote.quoteOfQ || null }),
  qMeta?.symbol || null, form.creatorFeeBps, devBuy?.currency || null, String(devBuy?.units || 0n), launchTx.hash, null, now(), now());
  return {
    mint: m, feeWallet, quote: { mint: quote.mint, symbol: qMeta?.symbol || null, kind: quote.kind },
    transactions: [sol.b64(launchTx.tx)],
    firstBuy: devBuy ? { estimate: String(launchTx.estimate), minOut: String(launchTx.minOut) } : null,
  };
}

function markLive(mint, sig = null) {
  vanity.markLaunched(mint);
  const first = run("UPDATE launches SET status = 'live', sig = COALESCE(?, sig), error = NULL, live_at = COALESCE(live_at, ?), updated_at = ? WHERE mint = ? AND status <> 'live'", sig, now(), now(), mint).changes > 0;
  // The launch card (paid by Ads) is queued once, the moment the coin is live.
  if (first) import('./content/index.mjs').then((c) => c.onLaunched?.(mint)).catch((e) => console.error(`[launch] launch card for ${mint}: ${e.message}`));
}
async function goLiveIfRouted(row, sig = null) {
  if (row.status === 'live') return true;
  if (await lockedTo(row.mint, row.fee_wallet, JSON.parse(row.quote_json)).catch(() => false)) { markLive(row.mint, sig); return true; }
  return false;
}

const inFlight = new Set();
/**
 * Relays the prepared launch (first buy inside it) and declares it live only once the chain shows the coin with its fee
 * wallet as creator (read back, not assumed). An unknown outcome keeps the row 'created'; reconcile() heals it later.
 */
export async function submit({ mint, transactions }, sessionWallet) {
  const row = one('SELECT * FROM launches WHERE mint = ?', String(mint || ''));
  if (!row) throw new ApiError('Unknown launch', 404, { stage: 'launch' });
  if (!sessionWallet || sessionWallet !== row.launcher) throw new ApiError('Sign in with the wallet that launched this.', 401, { stage: 'launch' });
  if (row.status === 'rejected') throw new ApiError('This launch was refused.', 409, { stage: 'launch' });
  if (!Array.isArray(transactions) || transactions.length !== 1) throw new ApiError('The signed launch transaction is required', 400, { stage: 'launch' });
  const tx = sol.parseTx(transactions[0], 'The launch');
  checkSigned(tx, row, row.tx_hash, { mintSigned: true });
  if (inFlight.has(mint)) throw new ApiError('This launch is already being sent.', 409, { stage: 'unknown' });
  inFlight.add(mint);
  try {
    if (!(await goLiveIfRouted(row))) {
      let sig;
      try {
        sig = await sol.sendSigned(tx, 'The launch');
      } catch (e) {
        const definite = e.stage === 'refused' || e.stage === 'failed' || e.stage === 'expired';
        run("UPDATE launches SET status = ?, error = ?, sig = ?, updated_at = ? WHERE mint = ? AND status <> 'live'", definite ? 'failed' : 'created', e.message.slice(0, 300), sol.sigOf(tx), now(), mint);
        throw Object.assign(e, { stage: definite ? 'launch' : 'unknown' });
      }
      run("UPDATE launches SET status = 'created', sig = ?, buy_sig = CASE WHEN dev_buy_currency IS NULL THEN NULL ELSE ? END, updated_at = ? WHERE mint = ? AND status <> 'live'", sig, sig, now(), mint);
      let live = false;
      for (let i = 0; i < 10 && !live; i++) {
        live = await goLiveIfRouted({ ...row, status: 'created' }, sig);
        if (!live) await sol.sleep(1000);
      }
      if (!live) throw new ApiError('The launch confirmed but is not readable yet. Use Finish launch in a moment.', 502, { stage: 'lock' });
    }
    const done = one('SELECT sig, buy_sig FROM launches WHERE mint = ?', mint);
    return { mint, status: 'live', signatures: { launch: done.sig, firstBuy: done.buy_sig || null } };
  } finally {
    inFlight.delete(mint);
  }
}

/** "Finish launch": live if the chain says so; otherwise there is nothing to sign, the launch is simply not there. */
export async function relock(mint, sessionWallet) {
  const row = one('SELECT * FROM launches WHERE mint = ?', String(mint || ''));
  if (!row) throw new ApiError('Unknown launch', 404);
  if (!sessionWallet || sessionWallet !== row.launcher) throw new ApiError('Sign in with the wallet that launched this.', 401);
  if (await goLiveIfRouted(row)) return { mint, live: true };
  if (row.sig && (await sol.txStatus(row.sig).catch(() => null)) === 'ok') throw new ApiError('The launch landed but is not readable yet. Try again in a moment.', 503, { stage: 'lock' });
  throw new ApiError('This launch never landed. Start a new launch.', 400, { stage: 'launch' });
}

/**
 * Addresses issued for a launch that never happened go back to the pool (a failed prepare used to spend an `…ads` mint
 * for good, so wallets could drain the pool). Only after 2 h (the transaction expired long ago, reconcile had its hour)
 * and only when the coin provably does not exist. The mint's creator wallet stays tied to it and is reused with it.
 */
export async function recycleAddresses() {
  let n = 0;
  for (const v of all("SELECT pubkey FROM vanity WHERE role = 'mint' AND state = 'issued' AND issued_at < ?", now() - 2 * 3_600_000)) {
    const row = one('SELECT status FROM launches WHERE mint = ?', v.pubkey);
    if (row && !['prepared', 'failed'].includes(row.status)) continue;
    if (await sol.exists(v.pubkey).catch(() => true)) continue; // the mint account exists (or the RPC could not say): keep it out
    run("DELETE FROM launches WHERE mint = ? AND status IN ('prepared', 'failed')", v.pubkey);
    run("UPDATE vanity SET state = 'fresh', launcher = NULL, issued_at = NULL WHERE pubkey = ? AND state = 'issued'", v.pubkey);
    n++;
  }
  return n;
}

/** Launches found live on chain but still marked created (a submit that died after the launch landed). */
export async function reconcile() {
  let n = 0;
  // 'created' (sent, unread) and recent 'failed' (a send error that may have been wrong about it) are both checked.
  for (const r of all("SELECT * FROM launches WHERE (status = 'created' AND updated_at < ? AND updated_at > ?) OR (status = 'failed' AND sig IS NOT NULL AND updated_at > ?)", now() - 60_000, now() - 86_400_000, now() - 3_600_000)) {
    try {
      if (await goLiveIfRouted(r)) { n++; continue; }
      // Sent but never seen on chain 10 minutes later: its blockhash expired long ago, it cannot land any more.
      if (r.status === 'created' && r.sig && r.updated_at < now() - 600_000 && (await sol.txStatus(r.sig)) === null) {
        run("UPDATE launches SET status = 'failed', error = COALESCE(error, 'never landed'), updated_at = ? WHERE mint = ? AND status = 'created'", now(), r.mint);
      }
    } catch {}
  }
  return n;
}
