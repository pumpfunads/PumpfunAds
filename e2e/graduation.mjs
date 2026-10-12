/**
 * An Ads coin's whole life across GRADUATION, on a local validator with mainnet pump.fun cloned (e2e/validator.sh):
 *   launch (atomic, 100% route) → buy out the curve (synthetic migration completes it) → shown as 'migrating' with its
 *   curve price → migrate_v2 (permissionless) → shown as 'graduated', priced from its own pool, price continuous →
 *   a buy through its POOL → fees waiting on curve AND pool → the keeper's pass sweeps both into the creator wallet,
 *   burns 20% ($ADS supply drops by exactly that) and sends 80% to the treasury, nothing left waiting.
 * For $ADS on its curve and $ADS on PumpSwap, both bought out with SOL.
 * node e2e/graduation.mjs
 */
import fs from 'node:fs';
import { AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ADS_STANDINS } from './standins.mjs';

process.env.DB_PATH = `/tmp/ads-grad-${process.pid}.db`;
process.env.SOLANA_RPC = process.env.LOCAL_RPC || 'http://127.0.0.1:8994'; // api/ modules read through their own connection
const pump = await import('../lib/pump.mjs');
const { chainMarkets } = await import('../api/market.mjs');
const { readPending } = await import('../api/keeper.mjs');
const decodePoolRaw = (info) => { const d = pump.decodePool(info.data); return { len: info.data.length, vqr: pump.poolVirtualQuote(info.data), baseAcc: d.pool_base_token_account, base: null, quote: null }; };

const conn = new Connection(process.env.LOCAL_RPC || 'http://127.0.0.1:8994', 'confirmed');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fund = async (pk, n) => { const sig = await conn.requestAirdrop(pk, n * LAMPORTS_PER_SOL); await conn.confirmTransaction(sig, 'confirmed'); };
const supplyOf = async (mint) => BigInt((await conn.getTokenSupply(new PublicKey(mint), 'confirmed')).value.amount);
const tokenBal = async (k) => { const a = await conn.getAccountInfo(k, 'confirmed'); return a ? pump.tokenAccountAmount(a.data) : 0n; };

async function sendIxs(payer, ixs, signers, luts = [], units = 1_000_000) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs] }).compileToV0Message(luts));
  tx.sign([payer, ...signers]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: true });
  // The validator's first heavy transaction can take over 30 s (program cache): wait on the signature, not a timer.
  let st = null;
  for (let i = 0; i < 90 && !st; i++) { const v = (await conn.getSignatureStatuses([sig])).value[0]; if (v && (v.err || v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) st = { value: { err: v.err } }; else await sleep(1000); }
  if (!st) throw new Error(`not confirmed in 90 s: ${sig}`);
  if (st.value.err) {
    const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    throw new Error(`${JSON.stringify(st.value.err)} ${(t?.meta?.logMessages || []).slice(-6).join(' | ')}`);
  }
  return sig;
}
async function makeLut(authority, addresses) {
  const slot = await conn.getSlot('finalized');
  const [create, addr] = AddressLookupTableProgram.createLookupTable({ authority: authority.publicKey, payer: authority.publicKey, recentSlot: slot });
  await sendIxs(authority, [create], []);
  for (let i = 0; i < addresses.length; i += 25) await sendIxs(authority, [AddressLookupTableProgram.extendLookupTable({ lookupTable: addr, authority: authority.publicKey, payer: authority.publicKey, addresses: addresses.slice(i, i + 25) })], []);
  await sleep(1200);
  return (await conn.getAddressLookupTable(addr)).value;
}

const launcher = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(new URL('./fixtures/launcher.json', import.meta.url)))));
const keeper = Keypair.generate(), treasury = Keypair.generate(), whale = Keypair.generate(), migrator = Keypair.generate();
await fund(launcher.publicKey, 50); await fund(keeper.publicKey, 5); await fund(whale.publicKey, 500); await fund(migrator.publicKey, 5);
const global = await pump.loadGlobal(conn);
const entries = await pump.readQuoteControlEntries(conn);
const listed = entries.map((e) => e.mint);
const qPool = await pump.resolveQuote(conn, ADS_STANDINS.pool, { listed });
const qCurve = await pump.resolveQuote(conn, ADS_STANDINS.curve, { listed });
const staticKeys = await pump.launchStaticAccounts(conn, qCurve, qPool);
const staticLut = await makeLut(keeper, staticKeys);
const poolLut = await makeLut(keeper, await pump.quoteAccounts(conn, qPool, staticKeys));
const curveLut = await makeLut(keeper, await pump.quoteAccounts(conn, qCurve, staticKeys));

const cases = [
  { label: '$ADS on PumpSwap, coin bought out with SOL', q: qPool, buyer: whale, currency: 'sol', buyOut: 150n * 10n ** 9n, later: 2n * 10n ** 9n, luts: [staticLut, poolLut] },
  { label: '$ADS on its curve, coin bought out with SOL', q: qCurve, buyer: whale, currency: 'sol', buyOut: 150n * 10n ** 9n, later: 2n * 10n ** 9n, luts: [staticLut, curveLut] },
];

for (const c of cases) {
  console.log(`\n── ${c.label}`);
  const mint = Keypair.generate(), M = mint.publicKey, feeWallet = Keypair.generate(), Q = new PublicKey(c.q.mint), qProg = new PublicKey(c.q.tokenProgram);
  const row = { mint: M.toBase58(), quote_mint: c.q.mint, quote_json: JSON.stringify({ kind: c.q.kind, mint: c.q.mint, tokenProgram: c.q.tokenProgram, decimals: c.q.decimals }), fee_wallet: feeWallet.publicKey.toBase58() };
  try {
    await sendIxs(launcher, await pump.launchIxs(conn, { mint: M, user: launcher.publicKey, creator: feeWallet.publicKey, name: 'Graduation test', symbol: 'GRAD', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6ah6fkpkvwlfmjtx5gbd4pffoh5xm', quote: c.q, creatorFeeBps: 100 }), [mint], c.luts);
    const before = (await chainMarkets([row]))[row.mint];
    check('launched, shown on its curve', before?.phase === 'curve' && before.priceQ > 0, `price ${before?.priceQ?.toExponential(3)} Q`);

    // Buy the whole curve out: the buy that crosses the limit completes it (synthetic migration).
    await sendIxs(c.buyer, await pump.firstBuyIxs(conn, global, { mint: M, user: c.buyer.publicKey, q: c.q, currency: c.currency, amountIn: c.buyOut, minOut: 1n }), [], c.luts);
    const curve = pump.decodeBondingCurve((await conn.getAccountInfo(pump.bondingCurveAddress(M))).data);
    check('the curve is complete', curve.complete);
    // A coin's buy-out pushes ~85 SOL through $ADS: if $ADS was still on its curve, $ADS completes too. Migrate it and
    // read it fresh (production re-resolves $ADS on every launch, fee pass and sale for exactly this).
    if (c.q.kind === 'curve' && pump.decodeBondingCurve((await conn.getAccountInfo(new PublicKey(c.q.curve))).data).complete) {
      await sendIxs(migrator, [await pump.migrateV2Ix(conn, global, { mint: Q, user: migrator.publicKey, quote: { mint: pump.WSOL.toBase58(), tokenProgram: pump.TOKEN_PROGRAM.toBase58() } })], [], c.luts);
      c.q = await pump.resolveQuote(conn, c.q.mint, { listed });
      check('$ADS itself graduated on the way and still resolves as the pair (now on PumpSwap)', c.q.ok && c.q.kind === 'pool');
      c.luts = [...c.luts, await makeLut(keeper, await pump.quoteAccounts(conn, c.q, staticKeys))];
    }
    const mid = (await chainMarkets([row]))[row.mint];
    check('completed, pool not made yet: shown as migrating WITH a price (not –)', mid?.phase === 'migrating' && mid.priceQ > 0, `price ${mid?.priceQ?.toExponential(3)} Q`);
    const pendingMid = (await readPending([row]))[0];
    check('fees from the buy-out are waiting on the curve', pendingMid.waiting > 0n, `${pendingMid.waiting} Q units`);

    // Graduate: migrate_v2 is permissionless.
    await sendIxs(migrator, [await pump.migrateV2Ix(conn, global, { mint: M, user: migrator.publicKey, quote: c.q })], [], c.luts);
    const pool = await pump.readCoinPool(conn, M, c.q);
    check('migrate_v2: the pool exists at the address Ads derives (index 0, pump pool authority, against Q)', Boolean(pool));
    check('the pool\'s coin creator is the creator wallet (fees still go there after graduation)', pool?.coinCreator === feeWallet.publicKey.toBase58());
    const after = (await chainMarkets([row]))[row.mint];
    const jump = after?.priceQ && mid?.priceQ ? after.priceQ / mid.priceQ : null;
    check('graduated: shown as graduated, priced from its own pool', after?.phase === 'graduated' && after.pool === pool?.address && after.priceQ > 0, `price ${after?.priceQ?.toExponential(3)} Q`);
    check('the price carries across graduation (no jump to zero or a wild number)', jump && jump > 0.8 && jump < 1.25, `×${jump?.toFixed(3)}`);
    check('supply read live after graduation', after?.supply > 900_000_000 && after.supply <= 1_000_000_000, `${Math.round(after?.supply)}`);

    // What a small buy on the new pool REALLY pays per token: the truth both displayed prices are measured against.
    {
      const outAta = pump.ata(c.buyer.publicKey, M, pump.TOKEN_2022), t0 = await tokenBal(outAta);
      const small = c.currency === 'sol' ? 10_000_000n : 1_000n * 10n ** 6n;
      const qBefore = c.currency === 'quote' ? await tokenBal(pump.ata(c.buyer.publicKey, Q, qProg)) : null;
      await sendIxs(c.buyer, await pump.firstBuyIxs(conn, global, { mint: M, user: c.buyer.publicKey, q: c.q, currency: c.currency, amountIn: small, minOut: 1n, coinPool: pool }), [], c.luts);
      const got = Number(await tokenBal(outAta) - t0) / 1e6;
      const paidQ = c.currency === 'quote' ? Number(qBefore - await tokenBal(pump.ata(c.buyer.publicKey, Q, qProg))) / 10 ** c.q.decimals : null;
      const r = await pump.quoteReserves(conn, c.q);
      const qPerSol = c.currency === 'sol' ? Number(r.base) / Number(r.quote) * 1e9 / 10 ** c.q.decimals : null; // Q per SOL at Q's pool
      const paid = paidQ ?? (Number(small) / 1e9) * qPerSol;
      const real = paid / got;
      const pd = decodePoolRaw(await conn.getAccountInfo(new PublicKey(pool.address)));
      console.log(`   real fill ${real.toExponential(3)} Q/token · shown before migration ${mid.priceQ.toExponential(3)} · shown after ${after.priceQ.toExponential(3)} · pool len ${pd.len} vqr ${pd.vqr} base ${pd.base} quote ${pd.quote}`);
      check('the graduated price matches what a real pool buy pays (within fees)', after.priceQ / real > 0.85 && after.priceQ / real < 1.15, `shown/real ×${(after.priceQ / real).toFixed(3)}`);
    }

    // A buy through the coin's POOL (any buy after graduation), then the keeper's burn sweeps curve and pool.
    await sendIxs(c.buyer, await pump.firstBuyIxs(conn, global, { mint: M, user: c.buyer.publicKey, q: c.q, currency: c.currency, amountIn: c.later, minOut: 1n, coinPool: pool }), [], c.luts);
    const p = (await readPending([row]))[0];
    const fees = await pump.pendingQuoteFees(conn, { mint: M, quote: c.q, creator: feeWallet.publicKey });
    check('a pool buy works; its creator fee waits on the pool', p.graduated && fees.poolUnswept > 0n, `pool ${fees.poolUnswept}, curve ${fees.curveUnswept}, vaults ${fees.curve + fees.amm}`);
    const supply0 = await supplyOf(Q);
    const amount = p.waiting + p.inWallet;
    const split = await pump.splitIxs({ payer: keeper.publicKey, creator: feeWallet.publicKey, treasury: treasury.publicKey, quote: c.q, amount });
    await sendIxs(keeper, [...(await pump.collectIxs(conn, { mint: M, payer: keeper.publicKey, creator: feeWallet.publicKey, quote: c.q, graduated: p.graduated })), ...split.ixs], [feeWallet], c.luts);
    const burned = supply0 - (await supplyOf(Q));
    const left = (await readPending([row]))[0];
    check('keeper pass after graduation: 20% burned exactly, 80% to the treasury', burned === split.burn && split.burn + split.toTreasury === amount && amount > 0n && (await tokenBal(pump.ata(treasury.publicKey, Q, qProg))) >= split.toTreasury, `${split.burn} burned of ${amount}`);
    check('nothing left waiting on curve, pool, vaults or creator wallet', left.waiting === 0n && left.inWallet === 0n);
  } catch (e) {
    check(c.label, false, e.message.slice(0, 700));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of fs.readdirSync('/tmp')) if (f.startsWith(`ads-grad-${process.pid}`)) fs.rmSync(`/tmp/${f}`, { force: true });
process.exit(failed.length ? 1 : 0);
