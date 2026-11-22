// Offline tests of the HSP QA flow against replies shaped like the live server's (test/fixtures: real QA replies, no secrets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { payVisit, firewall, pickToken, Refused, MERCHANT } from '../lib/hsp.mjs';

const FX = new URL('./fixtures/', import.meta.url);
const CFG = JSON.parse(fs.readFileSync(new URL('live_chain_config.json', FX))).config;
const PREP = JSON.parse(fs.readFileSync(new URL('live_prepare_payment.json', FX)));
const payer = privateKeyToAccount('0x' + '11'.repeat(32));
const payTo = '0x58232CF98671Bc0Bd0E7aaA7cd6adE9EdB2E64A6';
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
