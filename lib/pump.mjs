/**
 * pump.fun client for Ads (forked from Pairs), driven by the IDLs in pump-fun/pump-public-docs (idl/, 8 Oct 2026; the IDL published on
 * chain is older and lacks multi_hop_swap, the v2 fee-sharing calls and the sweeps). Anchor resolves the PDAs the IDL
 * describes; the rest is derived here by hand. Proven end to end on a local clone of mainnet: e2e/chain.mjs.
 *
 * ⛔ A graduated coin's BondingCurve reads ALL ZEROES with complete = 1 (its quote too): price it from its pool.
 * ⛔ PumpSwap's virtual_quote_reserves is a SIGNED i128 @245 since 30 Sep 2026 (can be negative), not a u64.
 * ⛔ New-style trades (multi_hop_swap, buy_v3) keep creator fees ON the curve / pool: sweep before collecting.
 * ⛔ pump.fun keeps ONE creator vault PER CREATOR: each coin has its own creator wallet, so no two coins share one.
 */
import { AnchorProvider, BorshCoder, Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import BN from 'bn.js';
import { readFileSync } from 'node:fs';

export const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PFEE = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
export const COIN_DECIMALS = 6;
/** Real tokens a fresh SOL-paired curve sells before it completes. */
export const CURVE_TOKENS_FOR_SALE = 793_100_000_000_000n;

const load = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url)));
export const pumpIdl = load('./pump.idl.json');
export const pumpAmmIdl = load('./pump_amm.idl.json');
export const feesIdl = load('./pump_fees.idl.json');
const pumpCoder = new BorshCoder(pumpIdl);
const ammCoder = new BorshCoder(pumpAmmIdl);
const feesCoder = new BorshCoder(feesIdl);

const pda = (seeds, program = PUMP) => PublicKey.findProgramAddressSync(seeds, program)[0];
export const globalAddress = () => pda([Buffer.from('global')]);
export const bondingCurveAddress = (mint) => pda([Buffer.from('bonding-curve'), mint.toBuffer()]);
export const bondingCurveV2Address = (mint) => pda([Buffer.from('bonding-curve-v2'), mint.toBuffer()]);
export const creatorVaultAddress = (creator) => pda([Buffer.from('creator-vault'), creator.toBuffer()]);
export const mayhemStateAddress = (mint) => pda([Buffer.from('mayhem-state'), mint.toBuffer()]);
export const sharingConfigAddress = (mint) => pda([Buffer.from('sharing-config'), mint.toBuffer()], PFEE);
/** The account pump.fun migrates a coin as; also the pool PDA's `creator` seed. */
export const poolAuthority = (mint) => pda([Buffer.from('pool-authority'), mint.toBuffer()]);
export const poolAddress = (mint, index = 0, quoteMint = WSOL) => {
  const idx = Buffer.alloc(2);
  idx.writeUInt16LE(index);
  return pda([Buffer.from('pool'), idx, poolAuthority(mint).toBuffer(), mint.toBuffer(), quoteMint.toBuffer()], PUMP_AMM);
};
export const POOL_INDEXES = [0, 1, 2, 3];
/** PumpSwap: the authority whose WSOL account holds a graduated coin's creator fees. */
export const ammCreatorVaultAuthority = (creator) => pda([Buffer.from('creator_vault'), creator.toBuffer()], PUMP_AMM);
export const ata = (owner, mint, tokenProgram = TOKEN_2022) => pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);

export const decodeGlobal = (data) => pumpCoder.accounts.decode('Global', data);
/**
 * BondingCurve, read leniently: pump.fun appended fields over the years and an old coin's account is shorter than the
 * newest layout (a 2025 coin's curve is 49..151 bytes). Missing trailing fields read as their defaults (quote = SOL,
 * depth 0, no mayhem), which is what the program assumes for them too.
 */
export function decodeBondingCurve(data) {
  try {
    return pumpCoder.accounts.decode('BondingCurve', data);
  } catch {
    const u64 = (o) => (data.length >= o + 8 ? new BN(data.readBigUInt64LE(o).toString()) : new BN(0));
    const key = (o) => (data.length >= o + 32 ? new PublicKey(data.subarray(o, o + 32)) : PublicKey.default);
    const byte = (o) => (data.length > o ? data[o] : 0);
    return {
      virtual_token_reserves: u64(8), virtual_quote_reserves: u64(16), real_token_reserves: u64(24), real_quote_reserves: u64(32),
      token_total_supply: u64(40), complete: Boolean(byte(48)), creator: key(49), is_mayhem_mode: Boolean(byte(81)),
      is_cashback_coin: Boolean(byte(82)), quote_mint: key(83), creator_fee_bps: u64(115), is_holder_reward: Boolean(byte(124)), depth: byte(141),
    };
  }
}
export const decodePool = (data) => ammCoder.accounts.decode('Pool', data);
export const decodeSharingConfig = (data) => feesCoder.accounts.decode('SharingConfig', data);
/**
 * PumpSwap's virtual quote reserves. ⛔ Since 30 Sep 2026 an i128 that can be NEGATIVE (v2 trades keep fees in the
 * quote vault and subtract them here): price against vault + this, signed. Older pools hold a u64 (253-byte layout).
 */
export const poolVirtualQuote = (data) => {
  if (data.length >= 261) return data.readBigInt64LE(253) * (1n << 64n) + data.readBigUInt64LE(245);
  return data.length >= 253 ? data.readBigUInt64LE(245) : 0n;
};
/** Creator fees a v2 trade left waiting in the pool (u64 @279); 0 on older layouts. */
export const poolCreatorFees = (data) => (data.length >= 287 ? data.readBigUInt64LE(279) : 0n);
/** Creator fees a v3 / multi-hop trade left waiting in the curve (u64 @125); 0 on older layouts. */
export const curveCreatorFee = (data) => (data.length >= 133 ? data.readBigUInt64LE(125) : 0n);
/** The `amount` of an SPL token account (classic and Token-2022 share the first 72 bytes). */
export const tokenAccountAmount = (data) => data.readBigUInt64LE(64);

const readOnly = { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t };
const cache = new WeakMap();
/** Read-only Programs bound to a connection (instruction building needs lookups, never a wallet). */
export function programs(connection) {
  let p = cache.get(connection);
  if (!p) {
    const provider = new AnchorProvider(connection, readOnly, {});
    p = { pump: new Program(pumpIdl, provider), amm: new Program(pumpAmmIdl, provider), fees: new Program(feesIdl, provider) };
    cache.set(connection, p);
  }
  return p;
}

export async function loadGlobal(connection) {
  const acc = await connection.getAccountInfo(globalAddress());
  if (!acc) throw new Error('pump.fun Global not found: wrong cluster?');
  return decodeGlobal(acc.data);
}

/**
 * A Token-2022 coin with creator rewards (not holder rewards, not cashback). Without `quote` it is SOL-paired (used only
 * to derive launch-independent accounts); with `quote` (resolveQuote) it is paired with that token, and
 * `creatorFeeBps` is the coin's own creator fee rate (0 = pump.fun's standard schedule).
 */
export async function createV2Ix(connection, { mint, user, name, symbol, uri, creator, quote = null, creatorFeeBps = 0 }) {
  const m = programs(connection).pump.methods
    .createV2(name, symbol, uri, creator, false, { 0: false }, { 0: new BN(String(creatorFeeBps)) }, { 0: false })
    .accountsPartial({ mint, user, mayhemTokenVault: ata(mayhemStateAddress(mint), mint, TOKEN_2022) });
  if (quote) m.remainingAccounts(quoteRemainingAccounts(quote, mint));
  return m.instruction();
}

/* ───────────── custom pairs ─────────────
 * A coin paired with token Q (pump-public-docs, docs/instructions/CREATE_WITH_PUMP_COIN_QUOTE.md, 8 Oct 2026):
 * create_v2 + remaining [Q, curve's Q ATA, Q's token program, quote_control] for a mint on pump.fun's quote-control
 * list, + [Q's bonding curve] for a pump coin, + [Q's pool, its base and quote vaults] once that pump coin migrated.
 * ⛔ Creator fees on such a coin accrue IN Q (collect/distribute *_v2 move Q tokens, not SOL). */

export const QUOTE_CONTROL = pda([Buffer.from('quote-control')]);
export const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const decodeQuoteControl = (data) => pumpCoder.accounts.decode('QuoteControl', data);

/** pump.fun's quote-control list: the non-pump tokens (xStocks, BONK, …) a coin may be paired with, each with its own
 *  opening virtual quote reserve. */
export async function readQuoteControlEntries(connection) {
  const info = await connection.getAccountInfo(QUOTE_CONTROL);
  if (!info) return [];
  return decodeQuoteControl(info.data).mints.map((x) => ({ mint: x.mint.toBase58(), initialVirtualQuoteReserves: BigInt(x.initial_virtual_quote_reserves.toString()) }));
}
export const readQuoteControl = async (connection) => (await readQuoteControlEntries(connection)).map((e) => e.mint);

const isSolOrUsdc = (k) => !k || k.equals(PublicKey.default) || k.equals(WSOL) || k.equals(USDC);

/**
 * Whether token Q can be an Ads coin's pair, and every account a launch against it needs. Never throws for a bad Q:
 * returns { ok: false, reason }. Mirrors pump.fun's own refusals (errors 6063, 6100, 6105, 6107); the launch is
 * simulated anyway, so a rule pump.fun adds later is still caught before anyone signs.
 */
export async function resolveQuote(connection, q, { listed = null } = {}) {
  let mint;
  try {
    mint = q instanceof PublicKey ? q : new PublicKey(String(q).trim());
  } catch {
    return { ok: false, reason: 'Not a token address' };
  }
  if (mint.equals(WSOL) || mint.equals(USDC)) return { ok: false, reason: 'SOL and USDC are not custom pairs. Pick a token.' };
  const curveAddr = bondingCurveAddress(mint);
  const [mintInfo, curveInfo] = await connection.getMultipleAccountsInfo([mint, curveAddr]);
  if (!mintInfo || !(mintInfo.owner.equals(TOKEN_PROGRAM) || mintInfo.owner.equals(TOKEN_2022)) || mintInfo.data.length < 82) {
    return { ok: false, reason: 'Not a token mint' };
  }
  const base = { mint: mint.toBase58(), tokenProgram: mintInfo.owner.toBase58(), decimals: mintInfo.data[44] };
  const list = listed ?? (await readQuoteControl(connection));
  if (list.includes(base.mint)) return { ok: true, kind: 'listed', ...base, curve: null, pool: null };
  if (!curveInfo) return { ok: false, reason: 'Not a pump.fun coin, and not on pump.fun\'s custom pair list', ...base };
  const c = decodeBondingCurve(curveInfo.data);
  if (c.is_mayhem_mode) return { ok: false, reason: 'Mayhem mode coins cannot be a pair', ...base };
  if (Number(c.depth ?? 0) > 0 || !isSolOrUsdc(c.quote_mint)) {
    return { ok: false, reason: 'This coin is itself paired with another token. pump.fun allows one level of pairing.', ...base };
  }
  if (!c.complete) return { ok: true, kind: 'curve', ...base, curve: curveAddr.toBase58(), pool: null, quoteOfQ: c.quote_mint.toBase58() };
  // Graduated: its PumpSwap pool must exist (pool index 0, pump's pool authority, against Q's own quote). ⛔ A migrated
  // curve reads ALL ZEROES, quote included, so both possible quotes are tried.
  const candidates = [WSOL, USDC].map((k) => ({ k, addr: poolAddress(mint, 0, k) }));
  const infos = await connection.getMultipleAccountsInfo(candidates.map((x) => x.addr));
  const hit = candidates.findIndex((_, i) => infos[i] && infos[i].data.length >= 200);
  if (hit < 0) {
    // A curve that holds reserves and a creator is mid-migration; an emptied one graduated before PumpSwap (Raydium).
    const midMigration = !c.creator.equals(PublicKey.default) && Number(c.real_token_reserves) > 0;
    return { ok: false, reason: midMigration ? 'This coin finished its curve and is waiting for its pool. Try again in a minute.' : 'This coin graduated outside PumpSwap (Raydium). pump.fun does not allow it as a pair.', ...base };
  }
  const quoteOfQ = candidates[hit].k, poolAddr = candidates[hit].addr, pool = decodePool(infos[hit].data);
  return {
    ok: true, kind: 'pool', ...base, curve: curveAddr.toBase58(), quoteOfQ: quoteOfQ.toBase58(),
    pool: { address: poolAddr.toBase58(), base: pool.pool_base_token_account.toBase58(), quote: pool.pool_quote_token_account.toBase58() },
  };
}

/** create_v2's remaining accounts for a coin `mint` paired with the resolved quote `q`. */
export function quoteRemainingAccounts(q, mint) {
  const Q = new PublicKey(q.mint), prog = new PublicKey(q.tokenProgram);
  const acc = (k, w = false) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: w });
  const out = [acc(Q), acc(ata(bondingCurveAddress(mint), Q, prog), true), acc(prog), acc(QUOTE_CONTROL)];
  if (q.kind === 'listed') return out;
  out.push(acc(q.curve));
  if (q.kind === 'pool') out.push(acc(q.pool.address), acc(q.pool.base), acc(q.pool.quote));
  return out;
}

/** The coin's own PumpSwap pool once it graduates: index 0, pump's pool authority, against Q. */
export const coinPoolAddress = (mint, quote) => poolAddress(new PublicKey(mint), 0, new PublicKey(quote.mint));

/**
 * Q waiting for a coin's creator (its fee wallet), in Q's smallest units, everywhere it can wait: unswept on the curve
 * (BondingCurve.creator_fee) and on the coin's pool (Pool.creator_fees), and swept into the creator's two vaults' Q
 * accounts (pump.fun's creator vault, PumpSwap's coin creator vault). `graduated` = the coin's pool exists.
 */
export async function pendingQuoteFees(connection, { mint, quote, creator }) {
  const m = new PublicKey(mint), c = new PublicKey(creator), Q = new PublicKey(quote.mint), prog = new PublicKey(quote.tokenProgram);
  const [curve, pool, a, b] = await connection.getMultipleAccountsInfo([bondingCurveAddress(m), coinPoolAddress(m, quote), ata(creatorVaultAddress(c), Q, prog), ata(ammCreatorVaultAuthority(c), Q, prog)]);
  const out = {
    curveUnswept: curve ? curveCreatorFee(curve.data) : 0n,
    poolUnswept: pool && pool.data.length >= 200 ? poolCreatorFees(pool.data) : 0n,
    curve: a ? tokenAccountAmount(a.data) : 0n,
    amm: b ? tokenAccountAmount(b.data) : 0n,
    graduated: Boolean(pool && pool.data.length >= 200),
  };
  out.total = out.curveUnswept + out.poolUnswept + out.curve + out.amm;
  return out;
}

/** Pump: pays BondingCurve.creator_fee (in Q) into the creator vault of the curve's creator (here: the sharing config). */
export async function sweepCurveCreatorFeeIx(connection, { mint, payer, creator, quote }) {
  const m = new PublicKey(mint), Q = new PublicKey(quote.mint), prog = new PublicKey(quote.tokenProgram);
  const curve = bondingCurveAddress(m), vault = creatorVaultAddress(creator);
  return programs(connection).pump.methods.sweepCreatorFee()
    .accountsPartial({ payer, global: globalAddress(), baseMint: m, quoteMint: Q, quoteTokenProgram: prog, bondingCurve: curve, associatedQuoteBondingCurve: ata(curve, Q, prog), recipient: vault, associatedQuoteRecipient: ata(vault, Q, prog) })
    .instruction();
}

/** PumpSwap: pays Pool.creator_fees into the coin creator vault authority's Q account. */
export async function sweepPoolCreatorFeeIx(connection, { mint, payer, creator, quote }) {
  const Q = new PublicKey(quote.mint), prog = new PublicKey(quote.tokenProgram);
  const pool = coinPoolAddress(mint, quote), info = await connection.getAccountInfo(pool);
  const authority = ammCreatorVaultAuthority(creator);
  return programs(connection).amm.methods.sweepCreatorFee()
    .accountsPartial({ payer, globalConfig: AMM_GLOBAL_CONFIG, pool, quoteMint: Q, quoteTokenProgram: prog, poolQuoteTokenAccount: decodePool(info.data).pool_quote_token_account, recipient: authority, recipientTokenAccount: ata(authority, Q, prog) })
    .instruction();
}

/* ───────────── creator fees (the coin's creator IS its fee wallet) ───────────── */

/** Pump: the creator vault's Q → the creator's own Q account (must exist). Permissionless. */
export async function collectCreatorFeeV2Ix(connection, { creator, quote }) {
  const c = new PublicKey(creator), Q = new PublicKey(quote.mint), prog = new PublicKey(quote.tokenProgram), vault = creatorVaultAddress(c);
  return programs(connection).pump.methods.collectCreatorFeeV2()
    .accountsPartial({ creator: c, creatorTokenAccount: ata(c, Q, prog), creatorVault: vault, creatorVaultTokenAccount: ata(vault, Q, prog), quoteMint: Q, quoteTokenProgram: prog })
    .instruction();
}

/** PumpSwap: the coin creator vault's Q → the creator's own Q account (must exist). Permissionless. */
export async function collectCoinCreatorFeeIx(connection, { creator, quote }) {
  const c = new PublicKey(creator), Q = new PublicKey(quote.mint), prog = new PublicKey(quote.tokenProgram), auth = ammCreatorVaultAuthority(c);
  return programs(connection).amm.methods.collectCoinCreatorFee()
    .accountsPartial({ quoteMint: Q, quoteTokenProgram: prog, coinCreator: c, coinCreatorVaultAuthority: auth, coinCreatorVaultAta: ata(auth, Q, prog), coinCreatorTokenAccount: ata(c, Q, prog) })
    .instruction();
}

/** The coin's pump.fun creator, the one creator fees are paid to: the curve's, or (graduated: the curve reads zero) the pool's. */
export async function coinCreator(connection, mint, quote) {
  const m = new PublicKey(mint);
  const [curve, pool] = await connection.getMultipleAccountsInfo([bondingCurveAddress(m), coinPoolAddress(m, quote)]);
  if (pool && pool.data.length >= 200) return decodePool(pool.data).coin_creator.toBase58();
  if (!curve) return null;
  const c = decodeBondingCurve(curve.data).creator;
  return c.equals(PublicKey.default) ? null : c.toBase58();
}

/* ───────────── reads ───────────── */

const unitsToNumber = (u, decimals) => Number(u) / 10 ** decimals;

/**
 * An Ads coin in a few reads: curve (creator, pair, fee rate, progress) and, once graduated, its own PumpSwap pool
 * against Q. Prices are in Q (`priceQ`: Q per whole coin), never in SOL: a pair's quote is Q. Null when not a pump.fun
 * coin; prices null when unknown, never 0. `quoteDecimals` is Q's (from the caller's resolved quote, default 6).
 * ⛔ A graduated coin's BondingCurve reads ALL ZEROES (quote included): the pair comes from our own record.
 */
export async function coinState(connection, mint, { quoteMint = null, quoteDecimals = 6 } = {}) {
  const m = mint instanceof PublicKey ? mint : new PublicKey(mint);
  const curveAddr = bondingCurveAddress(m);
  const [curveInfo, mintInfo] = await connection.getMultipleAccountsInfo([curveAddr, m]);
  if (!curveInfo || !mintInfo) return null;
  const c = decodeBondingCurve(curveInfo.data);
  const supplyUnits = mintInfo.data.length >= 44 ? mintInfo.data.readBigUInt64LE(36) : BigInt(c.token_total_supply.toString());
  const qm = quoteMint ? new PublicKey(quoteMint) : c.quote_mint;
  const out = {
    mint: m.toBase58(),
    creator: c.creator.toBase58(),
    quoteMint: qm.toBase58(),
    creatorFeeBps: Number(c.creator_fee_bps ?? 0),
    depth: Number(c.depth ?? 0),
    complete: Boolean(c.complete),
    phase: c.complete ? 'graduated' : 'curve',
    supply: unitsToNumber(supplyUnits, COIN_DECIMALS),
    priceQ: null,
    capQ: null,
    progress: null,
    pool: null,
  };
  if (!c.complete) {
    const vt = BigInt(c.virtual_token_reserves.toString()), vq = BigInt(c.virtual_quote_reserves.toString()), real = BigInt(c.real_token_reserves.toString());
    out.progress = Math.max(0, Math.min(1, 1 - Number(real) / Number(CURVE_TOKENS_FOR_SALE)));
    if (vt > 0n) {
      out.priceQ = unitsToNumber(vq, quoteDecimals) / unitsToNumber(vt, COIN_DECIMALS);
      out.capQ = out.priceQ * out.supply;
    }
    return out;
  }
  out.progress = 1;
  const poolAddr = poolAddress(m, 0, qm), info = await connection.getAccountInfo(poolAddr);
  if (!info || info.data.length < 200) return out;
  const pool = decodePool(info.data);
  out.pool = poolAddr.toBase58();
  const [b, q] = await connection.getMultipleAccountsInfo([pool.pool_base_token_account, pool.pool_quote_token_account]);
  if (b && q) {
    const bb = unitsToNumber(tokenAccountAmount(b.data), COIN_DECIMALS), qq = unitsToNumber(tokenAccountAmount(q.data) + poolVirtualQuote(info.data), quoteDecimals);
    if (bb > 0 && qq > 0) { out.priceQ = qq / bb; out.capQ = out.priceQ * out.supply; }
  }
  return out;
}

/* ───────────── the launch, and its lookup tables ─────────────
 * ONE transaction, like pump.fun's own: create_v2 paired with Q ($ADS), its CREATOR set to the coin's creator wallet (a
 * key Ads holds, so pump.fun pays 100% of the creator fees there from the first slot), and the launcher's first buy. Nothing can
 * land between the creation and that buy. Fits 1,232 B through lookup tables: 964..1,079 B measured (32-char name) with
 * the static accounts and the pair's own in tables (scripts/one-tx-size.mjs). */

/** The launch's instructions (api/launch.mjs adds the compute budget). `firstBuy`: { global, currency, amountIn, minOut } or null. */
export async function launchIxs(connection, { mint, user, name, symbol, uri, creator, quote, creatorFeeBps, firstBuy = null }) {
  if (!creator) throw new Error('launchIxs: creator (the coin\'s creator wallet) is required');
  const ixs = [await createV2Ix(connection, { mint, user, name, symbol, uri, creator: new PublicKey(creator), quote, creatorFeeBps })];
  if (firstBuy) ixs.push(...(await firstBuyIxs(connection, firstBuy.global, { mint, user, q: quote, currency: firstBuy.currency, amountIn: firstBuy.amountIn, minOut: firstBuy.minOut })));
  return ixs;
}

const keysOfIxs = (ixs) => new Set(ixs.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())]));
const throwaway = () => ({ mint: Keypair.generate().publicKey, user: Keypair.generate().publicKey, creator: Keypair.generate().publicKey, name: 'x', symbol: 'X', uri: 'https://x', creatorFeeBps: 100 });
/** Every key a launch against q may use: with no first buy, a buy in q, and (a pump coin pair) a buy in SOL. */
async function launchKeyVariants(connection, global, q) {
  const variants = [null, { global, currency: 'quote', amountIn: 1n, minOut: 1n }];
  if (q.kind !== 'listed') variants.push({ global, currency: 'sol', amountIn: 1n, minOut: 1n });
  const out = [];
  for (const firstBuy of variants) out.push(keysOfIxs(await launchIxs(connection, { ...throwaway(), quote: q, firstBuy })));
  return out;
}

/**
 * The accounts every launch shares (programs, pump.fun and PumpSwap globals, fee configs, event authorities, the buyback
 * wallet's wSOL account …): keys common to launches against `quoteA` and `quoteB` (each with a buy in the pair), plus the
 * wSOL route's own fixed accounts. The pairs' own mints are left out (they belong in pair tables).
 */
export async function launchStaticAccounts(connection, quoteA, quoteB) {
  const global = await loadGlobal(connection);
  const fb = { global, currency: 'quote', amountIn: 1n, minOut: 1n };
  const a = keysOfIxs(await launchIxs(connection, { ...throwaway(), quote: quoteA, firstBuy: fb }));
  const b = keysOfIxs(await launchIxs(connection, { ...throwaway(), quote: quoteB, firstBuy: fb }));
  const skip = new Set([quoteA.mint, quoteB.mint]);
  const common = [...a].filter((k) => b.has(k) && !skip.has(k));
  const wsolRoute = [WSOL, TOKEN_PROGRAM, ata(buybackWallet(global), WSOL, TOKEN_PROGRAM)].map((k) => k.toBase58());
  return [...new Set([...common, ...wsolRoute])].map((k) => new PublicKey(k));
}

/** A pair's own accounts every launch against it repeats (Q's mint, curve, pool, vaults, buyback Q account …), minus the static ones. */
export async function quoteAccounts(connection, quote, staticKeys) {
  const s = new Set(staticKeys.map((k) => k.toBase58()));
  const global = await loadGlobal(connection);
  const x = await launchKeyVariants(connection, global, quote), y = await launchKeyVariants(connection, global, quote);
  const again = new Set(y.flatMap((set) => [...set]));
  return [...new Set(x.flatMap((set) => [...set]))].filter((k) => again.has(k) && !s.has(k)).map((k) => new PublicKey(k));
}

export async function loadLookupTable(connection, address) {
  const r = await connection.getAddressLookupTable(new PublicKey(address));
  return r.value;
}

/* ───────────── the first buy (multi_hop_swap) ─────────────
 * PumpSwap's multi_hop_swap (pump-public-docs MULTI_HOP_SWAP.md): 16 fixed accounts + 5 per hop. Ads uses it for the
 * launcher's first buy in either currency: SOL → Q → coin (two hops, Q a pump coin) or Q → coin (one hop, any Q; a
 * one-hop route pays exactly what buy_v3 pays). Fees are charged once per route. */

export const AMM_GLOBAL_CONFIG = pda([Buffer.from('global_config')], PUMP_AMM);
export const AMM_FEE_CONFIG = pda([Buffer.from('fee_config'), PUMP_AMM.toBuffer()], PFEE);
export const PUMP_FEE_CONFIG = pda([Buffer.from('fee_config'), PUMP.toBuffer()], PFEE);
export const AMM_EVENT_AUTHORITY = pda([Buffer.from('__event_authority')], PUMP_AMM);
export const PUMP_EVENT_AUTHORITY = pda([Buffer.from('__event_authority')]);
export const userVolumeAccumulatorAmm = (user) => pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP_AMM);
const SYSTEM = new PublicKey('11111111111111111111111111111111');

/** One of pump.fun's 8 buyback wallets (any is accepted); the trade pays the buyback part of its fee to its `mint` ATA. */
export const buybackWallet = (global) => global.buyback_fee_recipients.find((k) => !k.equals(PublicKey.default));

/** Q's live reserves for pricing (curve: virtual; pool: balances + PumpSwap's virtual quote). Null when unreadable. */
export async function quoteReserves(connection, q) {
  if (q.kind === 'curve') {
    const info = await connection.getAccountInfo(new PublicKey(q.curve));
    if (!info) return null;
    const c = decodeBondingCurve(info.data);
    return { base: BigInt(c.virtual_token_reserves.toString()), quote: BigInt(c.virtual_quote_reserves.toString()) };
  }
  if (q.kind === 'pool') {
    const [poolInfo, b, qq] = await connection.getMultipleAccountsInfo([q.pool.address, q.pool.base, q.pool.quote].map((k) => new PublicKey(k)));
    if (!poolInfo || !b || !qq) return null;
    return { base: tokenAccountAmount(b.data), quote: tokenAccountAmount(qq.data) + poolVirtualQuote(poolInfo.data) };
  }
  return null;
}

const big = (x) => BigInt(x.toString());
/**
 * The new coin's opening virtual quote reserves, as pump.fun computes them at create_v2 (ported from pump-sdk 4.0.0
 * pumpQuoteReserves): a listed Q has its own entry; a pump coin Q gets "what ~85 SOL buys of Q on Q's own curve or
 * pool, without fees", scaled back to a seed.
 */
export function initialQuoteReserves(global, q, entries, reserves) {
  if (q.kind === 'listed') {
    const e = entries.find((x) => x.mint === q.mint);
    if (!e) throw new Error('Q is no longer on pump.fun\'s list');
    return e.initialVirtualQuoteReserves;
  }
  if (!reserves || reserves.quote <= 0n) throw new Error('Q has no readable reserves');
  // Q is depth 0 and paired with SOL (or a listed quote): its target is that quote's normal opening reserve.
  const quoteOfQ = q.quoteOfQ ? new PublicKey(q.quoteOfQ) : WSOL;
  const target = quoteOfQ.equals(WSOL) || quoteOfQ.equals(PublicKey.default) ? big(global.initial_virtual_sol_reserves)
    : (entries.find((x) => x.mint === quoteOfQ.toBase58())?.initialVirtualQuoteReserves ?? big(global.initial_virtual_quote_reserves));
  const vt0 = big(global.initial_virtual_token_reserves), rt0 = big(global.initial_real_token_reserves), tradable = vt0 - rt0;
  const input = (target * rt0) / tradable;
  const raise = (input * reserves.base) / (reserves.quote + input);
  const derived = (raise * tradable) / rt0;
  if (derived < 1n) throw new Error('Q is priced too high to pair with (pump.fun error 6104)');
  return derived;
}

/**
 * The tokens a first buy should receive at the opening price, before slippage: `amountIn` in SOL lamports (`currency`
 * 'sol', through Q's curve or pool) or in Q units ('quote'). Fees are charged once per route; `feeBps` is a ceiling
 * for all of them together, so the estimate errs low.
 */
export function quoteFirstBuy({ global, q, entries, reserves, currency, amountIn, feeBps = 600n }) {
  let qIn = BigInt(amountIn);
  if (currency === 'sol') {
    if (q.kind === 'listed') throw new Error('A first buy in SOL needs a pump coin pair; pay in the pair token instead');
    qIn = (qIn * reserves.base) / (reserves.quote + qIn);
  }
  qIn = (qIn * (10_000n - feeBps)) / 10_000n;
  const vq0 = initialQuoteReserves(global, q, entries, reserves), vt0 = big(global.initial_virtual_token_reserves);
  const out = (qIn * vt0) / (vq0 + qIn);
  const cap = big(global.initial_real_token_reserves);
  return out > cap ? cap : out;
}

/**
 * The first buy of `mint` (a coin paired with q) by `user`: the account setup it needs, then multi_hop_swap.
 * 'sol': SOL → Q → coin; wraps exactly `amountIn` when Q trades on a pool (a SOL curve hop takes native SOL but the
 *        wrapped SOL account must still exist), and closes the wrapped SOL account after, returning anything left.
 * 'quote': Q → coin from the user's own Q account.
 * `coinPool` ({ address, base, quote }): the coin has graduated, its hop is its PumpSwap pool (any later buy).
 */
export async function firstBuyIxs(connection, global, { mint, user, q, currency, amountIn, minOut, coinPool = null }) {
  const { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction } = await import('@solana/spl-token');
  const { SystemProgram } = await import('@solana/web3.js');
  const Q = new PublicKey(q.mint), qProg = new PublicKey(q.tokenProgram), buyback = buybackWallet(global);
  const curve = bondingCurveAddress(mint);
  const acc = (k, w = false) => ({ pubkey: k, isSigner: false, isWritable: w });
  // The coin's own hop: its curve, or (graduated) its PumpSwap pool against Q.
  let coinHop = [acc(mint), acc(Q), acc(curve, true), acc(ata(curve, mint, TOKEN_2022), true), acc(ata(curve, Q, qProg), true)];
  if (coinPool) coinHop = [acc(mint), acc(Q), acc(new PublicKey(coinPool.address), true), acc(new PublicKey(coinPool.base), true), acc(new PublicKey(coinPool.quote), true)];
  const userOut = ata(user, mint, TOKEN_2022);
  const pre = [createAssociatedTokenAccountIdempotentInstruction(user, userOut, user, mint, TOKEN_2022)];
  const post = [];
  let userIn, buybackAta, hops;
  if (currency === 'sol') {
    if (q.kind === 'listed') throw new Error('A first buy in SOL needs a pump coin pair');
    userIn = ata(user, WSOL, TOKEN_PROGRAM);
    buybackAta = ata(buyback, WSOL, TOKEN_PROGRAM);
    pre.push(createAssociatedTokenAccountIdempotentInstruction(user, userIn, user, WSOL, TOKEN_PROGRAM));
    pre.push(createAssociatedTokenAccountIdempotentInstruction(user, buybackAta, buyback, WSOL, TOKEN_PROGRAM));
    let qHop;
    if (q.kind === 'pool') {
      pre.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: userIn, lamports: BigInt(amountIn) }), createSyncNativeInstruction(userIn));
      qHop = [acc(Q), acc(WSOL), acc(new PublicKey(q.pool.address), true), acc(new PublicKey(q.pool.base), true), acc(new PublicKey(q.pool.quote), true)];
    } else {
      const qc = new PublicKey(q.curve);
      qHop = [acc(Q), acc(WSOL), acc(qc, true), acc(ata(qc, Q, qProg), true), acc(ata(qc, WSOL, TOKEN_PROGRAM), true)];
    }
    post.push(createCloseAccountInstruction(userIn, user, user, [], TOKEN_PROGRAM));
    hops = [...qHop, ...coinHop];
  } else {
    userIn = ata(user, Q, qProg);
    buybackAta = ata(buyback, Q, qProg);
    pre.push(createAssociatedTokenAccountIdempotentInstruction(user, buybackAta, buyback, Q, qProg));
    hops = coinHop;
  }
  const swap = await programs(connection).amm.methods.multiHopSwap(new BN(String(amountIn)), new BN(String(minOut > 0n ? minOut : 1n)))
    .accountsPartial({
      user, userInTokenAccount: userIn, userOutTokenAccount: userOut, globalConfig: AMM_GLOBAL_CONFIG, feeConfig: AMM_FEE_CONFIG,
      userVolumeAccumulator: userVolumeAccumulatorAmm(user), buybackFeeRecipient: buybackAta, tokenProgram: TOKEN_PROGRAM,
      token2022Program: TOKEN_2022, systemProgram: SYSTEM, eventAuthority: AMM_EVENT_AUTHORITY, program: PUMP_AMM,
      pumpProgram: PUMP, pumpGlobal: globalAddress(), pumpFeeConfig: PUMP_FEE_CONFIG, pumpEventAuthority: PUMP_EVENT_AUTHORITY,
    })
    .remainingAccounts(hops)
    .instruction();
  return [...pre, swap, ...post];
}

/**
 * Selling Q (a pump coin: on its curve or its PumpSwap pool) for SOL: multi_hop_swap with ONE hop, Q → wSOL, from
 * `user`'s Q account into a wSOL account that is closed after (the SOL lands in `user`). The treasury's daily sale.
 */
export async function sellQuoteIxs(connection, global, { user, q, amountIn, minOut }) {
  const { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction } = await import('@solana/spl-token');
  if (q.kind === 'listed') throw new Error('selling for SOL needs a pump coin');
  const Q = new PublicKey(q.mint), qProg = new PublicKey(q.tokenProgram), buyback = buybackWallet(global);
  const acc = (k, w = false) => ({ pubkey: k, isSigner: false, isWritable: w });
  const userIn = ata(user, Q, qProg), userOut = ata(user, WSOL, TOKEN_PROGRAM), buybackAta = ata(buyback, WSOL, TOKEN_PROGRAM);
  let hop;
  if (q.kind === 'pool') hop = [acc(Q), acc(WSOL), acc(new PublicKey(q.pool.address), true), acc(new PublicKey(q.pool.base), true), acc(new PublicKey(q.pool.quote), true)];
  else { const qc = new PublicKey(q.curve); hop = [acc(Q), acc(WSOL), acc(qc, true), acc(ata(qc, Q, qProg), true), acc(ata(qc, WSOL, TOKEN_PROGRAM), true)]; }
  const swap = await programs(connection).amm.methods.multiHopSwap(new BN(String(amountIn)), new BN(String(minOut > 0n ? minOut : 1n)))
    .accountsPartial({
      user, userInTokenAccount: userIn, userOutTokenAccount: userOut, globalConfig: AMM_GLOBAL_CONFIG, feeConfig: AMM_FEE_CONFIG,
      userVolumeAccumulator: userVolumeAccumulatorAmm(user), buybackFeeRecipient: buybackAta, tokenProgram: TOKEN_PROGRAM,
      token2022Program: TOKEN_2022, systemProgram: SYSTEM, eventAuthority: AMM_EVENT_AUTHORITY, program: PUMP_AMM,
      pumpProgram: PUMP, pumpGlobal: globalAddress(), pumpFeeConfig: PUMP_FEE_CONFIG, pumpEventAuthority: PUMP_EVENT_AUTHORITY,
    })
    .remainingAccounts(hop)
    .instruction();
  return [
    createAssociatedTokenAccountIdempotentInstruction(user, userOut, user, WSOL, TOKEN_PROGRAM),
    createAssociatedTokenAccountIdempotentInstruction(user, buybackAta, buyback, WSOL, TOKEN_PROGRAM),
    swap,
    createCloseAccountInstruction(userOut, user, user, [], TOKEN_PROGRAM),
  ];
}

/** Lamports a sale of `amountIn` Q should get against Q's reserves (`quoteReserves`), before fees (`feeBps` ceiling). */
export function quoteSell({ reserves, amountIn, feeBps = 300n }) {
  const out = (BigInt(amountIn) * reserves.quote) / (reserves.base + BigInt(amountIn));
  return (out * (10_000n - feeBps)) / 10_000n;
}

/* ───────────── collect, burn 20%, fund the ads ───────────── */

/** The share of every fee pass that burns $ADS (operator, 10 Oct 2026: 20% burn, 80% to the coin's ad budget). */
export const BURN_BPS = 2_000n;
export const splitFees = (units) => { const burn = (BigInt(units) * BURN_BPS) / 10_000n; return { burn, toTreasury: BigInt(units) - burn }; };

/**
 * Everything waiting for a coin's creator wallet, collected INTO it: its Q account (made if missing, `payer` pays the
 * rent once), sweep the curve's waiting fee into the creator vault and collect it, the same on PumpSwap once graduated.
 * All permissionless. ⛔ The sweeps come first: new-style trades keep the fees on the curve / pool until swept.
 */
export async function collectIxs(connection, { mint, payer, creator, quote, graduated }) {
  const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');
  const m = new PublicKey(mint), c = new PublicKey(creator), Q = new PublicKey(quote.mint), prog = new PublicKey(quote.tokenProgram);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(payer, ata(c, Q, prog), c, Q, prog),
    await sweepCurveCreatorFeeIx(connection, { mint: m, payer, creator: c, quote }),
    await collectCreatorFeeV2Ix(connection, { creator: c, quote }),
  ];
  if (graduated) ixs.push(await sweepPoolCreatorFeeIx(connection, { mint: m, payer, creator: c, quote }), await collectCoinCreatorFeeIx(connection, { creator: c, quote }));
  return ixs;
}

/**
 * The split of `amount` Q units the creator wallet holds after collecting: burn 20% (burnChecked, Q's supply drops) and
 * send 80% to the treasury's Q account (made if missing; `payer` pays). The creator wallet signs both as owner.
 */
export async function splitIxs({ payer, creator, treasury, quote, amount }) {
  const { createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction, createTransferCheckedInstruction } = await import('@solana/spl-token');
  const c = new PublicKey(creator), t = new PublicKey(treasury), Q = new PublicKey(quote.mint), prog = new PublicKey(quote.tokenProgram);
  const from = ata(c, Q, prog), to = ata(t, Q, prog);
  const { burn, toTreasury } = splitFees(amount);
  const ixs = [];
  if (burn > 0n) ixs.push(createBurnCheckedInstruction(from, Q, c, burn, quote.decimals, [], prog));
  if (toTreasury > 0n) ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, to, t, Q, prog), createTransferCheckedInstruction(from, Q, to, c, toTreasury, quote.decimals, [], prog));
  return { ixs, burn, toTreasury };
}

/* ───────────── graduation ───────────── */

/** PumpSwap's boost vault authority of a pool (migrate_v2 takes it and its Q account as remaining accounts). */
export const boostVaultAuthority = (pool) => pda([Buffer.from('boost_vault'), pool.toBuffer()], PUMP_AMM);

/**
 * migrate_v2 for a completed Ads coin: creates its PumpSwap pool against Q (index 0, pump's pool authority) with the
 * reserves the curve left. Permissionless (only `user` signs and pays). Mirrors pump-sdk 4.0.0 migrateV2Instruction.
 */
export async function migrateV2Ix(connection, global, { mint, user, quote }) {
  const m = new PublicKey(mint), Q = new PublicKey(quote.mint), qProg = new PublicKey(quote.tokenProgram);
  const curve = bondingCurveAddress(m), auth = poolAuthority(m), pool = poolAddress(m, 0, Q), boost = boostVaultAuthority(pool);
  return programs(connection).pump.methods.migrateV2()
    .accountsPartial({
      baseMint: m, quoteMint: Q, user, withdrawAuthority: global.withdraw_authority, bondingCurve: curve,
      poolAuthorityMintAccount: ata(auth, m, TOKEN_2022), poolBaseTokenAccount: ata(pool, m, TOKEN_2022), pool, poolAuthority: auth,
      associatedBaseBondingCurve: ata(curve, m, TOKEN_2022), associatedQuoteBondingCurve: ata(curve, Q, qProg),
      poolAuthorityQuoteAccount: ata(auth, Q, qProg), poolQuoteTokenAccount: ata(pool, Q, qProg), baseTokenProgram: TOKEN_2022, quoteTokenProgram: qProg,
      pumpAmm: PUMP_AMM, pumpAmmEventAuthority: AMM_EVENT_AUTHORITY, eventAuthority: PUMP_EVENT_AUTHORITY, program: PUMP,
    })
    .remainingAccounts([{ pubkey: boost, isSigner: false, isWritable: false }, { pubkey: ata(boost, Q, qProg), isSigner: false, isWritable: true }])
    .instruction();
}

/** The coin's own pool accounts once it exists, else null. */
export async function readCoinPool(connection, mint, quote) {
  const addr = coinPoolAddress(mint, quote), info = await connection.getAccountInfo(addr);
  if (!info || info.data.length < 200) return null;
  const d = decodePool(info.data);
  return { address: addr.toBase58(), base: d.pool_base_token_account.toBase58(), quote: d.pool_quote_token_account.toBase58(), coinCreator: d.coin_creator.toBase58() };
}
