import test from 'node:test';
import assert from 'node:assert/strict';
import { rateFrom, maxPayRaw, recordLimitRaw, usdFor } from '../lib/fx.mjs';

test('testnet scale: 45,000 won at 1,390 KRW/USD, 1:1000 -> rate 719,424, at most 32,375 raw, asks HSP for $0.03', () => {
  const r = rateFrom({ krwPerUsd: 1390, scale: 1000 });
  assert.equal(r, 719424n);
  assert.equal(maxPayRaw(45000, r), 32375n);          // = CareMandate.maxPayRaw (forge test_capConversionAndOverMandatePaymentRefused)
  assert.equal(recordLimitRaw(45000, r), 33993n);
  assert.equal(usdFor(45000, r), '0.03');
  assert.ok(30006n <= recordLimitRaw(45000, r));       // HSP's live quote for $0.03 (+0.02%) fits
});
test('real scale: 45,000 won = $32.37', () => {
  const r = rateFrom({ krwPerUsd: 1390, scale: 1 });
  assert.equal(usdFor(45000, r), '32.37');
});
test('rounds the HSP ask down, never up', () => {
  assert.equal(usdFor(13901, 719424n), '0.01');       // 10,000.6 raw -> $0.01
  assert.throws(() => usdFor(13900, 719424n));         // 9,999.99 raw: under a cent, refused rather than rounded up
  assert.equal(usdFor(27799, 719424n), '0.01');       // 19,999.x raw -> $0.01, not $0.02
});
test('refuses nonsense', () => {
  assert.throws(() => rateFrom({ krwPerUsd: 0 }));
  assert.throws(() => rateFrom({ krwPerUsd: 1390, scale: 0 }));
  assert.throws(() => usdFor(100, 719424n));            // 0.07 cent
});
