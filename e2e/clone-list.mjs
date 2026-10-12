/**
 * Every mainnet account Ads' instructions touch, so a local validator can clone exactly those. Builds the real
 * instructions (paired create_v2, first buys in SOL, collect + split, the treasury's sale, migrate) with throwaway keys
 * against the $ADS stand-ins, keeps the accounts that EXIST on mainnet, and prints validator flags.
 * Also writes e2e/fixtures/launcher.json (a test launcher key).
 *   CLONE: SOLANA_RPC=<keyed> node e2e/clone-list.mjs > e2e/clones.txt
 */
import { Keypair, PublicKey } from '@solana/web3.js';
import fs from 'node:fs';
import * as sol from '../api/sol.mjs';
import * as pump from '../lib/pump.mjs';
import { ADS_STANDINS } from './standins.mjs';

const dir = new URL('./fixtures/', import.meta.url);
fs.mkdirSync(dir, { recursive: true });
const launcherFile = new URL('launcher.json', dir);
if (!fs.existsSync(launcherFile)) fs.writeFileSync(launcherFile, JSON.stringify([...Keypair.generate().secretKey]));
const L = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(launcherFile))));

const global = await pump.loadGlobal(sol.conn);
const entries = await pump.readQuoteControlEntries(sol.conn);
const keys = new Set();
const add = (ixs) => ixs.forEach((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)].forEach((k) => keys.add(k.toBase58())));
for (const [label, addr] of Object.entries(ADS_STANDINS)) {
  const q = await pump.resolveQuote(sol.conn, addr, { listed: entries.map((e) => e.mint) });
  if (!q.ok) throw new Error(`${label} ${addr}: ${q.reason}`);
  const mint = Keypair.generate().publicKey, user = Keypair.generate().publicKey, creator = Keypair.generate().publicKey;
  const fb = (currency) => ({ global, currency, amountIn: 1n, minOut: 1n });
  add([
    ...(await pump.launchIxs(sol.conn, { mint, user, creator, name: 'x', symbol: 'X', uri: 'https://x', quote: q, creatorFeeBps: 100, firstBuy: fb('sol') })),
    ...(await pump.collectIxs(sol.conn, { mint, payer: user, creator, quote: q, graduated: false })),
    ...(await pump.sellQuoteIxs(sol.conn, global, { user, q, amountIn: 1n, minOut: 1n })),
    await pump.migrateV2Ix(sol.conn, global, { mint, user, quote: q }),
  ]);
}
// Every buyback wallet's accounts (the route may pick any) and pump.fun's fee recipients.
for (const k of global.buyback_fee_recipients) keys.add(k.toBase58());

const BUILTIN = new Set(['11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'SysvarRent111111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', 'So11111111111111111111111111111111111111112']);
const list = [...keys];
const out = [];
for (let i = 0; i < list.length; i += 90) {
  const batch = list.slice(i, i + 90);
  const infos = await sol.conn.getMultipleAccountsInfo(batch.map((k) => new PublicKey(k)));
  batch.forEach((k, j) => {
    const a = infos[j];
    if (!a || BUILTIN.has(k)) return;
    if (a.executable) out.push(`--clone-upgradeable-program ${k}`);
    else if (!a.owner.equals(new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))) out.push(`--clone ${k}`);
  });
}

console.log(out.join('\n'));
process.exit(0);
