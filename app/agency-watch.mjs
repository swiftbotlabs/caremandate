// The care agency's agent, reacting on its own to payments (no call from Mina's server, no shared state file).
// Every AGENCY_WATCH_MS it reads CareMandate's PaymentSettled and PaymentIssue events for its mandate on HSK Chain. For each new
// PaymentSettled it checks the money itself on HSP's settlement network: the settlement tx succeeded and holds exactly one Transfer of
// the expected token to the agency's HSP pay-to address for exactly the recorded paidRaw. Only then it calls ackPaid(visitId) on chain
// (AgencyAck event: Mina's page shows "agency confirmed receipt"). A mismatch is logged and never acknowledged. PaymentIssue events
// are logged as seen (the visit stays Confirmed and unpaid; the agency waits). One JSON line per check; exits 1 after
// AGENCY_MAX_FAILS consecutive failed checks (a watchdog: run it under Restart=on-failure).
// Env: CM_NET, CM_CONTRACT, CM_MANDATE, AGENCY_PK, AGENCY_PAYTO, SETTLE_RPC, SETTLE_TOKEN, [SETTLE_CHAIN_ID], [AGENCY_FROM_BLOCK],
//      [AGENCY_WATCH_MS=5000], [AGENCY_MAX_FAILS=5], [AGENCY_EXIT_AFTER_ACKS=n: exit 0 after n acks, for tests]
import { createPublicClient, http, parseAbiItem, decodeEventLog } from 'viem';
import { connect, send, visit, payment, ABI } from './lib/chain.mjs';

const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), agent: 'agency', ...o }));
const ADDR = /^0x[0-9a-fA-F]{40}$/, HEX32 = /^0x[0-9a-fA-F]{64}$/;
const need = (k, re) => { const v = process.env[k] || ''; if (!re.test(v)) { log({ event: 'refuse_start', error: `${k} missing or malformed` }); process.exit(2); } return v; };
const C = need('CM_CONTRACT', ADDR), PAYTO = need('AGENCY_PAYTO', ADDR), TOKEN = need('SETTLE_TOKEN', ADDR), SRPC = need('SETTLE_RPC', /^https?:\/\/[^\s]{3,200}$/);
const M = BigInt(process.env.CM_MANDATE || 1), EVERY = Number(process.env.AGENCY_WATCH_MS || 5000), MAX_FAILS = Number(process.env.AGENCY_MAX_FAILS || 5);
const EXIT_AFTER = Number(process.env.AGENCY_EXIT_AFTER_ACKS || 0);
const ctx = connect(), me = ctx.wallet(need('AGENCY_PK', /^0x[0-9a-fA-F]{64}$/));
const settle = createPublicClient({ transport: http(SRPC, { timeout: 30_000, retryCount: 3, retryDelay: 1_000 }) });
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

let from = process.env.AGENCY_FROM_BLOCK ? BigInt(process.env.AGENCY_FROM_BLOCK) : null;
const seenIssue = new Set(), refused = new Set(), pending = new Map();   // visitId -> {paidRaw, settlementTx}
let fails = 0, acks = 0;

/** Independent check of one settlement on HSP's network. Returns null when it matches, else the reason. */
async function verify(paidRaw, stx) {
  if (!HEX32.test(stx) || /^0x0{64}$/.test(stx)) return 'no settlement tx (mock run?)';
  if (process.env.SETTLE_CHAIN_ID) { const id = await settle.getChainId(); if (id !== Number(process.env.SETTLE_CHAIN_ID)) return `settlement RPC is chain ${id}`; }
  const rc = await settle.getTransactionReceipt({ hash: stx });
  if (rc.status !== 'success') return 'settlement tx reverted';
  const t = rc.logs.filter((l) => same(l.address, TOKEN) && l.topics[0] === T0).map((l) => decodeEventLog({ abi: [TRANSFER], data: l.data, topics: l.topics }).args);
  const toUs = t.filter((x) => same(x.to, PAYTO));
  if (toUs.length !== 1) return `${toUs.length} token transfers to our pay-to in the tx`;
  if (toUs[0].value !== BigInt(paidRaw)) return `transfer ${toUs[0].value} != recorded ${paidRaw}`;
  return null;
}

async function check() {
  const head = await ctx.pub.getBlockNumber();
  if (from === null) from = head > 5000n ? head - 5000n : 0n;
  let settled = [], issues = [];
  for (let a = from; a <= head; a += 5000n) {   // RPC log ranges are capped: walk in 5,000-block chunks
    const b = a + 4999n < head ? a + 4999n : head;
    settled.push(...await ctx.pub.getContractEvents({ address: C, abi: ABI, eventName: 'PaymentSettled', fromBlock: a, toBlock: b }));
    issues.push(...await ctx.pub.getContractEvents({ address: C, abi: ABI, eventName: 'PaymentIssue', fromBlock: a, toBlock: b }));
  }
  for (const e of settled) { const id = Number(e.args.visitId); if (!refused.has(id)) pending.set(id, { paidRaw: e.args.paidRaw, settlementTx: e.args.settlementTx, tx: e.transactionHash }); }
  from = head + 1n;   // only after the settled events are queued: a failed check re-reads the same range
  for (const e of issues) {
    const id = Number(e.args.visitId), k = `${id}:${e.args.count}`; if (seenIssue.has(k)) continue; seenIssue.add(k);
    const v = await visit(ctx, C, id); if (BigInt(v.mandateId) !== M) continue;
    log({ event: 'issue_seen', visitId: id, issue: Number(e.args.issue), count: Number(e.args.count), tx: e.transactionHash, note: 'visit confirmed, not paid yet: waiting' });
  }
  for (const [id, p] of [...pending]) {
    const v = await visit(ctx, C, id); if (BigInt(v.mandateId) !== M) { pending.delete(id); continue; }
    const oc = await payment(ctx, C, id);
    if (oc.agencyAck) { pending.delete(id); continue; }
    const why = await verify(p.paidRaw, p.settlementTx);
    if (why) { refused.add(id); pending.delete(id); log({ event: 'ack_refused', visitId: id, reason: why, settlementTx: p.settlementTx }); continue; }
    const w = await send(ctx, me, C, 'ackPaid', [BigInt(id)]);
    acks++; pending.delete(id);
    log({ event: 'ack', visitId: id, paidRaw: String(p.paidRaw), settlementTx: p.settlementTx, markPaidTx: p.tx, ackTx: w.hash });
  }
  return { head: Number(head), settledEvents: settled.length, issueEvents: issues.length, pending: pending.size, acks };
}

log({ event: 'start', net: ctx.net, contract: C, mandate: Number(M), payTo: PAYTO, token: TOKEN, settleRpc: SRPC.replace(/\/\/([^/]+).*/, '//$1'), every: EVERY });
for (;;) {
  try { const r = await check(); fails = 0; log({ event: 'check', rc: 0, ...r }); }
  catch (e) { fails++; log({ event: 'check', rc: 1, fails, error: String(e.shortMessage || e.message).slice(0, 200) }); if (fails >= MAX_FAILS) { log({ event: 'watchdog_exit', fails }); process.exit(1); } }
  if (EXIT_AFTER && acks >= EXIT_AFTER) { log({ event: 'done', acks }); process.exit(0); }
  await new Promise((r) => setTimeout(r, EVERY));
}
