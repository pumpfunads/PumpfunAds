/**
 * Public reads. An Ads coin is priced IN $ADS (its pair): on its curve from the bonding curve, once graduated from its
 * own PumpSwap pool against Q (the curve then reads all zeroes). USD = price in Q × Q's USD price (Jupiter).
 * Lists read every coin's chain state in a few batched calls, shared 60 s; a value that cannot be read is null, never 0.
 */
import { PublicKey } from '@solana/web3.js';
import { all, one, now, HOUR } from './db.mjs';
import * as sol from './sol.mjs';
import { ApiError } from './errors.mjs';
import * as quotes from './quotes.mjs';
import { launchKeeperStatus, graduated as keeperGraduated } from './keeper.mjs';
import * as ledger from './ledger.mjs';
import * as content from './content/index.mjs';
import { ladderFor } from '../lib/ladder.mjs';
import { ata, TOKEN_2022, bondingCurveAddress, decodeBondingCurve, decodePool, coinPoolAddress, poolVirtualQuote, tokenAccountAmount, CURVE_TOKENS_FOR_SALE, COIN_DECIMALS } from '../lib/pump.mjs';

const quoteOf = (row) => JSON.parse(row.quote_json);
const units = (v, d) => Number(v) / 10 ** d;

/** Chain state for many coins: 2 batched reads (+2 for graduated ones). { [mint]: { phase, progress, priceQ, supply, pool } } */
export async function chainMarkets(rows) {
  const chunk = async (ks) => { const out = []; for (let i = 0; i < ks.length; i += 100) out.push(...(await sol.conn.getMultipleAccountsInfo(ks.slice(i, i + 100), 'confirmed'))); return out; };
  const first = await chunk(rows.flatMap((r) => [bondingCurveAddress(new PublicKey(r.mint)), new PublicKey(r.mint)]));
  const out = {}, grads = [];
  rows.forEach((r, i) => {
    const curveInfo = first[2 * i], mintInfo = first[2 * i + 1];
    if (!curveInfo || !mintInfo) { out[r.mint] = null; return; }
    const c = decodeBondingCurve(curveInfo.data), q = quoteOf(r);
    const supply = units(mintInfo.data.readBigUInt64LE(36), COIN_DECIMALS);
    const m = { phase: c.complete ? 'graduated' : 'curve', progress: 1, priceQ: null, supply, pool: null };
    const vt = BigInt(c.virtual_token_reserves.toString()), vq = BigInt(c.virtual_quote_reserves.toString());
    if (!c.complete) {
      if (vt > 0n) m.priceQ = units(vq, q.decimals) / units(vt, COIN_DECIMALS);
      m.progress = Math.max(0, Math.min(1, 1 - Number(BigInt(c.real_token_reserves.toString())) / Number(CURVE_TOKENS_FOR_SALE)));
    } else {
      // ⛔ A completed curve's virtual reserves are STALE: the completing buy goes on past the curve at the future pool's
      // price (synthetic migration, pump-public-docs SYNTHETIC_MIGRATION.md; ×3 to ×137 off on the clone, 9 Oct). Until
      // migrate_v2 runs, the price is the pool's opening one: quote = real_quote_reserves + post_complete_quote_in (no
      // migration fee on a token pair), base = the curve's token balance (read below). After migration the curve reads
      // ALL ZEROES and the pool prices it.
      m.openingQuote = BigInt(c.real_quote_reserves.toString()) + BigInt((c.post_complete_quote_in ?? 0).toString());
      grads.push(r);
    }
    out[r.mint] = m;
  });
  if (grads.length) {
    const poolAddrs = grads.map((r) => coinPoolAddress(r.mint, quoteOf(r)));
    const pools = await chunk(poolAddrs);
    const waiting = grads.filter((r, i) => !(pools[i] && pools[i].data.length >= 200));
    const curveBase = waiting.length ? await chunk(waiting.map((r) => ata(bondingCurveAddress(new PublicKey(r.mint)), new PublicKey(r.mint), TOKEN_2022))) : [];
    const legs = [];
    grads.forEach((r, i) => {
      const p = pools[i];
      if (p && p.data.length >= 200) { const d = decodePool(p.data); legs.push({ r, pool: poolAddrs[i], vq: poolVirtualQuote(p.data), base: d.pool_base_token_account, quote: d.pool_quote_token_account }); }
      else out[r.mint].phase = 'migrating'; // complete, pool not made yet: priced at the pool's opening reserves
    });
    waiting.forEach((r, i) => {
      const m = out[r.mint], b = curveBase[i];
      const base = b ? tokenAccountAmount(b.data) : 0n;
      if (base > 0n && m.openingQuote > 0n) m.priceQ = units(m.openingQuote, quoteOf(r).decimals) / units(base, COIN_DECIMALS);
    });
    const accts = await chunk(legs.flatMap((l) => [l.base, l.quote]));
    legs.forEach((l, i) => {
      const m = out[l.r.mint], b = accts[2 * i], qa = accts[2 * i + 1], d = quoteOf(l.r).decimals;
      m.pool = l.pool.toBase58();
      if (b && qa) { const bb = units(tokenAccountAmount(b.data), COIN_DECIMALS), qq = units(tokenAccountAmount(qa.data) + l.vq, d); if (bb > 0 && qq > 0) m.priceQ = qq / bb; }
    });
  }
  return out;
}

const liveRows = () => all("SELECT * FROM launches WHERE status = 'live' AND hidden = 0 ORDER BY live_at DESC LIMIT 500");
/** Rows a visitor may see: live ones, plus the private preview for a browser holding the preview cookie. */
const visibleRows = (preview) => all(`SELECT * FROM launches WHERE (status = 'live'${preview ? " OR status = 'preview'" : ''}) AND hidden = 0 ORDER BY official DESC, live_at DESC LIMIT 500`);
const listMarkets = sol.shared(async () => chainMarkets(liveRows().filter((r) => r.origin === 'ads')), 60_000);

/**
 * An EXTERNAL token's market (the site's own token, launched on another platform): DexScreener's busiest pool for it,
 * shared 60 s. `marketMint` is the token's CA (or, in the private preview, a stand-in coin whose market is borrowed).
 * Null when nothing prices it; never 0.
 */
const external = sol.sharedMap(async (marketMint) => {
  const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${marketMint}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`dexscreener ${r.status}`);
  const pools = (await r.json()) || [];
  const p = pools.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!p) return null;
  const cap = Number(p.marketCap ?? p.fdv), price = Number(p.priceUsd);
  return { dexId: p.dexId, url: p.url, capUsd: cap > 0 ? cap : null, priceUsd: price > 0 ? price : null, quote: p.quoteToken ? { mint: p.quoteToken.address, symbol: p.quoteToken.symbol } : null };
}, 60_000, 50);
const externalMeta = (row) => JSON.parse(row.quote_json || '{}');

/**
 * An external token that is a pump.fun coin paired with SOL: its market straight from the chain (bonding curve, or its
 * PumpSwap pool once graduated), shared 20 s. Live from the first block, unlike DexScreener, which indexes with a delay.
 */
const SOL_QUOTE = JSON.stringify({ kind: 'sol', mint: 'So11111111111111111111111111111111111111112', tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', decimals: 9 });
const pumpExternal = sol.sharedMap(async (mint) => {
  const m = (await chainMarkets([{ mint, quote_json: SOL_QUOTE }]))[mint];
  if (!m) return null;
  const solUsd = await sol.solUsd();
  const capSol = m.priceQ != null && m.supply != null ? m.priceQ * m.supply : null;
  return { ...m, capUsd: capSol != null && solUsd ? capSol * solUsd : null };
}, 20_000, 50);

/** The card / page shape of an external (official) token. */
async function shapeExternal(row) {
  const x = externalMeta(row);
  const chain = await pumpExternal(x.marketMint || row.mint).catch(() => null);
  const d = await external(x.marketMint || row.mint).catch(() => null);
  // The pair the operator gave (the official token is paired with SOL), else whatever its busiest pool trades against.
  const qMint = x.pairMint || d?.quote?.mint || null;
  const qm = qMint ? await quotes.meta(qMint).catch(() => null) : null;
  const onPump = Boolean(chain) || d?.dexId === 'pumpfun', lm = x.marketMint || row.mint;
  return {
    mint: row.mint, name: row.name, symbol: row.symbol, image: row.image, description: row.description,
    socials: JSON.parse(row.socials_json || '{}'), launcher: null, feeWallet: null, creatorFeeBps: null, official: true, origin: 'external', preview: row.status === 'preview',
    pair: { mint: qMint, kind: null, symbol: qm?.symbol || d?.quote?.symbol || null, name: qMint === 'So11111111111111111111111111111111111111112' ? 'Solana' : qm?.name || null, icon: qm?.icon || null, usdPrice: qm?.usdPrice ?? null, decimals: null },
    createdAt: new Date(row.created_at).toISOString(), liveAt: row.live_at ? new Date(row.live_at).toISOString() : null,
    market: chain ? { phase: chain.phase, graduated: chain.phase === 'graduated', migrating: chain.phase === 'migrating', progress: chain.phase === 'curve' ? chain.progress : null, priceQ: null, capQ: null, capUsd: chain.capUsd ?? d?.capUsd ?? null, pool: chain.pool }
      : d ? { phase: onPump ? 'curve' : 'graduated', graduated: !onPump, migrating: false, progress: null, priceQ: null, capQ: null, capUsd: d.capUsd, pool: null } : null,
    burned: { amount: 0, usd: null, count: 0 },
    // Links follow the market's coin: the CA itself once live; in the preview, the stand-in whose market is borrowed.
    links: { pump: onPump ? `https://pump.fun/coin/${lm}` : d?.url || `https://dexscreener.com/solana/${lm}`, dex: `https://dexscreener.com/solana/${lm}`, token: `${sol.EXPLORER}/token/${lm}`, feeWallet: null, pair: qMint ? `${sol.EXPLORER}/token/${qMint}` : null },
  };
}
const coinMarket = sol.sharedMap(async (mint) => (await chainMarkets([one('SELECT * FROM launches WHERE mint = ?', mint)]))[mint], 30_000);

/** $ADS's USD price (Jupiter, cached), the pair every coin is priced in. */
const adsUsd = async (mint) => (await quotes.metaMany([mint]).catch(() => ({})))[mint]?.usdPrice ?? null;

const parse = (j, d) => { try { return JSON.parse(j || ''); } catch { return d; } };

/** The card every list shows (SPEC coinCard). */
/**
 * Creator fees a coin has EARNED, in dollars: every $ADS the keeper collected for it (fee passes that landed), valued at
 * $ADS's current price. Shown from the first collection (every 5 min), not only after the daily sale credits the budget.
 */
const earnedUnits = (mint) => all("SELECT collected, decimals FROM fees WHERE mint = ? AND status = 'ok'", mint).reduce((a, f) => a + units(f.collected, f.decimals), 0);
const earnedUsd = (mint, qUsd) => (qUsd ? earnedUnits(mint) * qUsd : null);

function card(row, m, qUsd) {
  const capQ = m?.priceQ != null && m?.supply != null ? m.priceQ * m.supply : null;
  const brief = parse(row.brief_json, {});
  return {
    mint: row.mint, name: row.name, symbol: row.symbol, image: row.image, description: row.description, launcher: row.launcher,
    createdAt: new Date(row.live_at || row.created_at).toISOString(), phase: m?.phase || null, progress: m?.progress ?? null,
    marketCapUsd: capQ != null && qUsd ? capQ * qUsd : null, creatorFeeBps: row.creator_fee_bps, platforms: brief.platforms || ['x', 'tiktok'],
    assets: one('SELECT COUNT(*) AS n FROM assets WHERE mint = ?', row.mint)?.n ?? 0,
    official: Boolean(row.official),
    feesUsd: earnedUsd(row.mint, qUsd), // creator fees earned so far, in dollars (Explore's Fees sort)
  };
}

/** A coin's budget and where it stands on the ladder. */
function budgetOf(row, graduated) {
  const s = ledger.summary(row.mint);
  const c = content.coinContent(row.mint);
  const { steps, next } = ladderFor({ lifetimeUsd: s.lifetimeUsd, graduated, done: c.done || {} });
  const q = quoteOf(row);
  return {
    budget: { balanceUsd: s.balanceUsd, lifetimeUsd: s.lifetimeUsd, pendingAds: units(s.pendingAds, q.decimals), nextStep: next },
    ladder: steps.map((x) => ({ key: x.key, label: x.label, detail: x.detail, state: x.state, atUsd: x.atUsd, made: x.made })),
    content: c,
  };
}

const ownRows = (preview) => visibleRows(preview).filter((r) => r.origin === 'ads');

/** $ADS (the official token, launched outside Ads) as a coin card, from its own market. */
async function externalCard(row) {
  const x = await shapeExternal(row).catch(() => null);
  return {
    mint: row.mint, name: row.name, symbol: row.symbol, image: row.image, description: row.description, launcher: row.launcher,
    createdAt: new Date(row.live_at || row.created_at).toISOString(), phase: x?.market?.phase ?? null, progress: x?.market?.progress ?? null,
    marketCapUsd: x?.market?.capUsd ?? null, creatorFeeBps: null, platforms: [], assets: 0, official: true, feesUsd: null,
  };
}

export async function list({ sort = 'new', q = '', limit = 100, preview = false, graduated = false, platform = '' } = {}) {
  // Coins launched here, plus the official $ADS (shown like any coin, operator 11 Oct).
  let rows = visibleRows(preview).filter((r) => r.origin === 'ads' || r.official);
  const s = String(q || '').trim().toLowerCase();
  if (s) rows = rows.filter((r) => r.name.toLowerCase().includes(s) || r.symbol.toLowerCase().includes(s) || r.mint === String(q).trim());
  const markets = await listMarkets().catch(() => ({}));
  const own = rows.find((r) => r.origin === 'ads');
  const qUsd = own ? await adsUsd(own.quote_mint) : null;
  let out = await Promise.all(rows.map((r) => (r.origin === 'ads' ? card(r, markets[r.mint], qUsd) : externalCard(r))));
  if (sort === 'top' || sort === 'mcap') out.sort((a, b) => (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1));
  if (sort === 'fees') out.sort((a, b) => (b.feesUsd ?? -1) - (a.feesUsd ?? -1));
  if (sort === 'graduated' || graduated) out = out.filter((c) => c.phase === 'graduated');
  if (platform === 'x' || platform === 'tiktok') out = out.filter((c) => c.platforms.includes(platform));
  return { coins: out.slice(0, Math.min(Number(limit) || 100, 200)), total: out.length };
}

export async function get(mint, { preview = false } = {}) {
  // 'demo': the operator's demo coin for app reviews (scripts/ads.mjs demo-coin). Reachable by its address only: no list,
  // no keeper, no planner, no posting reads it. It counts as bonded so its page shows the account linking.
  const row = one(`SELECT * FROM launches WHERE mint = ? AND (status = 'live' OR status = 'demo'${preview ? " OR status = 'preview'" : ''}) AND hidden = 0`, mint);
  if (!row) throw new ApiError('No such coin on Ads', 404);
  if (row.origin !== 'ads') {
    const x = await shapeExternal(row);
    // The card fields the coin page reads, from the external market (it has no ladder, budget or creator fee of its own).
    return { ...x, marketCapUsd: x.market?.capUsd ?? null, phase: x.market?.phase ?? null, progress: x.market?.progress ?? null, graduated: Boolean(x.market?.graduated),
      brief: null, budget: null, ladder: [], gallery: [], ledger: [], socials: { x: null, tiktok: null } };
  }
  const m = await coinMarket(mint).catch(() => null);
  const qUsd = await adsUsd(row.quote_mint);
  const demo = row.status === 'demo';
  const graduated = demo || m?.phase === 'graduated' || keeperGraduated(mint);
  const b = budgetOf(row, graduated);
  const ks = launchKeeperStatus(mint);
  const fees = all("SELECT collected, burned, to_treasury, decimals, sig, status, created_at FROM fees WHERE mint = ? AND status IN ('ok', 'pending') ORDER BY created_at DESC LIMIT 100", mint)
    .map((f) => ({ collected: units(f.collected, f.decimals), burned: units(f.burned, f.decimals), toAds: units(f.to_treasury, f.decimals), sig: f.sig, status: f.status, at: new Date(f.created_at).toISOString(), url: f.sig ? `${sol.EXPLORER}/tx/${f.sig}` : null }));
  return {
    ...card(row, m, qUsd),
    demo,
    brief: parse(row.brief_json, {}),
    budget: b.budget, ladder: b.ladder,
    gallery: b.content.gallery || [], site: b.content.site || null, siteStatus: content.planner?.siteStatus ? content.planner.siteStatus(mint) : 'none',
    ledger: ledger.entries(mint),
    socials: b.content.socials || { x: null, tiktok: null },
    graduated,
    fees,
    keeper: ks ? { note: ks.note || null, error: ks.error ? 'The last fee pass failed; it is retried every 5 minutes.' : null, at: ks.at ? new Date(ks.at).toISOString() : null } : null,
    feeWallet: row.fee_wallet,
    signatures: { launch: row.sig, firstBuy: row.buy_sig },
    links: { pump: `https://pump.fun/coin/${row.mint}`, dex: `https://dexscreener.com/solana/${row.mint}`, token: `${sol.EXPLORER}/token/${row.mint}`, feeWallet: `${sol.EXPLORER}/account/${row.fee_wallet}` },
  };
}

export async function stats() {
  // Public coins only: a hidden coin (the rehearsal) or the demo coin never shows in the totals.
  const burned = all("SELECT f.burned, f.decimals FROM fees f JOIN launches l ON l.mint = f.mint WHERE f.status = 'ok' AND l.status = 'live' AND l.hidden = 0").reduce((a, f) => a + units(f.burned, f.decimals), 0);
  // Fees earned by every public coin (collected $ADS at its current price), as on the coin cards.
  const live = all("SELECT mint, quote_mint FROM launches WHERE status = 'live' AND hidden = 0 AND origin = 'ads'");
  const qUsd = live.length ? await adsUsd(live[0].quote_mint) : null;
  const earned = qUsd ? live.reduce((a, r) => a + earnedUnits(r.mint), 0) * qUsd : 0;
  return {
    coins: one("SELECT COUNT(*) AS n FROM launches WHERE status = 'live' AND hidden = 0 AND origin = 'ads'").n,
    graduated: ownRows(false).filter((r) => keeperGraduated(r.mint)).length,
    feesUsd: earned,
    burnedAds: burned,
    // Public coins only: a hidden coin or the demo coin is not counted.
    videos: one("SELECT COUNT(*) AS n FROM assets a JOIN launches l ON l.mint = a.mint WHERE a.kind = 'video' AND l.status = 'live' AND l.hidden = 0")?.n ?? 0,
    posts: one("SELECT COUNT(*) AS n FROM posts p JOIN launches l ON l.mint = p.mint WHERE p.status = 'posted' AND l.status = 'live' AND l.hidden = 0")?.n ?? 0,
  };
}

export async function mine(wallet) {
  const rows = all("SELECT * FROM launches WHERE launcher = ? AND status IN ('live', 'created') AND origin = 'ads' AND hidden = 0 ORDER BY created_at DESC LIMIT 100", wallet);
  const markets = await listMarkets().catch(() => ({}));
  const qUsd = rows.length ? await adsUsd(rows[0].quote_mint) : null;
  return { coins: rows.map((r) => ({ ...card(r, markets[r.mint], qUsd), status: r.status, error: r.error, budget: budgetOf(r, markets[r.mint]?.phase === 'graduated' || keeperGraduated(r.mint)).budget })) };
}

/** Every logo a coin still uses (the image store's garbage collector keeps these). */
// Logos AND the reference images in briefs (Details upload): the cleaner must keep both.
export const allImages = () => all('SELECT image, brief_json FROM launches').flatMap((r) => [r.image, parse(r.brief_json, {}).refImage].filter(Boolean));
