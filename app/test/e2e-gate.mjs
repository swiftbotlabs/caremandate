// The gate of the end-to-end runs: decides PASS/FAIL from the run's records AND the chain (never from printed text).
//   node test/e2e-gate.mjs <runDir> <scenario>     scenario: ok | failed-once | timeout | overcharge | testnet
// Reads <runDir>/state.json, setup.json, agency.log, captrip.json, [mock-stats.json], [agency-watch.log]; re-reads every paid visit on
// chain (CM_NET), and, when SETTLE_RPC + SETTLE_TOKEN are set, the settlement transfer on HSP's network. Exit 0 = PASS.
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, http, parseAbiItem, decodeEventLog, keccak256, toBytes } from 'viem';
import { connect, visit, payment, mandate } from '../lib/chain.mjs';
import { recordLimitRaw, usdFor } from '../lib/fx.mjs';

const [dir, scen = 'ok'] = process.argv.slice(2);
const J = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const has = (f) => fs.existsSync(path.join(dir, f));
const jl = (f) => has(f) ? fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) : [];
const fails = []; let checks = 0;
const must = (ok, msg) => { checks++; if (!ok) fails.push(msg); };
const st = J('state.json'), setup = J('setup.json'), posts = jl('agency.log').filter((x) => x.visitId), watch = jl('agency-watch.log');
const stats = has('mock-stats.json') ? J('mock-stats.json') : null;
const ctx = connect(), C = setup.contract;
const m = await mandate(ctx, C, setup.mandateId);
const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const settle = process.env.SETTLE_RPC ? createPublicClient({ transport: http(process.env.SETTLE_RPC, { timeout: 30_000, retryCount: 4, retryDelay: 1_500 }) }) : null;
const TOKEN = (process.env.SETTLE_TOKEN || '').toLowerCase(), PAYTO = (process.env.AGENCY_PAYTO || '').toLowerCase();

// 1. the mandate's rate is on chain and the conversion shown is the contract's
must(m.rawPerMillionWon > 0n && String(m.rawPerMillionWon) === setup.fx.rawPerMillionWon, 'mandate rate on chain = setup fx');
must(usdFor(m.perVisitCap, m.rawPerMillionWon) === setup.fx.capUsd, 'cap in USD = setup fx');
// 2. cap trip: the over-cap visit was refused on chain and never became a visit
const trip = has('captrip.json') ? J('captrip.json') : null;
must(trip && trip.refused === true && trip.reason === 'BadInput' && trip.amountWon > Number(m.perVisitCap), 'cap-trip visit refused on chain (BadInput)');
const vc = Number(await ctx.pub.readContract({ address: C, abi: (await import('../lib/chain.mjs')).ABI, functionName: 'visitCount' }));
must(vc === posts.length && posts.length === 5, `visitCount ${vc} = 5 posted visits (the over-cap one is not a visit)`);

// 3. per visit
const flowsSigned = new Set(); let paid = 0, acked = 0, issues = 0, sumRaw = 0n;
for (const p of posts) {
  const id = p.visitId, v = await visit(ctx, C, id), oc = await payment(ctx, C, id), rec = st.payments[String(id)];
  issues += oc.issues;
  if (v.status === 'Paid') {
    paid++;
    must(rec && ['payment-safe', 'payment-finalized'].includes(rec.status), `visit ${id}: settled in records`);
    must(v.paymentRef.toLowerCase() === keccak256(toBytes(rec.flowId)).toLowerCase(), `visit ${id}: paymentRef = keccak(flow id)`);
    must(String(oc.paidRaw) === String(rec.paidRaw) && oc.paidRaw <= recordLimitRaw(v.amount, m.rawPerMillionWon), `visit ${id}: paidRaw on chain = signed value, within the mandate`);
    must(oc.settlementTx.toLowerCase() === String(rec.txHash).toLowerCase(), `visit ${id}: settlement tx on chain = HSP tx`);
    if (settle) {
      const rc = await settle.getTransactionReceipt({ hash: oc.settlementTx });
      const t = rc.logs.filter((l) => l.address.toLowerCase() === TOKEN && l.topics[0] === T0).map((l) => decodeEventLog({ abi: [TRANSFER], data: l.data, topics: l.topics }).args).filter((x) => x.to.toLowerCase() === PAYTO);
      must(rc.status === 'success' && t.length === 1 && t[0].value === oc.paidRaw, `visit ${id}: one token transfer to the agency pay-to = paidRaw`);
      sumRaw += oc.paidRaw;
    }
    if (oc.agencyAck) acked++;
    flowsSigned.add(rec.flowId);
  }
  if (rec) for (const a of rec.attempts || []) if (a.flowId) flowsSigned.add(a.flowId);
}
const want = { ok: [4, 0], 'failed-once': [4, 1], testnet: [4, null], timeout: [0, null], overcharge: [0, null] }[scen];
must(want, 'known scenario');
must(paid === want[0], `${paid} visits Paid on chain (want ${want[0]})`);
if (want[0]) must(acked === paid, `agency acknowledged ${acked}/${paid} on chain by itself`);
if (want[0]) must(watch.filter((x) => x.event === 'ack').length === paid, 'agency-watch.log: one ack line per paid visit');
if (want[1] !== null) must(issues === want[1], `on-chain PaymentIssue count ${issues} (want ${want[1]})`);
if (scen === 'failed-once') {
  const r = Object.values(st.payments).find((x) => (x.attempts || []).length);
  must(r && r.attempts.length === 1 && r.status === 'payment-safe' && r.attempts[0].flowId !== r.flowId, 'one visit failed once, retried automatically with a NEW flow, paid once');
  must(stats && stats.failedFlows === 1 && stats.transfers === 4 && stats.signaturesOk === 5, `mock: 1 failed flow, 5 signatures, 4 transfers (got ${JSON.stringify(stats)})`);
}
if (scen === 'ok') must(stats && stats.signaturesOk === 4 && stats.transfers === 4 && stats.submits === 4, `mock: 4 signatures, 4 submits, 4 transfers (got ${JSON.stringify(stats)})`);
if (scen === 'timeout') {
  const r = st.payments['1'];
  must(r && r.status === 'unsettled' && r.kind === 'Unsettled' && r.retryable === false && r.flowId, 'visit 1: unsettled, not retryable, flow kept');
  must((await visit(ctx, C, 1)).status === 'Confirmed', 'visit 1: Confirmed (unpaid) on chain');
  must((await payment(ctx, C, 1)).issues >= 1, 'visit 1: PaymentIssue on chain');
  must(stats && stats.signaturesOk === stats.orders && stats.submits === stats.orders && stats.transfers === 0, `mock: every flow signed and submitted once, no transfer (got ${JSON.stringify(stats)})`);
  // later: other visits' payments go on (one new flow each); no visit ever gets a second flow, no flow is signed twice
  const later = has('mock-stats-later.json') ? J('mock-stats-later.json') : null, st2 = has('state-later.json') ? J('state-later.json') : null;
  must(later && later.signaturesOk === later.orders && later.submits === later.orders && later.transfers === 0 && later.queries > stats.queries, `after the resume period: the same flows queried again, none signed twice (got ${JSON.stringify(later)})`);
  must(st2 && Object.values(st2.payments).every((x) => !(x.attempts || []).length) && st2.payments['1'].flowId === r.flowId, 'after the resume period: one flow per visit, visit 1 kept its flow');
  must(st2 && later.orders <= Object.keys(st2.payments).length, 'orders <= visits with a payment record');
}
if (scen === 'overcharge') {
  const r = st.payments['1'];
  must(r && r.status === 'failed' && r.kind === 'RefusedBySigningFirewall' && r.retryable === true && !r.submitted, 'visit 1: refused by the signing firewall, nothing submitted');
  must((await payment(ctx, C, 1)).issues >= 1 && (await visit(ctx, C, 1)).status === 'Confirmed', 'visit 1: Confirmed + PaymentIssue on chain');
  must(stats && stats.signaturesOk === 0 && stats.submits === 0 && stats.transfers === 0, `mock: nothing signed or submitted (got ${JSON.stringify(stats)})`);
}
console.log(JSON.stringify({ scenario: scen, checks, failed: fails.length, paid, acked, issues, sumRaw: String(sumRaw), fails }));
if (checks < 8) { console.error('GATE FAIL: too few checks'); process.exit(1); }
process.exit(fails.length ? 1 : 0);
