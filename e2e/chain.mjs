/**
 * The money path on a local validator with mainnet pump.fun cloned (e2e/validator.sh, port 8994), lib level, for $ADS
 * on its curve and $ADS graduated to PumpSwap (real mainnet pump coins stand in for it):
 *   lookup tables → ONE-transaction launch (paired create_v2 with the coin's CREATOR WALLET as creator + the launcher's
 *   first buy, SOL → $ADS → coin) → buyers trade → creator fees accrue in $ADS → keeper: collect + burn 20% + 80% to
 *   the treasury in one tx (keeper pays, creator wallet signs) → $ADS supply drops by exactly the burn → treasury sells
 *   its $ADS for SOL (multi_hop_swap, one hop) → SOL received ≈ quote.
 * node e2e/chain.mjs
 */
import fs from 'node:fs';
import { AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import * as pump from '../lib/pump.mjs';
import { ADS_STANDINS } from './standins.mjs';

const conn = new Connection(process.env.LOCAL_RPC || 'http://127.0.0.1:8994', 'confirmed');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fund = async (pk, n) => { const sig = await conn.requestAirdrop(pk, n * LAMPORTS_PER_SOL); await conn.confirmTransaction(sig, 'confirmed'); };
const tokenBal = async (k) => { const a = await conn.getAccountInfo(k, 'confirmed'); return a ? pump.tokenAccountAmount(a.data) : 0n; };
const supplyOf = async (mint) => BigInt((await conn.getTokenSupply(new PublicKey(mint), 'confirmed')).value.amount);

async function sendIxs(payer, ixs, signers, luts = [], units = 600_000) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs] }).compileToV0Message(luts);
  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...signers]);
  const bytes = tx.serialize().length;
  const sig = await conn.sendTransaction(tx, { skipPreflight: true });
  const st = await conn.confirmTransaction(sig, 'confirmed');
  if (st.value.err) {
    const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    throw new Error(`${JSON.stringify(st.value.err)} ${(t?.meta?.logMessages || []).slice(-6).join(' | ')}`);
  }
  return { sig, bytes };
}

async function makeLut(authority, addresses) {
  const slot = await conn.getSlot('finalized');
  const [create, lutAddr] = AddressLookupTableProgram.createLookupTable({ authority: authority.publicKey, payer: authority.publicKey, recentSlot: slot });
  await sendIxs(authority, [create], []);
  for (let i = 0; i < addresses.length; i += 25) {
    await sendIxs(authority, [AddressLookupTableProgram.extendLookupTable({ lookupTable: lutAddr, authority: authority.publicKey, payer: authority.publicKey, addresses: addresses.slice(i, i + 25) })], []);
  }
  await sleep(1200); // entries activate from the next slot
  return (await conn.getAddressLookupTable(lutAddr)).value;
}

const launcher = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(new URL('./fixtures/launcher.json', import.meta.url)))));
const keeper = Keypair.generate();
const treasury = Keypair.generate();
const buyers = [Keypair.generate(), Keypair.generate()];
await fund(launcher.publicKey, 50); await fund(keeper.publicKey, 5); await fund(treasury.publicKey, 1); for (const b of buyers) await fund(b.publicKey, 50);

const global = await pump.loadGlobal(conn);
const entries = await pump.readQuoteControlEntries(conn);
const listed = entries.map((e) => e.mint);
const quotes = {};
for (const [k, addr] of Object.entries(ADS_STANDINS)) quotes[k] = await pump.resolveQuote(conn, addr, { listed });
check('both $ADS stand-ins resolve as pairs', Object.values(quotes).every((q) => q.ok), Object.entries(quotes).map(([k, q]) => `${k}:${q.kind || q.reason}`).join(' '));

const staticKeys = await pump.launchStaticAccounts(conn, quotes.curve, quotes.pool);
const staticLut = await makeLut(keeper, staticKeys);
const curveLut = await makeLut(keeper, await pump.quoteAccounts(conn, quotes.curve, staticKeys));
const poolLut = await makeLut(keeper, await pump.quoteAccounts(conn, quotes.pool, staticKeys));
check('lookup tables', staticLut && poolLut && curveLut, `static ${staticLut.state.addresses.length}, curve ${curveLut.state.addresses.length}, pool ${poolLut.state.addresses.length}`);

const cases = [
  { label: '$ADS on its curve', q: quotes.curve, amount: 1_000_000_000n, bps: 300, luts: [staticLut, curveLut] },
  { label: '$ADS on PumpSwap', q: quotes.pool, amount: 500_000_000n, bps: 0, luts: [staticLut, poolLut] },
];

for (const c of cases) {
  console.log(`\n── ${c.label}`);
  const mint = Keypair.generate(), creator = Keypair.generate();
  const M = mint.publicKey, Q = new PublicKey(c.q.mint), qProg = new PublicKey(c.q.tokenProgram);
  try {
    // 1. ONE transaction: the coin (creator = its creator wallet) and the launcher's first buy in SOL.
    const reserves = await pump.quoteReserves(conn, c.q);
    const est = pump.quoteFirstBuy({ global, q: c.q, entries, reserves, currency: 'sol', amountIn: c.amount });
    const minOut = (est * 90n) / 100n;
    const ixs = await pump.launchIxs(conn, { mint: M, user: launcher.publicKey, creator: creator.publicKey, name: 'A'.repeat(32), symbol: 'ADSTEST', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6ah6fkpkvwlfmjtx5gbd4pffoh5xm', quote: c.q, creatorFeeBps: c.bps, firstBuy: { global, currency: 'sol', amountIn: c.amount, minOut } });
    const { bytes } = await sendIxs(launcher, ixs, [mint], c.luts, 900_000);
    check('launch + first buy land in ONE transaction', bytes <= 1232, `${bytes} B`);
    const curve = pump.decodeBondingCurve((await conn.getAccountInfo(pump.bondingCurveAddress(M))).data);
    check('paired with $ADS', curve.quote_mint.toBase58() === c.q.mint);
    check('the coin\'s pump.fun creator is its creator wallet (every creator fee goes there)', (await pump.coinCreator(conn, M, c.q)) === creator.publicKey.toBase58());
    check('creator fee rate stored', Number(curve.creator_fee_bps) === c.bps, `${curve.creator_fee_bps} bps`);
    const got = await tokenBal(pump.ata(launcher.publicKey, M, pump.TOKEN_2022));
    check('the dev buy\'s tokens are the LAUNCHER\'s', got >= minOut, `${got} tokens, min ${minOut}`);
    check('the creator wallet holds none of the coin and no SOL', (await tokenBal(pump.ata(creator.publicKey, M, pump.TOKEN_2022))) === 0n && (await conn.getBalance(creator.publicKey)) === 0);

    // 2. buyers trade; fees accrue in $ADS
    for (const b of buyers) await sendIxs(b, await pump.firstBuyIxs(conn, global, { mint: M, user: b.publicKey, q: c.q, currency: 'sol', amountIn: 2_000_000_000n, minOut: 1n }), [], c.luts);
    const pending = await pump.pendingQuoteFees(conn, { mint: M, quote: c.q, creator: creator.publicKey });
    check('creator fees accrue in $ADS', pending.total > 0n, `${pending.total} units waiting`);

    // 3. the keeper's pass: collect + burn 20% + 80% to the treasury; keeper pays, creator wallet signs as owner
    const supply0 = await supplyOf(Q);
    const split = await pump.splitIxs({ payer: keeper.publicKey, creator: creator.publicKey, treasury: treasury.publicKey, quote: c.q, amount: pending.total });
    const pass = await sendIxs(keeper, [...(await pump.collectIxs(conn, { mint: M, payer: keeper.publicKey, creator: creator.publicKey, quote: c.q, graduated: pending.graduated })), ...split.ixs], [creator], c.luts);
    const supply1 = await supplyOf(Q);
    const tAta = pump.ata(treasury.publicKey, Q, qProg);
    check('20% burned: $ADS supply dropped by exactly the burn', supply0 - supply1 === split.burn && split.burn === (pending.total * 2000n) / 10000n, `${split.burn} burned`);
    check('80% reached the treasury', (await tokenBal(tAta)) >= split.toTreasury && split.burn + split.toTreasury === pending.total, `${split.toTreasury} to treasury, ${pass.bytes} B`);
    check('creator wallet left empty, vaults drained, still no SOL', (await tokenBal(pump.ata(creator.publicKey, Q, qProg))) === 0n && (await pump.pendingQuoteFees(conn, { mint: M, quote: c.q, creator: creator.publicKey })).total === 0n && (await conn.getBalance(creator.publicKey)) === 0);

    // 4. nobody but the creator wallet can move its tokens
    for (const b of buyers) await sendIxs(b, await pump.firstBuyIxs(conn, global, { mint: M, user: b.publicKey, q: c.q, currency: 'sol', amountIn: 500_000_000n, minOut: 1n }), [], c.luts);
    await sendIxs(keeper, await pump.collectIxs(conn, { mint: M, payer: keeper.publicKey, creator: creator.publicKey, quote: c.q, graduated: false }), [], c.luts);
    const held = await tokenBal(pump.ata(creator.publicKey, Q, qProg));
    const thief = Keypair.generate(); await fund(thief.publicKey, 1);
    const evil = await pump.splitIxs({ payer: thief.publicKey, creator: creator.publicKey, treasury: thief.publicKey, quote: c.q, amount: held });
    const steal = await sendIxs(thief, evil.ixs, []).then(() => 'moved', (e) => e.message);
    check('a split not signed by the creator wallet is refused', held > 0n && steal !== 'moved' && (await tokenBal(pump.ata(creator.publicKey, Q, qProg))) === held, String(steal).slice(0, 60));

    // 5. the treasury's daily sale: all its $ADS → SOL through Pumpfun
    const sellAmt = await tokenBal(tAta);
    const r2 = await pump.quoteReserves(conn, c.q);
    const expected = pump.quoteSell({ reserves: r2, amountIn: sellAmt });
    const solBefore = BigInt(await conn.getBalance(treasury.publicKey));
    const sale = await sendIxs(treasury, await pump.sellQuoteIxs(conn, global, { user: treasury.publicKey, q: c.q, amountIn: sellAmt, minOut: (expected * 95n) / 100n }), [], c.luts);
    const t = await conn.getTransaction(sale.sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const received = BigInt(t.meta.postBalances[0]) - BigInt(t.meta.preBalances[0]) + BigInt(t.meta.fee);
    check('treasury sold all its $ADS for SOL', (await tokenBal(tAta)) === 0n && received > 0n, `${sellAmt} units → ${Number(received) / 1e9} SOL`);
    check('SOL received within 5% of the quote (fees included)', received >= (expected * 95n) / 100n && received <= (expected * 110n) / 100n, `expected ~${Number(expected) / 1e9}, got ${Number(received) / 1e9}; balance +${Number(BigInt(await conn.getBalance(treasury.publicKey)) - solBefore) / 1e9}`);
  } catch (e) {
    check(c.label, false, e.message.slice(0, 600));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(new URL('./last-chain-run.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
process.exit(failed.length ? 1 : 0);
