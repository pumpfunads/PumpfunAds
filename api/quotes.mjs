/**
 * The pair picker: token look-ups and USD prices (Jupiter, DexScreener fallback); Ads pairs every coin with $ADS, and what they look like.
 *
 * pump.fun allows (pump-public-docs CREATE_WITH_PUMP_COIN_QUOTE.md, 8 Oct 2026):
 *   - a token on pump.fun's custom pair list (the quote-control account: xStocks, BONK, PUMP, Fartcoin …), and
 *   - any pump coin paired with SOL or USDC (on its curve, or graduated to PumpSwap), not in mayhem mode.
 *   Never: a coin that is itself paired with a pump coin (depth 1 is the maximum), or one graduated to Raydium.
 *
 * Names, logos and USD prices come from Jupiter's free token API (no key). Eligibility always comes from the chain
 * (lib/pump.resolveQuote); the launch is simulated anyway before anyone signs.
 * ⛔ Reads run on demand only (someone opened the picker or a coin page) and are cached: nothing polls.
 */
import { PublicKey } from '@solana/web3.js';
import * as sol from './sol.mjs';
import { ApiError } from './errors.mjs';
import { ipfsPath, GATEWAYS } from './images.mjs';
import { getKv, setKv, all } from './db.mjs';
import { resolveQuote, readQuoteControlEntries, bondingCurveAddress, decodeBondingCurve, poolAddress, WSOL, USDC } from '../lib/pump.mjs';

const JUP = 'https://lite-api.jup.ag/tokens/v2';

/** pump.fun's list, re-read at most every 10 minutes. */
export const listedEntries = sol.shared(() => readQuoteControlEntries(sol.conn), 600_000);
const listedMints = async () => (await listedEntries()).map((e) => e.mint);

/** Jupiter metadata for up to 100 mints per call: { [mint]: { symbol, name, icon, usdPrice, mcap, verified, liquidity } }. */
async function jupiterOnly(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 100) {
    const r = await fetch(`${JUP}/search?query=${mints.slice(i, i + 100).join(',')}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Jupiter tokens ${r.status}`);
    for (const t of await r.json()) out[t.id] = shapeMeta(t);
  }
  return out;
}

/**
 * DexScreener as the second source (30 mints per call): its busiest pool per token gives name, symbol, logo, USD price
 * and market cap. ⛔ Jupiter's free API rate-limits by IP and the box is shared by many projects (429s seen 9 Oct, which
 * left pairs without logos or prices and fed a null symbol into the page).
 */
async function dexscreener(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 30) {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`dexscreener ${r.status}`);
    const best = {};
    for (const p of (await r.json()) || []) {
      const t = p.baseToken?.address;
      if (t && (!best[t] || (p.liquidity?.usd ?? 0) > (best[t].liquidity?.usd ?? 0))) best[t] = p;
    }
    for (const [t, p] of Object.entries(best)) {
      out[t] = { symbol: String(p.baseToken.symbol || '').slice(0, 16), name: String(p.baseToken.name || '').slice(0, 48), icon: /^https:\/\//.test(p.info?.imageUrl || '') ? p.info.imageUrl : null,
        usdPrice: Number(p.priceUsd) || null, mcap: Number(p.marketCap ?? p.fdv) || null, liquidity: Number(p.liquidity?.usd) || null, verified: false, organicScore: 0 };
    }
  }
  return out;
}

/** Metadata from Jupiter, with DexScreener filling whatever Jupiter refused or did not know. */
async function jupiter(mints) {
  const out = await jupiterOnly(mints).catch(() => ({}));
  const missing = mints.filter((m) => !out[m] || out[m].usdPrice == null || !out[m].icon);
  if (missing.length) {
    const d = await dexscreener(missing).catch(() => ({}));
    for (const m of missing) if (d[m]) out[m] = { ...d[m], ...Object.fromEntries(Object.entries(out[m] || {}).filter(([, v]) => v != null && v !== '')) };
  }
  if (!Object.keys(out).length && mints.length) throw new Error('no token metadata source answered');
  return out;
}

/** ⛔ ipfs.io refuses many pump.fun CIDs (403): an IPFS logo is served through the first gateway that works for them. */
const iconUrl = (u) => {
  if (!/^https:\/\//.test(u || '')) return null;
  const p = ipfsPath(u);
  return p ? `${GATEWAYS[0]}/${p}` : u;
};
const shapeMeta = (t) => ({
  symbol: String(t.symbol || '').slice(0, 16), name: String(t.name || '').slice(0, 48),
  icon: iconUrl(t.icon),
  usdPrice: Number(t.usdPrice) || null, mcap: Number(t.mcap) || null, liquidity: Number(t.liquidity) || null,
  verified: Boolean(t.isVerified), organicScore: Number(t.organicScore) || 0,
});

/** Metadata for one mint, cached 5 minutes (a coin page, a burn total). Null when Jupiter does not know it. */
export const meta = sol.sharedMap(async (mint) => { const m = (await jupiter([mint]))[mint]; if (!m) throw new Error('unknown token'); return m; }, 300_000);
/** Metadata for many mints (lists), each cached through `meta` when already known. */
export async function metaMany(mints) {
  const uniq = [...new Set(mints)];
  try {
    return await jupiter(uniq);
  } catch {
    const out = {};
    for (const m of uniq) out[m] = await meta(m).catch(() => null);
    return out;
  }
}

/** USD price per whole Q (Jupiter), cached 2 minutes. Null when unknown, never 0. */
export const usdPrice = sol.sharedMap(async (mint) => {
  const j = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { signal: AbortSignal.timeout(6000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const v = Number(j?.[mint]?.usdPrice);
  if (v > 0) return v;
  const d = (await dexscreener([mint]).catch(() => ({})))[mint]?.usdPrice;
  if (d > 0) return d;
  throw new Error('no price');
}, 120_000);

/** Resolves a pasted address into a pair (chain checks + metadata). Cached 60 s per mint. */
const resolved = sol.sharedMap(async (mint) => {
  const q = await resolveQuote(sol.conn, mint, { listed: await listedMints() });
  const m = q.mint ? await meta(q.mint).catch(() => null) : null;
  return { ...q, meta: m };
}, 60_000);
export async function resolve(address) {
  const s = String(address || '').trim();
  if (!sol.isKey(s)) throw new ApiError('Paste a token address (CA)');
  return resolved(s);
}

/**
 * Pump coins eligible right now among `mints`, from batched reads: their curves, then (graduated ones) their pools.
 * The cheap first filter for lists; a launch still re-resolves its pair from scratch.
 */
async function eligiblePumpCoins(mints) {
  const keys = mints.map((m) => bondingCurveAddress(new PublicKey(m)));
  const curves = [];
  for (let i = 0; i < keys.length; i += 100) curves.push(...(await sol.conn.getMultipleAccountsInfo(keys.slice(i, i + 100))));
  const ok = [], graduated = [];
  mints.forEach((m, i) => {
    const info = curves[i];
    if (!info) return;
    const c = decodeBondingCurve(info.data);
    if (c.is_mayhem_mode || Number(c.depth ?? 0) > 0) return;
    if (!c.complete) {
      const q = c.quote_mint;
      if (q.equals(PublicKey.default) || q.equals(WSOL) || q.equals(USDC)) ok.push({ mint: m, kind: 'curve', progress: Math.max(0, Math.min(1, 1 - Number(c.real_token_reserves) / 793_100_000_000_000)) });
      return;
    }
    graduated.push(m);
  });
  if (graduated.length) {
    const pools = graduated.flatMap((m) => [poolAddress(new PublicKey(m), 0, WSOL), poolAddress(new PublicKey(m), 0, USDC)]);
    const infos = [];
    for (let i = 0; i < pools.length; i += 100) infos.push(...(await sol.conn.getMultipleAccountsInfo(pools.slice(i, i + 100))));
    graduated.forEach((m, i) => { if ((infos[2 * i] && infos[2 * i].data.length >= 200) || (infos[2 * i + 1] && infos[2 * i + 1].data.length >= 200)) ok.push({ mint: m, kind: 'pool', progress: 1 }); });
  }
  return ok;
}

/**
 * The picker's shelf: today's most traded pump coins (Jupiter's top traded + top organic lists, `…pump` addresses)
 * that are eligible on chain, and pump.fun's whole custom pair list. Rebuilt at most every 15 minutes, only when asked.
 */
export const popular = sol.shared(async () => {
  const listed = await listedMints();
  const lists = await Promise.all(['toptraded/24h', 'toporganicscore/24h'].map((c) => fetch(`${JUP}/${c}?limit=100`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : []), () => [])));
  const seen = new Map();
  for (const t of lists.flat()) if (t?.id && !seen.has(t.id)) seen.set(t.id, shapeMeta(t));
  // ⛔ Jupiter rate-limits the shared box (429). pump.fun's own "biggest coins" list is NOT a fallback: it is dominated
  // by a bot farm (repeated tickers, fake stablecoins, 30k buys vs 300 sells, 9 Oct). Known-real coins instead: the
  // pairs already used on Pairs and the site's own token. The trending list returns when Jupiter answers again.
  if (![...seen.keys()].some((m) => m.endsWith('pump') || m.endsWith('pair'))) {
    const known = all("SELECT DISTINCT quote_mint AS m FROM launches WHERE status = 'live' AND origin = 'ads'").map((r) => r.m);
    const own = getKv('token', null)?.mint;
    const mints = [...new Set([...known, ...(own ? [own] : [])])].filter((m) => !listed.includes(m));
    const d = await metaMany(mints).catch(() => ({}));
    for (const m of mints) if (d[m]) seen.set(m, d[m]);
  }
  const pumpCandidates = [...seen.keys()].filter((m) => (m.endsWith('pump') || m.endsWith('pair') || seen.get(m)?.symbol) && !listed.includes(m));
  const pumpOk = await eligiblePumpCoins(pumpCandidates);
  const listedMeta = await metaMany(listed);
  const pumpCoins = pumpOk.map((p) => ({ mint: p.mint, kind: p.kind, progress: p.progress, ...seen.get(p.mint) }))
    .filter((r) => r.symbol)
    .sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
  const listedRows = listed.map((m) => ({ mint: m, kind: 'listed', ...(listedMeta[m] || { symbol: '', name: '' }) }))
    .filter((r) => r.symbol)
    .sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
  // Keep the last good shelf: a moment when every source refuses must not empty the picker (or survive a restart empty).
  const prev = getKv('popularShelf', null);
  if (!pumpCoins.length && prev?.pumpCoins?.length) return prev;
  const out = { at: new Date().toISOString(), pumpCoins, listed: listedRows.length ? listedRows : prev?.listed || [] };
  setKv('popularShelf', out);
  return out;
}, 900_000);

/** Text search for the picker ("bonk", "SharkTank"): Jupiter's search, eligibility left to resolve() on pick. */
export async function search(text) {
  const s = String(text || '').trim().slice(0, 40);
  if (!s) return { results: [] };
  if (sol.isKey(s)) return { results: [await resolve(s)] };
  const listed = await listedMints();
  let rows = [];
  const r = await fetch(`${JUP}/search?query=${encodeURIComponent(s)}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (r?.ok) rows = (await r.json()).slice(0, 20).map((t) => ({ mint: t.id, listed: listed.includes(t.id), pumpLike: t.id.endsWith('pump'), ...shapeMeta(t) }));
  else {
    // Jupiter refused (429 on the shared box): DexScreener's search, one row per token, busiest pool first.
    const d = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(s)}`, { signal: AbortSignal.timeout(8000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    if (!d) throw new ApiError('Search is not answering right now. Paste the token address instead.', 503);
    const seen = new Map();
    for (const p of (d.pairs || []).filter((p) => p.chainId === 'solana').sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))) {
      const t = p.baseToken?.address;
      if (!t || seen.has(t)) continue;
      seen.set(t, { mint: t, listed: listed.includes(t), pumpLike: /pump$|pair$/.test(t), symbol: String(p.baseToken.symbol || '').slice(0, 16), name: String(p.baseToken.name || '').slice(0, 48), icon: /^https:\/\//.test(p.info?.imageUrl || '') ? p.info.imageUrl : null, usdPrice: Number(p.priceUsd) || null, mcap: Number(p.marketCap ?? p.fdv) || null, liquidity: Number(p.liquidity?.usd) || null });
    }
    rows = [...seen.values()].slice(0, 20);
  }
  return { results: rows.filter((x) => x.listed || x.pumpLike) };
}
