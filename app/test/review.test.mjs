// The family agent's visit-note review (lib/review.mjs): offline, the model replaced by a stub fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewVisit, ruleCheck, noteTimes } from '../lib/review.mjs';
import { receiptHash } from '../lib/chain.mjs';
import { NOTES, visitAt } from './review-fixtures.mjs';

const T = visitAt('2026-11-24T11:00');   // Tuesday 11:00 Korea time
const rc = (note, extra = {}) => ({ mandateId: 1, visitTime: T, amountWon: 45000, carer: 'Ji-woo', tasks: 'lunch, medicines, a short walk', agency: '0x' + '1'.repeat(40), note, ...extra });
const ENV_OFF = { CM_NET: 'local' };                                   // no model key: rules only
const stub = (reply, status = 200) => async () => ({ ok: status === 200, status, text: async () => (typeof reply === 'string' ? reply : JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] })) });
const ENV_M = { CM_NET: 'local', REVIEW_LLM_KEY: 'test', REVIEW_LLM_URL: 'http://127.0.0.1:9/' };
const run = (note, o = {}) => { const r = rc(note); return reviewVisit({ receipt: r, onchainHash: receiptHash(r), visitTime: T, env: ENV_OFF, ...o }); };

test('a normal note is paid (rules only, model off)', async () => {
  const d = await run(NOTES.normal);
  assert.equal(d.decision, 'pay', JSON.stringify(d)); assert.equal(d.source, 'rules'); assert.equal(d.model.error, 'off');
});
test('POSITIVE CONTROL: the anomalous note is held with the guard on, and paid with the guard off', async () => {
  const on = await run(NOTES.anomalous);
  assert.equal(on.decision, 'hold');
  for (const c of ['time_mismatch', 'short_visit', 'missed_task']) assert.ok(on.rules.includes(c), c + ' in ' + on.rules);
  const off = await run(NOTES.anomalous, { env: { CM_NET: 'local', REVIEW_OFF: '1' } });
  assert.equal(off.decision, 'pay'); assert.equal(off.source, 'off');
});
test('the guard cannot be switched off outside a local chain', async () => {
  await assert.rejects(run(NOTES.anomalous, { env: { CM_NET: 'testnet', REVIEW_OFF: '1' } }), /local test switch/);
});
test('no note, or a note that does not match the hash on chain, is held', async () => {
  assert.deepEqual((await run('')).rules, ['no_note']);
  const r = rc(NOTES.normal), h = receiptHash(r);
  const d = await reviewVisit({ receipt: { ...r, note: NOTES.normal.replace('12:35', '11:20') }, onchainHash: h, visitTime: T, env: ENV_OFF });
  assert.equal(d.decision, 'hold'); assert.ok(d.rules.includes('receipt_mismatch'));
  assert.equal((await reviewVisit({ receipt: null, visitTime: T, env: ENV_OFF })).decision, 'hold');
});
test('negated tasks are missed tasks', () => {
  const r = ruleCheck({ receipt: rc('Arrived 11:00, left 12:30. Cooked lunch, gave her pills, did not go for a walk because of rain.'), visitTime: T });
  assert.deepEqual(r.hold.map((h) => h.code), ['missed_task']);
  assert.match(r.hold[0].text, /walk/);
});
test('worrying words and text aimed at the agent are held, even if the model says pay', async () => {
  const pay = stub({ decision: 'pay', reasons: [] });
  const f = await run(NOTES.fall, { env: ENV_M, fetchImpl: pay });
  assert.equal(f.decision, 'hold'); assert.ok(f.rules.includes('concern'));
  const i = await run(NOTES.injection, { env: ENV_M, fetchImpl: pay });
  assert.equal(i.decision, 'hold'); assert.ok(i.rules.includes('instruction_text')); assert.equal(i.model.decision, 'pay');
});
test('the model can add a hold the rules miss', async () => {
  const d = await run(NOTES.cashSideDeal, { env: ENV_M, fetchImpl: stub({ decision: 'hold', reasons: ['Someone asked to be paid in cash outside the mandate.'] }) });
  assert.equal(d.rules.length, 0, 'rules see nothing: ' + d.rules);
  assert.equal(d.decision, 'hold'); assert.equal(d.source, 'model+rules'); assert.match(d.reasons[0], /^Model: .*cash/);
});
test('a broken, slow or odd model reply falls back to the rules', async () => {
  for (const f of [stub('not json'), stub({ decision: 'maybe', reasons: [] }), stub({ error: 'x' }, 500),
    (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))]) {
    const d = await run(NOTES.normal, { env: { ...ENV_M, REVIEW_LLM_TIMEOUT_MS: '200' }, fetchImpl: f });
    assert.equal(d.decision, 'pay'); assert.equal(d.source, 'rules'); assert.ok(d.model.error, 'model error recorded');
  }
});
test('note times', () => {
  assert.deepEqual(noteTimes('Arrived 11:02, left 12:35.'), { arrive: 662, leave: 755 });
  assert.deepEqual(noteTimes('Visit 11:00-12:30, all fine'), { arrive: 660, leave: 750 });
  assert.deepEqual(noteTimes('All fine'), { arrive: null, leave: null });
});
test('every fixture note the e2e runs post gets the expected rules decision', async () => {
  for (const [k, want] of Object.entries({ normal: 'pay', normal2: 'pay', normal3: 'pay', anomalous: 'hold', fall: 'hold', injection: 'hold', cashSideDeal: 'pay' })) {
    assert.equal((await run(NOTES[k])).decision, want, k);
  }
});
