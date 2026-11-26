// Guard against lost updates in server.mjs: state.json is read-modify-written by several request handlers, and Node runs another
// handler at every `await`. A copy of the state taken by load() must never be saved after an await unless it was re-read after it.
// (26 Nov testnet run: /api/release read state, awaited a chain read, then saved its stale copy 100 ms after visit 5's review was
// stored, and the review record was lost.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

export function staleSaves(src) {
  const out = [];
  // split into top-level functions (good enough for this file: every handler is a top-level `function` / `async function`)
  const parts = src.split(/\n(?=(?:async )?function |const \w+ = (?:async )?\()/);
  for (const part of parts) {
    const name = (part.match(/^(?:async )?function (\w+)/) || part.match(/^const (\w+)/) || [, '?'])[1];
    const live = new Map();   // var -> 'fresh' | 'stale'
    for (const stmt of part.split(/;|\n/)) {
      const a = stmt.match(/\b(?:const|let)?\s*(\w+)\s*=\s*load\(\)/);
      if (a) live.set(a[1], 'fresh');
      if (/\bawait\b/.test(stmt)) for (const k of live.keys()) live.set(k, 'stale');
      for (const m of stmt.matchAll(/\bsave\((\w+)\)/g)) if (live.get(m[1]) === 'stale') out.push(`${name}: save(${m[1]}) after an await without re-reading`);
    }
  }
  return out;
}

test('server.mjs never saves a state copy that was read before an await', () => {
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.deepEqual(staleSaves(src), []);
});

test('positive control: the 26 Nov release() shape is caught', () => {
  const bad = `async function release({ visitId }) {
  const st = load(); const r = (st.reviews || {})[visitId];
  const vi = await visit(ctx, C, visitId);
  r.released = { by: 'mina' }; save(st);
}`;
  assert.equal(staleSaves(bad).length, 1);
  const good = bad.replace("r.released = { by: 'mina' }; save(st);", "const s2 = load(); s2.reviews[visitId].released = 1; save(s2);");
  assert.deepEqual(staleSaves(good), []);
});
