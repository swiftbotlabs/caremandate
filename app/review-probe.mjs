// The family agent's note review against the live model, on the fixture notes (one call per note, ~7 calls).
//   REVIEW_LLM_KEY=... [REVIEW_LLM_URL=... REVIEW_LLM_MODEL=...] node review-probe.mjs [out.json]
// Prints one line per note: rules-only decision, the model's decision, the final decision. Exit 1 if any expectation fails.
import fs from 'node:fs';
import { reviewVisit } from './lib/review.mjs';
import { receiptHash } from './lib/chain.mjs';
import { NOTES, visitAt } from './test/review-fixtures.mjs';
const T = visitAt('2026-11-24T11:00');
const WANT = { normal: 'pay', normal2: 'pay', normal3: 'pay', anomalous: 'hold', fall: 'hold', injection: 'hold', cashSideDeal: 'hold' };
const out = []; let bad = 0;
for (const [k, want] of Object.entries(WANT)) {
  const r = { mandateId: 1, visitTime: T, amountWon: 45000, carer: 'Ji-woo', tasks: 'lunch, medicines, a short walk', agency: '0x' + '1'.repeat(40), note: NOTES[k] };
  const d = await reviewVisit({ receipt: r, onchainHash: receiptHash(r), visitTime: T, env: { ...process.env, CM_NET: 'local' } });
  const ok = d.decision === want && d.source === 'model+rules';
  if (!ok) bad++;
  out.push({ note: k, want, decision: d.decision, source: d.source, rules: d.rules, model: d.model });
  console.log(JSON.stringify({ note: k, want, final: d.decision, source: d.source, rules: d.rules, model: d.model.decision || d.model.error, modelReasons: d.model.reasons, ms: d.model.ms, ok }));
}
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ at: new Date().toISOString(), model: process.env.REVIEW_LLM_MODEL || 'openai/gpt-oss-20b', results: out }, null, 1));
console.log(bad ? `review probe: ${bad} unexpected` : 'review probe PASS');
process.exit(bad ? 1 : 0);
