// The off-chain provider credit ledger (api/content/credits.mjs): balance arithmetic, the low alarm, the hard stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ads-credits-')), 'ads.db');
const cr = await import('../api/content/credits.mjs');
const { getKv } = await import('../api/db.mjs');

test('higgsfield balance: unknown until set, then set + top-ups - spend; low under $10', () => {
  assert.equal(cr.higgsfield().known, false);
  cr.setBalance(20);
  cr.recordSpend(4_500_000, 'video');
  cr.topup(5);
  const s = cr.higgsfield();
  assert.equal(s.known, true);
  assert.equal(s.balanceUsd, 20.5);
  assert.equal(s.low, false);
  cr.recordSpend(12_000_000, 'trailer');
  assert.equal(cr.higgsfield().low, true, '$8.50 left is under the $10 floor');
  cr.setBalance(100); // the Console figure replaces the running count
  assert.equal(cr.higgsfield().balanceUsd, 100);
});

test('a "no credit" refusal pauses all generation (kill switch) and a top-up clears the flag', () => {
  assert.equal(cr.isCreditError({ status: 402, message: '' }), true);
  assert.equal(cr.isCreditError({ status: 400, message: 'higgsfield POST /x 400: Insufficient balance' }), true);
  assert.equal(cr.isCreditError({ status: 400, message: 'too many concurrent requests' }), false);
  cr.outOfCredits('402 payment required');
  assert.equal(getKv('content.killed', false), true);
  assert.ok(cr.higgsfield().outOfCredits);
  cr.topup(50);
  assert.equal(cr.higgsfield().outOfCredits, null);
});
