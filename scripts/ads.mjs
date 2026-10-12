/**
 * Operator commands. On the server, in the app directory: NODE_ENV=production node scripts/ads.mjs <cmd>   (reads .env)
 *   status                    launching open?, $ADS, tables, address pools, coins, fees, treasury, keeper
 *   open | close              launching on or off (kv launchOpen; launching also needs $ADS set)
 *   hide <MINT> | unhide <MINT>   take a coin off the lists (its fees still fund its ads)
 *   check <CA>                will Pumpfun accept this token as the pair? (read only)
 *   golive <CA> [SYMBOL] [NAME]   $ADS goes LIVE: checked as a pair (a pump.fun coin, SOL or USDC paired, not mayhem
 *                             mode), its accounts put in a lookup table (keeper pays ~0.0011 SOL), listed as the
 *                             official token, CA in the pill, LAUNCHING OPENED. One step.
 *   sell [--force]            the treasury's sale now (normally daily, SALE_HOUR_UTC)
 *   withdraw <SOL|all> <ADDRESS>  SOL out of the treasury now (keeps TREASURY_FLOOR_SOL for the sales). The automatic
 *                             version: TREASURY_PAYOUT_ADDRESS in .env sweeps after every sale.
 *   higgsfield [topup <USD> | set <USD>]   Higgsfield credit (paid off chain, no balance API): record a top-up, or set
 *                             the true balance from https://console.higgsfield.ai. A top-up / set also lifts the pause
 *                             that a "no credit" refusal puts on content generation.
 *   demo-coin <WALLET> | off   a site-only demo coin (status 'demo', bonded, one real video) for app reviews: its page
 *                             has Link TikTok / X and Send to TikTok for that wallet. Not listed, never touched by keeper/planner.
 *   token off                 unlists $ADS from the pill (launching closes: there is nothing to pair with)
 *   rehearse [--live] [--open]   the mainnet launch rehearsal (needs $ADS; works while launching is closed): DRY by
 *                             default (prepare + simulate). --live launches ADSTEST from a rehearsal wallet, checks it on
 *                             the public site, HIDES it, sends leftover SOL back to the funder; --open then opens launching
 */
import '../api/env.mjs';
import { readFileSync } from 'node:fs';
import { getKv, setKv, one, run, now } from '../api/db.mjs';
import * as vanity from '../api/vanity.mjs';
import * as sol from '../api/sol.mjs';
import { storeImage, squareLogo } from '../api/images.mjs';
import { resolveQuote, readQuoteControl } from '../lib/pump.mjs';

const flags = new Set(process.argv.slice(2).filter((x) => x.startsWith('--')));
const [cmd, a, b, c] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const closed = flags.has('--closed');
const isMint = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || '');
// $ADS (operator 12 Oct relaunch): name Pumpfun Ads, ticker ADS, their logo (brand/logo.png, the image the coin carries on
// Pumpfun), created by their wallet (TREASURY_PAYOUT_ADDRESS, or --creator=<wallet>).
const OFFICIAL = { name: 'Pumpfun Ads', symbol: 'ADS', description: 'Official Pumpfun Ads token.', logo: new URL('../brand/logo.png', import.meta.url) };

async function logo() {
  const path = storeImage(readFileSync(OFFICIAL.logo));
  await squareLogo(path.split('/').pop());
  return path;
}
async function check(ca) {
  const q = await resolveQuote(sol.conn, ca, { listed: await readQuoteControl(sol.conn) });
  if (!q.ok) throw new Error(`Pumpfun will NOT accept ${ca} as a pair: ${q.reason}`);
  if (q.kind === 'listed') throw new Error(`${ca} is on pump.fun's custom-pair list, not a pump coin: a first buy in SOL would not route. Ask before using it.`);
  return q;
}

if (cmd === 'open' || cmd === 'close') { setKv('launchOpen', cmd === 'open'); console.log(`launching ${cmd === 'open' ? 'OPEN' : 'closed'}${cmd === 'open' && !getKv('token', null) && !process.env.ADS_MINT ? ' (but no $ADS yet: the site still says launching opens soon)' : ''}`); }
else if (cmd === 'hide' || cmd === 'unhide') {
  if (!isMint(a)) throw new Error('usage: hide|unhide <MINT>');
  const r = run('UPDATE launches SET hidden = ? WHERE mint = ?', cmd === 'hide' ? 1 : 0, a);
  console.log(r.changes ? `${a} ${cmd === 'hide' ? 'hidden' : 'shown'}` : 'no such coin');
} else if (cmd === 'check') {
  if (!isMint(a)) throw new Error('usage: check <CA>');
  const q = await check(a);
  console.log(`OK: Pumpfun accepts it as a pair (${q.kind === 'curve' ? 'on its curve' : 'on PumpSwap'}, ${q.tokenProgram === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ? 'Token-2022' : 'classic token'}, ${q.decimals} decimals)`);
} else if (cmd === 'golive') {
  if (!isMint(a)) throw new Error('usage: golive <CA> [SYMBOL] [NAME]');
  // The pair's lookup table is paid by the keeper: without its key the first launch would wait for it (11 Oct).
  if (!sol.loadKeeper()) throw new Error('no keeper key in this process (KEEPER_KEY_FILE): fix .env first, nothing changed');
  const t0 = Date.now();
  const q = await check(a);
  const symbol = (b || OFFICIAL.symbol).replace(/^\$/, '').toUpperCase(), name = c || OFFICIAL.name;
  const creatorArg = [...flags].find((f) => f.startsWith('--creator='))?.split('=')[1];
  const creator = isMint(creatorArg) ? creatorArg : isMint(process.env.TREASURY_PAYOUT_ADDRESS) ? process.env.TREASURY_PAYOUT_ADDRESS : 'external';
  if (!one('SELECT 1 FROM launches WHERE mint = ?', a)) {
    run(`INSERT INTO launches (mint, launcher, fee_wallet, name, symbol, description, image, metadata_uri, socials_json, quote_mint, quote_json, quote_symbol, creator_fee_bps, status, origin, official, created_at, live_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', '{}', '', ?, NULL, 0, 'live', 'external', 1, ?, ?, ?)`,
    a, creator, `external:${a}`, name, symbol, OFFICIAL.description, await logo(), JSON.stringify({ kind: 'external', marketMint: a, pairMint: 'So11111111111111111111111111111111111111112' }), now(), now(), now());
  }
  // FIRST the site (operator: "not minutes"): $ADS listed, CA in the pill, launching open, all in this second.
  setKv('token', { mint: a, symbol, decimals: q.decimals, tokenProgram: q.tokenProgram });
  if (!closed) setKv('launchOpen', true);
  console.log(`LIVE in ${((Date.now() - t0) / 1000).toFixed(1)} s: $${symbol} ${a} is the pair, CA in the pill, ${closed ? 'launching still CLOSED (rehearse, then open)' : 'LAUNCHING OPEN'}`);
  // THEN the pair's lookup table, while the site is already open (a launch in these seconds makes it itself).
  const lut = await import('../api/lut.mjs');
  const { staticAccounts } = await import('./make-lut.mjs');
  const t1 = Date.now();
  await lut.ensureQuote(q, await staticAccounts()).then(() => console.log(`pair lookup table ready in ${((Date.now() - t1) / 1000).toFixed(1)} s`)).catch((e) => console.log(`(pair table: ${e.message}; made on the first launch instead)`));
} else if (cmd === 'watch') {
  // Waits for a CA that is known before it exists (the operator's own vanity) and runs golive the moment Pumpfun accepts
  // it: one cheap read every WATCH_SECONDS (default 5), for at most WATCH_HOURS (default 48). A coin that exists but is
  // REFUSED as a pair (mayhem mode, not SOL/USDC paired...) is logged and the watch stops: nothing goes live.
  if (!isMint(a)) throw new Error('usage: watch <CA>');
  const every = Math.max(2, Number(process.env.WATCH_SECONDS || 5)) * 1000;
  const until = Date.now() + Number(process.env.WATCH_HOURS || 48) * 3_600_000;
  const { spawnSync } = await import('node:child_process');
  console.log(`${new Date().toISOString()} watching ${a} every ${every / 1000} s`);
  for (let n = 0; Date.now() < until; n++) {
    const info = await sol.conn.getAccountInfo(new (await import('@solana/web3.js')).PublicKey(a), 'confirmed').catch(() => undefined);
    if (info) {
      const q = await resolveQuote(sol.conn, a, { listed: await readQuoteControl(sol.conn) }).catch((e) => ({ ok: false, reason: e.message }));
      if (q.ok && q.kind !== 'listed') {
        // --dry (checked HERE, in code): report and stop. 11 Oct a "harmless" test on prod ran the real golive.
        if (flags.has('--dry')) { console.log(`${new Date().toISOString()} ${a} is on Pumpfun (${q.kind}): DRY, would go live now`); process.exit(0); }
        console.log(`${new Date().toISOString()} ${a} is on Pumpfun (${q.kind}): going live`);
        const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'golive', a, ...process.argv.slice(4)], { stdio: 'inherit', env: process.env });
        process.exit(r.status ?? 1);
      }
      if (q.reason && /waiting for its pool|Try again/.test(q.reason)) { await sol.sleep(every); continue; }
      console.log(`${new Date().toISOString()} ${a} exists but Pumpfun REFUSES it as a pair: ${q.reason}. Nothing went live.`);
      process.exit(2);
    }
    if (n % 60 === 0) console.log(`${new Date().toISOString()} not on chain yet`);
    await sol.sleep(every);
  }
  console.log('watch window ended without the coin');
} else if (cmd === 'watch-creator') {
  // The CA is NOT known in advance (operator 12 Oct: "launch it with fomosZ2…, ticker ADS"): watch the launch WALLET.
  // A live log subscription on it fires within ~1 s of any confirmed transaction it signs; a poll every
  // WATCH_POLL_SECONDS (default 15) covers a dropped socket. Each new transaction is read once; the first Pumpfun
  // create (create or create_v2, top level or inner) whose ticker is SYMBOL runs golive on its mint with NAME.
  // Ticker read from the create instruction itself (no extra request). Other transactions of the wallet are ignored.
  //   watch-creator <WALLET> [SYMBOL=ADS] [NAME="Pumpfun Ads"] [--dry]
  if (!isMint(a)) throw new Error('usage: watch-creator <WALLET> [SYMBOL] [NAME] [--dry]');
  const want = (b || OFFICIAL.symbol).replace(/^\$/, '').toUpperCase(), name = c || OFFICIAL.name;
  const { PublicKey } = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;
  const { createHash } = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');
  const { PUMP } = await import('../lib/pump.mjs');
  const disc = (n) => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8);
  const CREATES = [disc('create'), disc('create_v2')];
  const wallet = new PublicKey(a);
  const until = Date.now() + Number(process.env.WATCH_HOURS || 24) * 3_600_000;
  const seen = new Set((await sol.conn.getSignaturesForAddress(wallet, { limit: 50 }, 'confirmed')).map((s) => s.signature));
  const str = (buf, o) => { const n = buf.readUInt32LE(o); return [buf.subarray(o + 4, o + 4 + n).toString('utf8'), o + 4 + n]; };
  /** The {mint, name, symbol} of a Pumpfun create in this transaction, or null. Reads any tx version (see memory). */
  async function createIn(sig) {
    const tx = await sol.conn._rpcRequest('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 5 }]);
    const r = tx?.result;
    if (!r) return undefined; // not readable yet: retried
    if (r.meta?.err) return null;
    const keys = [...r.transaction.message.accountKeys, ...(r.meta?.loadedAddresses?.writable || []), ...(r.meta?.loadedAddresses?.readonly || [])];
    const ixs = [...(r.transaction.message.instructions || []), ...(r.meta?.innerInstructions || []).flatMap((x) => x.instructions)];
    for (const ix of ixs) {
      if (keys[ix.programIdIndex] !== PUMP.toBase58()) continue;
      const data = Buffer.from(bs58.decode(ix.data));
      if (!CREATES.some((d) => data.subarray(0, 8).equals(d))) continue;
      const [nm, o1] = str(data, 8); const [sym] = str(data, o1);
      return { mint: keys[ix.accounts[0]], name: nm, symbol: sym };
    }
    return null;
  }
  let busy = false, again = false;
  async function scan(why) {
    if (busy) { again = true; return; } busy = true; again = false;
    let pending = false;
    try {
      const sigs = (await sol.conn.getSignaturesForAddress(wallet, { limit: 20 }, 'confirmed')).filter((s) => !seen.has(s.signature)).reverse();
      for (const s of sigs) {
        const found = await createIn(s.signature);
        if (found === undefined) { pending = true; continue; } // not readable yet: read again in 1 s
        seen.add(s.signature);
        if (!found) continue;
        const ok = found.symbol.replace(/^\$/, '').toUpperCase() === want;
        console.log(`${new Date().toISOString()} [${why}] ${a.slice(0, 6)}… created $${found.symbol} "${found.name}" ${found.mint}${ok ? '' : ` (not $${want}: ignored)`}`);
        if (!ok) continue;
        if (flags.has('--dry')) { console.log('DRY: would go live now'); process.exit(0); }
        // golive's own check waits for nothing: a brand-new curve is readable in the same slot. Retry briefly if not.
        for (let i = 0; i < 10; i++) {
          const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'golive', found.mint, want, name], { stdio: 'inherit', env: process.env });
          if (r.status === 0) process.exit(0);
          await sol.sleep(1500);
        }
        console.log('golive kept failing: run it by hand'); process.exit(1);
      }
    } catch (e) { console.log(`${new Date().toISOString()} scan (${why}) failed: ${e.message}`); }
    finally { busy = false; }
    // A signal that came in mid-scan, or a transaction not readable yet: look again in 1 s, not at the next poll.
    if (pending || again) setTimeout(() => scan('retry'), 1000);
  }
  sol.conn.onLogs(wallet, () => scan('live'), 'confirmed');
  console.log(`${new Date().toISOString()} watching ${a} for a Pumpfun create of $${want} (name ${name}); ${seen.size} earlier transactions skipped${flags.has('--dry') ? '; DRY' : ''}`);
  const poll = Math.max(5, Number(process.env.WATCH_POLL_SECONDS || 15)) * 1000;
  while (Date.now() < until) { await sol.sleep(poll); await scan('poll'); }
  console.log('watch window ended without the coin'); process.exit(0);
} else if (cmd === 'sell') {
  const t = await import('../api/treasury.mjs');
  console.log(await t.sell({ force: flags.has('--force') }));
} else if (cmd === 'withdraw') {
  if (!(a === 'all' || /^\d+(\.\d+)?$/.test(a || '')) || !isMint(b)) throw new Error('usage: withdraw <SOL|all> <ADDRESS>');
  const t = await import('../api/treasury.mjs');
  console.log(await t.payout({ to: b, lamports: a === 'all' ? null : BigInt(Math.round(Number(a) * 1e9)), kind: 'withdraw' }));
} else if (cmd === 'higgsfield') {
  const cr = await import('../api/content/credits.mjs');
  if ((a === 'topup' || a === 'set') && !(Number(b) > 0 || (a === 'set' && b === '0'))) throw new Error(`usage: higgsfield ${a} <USD>`);
  const wasOut = Boolean(getKv('hf:outOfCredits', null));
  const st = a === 'topup' ? cr.topup(Number(b), c || null) : a === 'set' ? cr.setBalance(Number(b)) : cr.higgsfield();
  if ((a === 'topup' || a === 'set') && wasOut) { setKv('content.killed', false); console.log('content generation RESUMED (it was paused for credit)'); }
  console.log({ balanceUsd: Number(st.balanceUsd.toFixed(2)), spent24hUsd: Number(st.spent24hUsd.toFixed(2)), daysLeft: st.daysLeft == null ? null : Number(st.daysLeft.toFixed(1)), low: st.low, outOfCredits: st.outOfCredits, recent: cr.history(5).map((h) => `${h.kind} $${(h.usd_micros / 1e6).toFixed(2)} ${new Date(h.created_at).toISOString().slice(0, 16)}`) });
} else if (cmd === 'rehearse') {
  // ⛔ DRY unless --live: a dry run prepares and SIMULATES the real launch (pump.fun metadata upload included), sends nothing.
  const launch = await import('../api/launch.mjs');
  const keys = await import('../api/keys.mjs');
  const { Keypair, PublicKey, SystemProgram, VersionedTransaction, TransactionMessage } = await import('@solana/web3.js');
  if (!keys.walletKeypair('rehearsal', 'launcher')) keys.storeWallet('rehearsal', Keypair.generate(), 'launcher'); // encrypted, in the backups
  const kp = keys.walletKeypair('rehearsal', 'launcher');
  // `rehearse wallet`: only print the address, so it can be funded before $ADS exists.
  if (a === 'wallet') { console.log(`rehearsal wallet (fund it with ~0.07 SOL):\n\n    ${kp.publicKey.toBase58()}\n`); process.exit(0); }
  if (!launch.adsMint()) throw new Error('no $ADS yet: run golive <CA> first');
  const w = kp.publicKey.toBase58();
  const base = process.env.PUBLIC_URL || 'https://pumpfunads.com';
  const lamports = async () => BigInt(await sol.conn.getBalance(kp.publicKey, 'confirmed'));
  const before = await lamports();
  console.log(`rehearsal wallet (fund it with ~0.07 SOL; the leftover goes back to whoever sent it):\n\n    ${w}\n\nbalance ${Number(before) / 1e9} SOL`);
  if (before < 65_000_000n) { console.log('⛔ fund the wallet above first (0.07 SOL), then run this again'); process.exit(1); }
  const body = {
    name: 'Ads Rehearsal', symbol: 'ADSTEST', description: 'A test launch by pumpfunads.com. Not a real coin: do not buy it.',
    brief: { pitch: 'A test of the pumpfunads.com launch flow. Not a real coin.', platforms: ['x'] },
    creatorFeeBps: 0, devBuy: { amount: '0.01' },
    imageData: `data:image/png;base64,${readFileSync(new URL('../brand/rehearsal.png', import.meta.url)).toString('base64')}`,
  };
  const p = await launch.prepare(body, w, { closedOk: true });
  console.log(`✅ prepared + simulated: ${p.mint} (creator wallet ${p.feeWallet}), first buy est. ${p.firstBuy?.estimate} units`);
  // Hidden BEFORE it exists: no paid launch card is queued (planner.onLaunched skips hidden coins).
  run('UPDATE launches SET hidden = 1 WHERE mint = ?', p.mint);
  if (!flags.has('--live')) { console.log('DRY: nothing sent. Run again with --live to launch it for real (add --open to open launching after).'); process.exit(0); }
  const tx = VersionedTransaction.deserialize(Buffer.from(p.transactions[0], 'base64'));
  tx.sign([kp]);
  const r = await launch.submit({ mint: p.mint, transactions: [Buffer.from(tx.serialize()).toString('base64')] }, w);
  const spent = before - (await lamports());
  console.log(`✅ LIVE: ${r.signatures.launch}  (wallet spent ${Number(spent) / 1e9} SOL, first buy included)`);
  const get = async (path) => (await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000) }).catch(() => ({ status: 0 }))).status;
  const listed = async () => ((await (await fetch(`${base}/api/coins?limit=100`, { signal: AbortSignal.timeout(20_000) })).json()).coins || []).some((x) => x.mint === p.mint);
  // A placeholder launch card BEFORE it is shown: the server's planner sees one already made and queues no paid content
  // for the rehearsal coin in the second it is visible.
  run("INSERT INTO jobs (mint, step, seq, status, paid_by, created_at, updated_at) VALUES (?, 'launch_card', 1, 'posted', 'platform', ?, ?)", p.mint, now(), now());
  // On the website briefly (operator: shown, then removed), checked through the PUBLIC URL.
  run('UPDATE launches SET hidden = 0 WHERE mint = ?', p.mint);
  await sol.sleep(1500);
  const shown = { api: await get(`/api/coins/${p.mint}`), page: await get(`/t/${p.mint}`), listed: await listed() };
  run('UPDATE launches SET hidden = 1 WHERE mint = ?', p.mint);
  run("UPDATE jobs SET status = 'rejected' WHERE mint = ? AND status IN ('queued', 'generating', 'review', 'approved')", p.mint);
  await sol.sleep(1500);
  const gone = { api: await get(`/api/coins/${p.mint}`), listed: await listed() };
  console.log(`${shown.api === 200 && shown.page === 200 && shown.listed ? '✅' : '❌'} on the site while shown: api ${shown.api}, page ${shown.page}, listed ${shown.listed}`);
  console.log(`${gone.api === 404 && !gone.listed ? '✅' : '❌'} removed from the site: api ${gone.api}, listed ${gone.listed}  (the coin stays on pump.fun forever; its fees are still swept)`);
  // Leftover SOL back to the wallet that FUNDED it (the payer of the first incoming transfer).
  const sigs = await sol.conn.getSignaturesForAddress(kp.publicKey, { limit: 50 }, 'confirmed');
  const first = sigs.length ? await sol.conn.getTransaction(sigs.at(-1).signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }) : null;
  const funder = first?.transaction.message.staticAccountKeys[0]?.toBase58();
  const left = await lamports();
  if (funder && funder !== w && left > 10_000n) {
    const { blockhash, lastValidBlockHeight } = await sol.conn.getLatestBlockhash('confirmed');
    const back = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(funder), lamports: Number(left - 5_000n) })] }).compileToV0Message());
    back.sign([kp]);
    const s = await sol.send({ tx: back, lastValidBlockHeight }, { skipPreflight: false });
    console.log(`${s.result === 'ok' ? '✅' : '❌'} ${Number(left - 5_000n) / 1e9} SOL back to the funder ${funder}: ${s.sig} (${s.result})`);
  } else console.log(`leftover ${Number(left) / 1e9} SOL stays in the rehearsal wallet (funder ${funder || 'unknown'})`);
  const passed = shown.api === 200 && shown.page === 200 && shown.listed && gone.api === 404 && !gone.listed;
  if (flags.has('--open')) {
    if (passed) { setKv('launchOpen', true); console.log('LAUNCHING OPEN'); } else console.log('⛔ a check failed above: launching stays CLOSED (`open` when it is understood)');
  }
  console.log(`coin: https://pump.fun/coin/${p.mint}  (hidden here; \`unhide ${p.mint}\` to show it again)`);
} else if (cmd === 'demo-coin') {
  // A coin that exists only on this site, for app reviews (TikTok's demo video): status 'demo', reachable by its
  // address only, counted as bonded so its page offers account linking, with one real 9:16 video in its gallery.
  // No list, keeper, planner or poster reads it. `demo-coin off` deletes it, its linked accounts and its files.
  const { Keypair } = await import('@solana/web3.js');
  const { execFileSync } = await import('node:child_process');
  const media = await import('../api/content/media.mjs');
  const old = one("SELECT mint FROM launches WHERE status = 'demo'");
  if (a === 'off') {
    if (!old) { console.log('no demo coin'); process.exit(0); }
    for (const t of ['posts', 'assets', 'jobs', 'socials', 'decisions']) run(`DELETE FROM ${t} WHERE mint = ?`, old.mint);
    run("DELETE FROM launches WHERE mint = ? AND status = 'demo'", old.mint);
    const { rmSync } = await import('node:fs');
    rmSync(media.dirOf(old.mint), { recursive: true, force: true });
    console.log(`demo coin ${old.mint} deleted`);
    process.exit(0);
  }
  if (!isMint(a)) throw new Error('usage: demo-coin <WALLET you sign in with> | demo-coin off');
  if (old) { console.log(`a demo coin exists: ${process.env.PUBLIC_URL || 'https://pumpfunads.com'}/t/${old.mint}  (demo-coin off first to make a new one)`); process.exit(0); }
  const m = Keypair.generate().publicKey.toBase58();
  const frame = new URL('../brand/demo-frame.png', import.meta.url).pathname; // logo + "DEMO COIN" (brand/demo-frame.png)
  const dir = media.dirOf(m);
  // 8 s, 1080x1920, H.264 + silent AAC (TikTok wants a normal phone video): the frame with a slow zoom and a fade in.
  // No drawtext (needs an ffmpeg built with freetype): the text is in the frame already.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', '30', '-i', frame, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-vf', "scale=1188:2112,zoompan=z='min(1.1,1+on/2400)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=240:s=1080x1920:fps=30,fade=t=in:st=0:d=1",
    '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', `${dir}/demo.mp4`]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '3', '-i', `${dir}/demo.mp4`, '-frames:v', '1', '-vf', 'scale=540:-2', `${dir}/demo.jpg`]);
  const t = now();
  run(`INSERT INTO launches (mint, launcher, fee_wallet, name, symbol, description, image, metadata_uri, socials_json, brief_json, quote_mint, quote_json, quote_symbol, creator_fee_bps, status, origin, created_at, live_at, updated_at)
       VALUES (?, ?, ?, 'Demo Coin', 'DEMO', ?, ?, '', '{}', ?, ?, ?, 'ADS', 0, 'demo', 'ads', ?, ?, ?)`,
  m, a, `demo:${m}`, 'A demo coin on Ads, to show how a creator links TikTok and receives drafts.', await logo(),
  JSON.stringify({ pitch: 'A demo coin, to show how creators link TikTok and get their videos as drafts.', vibe: ['Meme'], platforms: ['x', 'tiktok'] }),
  getKv('token', null)?.mint || 'So11111111111111111111111111111111111111112', JSON.stringify({ kind: 'demo', decimals: 6 }), t, t, t);
  const job = Number(run("INSERT INTO jobs (mint, step, seq, status, paid_by, created_at, updated_at, reviewed_at, posted_at) VALUES (?, 'video', 1, 'posted', 'platform', ?, ?, ?, ?)", m, t, t, t, t).lastInsertRowid);
  run("INSERT INTO assets (job_id, mint, idx, kind, path, thumb, mime, width, height, duration, caption, mock, created_at) VALUES (?, ?, 0, 'video', 'demo.mp4', 'demo.jpg', 'video/mp4', 1080, 1920, 8, ?, 0, ?)",
    job, m, 'Demo video made by Ads.', t);
  console.log(`demo coin: ${process.env.PUBLIC_URL || 'https://pumpfunads.com'}/t/${m}\nsign in there with ${a}: the "Your accounts" card has Link TikTok, and the video has "Send to TikTok"`);
} else if (cmd === 'token' && a === 'off') { setKv('token', null); console.log('$ADS removed: launching shows "opens soon"'); }
else if (cmd === 'status' || !cmd) {
  console.log({
    launchOpen: Boolean(getKv('launchOpen', false)), token: getKv('token', null), launchLut: getKv('launchLut', null), pairTables: (getKv('pairLuts', []) || []).map((t) => `${t.address} (${t.quotes.length})`),
    addressesReady: { mint: vanity.freshCount('mint'), creator: vanity.freshCount('creator') },
    coins: one("SELECT COUNT(*) AS n FROM launches WHERE status = 'live' AND origin = 'ads'").n,
    feePasses: one("SELECT COUNT(*) AS n FROM fees WHERE status = 'ok'").n, pendingFeePasses: one("SELECT COUNT(*) AS n FROM fees WHERE status = 'pending'").n,
    sales: one("SELECT COUNT(*) AS n, COALESCE(SUM(usd_micros), 0) AS usd FROM sales WHERE status = 'ok'"),
    keeper: getKv('keeper', null), treasury: getKv('treasury', null),
  });
} else { console.error('commands: status | open | close | hide|unhide <MINT> | check <CA> | golive <CA> [SYMBOL] [NAME] | sell [--force] | withdraw <SOL|all> <ADDRESS> | higgsfield [topup|set <USD>] | token off'); process.exit(1); }
process.exit(0);
