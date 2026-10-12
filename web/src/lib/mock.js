/**
 * DEV ONLY sample data for every endpoint (see api.js). Never shipped: a production build drops the import.
 * Images are inline SVG data URLs, so the mock works offline.
 */
import { ladderFor } from './ladder.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function addr(seed, suffix = 'ads') {
  let x = seed * 2654435761 >>> 0, s = '';
  for (let i = 0; i < 44 - suffix.length; i++) { x = (x * 1103515245 + 12345) >>> 0; s += B58[x % 58]; }
  return s + suffix;
}
const svg = (w, h, body) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`)}`;
const esc = (s) => String(s).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
function logo(symbol, hue) {
  return svg(256, 256, `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 58%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 70% 32%)"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="196" cy="60" r="70" fill="#fff" opacity=".12"/><text x="128" y="150" font-family="Arial Black,Arial" font-weight="900" font-size="${symbol.length > 4 ? 52 : 72}" text-anchor="middle" fill="#fff">${esc(symbol.slice(0, 6))}</text>`);
}
function poster(w, h, hue, title, sub) {
  return svg(w, h, `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 30%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 60% 10%)"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${h * 0.3}" r="${w * 0.35}" fill="hsl(${hue} 80% 70%)" opacity=".25"/><circle cx="${w * 0.25}" cy="${h * 0.75}" r="${w * 0.2}" fill="#86EFAC" opacity=".18"/><text x="${w / 2}" y="${h * 0.48}" font-family="Impact,Arial Black,Arial" font-size="${w * 0.11}" text-anchor="middle" fill="#fff">${esc(title)}</text><text x="${w / 2}" y="${h * 0.48 + w * 0.09}" font-family="Arial" font-size="${w * 0.05}" text-anchor="middle" fill="#ffffffcc">${esc(sub)}</text>`);
}

const ME = addr(999, 'mck');
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
const ms = (minAgo) => now - minAgo * 60_000;
const COINS = [
  { name: 'Trading Frog', symbol: 'FROG', hue: 130, pitch: 'A frog who only trades at 3am', vibe: ['Meme', 'Lo-fi'], cap: 412_000, progress: 1, phase: 'graduated', fee: 100, lifetime: 41.2, balance: 12.4, assets: 14, min: 60 * 30, launcher: ME },
  { name: 'Reply Guy', symbol: 'FIRST', hue: 200, pitch: 'The official coin of people who reply first', vibe: ['Chaotic', 'Meme'], cap: 61_300, progress: 0.72, phase: 'curve', fee: 200, lifetime: 7.8, balance: 3.1, assets: 6, min: 60 * 5, launcher: ME },
  { name: 'Hedge Cat', symbol: 'HCAT', hue: 40, pitch: 'A cat that runs a hedge fund', vibe: ['Cinematic', '3D mascot'], cap: 23_900, progress: 0.41, phase: 'curve', fee: 300, lifetime: 2.4, balance: 1.9, assets: 5, min: 95, launcher: addr(3, 'xyz') },
  { name: 'Patient Dog', symbol: 'WAIT', hue: 20, pitch: "Internet's most patient dog", vibe: ['Retro'], cap: 8_100, progress: 0.12, phase: 'curve', fee: 30, lifetime: 0.4, balance: 0.38, assets: 1, min: 22, launcher: addr(4, 'xyz') },
  { name: 'Anime Toast', symbol: 'TOAST', hue: 330, pitch: 'A slice of toast with main character energy', vibe: ['Anime'], cap: 1_210_000, progress: 1, phase: 'graduated', fee: 100, lifetime: 220, balance: 61.5, assets: 41, min: 60 * 72, launcher: addr(5, 'xyz') },
  { name: 'Moon Moth', symbol: 'MOTH', hue: 270, pitch: 'A moth that only follows green candles', vibe: ['Cinematic'], cap: null, progress: null, phase: null, fee: 0, lifetime: 1.1, balance: 0.95, assets: 2, min: 8, launcher: addr(6, 'xyz') },
].map((c, i) => ({ ...c, mint: addr(i + 1), image: logo(c.symbol, c.hue) }));

const card = (c) => ({ mint: c.mint, name: c.name, symbol: c.symbol, image: c.image, description: c.pitch, official: false, launcher: c.launcher, createdAt: iso(c.min), phase: c.phase, progress: c.progress, marketCapUsd: c.cap, creatorFeeBps: c.fee, platforms: ['x', 'tiktok'], assets: c.assets });
const doneFor = (c) => ({ launch_card: 1, ...(c.lifetime >= 3 ? { meme_pack: 1 } : {}), ...(c.lifetime >= 5 ? { video: Math.floor(c.lifetime / 5) } : {}), ...(c.phase === 'graduated' ? { trailer: 1, site: 1 } : {}) });
function budget(c) {
  const { next } = ladderFor({ lifetimeUsd: c.lifetime, graduated: c.phase === 'graduated', done: doneFor(c) });
  return { balanceUsd: c.balance, lifetimeUsd: c.lifetime, pendingAds: Math.round(c.balance * 18_000), nextStep: next };
}

const CAPTIONS = ['3am. Charts open. Frog awake.', 'First reply wins. Always.', 'Q3 letter to investors: meow.', 'Still waiting. Still winning.', 'Main character energy, toasted.', 'Follow the green light.'];
const FEED = [];
COINS.forEach((c, ci) => {
  const n = Math.min(c.assets, 4);
  for (let k = 0; k < n; k++) {
    const video = k % 2 === 1;
    const tall = video || k === 2;
    const [w, h] = tall ? [540, 960] : [800, 800];
    FEED.push({
      id: `f${ci}-${k}`, mint: c.mint, symbol: c.symbol, name: c.name, image: c.image,
      kind: video ? 'video' : 'image', mime: 'image/svg+xml', mock: true, url: poster(w, h, c.hue + k * 25, video ? `${c.symbol} TV` : c.symbol, CAPTIONS[ci]),
      thumb: poster(w, h, c.hue + k * 25, video ? `${c.symbol} TV` : c.symbol, CAPTIONS[ci]),
      caption: k === 0 ? `${c.name} just launched. ${c.pitch}.` : CAPTIONS[ci],
      postedTo: [{ platform: 'x', url: 'https://x.com/pumpfunads' }, ...(video ? [{ platform: 'tiktok', url: 'https://www.tiktok.com/@pumpfunad' }] : [])],
      createdAt: iso(c.min - k * 7 - 1),
    });
  }
});
FEED.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

function detail(c) {
  const graduated = c.phase === 'graduated';
  const { steps } = ladderFor({ lifetimeUsd: c.lifetime, graduated, done: doneFor(c) });
  const items = FEED.filter((f) => f.mint === c.mint);
  const gallery = items.map((f, i) => ({ id: `a-${f.id}`, kind: f.kind, mime: f.mime, mock: f.mock, url: f.url, thumb: f.thumb, caption: f.caption, step: i === 0 ? 'launch_card' : f.kind === 'video' ? 'video' : 'meme_pack', postedTo: f.postedTo, createdAt: f.createdAt }));
  const ledger = [
    { id: 1, kind: 'platform', usd: 0.02, note: 'Launch card (paid by Ads)', createdAt: ms(c.min) },
    ...(c.lifetime > 0 ? [{ id: 2, kind: 'credit', usd: Math.min(c.lifetime, 1.4), note: 'Daily $ADS sale, your share', createdAt: ms(c.min - 60) }] : []),
    ...(c.lifetime >= 1 ? [{ id: 3, kind: 'spend', usd: 0.15, note: 'Content pack: 4 images and captions', createdAt: ms(c.min - 62) }] : []),
    ...(c.lifetime >= 3 ? [{ id: 4, kind: 'spend', usd: 0.6, note: 'Video #1, 10 s vertical', createdAt: ms(c.min - 200) }, { id: 5, kind: 'refund', usd: 0.6, note: 'Video #2 failed moderation, refunded', createdAt: ms(c.min - 240) }] : []),
  ];
  return {
    ...card(c),
    brief: { pitch: c.pitch, vibe: c.vibe, audience: 'Night owls and degens', mascot: 'Small green frog in a hoodie, glowing monitor', platforms: ['x', 'tiktok'] },
    budget: budget(c),
    ladder: steps.map((s) => ({ key: s.key, label: s.label, detail: s.detail, state: s.state, atUsd: s.atUsd, made: s.made })),
    gallery,
    ledger: ledger.reverse(),
    socials: { x: c.symbol === 'FROG' ? { handle: '@tradingfrog' } : null, tiktok: null },
    graduated,
    site: c.symbol === 'FROG' ? {
      headline: 'The frog never sleeps',
      tagline: 'Charts at 3am. Calm as a pond.',
      paragraphs: ['Trading Frog only comes out when the timeline goes quiet. While everyone sleeps, he watches the candles, sips pond water and waits.', 'He is not here for the noise. He is here for the hour nobody else wants, and the people who are awake for it.'],
      hero: { url: poster(1600, 686, 130, 'NIGHT FROG', 'The frog never sleeps'), thumb: null, kind: 'image', mime: 'image/svg+xml' },
    } : null,
    fees: c.lifetime > 0 ? [
      { collected: 182_000, burned: 36_400, toAds: 145_600, sig: `sig${c.symbol}1`, status: 'ok', at: ms(c.min - 90), url: 'https://solscan.io/' },
      { collected: 61_000, burned: 12_200, toAds: 48_800, sig: `sig${c.symbol}2`, status: 'ok', at: ms(c.min - 30), url: 'https://solscan.io/' },
    ] : [],
    keeper: { lastRunAt: ms(4) },
    feeWallet: addr(5150),
    links: { pump: `https://pump.fun/coin/${c.mint}`, dex: `https://dexscreener.com/solana/${c.mint}`, token: `https://solscan.io/token/${c.mint}`, feeWallet: `https://solscan.io/account/${addr(5150)}` },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg, status = 400, stage = null) => Object.assign(new Error(msg), { status, stage });

let review = COINS.slice(0, 4).map((c, i) => ({ id: `r${i}`, mint: c.mint, symbol: c.symbol, name: c.name, kind: i % 2 ? 'video' : 'image', url: i % 2 ? null : poster(800, 800, c.hue, c.symbol, 'Pending review'), thumb: poster(540, 960, c.hue, c.symbol, 'Pending review'), caption: `${c.pitch}. Draft caption for review.`, step: i % 2 ? 'video' : 'meme_pack', moderation: i === 3 ? 'flagged: mentions a price' : 'ok', createdAt: iso(10 + i * 4) }));
let tiktokQ = COINS.slice(1, 4).map((c, i) => ({ id: `t${i}`, mint: c.mint, symbol: c.symbol, name: c.name, url: poster(540, 960, c.hue, c.symbol, 'Download me'), thumb: poster(540, 960, c.hue, c.symbol, 'TikTok'), caption: `${c.name}: ${CAPTIONS[i + 1]}`, createdAt: iso(30 + i * 9) }));

export async function handle(path, opts = {}) {
  await sleep(250 + Math.random() * 250);
  const u = new URL(path, location.origin);
  const p = u.pathname, m = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  let r;
  if (p === '/api/config') return { brand: 'Ads', accent: '#86EFAC', token: { mint: addr(77, 'ads'), symbol: 'ADS' }, launchOpen: !new URLSearchParams(location.search).has('closed'), feeRates: [0, 30, 100, 200, 300], maxDevBuySol: 10, vanity: { suffix: 'ads', ready: 240 }, platforms: ['x', 'tiktok'], socials: { x: '@pumpfunads', tiktok: '@pumpfunad' } };
  if (p === '/api/stats') return { coins: COINS.length, graduated: 2, feesUsd: 272.9, burnedAds: 1_284_000, videos: 31, posts: 88 };
  if (p === '/api/session') return m === 'DELETE' ? { ok: true } : m === 'POST' ? { wallet: ME } : { wallet: ME };
  if (p === '/api/nonce') return { nonce: 'mock', template: 'Sign in to Ads as YOUR_WALLET' };
  if (p === '/api/feed') {
    const before = u.searchParams.get('before');
    const limit = Math.min(Number(u.searchParams.get('limit') || 24), 12); // small pages so Load more shows
    const start = before ? FEED.findIndex((f) => f.id === before) + 1 : 0;
    const items = FEED.slice(start, start + limit);
    return { items, next: start + limit < FEED.length && items.length ? items[items.length - 1].id : null };
  }
  if (p === '/api/coins') {
    const sort = u.searchParams.get('sort') || 'new', q = (u.searchParams.get('q') || '').toLowerCase();
    let list = COINS.filter((c) => !q || c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q) || c.mint === q);
    if (sort === 'top') list = [...list].sort((a, b) => (b.cap || 0) - (a.cap || 0));
    else if (sort === 'graduated') list = list.filter((c) => c.phase === 'graduated');
    else list = [...list].sort((a, b) => a.min - b.min);
    return { coins: list.map(card) };
  }
  if ((r = p.match(/^\/api\/coins\/([^/]+)$/))) {
    const c = COINS.find((x) => x.mint === r[1]);
    if (!c) throw fail('Not launched on Ads', 404);
    return detail(c);
  }
  if ((r = p.match(/^\/api\/coins\/([^/]+)\/socials\/(x|tiktok)$/)) && m === 'DELETE') return { ok: true };
  if (p === '/api/mine') return { coins: COINS.filter((c) => c.launcher === ME).map((c) => ({ ...card(c), budget: budget(c) })) };
  if (p === '/api/launch/logo') { await sleep(900); return { imageData: logo(body.symbol || 'NEW', Math.floor(Math.random() * 360)), remaining: 2 }; }
  if (p === '/api/launch/prepare') { await sleep(600); return { mint: addr(Math.floor(Math.random() * 1e6)), feeWallet: addr(5150), transactions: ['bW9jaw=='] }; }
  if (p === '/api/launch/submit') { await sleep(900); return { mint: body.mint, status: 'live' }; }
  if (p === '/api/launch/relock') return { mint: body.mint, live: true };
  if (p === '/api/admin/overview') return { coins: COINS.length, live: 4, graduated: 2, budgetUsd: 79.6, reviewQueue: review.length, tiktokQueue: tiktokQ.length, postsToday: 7, xPostsPerDay: 20, keeper: { enabled: true, dryRun: true, lastRunAt: iso(3) }, treasury: { ads: 412_000, sol: 1.42, lastSaleAt: iso(600) } };
  if (p === '/api/admin/review') return { items: review };
  if ((r = p.match(/^\/api\/admin\/review\/([^/]+)\/(approve|reject)$/))) { review = review.filter((x) => x.id !== r[1]); return { ok: true }; }
  if (p === '/api/admin/tiktok') return { items: tiktokQ };
  if ((r = p.match(/^\/api\/admin\/tiktok\/([^/]+)\/posted$/))) { tiktokQ = tiktokQ.filter((x) => x.id !== r[1]); return { ok: true }; }
  throw fail(`Mock has no ${m} ${p}`, 404);
}
