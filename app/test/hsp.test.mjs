// Offline tests of the HSP QA flow against replies shaped like the live server's (test/fixtures: real QA replies, no secrets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { payVisit, firewall, pickToken, Refused, MERCHANT, mcpClient } from '../lib/hsp.mjs';

const FX = new URL('./fixtures/', import.meta.url);
const CFG = JSON.parse(fs.readFileSync(new URL('live_chain_config.json', FX))).config;
const PREP = JSON.parse(fs.readFileSync(new URL('live_prepare_payment.json', FX)));
const payer = privateKeyToAccount('0x' + '11'.repeat(32));
const payTo = '0x58232CF98671Bc0Bd0E7aaA7cd6adE9EdB2E64A6';
process.env.HSP_POLL_MS = '1';   // no real waits in the poll loop
const NOW = 1793530000 * 1000;   // the fixture's validBefore is 1793535406 (about 1.5 h later)

// a live-shaped prepare_payment for our payer (the fixture's own payer swapped in, nothing else changed)
function prepFor(p = payer.address, edit = (x) => x) {
  const x = structuredClone(PREP);
  x.eip712.message.from = p;
  return edit(x);
}
function fakeHsp({ prep = prepFor(), statuses = ['payment-processing', 'payment-safe'], wrap = true } = {}) {
  const calls = []; let prId = null; const st = [...statuses];
  const w = (d) => wrap ? { code: 0, msg: 'success', data: d } : d;
  return { calls, tool: async (name, args) => {
    calls.push([name, args]);
    if (name === 'get_chain_config') return w(CFG);
    if (name === 'create_order') { prId = args.cart_mandate.contents.payment_request.details.id; return w({ flow_id: 'flow-1', payment_request_id: prId, payment_url: 'https://x/pay?f=1' }); }
    if (name === 'get_order') return w({ flow_id: 'flow-1', merchant_name: MERCHANT, payment_request_id: prId, method_data: [] });
    if (name === 'prepare_payment') return w(prep);
    if (name === 'finalize_payment') return w({ payment_mandate_json: '{"pm":1}' });
    if (name === 'submit_payment') return w({ status: 'payment-submitted' });
    if (name === 'query_payment') return w({ status: st.shift() || 'payment-safe', payment: { tx_signature: '0xabc' }, attribution_verified: true });
    throw new Error('unexpected tool ' + name);
  } };
}

test('pickToken: default is Circle USDC on Ethereum Sepolia (the event HSP test network); base-sepolia when asked', () => {
  const t = pickToken({ code: 0, data: CFG });
  assert.equal(t.network, 'sepolia'); assert.equal(t.chainId, 11155111); assert.equal(t.address, '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'); assert.equal(t.decimals, 6);
  const b = pickToken({ code: 0, data: CFG }, 'base-sepolia');
  assert.equal(b.chainId, 84532); assert.equal(b.address, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
});

test('qa flow: order, firewall, real signature, submit, poll to payment-safe', async () => {
  process.env.HSP_POLL_MS = '1';
  process.env.HSP_NETWORK = 'base-sepolia';   // the recorded live prepare_payment fixture is a Base Sepolia payment
  const hsp = fakeHsp();
  let typedSeen;
  const r = await payVisit({ mode: 'qa', visitId: 7, amountUsd: '0.01', payTo, payer: payer.address, client: hsp, now: () => NOW,
    signTypedData: async (td) => { typedSeen = td; return payer.signTypedData(td); } });
  assert.equal(r.status, 'payment-safe'); assert.equal(r.flowId, 'flow-1'); assert.equal(r.txHash, '0xabc'); assert.equal(r.attributionVerified, true);
  assert.deepEqual(hsp.calls.map((c) => c[0]), ['get_chain_config', 'create_order', 'get_order', 'prepare_payment', 'finalize_payment', 'submit_payment', 'query_payment', 'query_payment']);
  const co = hsp.calls[1][1];
  assert.equal(co.merchant_name, MERCHANT); assert.equal(co.cart_mandate.contents.merchant_name, MERCHANT);
  assert.equal(co.cart_mandate.contents.payment_request.details.total.amount.value, '0.01');
  assert.equal(co.cart_mandate.contents.payment_request.method_data[0].data.chain_id, 84532);
  // the signature HSP receives recovers to our payer over the exact typed data HSP sent (hex chainId handled)
  const sig = hsp.calls[4][1].signature;
  assert.equal(await recoverTypedDataAddress({ ...typedSeen, signature: sig }), payer.address);
  assert.equal(hsp.calls[4][1].cart_hash, PREP.cart_hash);
});

test('firewall: every tampered field is refused before signing (positive controls)', () => {
  const ok = { payer: payer.address, payTo, token: pickToken(CFG), amountUsd: '0.01', now: NOW };
  assert.ok(firewall(prepFor(), ok));
  const cases = {
    payee: (x) => { x.eip712.message.to = '0x000000000000000000000000000000000000dEaD'; return x; },
    amount: (x) => { x.eip712.message.value = '20000'; x.payment_payload.accepted.amount = '20000'; return x; },
    chainId: (x) => { x.eip712.domain.chainId = '0x1'; return x; },
    'token contract': (x) => { x.eip712.domain.verifyingContract = '0x000000000000000000000000000000000000bEEF'; return x; },
    primaryType: (x) => { x.eip712.primaryType = 'Permit'; return x; },
    'validity window': (x) => { x.eip712.message.validBefore = String(NOW / 1000 + 86400); return x; },
    'x402 payload': (x) => { x.payment_payload.accepted.payTo = '0x000000000000000000000000000000000000dEaD'; return x; },
  };
  for (const [rule, edit] of Object.entries(cases)) assert.throws(() => firewall(prepFor(payer.address, edit), ok), Refused, rule);
  assert.throws(() => firewall(prepFor('0x000000000000000000000000000000000000c0de'), ok), /payer/);
  assert.throws(() => firewall(prepFor(), { ...ok, amountUsd: '5' }), /per-payment cap/);
});

test('qa flow: a refused order is never signed or submitted', async () => {
  const hsp = fakeHsp({ prep: prepFor(payer.address, (x) => { x.eip712.message.to = '0x000000000000000000000000000000000000dEaD'; return x; }) });
  let signed = 0;
  await assert.rejects(payVisit({ mode: 'qa', visitId: 8, amountUsd: '0.01', payTo, payer: payer.address, client: hsp, now: () => NOW,
    signTypedData: async () => { signed++; return '0x'; } }), Refused);
  assert.equal(signed, 0); assert.ok(!hsp.calls.some((c) => c[0] === 'submit_payment'));
});

test('qa flow: an order HSP describes differently (other merchant) is never prepared or signed', async () => {
  const hsp = fakeHsp(); const orig = hsp.tool;
  hsp.tool = async (n, a) => n === 'get_order' ? { code: 0, data: { flow_id: 'flow-1', merchant_name: 'Someone Else', method_data: [] } } : orig(n, a);
  let signed = 0;
  await assert.rejects(payVisit({ mode: 'qa', visitId: 9, amountUsd: '0.01', payTo, payer: payer.address, client: hsp, now: () => NOW,
    signTypedData: async () => { signed++; return '0x'; } }), /get_order is not our order/);
  assert.equal(signed, 0); assert.ok(!hsp.calls.some((c) => c[0] === 'prepare_payment'));
});

test('mock mode is labelled MOCK', async () => {
  const r = await payVisit({ mode: 'mock', visitId: 1, amountUsd: '0.01', payTo, payer: payer.address });
  assert.match(r.flowId, /^MOCK-/); assert.equal(r.txHash, null);
});

test('settle poll: transient query errors and payment-timeout are ridden out; status changes are logged', async () => {
  process.env.HSP_NETWORK = 'base-sepolia';
  const hsp = fakeHsp({ statuses: ['payment-processing', 'payment-timeout', 'payment-included', 'payment-safe'] }); const orig = hsp.tool; let fails = 2;
  hsp.tool = async (n, a) => { if (n === 'query_payment' && fails-- > 0) throw new Error('HSP MCP HTTP 502'); return orig(n, a); };
  const logs = [];
  const r = await payVisit({ mode: 'qa', visitId: 10, amountUsd: '0.01', payTo, payer: payer.address, client: hsp, now: () => NOW, log: (o) => logs.push(o),
    signTypedData: (td) => payer.signTypedData(td) });
  assert.equal(r.status, 'payment-safe');
  assert.deepEqual(logs.filter((l) => l.step === 'status').map((l) => l.status), ['payment-processing', 'payment-timeout', 'payment-included', 'payment-safe']);
  assert.equal(logs.filter((l) => l.step === 'query_error').length, 2);
  assert.ok(logs.some((l) => l.step === 'submitted' && l.flowId === 'flow-1'));
});

test('settle poll: payment-failed and the deadline throw with the flow id (never a silent hang)', async () => {
  const { waitSettled } = await import('../lib/hsp.mjs');
  const failed = fakeHsp({ statuses: ['payment-failed'] });
  await assert.rejects(waitSettled({ hsp: failed, flowId: 'flow-1', prId: 'p' }), (e) => e.code === 'FAILED' && e.flowId === 'flow-1');
  const stuck = fakeHsp({ statuses: Array(1000).fill('payment-processing') }); let t = 0;
  await assert.rejects(waitSettled({ hsp: stuck, flowId: 'flow-2', prId: 'p', now: () => (t += 1000), settleMs: 5000 }), (e) => e.code === 'UNSETTLED' && e.flowId === 'flow-2' && e.lastStatus === 'payment-processing');
  const down = fakeHsp(); down.tool = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(waitSettled({ hsp: down, flowId: 'flow-3', prId: 'p' }), (e) => e.code === 'UNSETTLED' && /6x/.test(e.message));
});

// HSP QA drops ~8% of requests (11-25): transport failures are retried with backoff, except the calls that move a payment forward.
function flakyFetch(failFirst) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body.method === 'tools/call' ? body.params.name : body.method);
    if (calls.length <= failFirst) throw new TypeError('fetch failed');
    const reply = body.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? {} : { structuredContent: { ok: true } } });
    return new Response(reply, { status: body.id === undefined ? 202 : 200, headers: { 'content-type': 'application/json' } });
  };
  return { f, calls };
}
test('mcp client: transient fetch failures are retried with backoff (init and read tools)', async () => {
  const { f, calls } = flakyFetch(2); const waits = [];
  const c = mcpClient('https://hsp.test/', f, { sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await c.tool('get_order', { flow_id: 'x' }), { ok: true });
  assert.deepEqual(waits, [2000, 4000]);
  assert.equal(calls.filter((n) => n === 'initialize').length, 3);
});
test('mcp client: submit_payment and finalize_payment are never retried (control: get_order is)', async () => {
  for (const name of ['submit_payment', 'finalize_payment']) {
    const { f, calls } = flakyFetch(0); let ready = false;
    const c = mcpClient('https://hsp.test/', async (u, i) => { const b = JSON.parse(i.body); if (ready && b.method === 'tools/call') { calls.push('fail'); throw new TypeError('fetch failed'); } if (b.method === 'notifications/initialized') ready = true; return f(u, i); }, { sleep: async () => {} });
    await assert.rejects(c.tool(name, {}), /fetch failed/);
    assert.equal(calls.filter((n) => n === 'fail').length, 1, name);
  }
  const { f } = flakyFetch(0); let ready = false, fails = 0;
  const c = mcpClient('https://hsp.test/', async (u, i) => { const b = JSON.parse(i.body); if (ready && b.method === 'tools/call' && fails++ < 1) throw new TypeError('fetch failed'); if (b.method === 'notifications/initialized') ready = true; return f(u, i); }, { sleep: async () => {} });
  assert.deepEqual(await c.tool('get_order', {}), { ok: true });
  assert.equal(fails, 2);
});
