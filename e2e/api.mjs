/**
 * End to end through Ads' REAL server code on a local validator with mainnet pump.fun cloned (e2e/validator.sh, port
 * 8994), in-process, real transactions on the local chain, real `…ads` addresses from the grinder. Stubs: pump.fun's
 * metadata upload (the one call that would leave the machine) and the content adapters (mock mode: no Higgsfield, Claude
 * or X call). SOL's USD price is read live.
 *
 *   closed / no $ADS refused → tables → prepare against $ADS on its curve, then $ADS on PumpSwap, each with a SOL first
 *   buy → tampered / unsigned / foreign submits refused → submit → creator wallet + pair read back, both addresses end
 *   in `ads` → launch card queued → buyers trade → keeper pass: 20% burned (supply checked), 80% in the treasury →
 *   treasury sale → each coin's budget credited its share → the content planner spends it (mock) → public reads.
 * node e2e/api.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { ADS_STANDINS } from './standins.mjs';

// ADS_E2E_DIR keeps the database afterwards (e2e/serve-local.sh serves the real site from it).
const tmp = process.env.ADS_E2E_DIR || fs.mkdtempSync('/tmp/ads-e2e-');
fs.mkdirSync(tmp, { recursive: true });
const keeperKp = Keypair.generate(), treasuryKp = Keypair.generate(), payoutKp = Keypair.generate();
Object.assign(process.env, {
  SOLANA_RPC: process.env.LOCAL_RPC || 'http://127.0.0.1:8994', DB_PATH: `${tmp}/ads.db`, VANITY_REQUIRED: '1', VANITY_TARGET: '2', VANITY_INCOMING: `${tmp}/in`,
  KEEPER_SECRET_KEY: JSON.stringify([...keeperKp.secretKey]), TREASURY_SECRET_KEY: JSON.stringify([...treasuryKp.secretKey]),
  PUMP_IPFS_URL: 'http://127.0.0.1:5427/ipfs', KEEPER_INTERVAL_SECONDS: '3600', PRIORITY_MICROLAMPORTS: '1000', LAUNCH_PRIORITY_MICROLAMPORTS: '1000',
  MIN_SPLIT_USD: '0', MAX_WAIT_HOURS: '0', SALE_MAX_IMPACT_BPS: '10000', MIN_SALE_USD: '0', MEDIA_DIR: `${tmp}/media`, AUTO_APPROVE: '1', TREASURY_PAYOUT_ADDRESS: payoutKp.publicKey.toBase58(), TREASURY_MIN_SWEEP_SOL: '0.01',
});
const stub = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ metadataUri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6ah6fkpkvwlfmjtx5gbd4pffoh5xm' })); }); }).listen(5427);

const sol = await import('../api/sol.mjs');
const launch = await import('../api/launch.mjs');
const market = await import('../api/market.mjs');
const keeper = await import('../api/keeper.mjs');
const treasury = await import('../api/treasury.mjs');
const ledger = await import('../api/ledger.mjs');
const vanity = await import('../api/vanity.mjs');
const content = await import('../api/content/index.mjs');
const lut = await import('../api/lut.mjs');
const { one, all, setKv } = await import('../api/db.mjs');
const pump = await import('../lib/pump.mjs');
const { ensureLaunchLut } = await import('../scripts/make-lut.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`); };
const step = async (name, fn) => { try { return await fn(); } catch (e) { check(name, false, e.message.slice(0, 400)); return null; } };
const conn = sol.conn;
const fund = async (pk, n) => { const sig = await conn.requestAirdrop(pk, n * LAMPORTS_PER_SOL); await conn.confirmTransaction(sig, 'confirmed'); };
const signB64 = (b64, kps) => { const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64')); tx.sign(kps); return Buffer.from(tx.serialize()).toString('base64'); };
const supplyOf = async (mint) => BigInt((await conn.getTokenSupply(new PublicKey(mint), 'confirmed')).value.amount);
const tokenBal = async (k) => { const a = await conn.getAccountInfo(k, 'confirmed'); return a ? pump.tokenAccountAmount(a.data) : 0n; };

const L = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(new URL('./fixtures/launcher.json', import.meta.url)))));
const buyer = Keypair.generate();
await fund(L.publicKey, 60); await fund(buyer.publicKey, 60); await fund(keeperKp.publicKey, 5); await fund(treasuryKp.publicKey, 1);
const png = fs.readFileSync(new URL('../web/public/logo.png', import.meta.url));
const W = L.publicKey.toBase58();
const brief = { pitch: 'A frog who only trades at 3am', vibe: ['Meme', 'Lo-fi'], audience: 'night owls', mascot: 'small green frog in a hoodie', platforms: ['x', 'tiktok'] };
const base = { description: 'end to end', imageData: `data:image/png;base64,${png.toString('base64')}`, brief };

/* ── setup ── */
check('launching is refused while closed', await launch.prepare({ ...base, name: 'x', symbol: 'X' }, W).then(() => false, (e) => /opens soon/.test(e.message)));
setKv('launchOpen', true);
setKv('token', null);
check('launching is refused while there is no $ADS', await launch.prepare({ ...base, name: 'x', symbol: 'X' }, W).then(() => false, (e) => /opens soon/.test(e.message)));
setKv('token', { mint: ADS_STANDINS.curve, symbol: 'ADS' });
await step('launch lookup table', () => ensureLaunchLut({ log: () => {} }));
setKv('token', null);
check('a launch without a brief is refused', await launch.prepare({ ...base, brief: {}, name: 'x', symbol: 'X' }, W).then(() => false, (e) => /Describe your coin/.test(e.message)));
vanity.start({ log: () => {}, error: console.error });
const t0 = Date.now();
while (vanity.ready() < 2 && Date.now() - t0 < 400_000) await new Promise((r) => setTimeout(r, 500));
check('the grinder made `…ads` mint and creator keys on its own', vanity.ready() >= 2, `${((Date.now() - t0) / 1000).toFixed(0)} s`);

const cases = [
  { label: '$ADS on its curve', ads: ADS_STANDINS.curve, creatorFeeBps: 300, devBuy: { amount: '1' } },
  { label: '$ADS on PumpSwap', ads: ADS_STANDINS.pool, creatorFeeBps: 100, devBuy: { amount: '0.5' } },
];
const live = [];
for (const c of cases) {
  console.log(`\n── ${c.label}`);
  setKv('token', { mint: c.ads, symbol: 'ADS' });
  const p = await step(`${c.label}: prepare`, () => launch.prepare({ ...base, name: `E2E ${c.label}`.slice(0, 32), symbol: 'ADSE2E', creatorFeeBps: c.creatorFeeBps, devBuy: c.devBuy }, W));
  if (!p) continue;
  check(`${c.label}: ONE transaction, first buy inside`, p.transactions.length === 1 && Buffer.from(p.transactions[0], 'base64').length <= 1232, `${Buffer.from(p.transactions[0], 'base64').length} B`);
  check(`${c.label}: the CA and the creator wallet both end in ads`, p.mint.endsWith('ads') && p.feeWallet.endsWith('ads'), `${p.mint} / ${p.feeWallet}`);
  check(`${c.label}: an unsigned launch is refused`, await launch.submit({ mint: p.mint, transactions: [p.transactions[0]] }, W).then(() => false, (e) => /not signed/i.test(e.message)));
  check(`${c.label}: another wallet cannot submit`, await launch.submit({ mint: p.mint, transactions: [signB64(p.transactions[0], [L])] }, Keypair.generate().publicKey.toBase58()).then(() => false, (e) => e.status === 401));
  const tampered = VersionedTransaction.deserialize(Buffer.from(p.transactions[0], 'base64'));
  tampered.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
  check(`${c.label}: a changed transaction is refused`, await launch.submit({ mint: p.mint, transactions: [Buffer.from(tampered.serialize()).toString('base64')] }, W).then(() => false, (e) => /not the transaction/i.test(e.message)));
  const r = await step(`${c.label}: submit`, () => launch.submit({ mint: p.mint, transactions: p.transactions.map((t) => signB64(t, [L])) }, W));
  check(`${c.label}: live, first buy in the launch transaction`, r?.status === 'live' && r.signatures.firstBuy === r.signatures.launch);
  const row = one('SELECT * FROM launches WHERE mint = ?', p.mint);
  check(`${c.label}: the coin's pump.fun creator is its creator wallet, on chain`, await launch.lockedTo(p.mint, row.fee_wallet, JSON.parse(row.quote_json)));
  const st = await pump.coinState(conn, p.mint);
  check(`${c.label}: paired with $ADS, fee rate as picked, brief stored`, st.quoteMint === c.ads && st.creatorFeeBps === c.creatorFeeBps && JSON.parse(row.brief_json).pitch === brief.pitch);
  check(`${c.label}: the launcher holds the first buy`, BigInt((await conn.getTokenAccountBalance(pump.ata(L.publicKey, new PublicKey(p.mint), pump.TOKEN_2022))).value.amount) >= BigInt(p.firstBuy.minOut));
  live.push({ ...c, mint: p.mint, row });
}
if (!live.length) { console.log('no launch went live: stopping'); process.exit(1); }
await new Promise((r) => setTimeout(r, 1500)); // onLaunched runs after markLive
check('a launch card was queued for every new coin, paid by Ads', live.every((c) => one("SELECT COUNT(*) AS n FROM ledger WHERE mint = ? AND kind = 'platform'", c.mint).n === 1 || one('SELECT COUNT(*) AS n FROM jobs WHERE mint = ?', c.mint).n >= 1));

/* ── trading, the keeper, the treasury ── */
console.log('\n── trading, fees, the daily sale');
const global = await pump.loadGlobal(conn);
for (const c of live) {
  const q = JSON.parse(c.row.quote_json);
  await step(`${c.label}: a trade`, async () => { const b = await lut.v0WithTables(buyer.publicKey, [...sol.budget(400_000), ...(await pump.firstBuyIxs(conn, global, { mint: new PublicKey(c.mint), user: buyer.publicKey, q, currency: 'sol', amountIn: 5_000_000_000n, minOut: 1n }))], [buyer]); const s = await sol.send(b, { skipPreflight: false }); if (s.result !== 'ok') throw new Error(JSON.stringify(s)); });
}
const supplies = {};
for (const c of live) supplies[c.mint] = await supplyOf(c.ads);
await step('keeper pass', () => keeper.tick());
for (const c of live) {
  const f = one("SELECT * FROM fees WHERE mint = ? AND status = 'ok'", c.mint);
  const dropped = supplies[c.mint] - (await supplyOf(c.ads));
  check(`${c.label}: 20% burned (supply dropped by exactly the recorded burn), 80% recorded for the treasury`, f && BigInt(f.burned) > 0n && dropped === BigInt(f.burned) && BigInt(f.burned) + BigInt(f.to_treasury) === BigInt(f.collected) && BigInt(f.burned) === (BigInt(f.collected) * 2000n) / 10000n, f ? `${f.burned} burned / ${f.to_treasury} to the treasury` : 'no fee row');
  const q = JSON.parse(c.row.quote_json);
  check(`${c.label}: treasury holds this coin's 80%`, (await tokenBal(pump.ata(treasuryKp.publicKey, new PublicKey(q.mint), new PublicKey(q.tokenProgram)))) >= BigInt(f?.to_treasury || 1n));
}
const [after] = await keeper.readPending([live[0].row]);
check('creator wallet and vaults empty after the pass', after.waiting === 0n && after.inWallet === 0n);
await step('idle keeper pass', () => keeper.tick());
check('an idle pass moves nothing more', all("SELECT * FROM fees WHERE status = 'ok'").length === live.length);

for (const c of live) {
  setKv('token', { mint: c.ads, symbol: 'ADS' });
  const note = await step(`${c.label}: treasury sale`, () => treasury.sell({ force: true }));
  check(`${c.label}: the treasury sold its $ADS for SOL, credited to the coins paired with it only`, /^sold /.test(note || '') && all('SELECT DISTINCT mint FROM ledger WHERE ref = (SELECT \'sale:\' || MAX(id) FROM sales)').every((r) => r.mint === c.mint), note);
}
const sales = all("SELECT * FROM sales WHERE status = 'ok'");
const credited = one("SELECT COALESCE(SUM(usd_micros), 0) AS s FROM ledger WHERE kind = 'credit'").s;
check('every sale credited exactly its USD value across the coins', sales.length === live.length && credited === sales.reduce((a, s) => a + s.usd_micros, 0), `$${(credited / 1e6).toFixed(2)} credited`);
check('nothing is left unsold', live.every((c) => ledger.pendingAds(c.mint) === 0n));
const swept = all("SELECT * FROM payouts WHERE kind = 'sweep' AND status = 'ok'");
const payoutBal = BigInt(await conn.getBalance(payoutKp.publicKey));
check('after each sale the treasury swept its SOL above the floor to the payout wallet', swept.length >= 1 && payoutBal === swept.reduce((a, p) => a + BigInt(p.lamports), 0n) && BigInt(await conn.getBalance(treasuryKp.publicKey)) >= 20_000_000n, `${Number(payoutBal) / 1e9} SOL swept in ${swept.length} payout(s)`);
const offCurve = (await import('../lib/pump.mjs')).bondingCurveAddress(new PublicKey(live[0].mint)).toBase58();
check('a payout to an off-curve address (a PDA) is refused', (await treasury.payout({ to: offCurve, lamports: 1000n })).result === 'refused');
check('a withdraw that would take the treasury under its floor is refused', (await treasury.payout({ to: payoutKp.publicKey.toBase58(), lamports: 10n ** 12n })).result === 'refused');
for (const c of live) console.log(`   ${c.label}: lifetime $${ledger.toUsd(ledger.lifetime(c.mint)).toFixed(2)}, balance $${ledger.toUsd(ledger.balance(c.mint)).toFixed(2)}`);

/* ── the content planner spends it (mock adapters) ── */
console.log('\n── content (mock)');
await step('content tick', () => content.tick());
await new Promise((r) => setTimeout(r, 3000));
await step('content tick 2', () => content.tick());
for (const c of live) {
  const spent = one("SELECT COALESCE(SUM(usd_micros), 0) AS s FROM ledger WHERE mint = ? AND kind = 'spend'", c.mint).s;
  const jobs = all('SELECT step, status FROM jobs WHERE mint = ?', c.mint);
  check(`${c.label}: the planner spent from its budget on content`, spent > 0 && jobs.some((j) => j.step !== 'launch_card'), jobs.map((j) => `${j.step}:${j.status}`).join(' '));
  check(`${c.label}: the budget never goes below zero`, ledger.balance(c.mint) >= 0);
}

/* ── public reads ── */
console.log('\n── public reads');
const l = await step('list', () => market.list({}));
check('list shows every live coin with a market cap', l?.coins.length === live.length && l.coins.every((x) => x.marketCapUsd > 0 || x.phase), l?.coins.map((x) => `${x.symbol}:${x.phase}:${x.marketCapUsd?.toFixed(0)}`).join(' '));
const g = await step('coin page', () => market.get(live[0].mint));
check('coin page: budget, ladder, ledger, fees', g?.budget?.lifetimeUsd > 0 && g.ladder.length === 5 && g.ledger.length > 0 && g.fees.length === 1, JSON.stringify(g?.budget));
const s = await step('stats', () => market.stats());
check('stats', s?.coins === live.length && s.feesUsd > 0 && s.burnedAds > 0, JSON.stringify(s));
const f = content.feed({ limit: 20 });
check('the feed has content', (f.items || []).length > 0, `${f.items?.length} items`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(new URL('./last-api-run.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
stub.close();
process.exit(failed.length ? 1 : 0);
