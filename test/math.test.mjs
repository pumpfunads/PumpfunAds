// The pure parts: amounts, signed PumpSwap reserves, lenient curve decoding, the opening-reserves formula. Values marked
// "on chain" were produced by pump.fun's own program on the mainnet clone (e2e/chain.mjs, 9 Oct 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
process.env.DB_PATH = `/tmp/pairs-unit-${process.pid}.db`;
const { toUnits, validate, FEE_RATES } = await import('../api/launch.mjs');
const pump = await import('../lib/pump.mjs');

test('toUnits parses decimals exactly, never through a float', () => {
  assert.equal(toUnits('1.5', 9), 1_500_000_000n);
  assert.equal(toUnits('0.000000001', 9), 1n);
  assert.equal(toUnits('0.0000000019', 9), 1n); // extra digits are cut, not rounded up
  assert.equal(toUnits('50000', 6), 50_000_000_000n);
  assert.equal(toUnits('.5', 9), 500_000_000n);
  assert.equal(toUnits('5.', 9), 5_000_000_000n);
  for (const bad of ['', '.', '-1', '1e3', 'abc', '1.2.3']) assert.equal(toUnits(bad, 6), null);
});

test('validate: fee rates from the list only, a brief is required, SOL first buy capped', () => {
  const base = { name: 'Coin', symbol: 'coin', brief: { pitch: 'A frog who trades at 3am', vibe: ['Meme', 'Nope'], platforms: ['x'] } };
  assert.equal(validate(base).symbol, 'COIN');
  assert.deepEqual(validate(base).brief.vibe, ['Meme']);
  assert.throws(() => validate({ ...base, creatorFeeBps: 250 }), /creator fee/);
  assert.throws(() => validate({ ...base, brief: { pitch: '' } }), /Describe your coin/);
  assert.throws(() => validate({ ...base, brief: { pitch: 'ok coin', platforms: ['facebook'] } }), /X or TikTok/);
  assert.throws(() => validate({ ...base, devBuy: { amount: '11' } }), /at most/);
  assert.equal(validate({ ...base, devBuy: { amount: '0' } }).devBuy.currency, null);
});

test('fees split exactly: 20% burn, 80% to the treasury, nothing lost to rounding', async () => {
  const { splitFees } = await import('../lib/pump.mjs');
  for (const u of [0n, 1n, 4n, 5n, 999n, 123456789n]) { const s = splitFees(u); assert.equal(s.burn + s.toTreasury, u); assert.equal(s.burn, (u * 2000n) / 10000n); }
});

test('ladder: thresholds, repeat videos, graduation steps', async () => {
  const { ladderFor, videosUnlocked, volumeFor } = await import('../lib/ladder.mjs');
  assert.equal(ladderFor({ lifetimeUsd: 0.5 }).next.key, 'meme_pack');
  assert.equal(ladderFor({ lifetimeUsd: 3.2, done: { meme_pack: 1 } }).next.key, 'video');
  assert.equal(videosUnlocked(4.9), 0);
  assert.equal(videosUnlocked(5), 1);
  assert.equal(videosUnlocked(9.9), 1);
  assert.equal(videosUnlocked(10), 2);
  assert.equal(ladderFor({ lifetimeUsd: 2.9 }).next.atUsd, 3); // content pack at $3
  assert.equal(ladderFor({ lifetimeUsd: 7 }).next.atUsd, 10); // a video every $5
  assert.equal(ladderFor({ lifetimeUsd: 0, graduated: true }).steps.find((s) => s.key === 'trailer').state, 'next');
  assert.equal(Math.round(volumeFor(3, 100)), 375);
});

test('PumpSwap virtual quote reserves are a SIGNED i128 on the new layout', () => {
  const pool = Buffer.alloc(301);
  pool.writeBigInt64LE(-5n, 245); pool.writeBigInt64LE(-1n, 253); // -5 as i128
  assert.equal(pump.poolVirtualQuote(pool), -5n);
  pool.writeBigUInt64LE(17_584_505_000n, 245); pool.writeBigInt64LE(0n, 253);
  assert.equal(pump.poolVirtualQuote(pool), 17_584_505_000n);
  const old = Buffer.alloc(253); old.writeBigUInt64LE(42n, 245);
  assert.equal(pump.poolVirtualQuote(old), 42n);
  const fees = Buffer.alloc(301); fees.writeBigUInt64LE(777n, 279);
  assert.equal(pump.poolCreatorFees(fees), 777n);
});

test('an old, short bonding curve decodes with defaults (SOL quote, depth 0)', () => {
  const d = Buffer.alloc(49); d.writeBigUInt64LE(5n, 8); d[48] = 1;
  const c = pump.decodeBondingCurve(d);
  assert.equal(c.complete, true);
  assert.equal(String(c.virtual_token_reserves), '5');
  assert.ok(c.quote_mint.equals(pump.WSOL.constructor.default));
  assert.equal(c.depth, 0);
});

test('opening reserves of a coin paired with a pump coin: pump.fun\'s formula', () => {
  // Global's mainnet values; Q on its curve at the reserves used on the clone.
  const global = { initial_virtual_token_reserves: new BN('1073000000000000'), initial_real_token_reserves: new BN('793100000000000'), initial_virtual_sol_reserves: new BN('30000000000'), initial_virtual_quote_reserves: new BN('30000000000') };
  const tradable = 1_073_000_000_000_000n - 793_100_000_000_000n;
  const reserves = { base: 1_000_000_000_000_000n, quote: 40_000_000_000n };
  const input = (30_000_000_000n * 793_100_000_000_000n) / tradable;
  const expect = ((input * reserves.base) / (reserves.quote + input) * tradable) / 793_100_000_000_000n;
  assert.equal(pump.initialQuoteReserves(global, { kind: 'curve', quoteOfQ: pump.WSOL.toBase58() }, [], reserves), expect);
  // A listed pair uses its own entry, untouched.
  assert.equal(pump.initialQuoteReserves(global, { kind: 'listed', mint: 'X' }, [{ mint: 'X', initialVirtualQuoteReserves: 590_807_788_206n }], null), 590_807_788_206n); // on chain
});

test('a first buy quote never exceeds the curve and errs low', () => {
  const global = { initial_virtual_token_reserves: new BN('1073000000000000'), initial_real_token_reserves: new BN('793100000000000'), initial_virtual_sol_reserves: new BN('30000000000'), initial_virtual_quote_reserves: new BN('30000000000') };
  const entries = [{ mint: 'X', initialVirtualQuoteReserves: 590_807_788_206n }];
  const q = { kind: 'listed', mint: 'X' };
  const out = pump.quoteFirstBuy({ global, q, entries, reserves: null, currency: 'quote', amountIn: 50_000_000_000n });
  assert.ok(out < 82_243_833_745_567n, 'below what the chain delivered for the same buy'); // on chain: 82,243,833,745,567
  assert.ok(out > 70_000_000_000_000n);
  assert.equal(pump.quoteFirstBuy({ global, q, entries, reserves: null, currency: 'quote', amountIn: 10n ** 30n }), 793_100_000_000_000n);
  assert.throws(() => pump.quoteFirstBuy({ global, q, entries, reserves: null, currency: 'sol', amountIn: 1n }), /pump coin pair/);
});
