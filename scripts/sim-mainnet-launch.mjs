// READ-ONLY mainnet check: build the real launch transaction (create_v2 paired with a real Pumpfun coin standing in for
// $ADS, with and without a first buy) and SIMULATE it on mainnet. Nothing is signed or sent, no database row is written.
// In the app directory (reads .env for the RPC): NODE_ENV=production node scripts/sim-mainnet-launch.mjs <payer with some SOL>
await import('../api/env.mjs');
const req = (await import('node:module')).createRequire(import.meta.url);
const { Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = req('@solana/web3.js');
const sol = await import('../api/sol.mjs');
const lut = await import('../api/lut.mjs');
const quotes = await import('../api/quotes.mjs');
const pump = await import('../lib/pump.mjs');
const payer = new PublicKey(process.argv[2]);
const STANDINS = { curve: '3BXio3YTY7MBaCjLHLR3rL491817x142bnBqQxN3pump', pool: 'Goh59QCfoX53RgJa615vzXx4swR3mv51VgvAN6ZCpump' };
const bal = await sol.conn.getBalance(payer);
console.log(`payer ${payer.toBase58().slice(0, 6)}… holds ${(bal / 1e9).toFixed(4)} SOL (simulation only, never charged)`);
const tables = (await lut.allTables()).slice(0, 1);
const global = await pump.loadGlobal(sol.conn);
const listed = await pump.readQuoteControl(sol.conn);
for (const [kind, ca] of Object.entries(STANDINS)) {
  const q = await pump.resolveQuote(sol.conn, ca, { listed });
  if (!q.ok) { console.log(`${kind}: stand-in refused as a pair: ${q.reason}`); continue; }
  for (const buySol of [0, 0.005]) {
    const mint = Keypair.generate(), creator = Keypair.generate();
    let firstBuy = null;
    if (buySol) {
      const amountIn = BigInt(Math.round(buySol * 1e9));
      const est = pump.quoteFirstBuy({ global, q, entries: await quotes.listedEntries(), reserves: await pump.quoteReserves(sol.conn, q), currency: 'sol', amountIn });
      firstBuy = { global, currency: 'sol', amountIn, minOut: (est * 85n) / 100n };
    }
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: buySol ? 900_000 : 300_000}), ...(await pump.launchIxs(sol.conn, { mint: mint.publicKey, user: payer, name: 'Ads Mainnet Check', symbol: 'CHECK', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6ah6fkpkvwlfmjtx5gbd4pffoh5xm', creator: creator.publicKey.toBase58(), quote: q, creatorFeeBps: 100, firstBuy }))];
    const { blockhash } = await sol.conn.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables);
    const tx = new VersionedTransaction(msg);
    const size = tx.serialize().length + 64; // + the mint's signature
    let verdict;
    if (size > 1232) verdict = `${size} B: too big without the pair's own lookup table (golive builds it)`;
    else {
      const sim = await sol.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
      verdict = sim.value.err ? `SIMULATION FAILED ${JSON.stringify(sim.value.err)} | ${(sim.value.logs || []).slice(-3).join(' | ').slice(0, 300)}` : `simulation OK, ${sim.value.unitsConsumed} CU, ${size} B`;
    }
    console.log(`pair ${kind} (${q.kind}), first buy ${buySol || 'none'} SOL: ${verdict}`);
  }
}
process.exit(0);
