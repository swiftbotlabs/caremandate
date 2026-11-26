// CareMandate demo server: Mum's page, Mina's page, and the family agent behind them.
// The family agent relays Mum's signed answer to the contract (it pays the gas), then, only for a visit the contract marks Confirmed,
// pays that one visit through HSP and records the HSP reference on chain. Env: CM_NET, CM_CONTRACT, CM_MANDATE, FAMILY_AGENT_PK,
// FAMILY_PK (Mina's own key, used only for her "approve an extra visit" button), AGENCY_PAYTO, HSP_MODE (mock|qa), HSP_PAYER_PK, PORT.
// HSP_MODE=qa needs HSP_PAYER_PK and AGENCY_PAYTO (the agency's HSP merchant pay-to address): the server refuses to start without them.
// A real HSP payment takes ~3 min to reach payment-safe, so /api/confirm answers as soon as Mum's answer is on chain and the payment
// runs in a serial background queue; its state (paying -> paid | failed | unsettled, with the HSP flow id) is in state.json, on both
// pages and in server.log (one JSON line per request and per payment step; keys are never logged).
// v2 (2026-11-25): the amount asked of HSP is the visit's won price converted at the mandate's ON-CHAIN rate (lib/fx.mjs, rounded down
// to the cent) and the signing firewall refuses any quote over that price + 5%; markPaid records the signed raw amount and the
// settlement tx (the contract refuses more than the mandate allows). Failure policy, never paying twice:
//   refused by the firewall      -> nothing signed; on chain PaymentIssue(RefusedBySigningFirewall); Mina may retry by hand
//   failed before submit         -> nothing broadcast; PaymentIssue(FailedBeforeSubmit); automatic retry (HSP_AUTO_RETRIES, delays)
//   HSP payment-failed, no tx    -> HSP's terminal state, no money moved; PaymentIssue(HspPaymentFailed); automatic retry
//   not settled in time          -> PaymentIssue(Unsettled); the SAME flow is queried again every minute; never re-signed
// A retry of a submitted flow first re-queries it: payment-safe -> recorded as paid (no new payment); anything but payment-failed -> no retry.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { keccak256, toBytes } from 'viem';
import { connect, send, visit, mandate, payment, ABI, ISSUE } from './lib/chain.mjs';
import { payVisit, waitSettled, Refused } from './lib/hsp.mjs';
import { usdFor, maxPayRaw, recordLimitRaw } from './lib/fx.mjs';
import { reviewVisit, DEFAULT_PLAN } from './lib/review.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const HSP_MODE = process.env.HSP_MODE || 'mock';
const AMOUNT_USD_OVERRIDE = process.env.HSP_AMOUNT_USD || '';   // test hook only: normally the amount comes from the mandate rate
const HSP_NETWORK = process.env.HSP_NETWORK || 'sepolia';
const AUTO_RETRY_DELAYS = String(process.env.HSP_RETRY_DELAYS_MS || '60000,300000').split(',').map(Number).filter((n) => n >= 0);
let FX = null; try { FX = process.env.CM_FX_JSON ? JSON.parse(process.env.CM_FX_JSON) : null; } catch { FX = null; }   // display only: the rate on chain rules
const ADDR = /^0x[0-9a-fA-F]{40}$/;
function refuseStart(why) { log({ event: 'refuse_start', error: why }); console.error('caremandate: ' + why); process.exit(2); }
if (!['qa', 'mock'].includes(HSP_MODE)) refuseStart('HSP_MODE must be qa or mock');
if (!ADDR.test(process.env.CM_CONTRACT || '')) refuseStart('CM_CONTRACT is not an address');
if (HSP_MODE === 'qa') {   // fail closed: a missing pay-to or payer key must stop the server, not surface 3 minutes into Mum's first payment
  if (!ADDR.test(process.env.AGENCY_PAYTO || '')) refuseStart('HSP_MODE=qa needs AGENCY_PAYTO (the HSP merchant pay-to address, e.g. HSP_QA_ADDRESS from the merchant env)');
  if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.HSP_PAYER_PK || '')) refuseStart('HSP_MODE=qa needs HSP_PAYER_PK (0x + 64 hex)');
}
// Mina's care plan: what every visit should include. Her agent reads each visit note against it before paying (lib/review.mjs).
let PLAN = DEFAULT_PLAN;
try { if (process.env.CM_CARE_PLAN) { const p = JSON.parse(process.env.CM_CARE_PLAN);
  if (!Array.isArray(p.tasks) || !p.tasks.length || p.tasks.length > 10 || !p.tasks.every((t) => typeof t === 'string' && t.length <= 30)) throw new Error('tasks');
  PLAN = { ...DEFAULT_PLAN, ...p, minMinutes: Number(p.minMinutes ?? DEFAULT_PLAN.minMinutes), startToleranceMin: Number(p.startToleranceMin ?? DEFAULT_PLAN.startToleranceMin) }; } }
catch (e) { refuseStart('CM_CARE_PLAN is not a valid plan: ' + e.message); }
if (process.env.REVIEW_OFF === '1' && (process.env.CM_NET || 'local') !== 'local') refuseStart('REVIEW_OFF is a local test switch only');
const ctx = connect();
const C = process.env.CM_CONTRACT, M = Number(process.env.CM_MANDATE || 1);
const agent = ctx.wallet(process.env.FAMILY_AGENT_PK);
const family = process.env.FAMILY_PK ? ctx.wallet(process.env.FAMILY_PK) : null;
// HSP pays on its own testnet (Circle USDC on Ethereum Sepolia for this event): the family agent's HSP payer key, separate from its HSK Chain key.
const hspPayer = process.env.HSP_PAYER_PK ? ctx.wallet(process.env.HSP_PAYER_PK) : agent;
const STATE = process.env.CM_STATE || path.join(ROOT, 'state.json');
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { messages: [], receipts: {}, payments: {} }; } };
const save = (s) => { fs.writeFileSync(STATE + '.tmp', JSON.stringify(s, null, 1)); fs.renameSync(STATE + '.tmp', STATE); };
// one chain writer at a time: confirmations and markPaid share the family agent's nonce
let chainLock = Promise.resolve();
const sendLocked = (...a) => { const r = chainLock.then(() => send(ctx, ...a)); chainLock = r.catch(() => {}); return r; };
const say = (s, text, kind = 'info') => { s.messages.unshift({ at: new Date().toISOString(), text, kind }); s.messages = s.messages.slice(0, 50); };
const day = (t) => new Date(t * 1000).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Asia/Seoul' });
const won = (a) => Number(a).toLocaleString('en-US');

async function allVisits() {
  const n = Number(await ctx.pub.readContract({ address: C, abi: ABI, functionName: 'visitCount' }));
  const out = []; const s = load();
  const m = await mandate(ctx, C, M);
  for (let i = 1; i <= n; i++) {
    const v = await visit(ctx, C, i); if (v.mandateId !== M) continue;
    const oc = await payment(ctx, C, i);
    let usd = null; try { usd = usdFor(v.amount, m.rawPerMillionWon); } catch { usd = null; }
    out.push({ ...v, amount: String(v.amount), receipt: s.receipts[v.receiptHash] || null, payment: s.payments[i] || null, review: (s.reviews || {})[i] || null,
      price: { usd, maxRaw: String(maxPayRaw(v.amount, m.rawPerMillionWon)), limitRaw: String(recordLimitRaw(v.amount, m.rawPerMillionWon)) },
      onchain: { paidRaw: String(oc.paidRaw), settlementTx: oc.settlementTx, issues: oc.issues, agencyAck: oc.agencyAck } });
  }
  return out;
}

async function confirm({ visitId, happened, v, r, s: sig }) {
  const w = await sendLocked(agent, C, 'confirmBySig', [BigInt(visitId), !!happened, Number(v), r, sig]);
  const vi = await visit(ctx, C, visitId), when = day(vi.visitTime);
  log({ event: 'confirmed', visitId, happened: !!happened, status: vi.status, tx: w.hash });
  const st = load();
  if (vi.status === 'Rejected') { say(st, `${when}'s visit: Mum says it did not happen. Nothing paid.`, 'warn'); save(st); return vi; }
  if (vi.status === 'Held') { say(st, `${when}'s visit is the 4th this week. It waits for you: approve it on your page if you want it paid.`, 'warn'); save(st); return vi; }
  if (vi.status === 'Confirmed') return reviewThenPay(vi, when, 'confirmed by Mum');
  throw new Error('unexpected status ' + vi.status);
}

// Mina's agent reads the carer's note before paying a confirmed visit. "pay" -> HSP payment; "hold" -> nothing is ordered or signed
// until Mina presses "Pay anyway" (/api/release). The decision, its source (model+rules or rules) and the reasons go to state.json
// (reviews) and server.log (event "review"), and both pages show them. A visit is reviewed once; a hold is never lifted by the agent.
async function reviewThenPay(vi, when, why) {
  let st = load(); st.reviews = st.reviews || {};
  const prev = st.reviews[vi.id];
  if (prev?.decision === 'hold' && !prev.released) return { ...vi, reviewHeld: true, review: prev };
  if (!prev) {
    let r;
    try { r = await reviewVisit({ receipt: st.receipts[vi.receiptHash] || null, onchainHash: vi.receiptHash, visitTime: vi.visitTime, plan: PLAN }); }
    catch (e) { r = { at: new Date().toISOString(), decision: 'hold', source: 'error', reasons: ['The note check failed, so the payment waits for you.'], rules: ['review_error'], model: { error: String(e.message).slice(0, 120) } }; }
    st = load(); st.reviews = st.reviews || {}; st.reviews[vi.id] = r; save(st);
    log({ event: 'review', visitId: vi.id, decision: r.decision, source: r.source, rules: r.rules, model: r.model?.name || null, modelDecision: r.model?.decision || null, modelError: r.model?.error || null, modelMs: r.model?.ms || null, reasons: r.reasons });
    if (r.decision === 'hold') {
      say(st, `${when}'s visit: Mum said it happened, but I am holding the payment until you look: ${r.reasons.slice(0, 3).join(' ')} Nothing has been paid. "Pay anyway" on your page pays it.`, 'warn'); save(st);
      return { ...vi, reviewHeld: true, review: r };
    }
  }
  return startPay(vi, when, why);
}

async function release({ visitId }) {
  const st = load(); const r = (st.reviews || {})[visitId];
  if (!r || r.decision !== 'hold' || r.released) throw new Error(`visit ${visitId}: no payment held by the note check`);
  const vi = await visit(ctx, C, visitId);
  if (vi.status !== 'Confirmed') throw new Error(`visit ${visitId} is ${vi.status} on chain, not Confirmed`);
  r.released = { by: 'mina', at: new Date().toISOString() }; save(st);
  log({ event: 'review_released', visitId, by: 'mina' });
  return startPay(vi, day(vi.visitTime), 'confirmed by Mum; you checked the note');
}

// Payments: one at a time, in the background. The record is written BEFORE any HSP call and updated at each step, so a crash or a
// slow HSP never loses the flow id, and a visit that has any record (except a failure before submit) is never paid again.
let payQueue = Promise.resolve();
function startPay(vi, when, why, { retry = false } = {}) {
  const st = load();
  const prev = st.payments[vi.id];
  if (prev && !(retry && prev.retryable && ['failed', 'retrying'].includes(prev.status))) throw new Error(`visit ${vi.id} already has a payment (${prev.status}${prev.flowId ? ' ' + prev.flowId : ''}); never pay twice`);
  const attempts = prev ? [...(prev.attempts || []), { flowId: prev.flowId || null, status: prev.status, hspStatus: prev.hspStatus || null, submitted: !!prev.submitted, error: prev.error || null, at: prev.failedAt || null }] : [];
  st.payments[vi.id] = { mode: HSP_MODE, status: 'paying', startedAt: new Date().toISOString(), attempts, autoRetries: prev?.autoRetries || 0 }; save(st);
  log({ event: 'pay_queued', visitId: vi.id, mode: HSP_MODE, attempt: attempts.length + 1 });
  payQueue = payQueue.then(() => pay(vi, when, why)).catch(() => {});
  return { ...vi, paying: true };
}

// A retry (automatic or Mina's button). If the earlier flow reached HSP, ask HSP about THAT flow first: settled -> record it, no new
// payment; anything but HSP's terminal payment-failed -> no new payment.
async function retryPay(id, who) {
  const rec = load().payments[id];
  if (!rec || !rec.retryable || !['failed', 'retrying'].includes(rec.status)) throw new Error(`visit ${id}: nothing to retry (${rec ? rec.status : 'no payment'})`);
  const vi = await visit(ctx, C, id), when = day(vi.visitTime);
  if (vi.status !== 'Confirmed') throw new Error(`visit ${id} is ${vi.status} on chain, not Confirmed`);
  if (HSP_MODE === 'qa' && rec.submitted && rec.flowId && rec.paymentRequestId) {
    try {
      const p = await waitSettled({ flowId: rec.flowId, prId: rec.paymentRequestId, settleMs: 0, network: HSP_NETWORK, log: (o) => log({ event: 'hsp', visitId: id, recheck: true, ...o }) });
      log({ event: 'retry_found_settled', visitId: id, flowId: rec.flowId });
      upd(id, { status: 'paying' });
      payQueue = payQueue.then(() => settled(vi, when, 'confirmed', { ...p, paidRaw: rec.paidRaw }, Date.now()).catch((e) => failed(vi, when, e, Date.now()))).catch(() => {});
      return { ...vi, paying: true };
    } catch (e) {
      if (e.code !== 'FAILED') { upd(id, { status: 'unsettled', retryable: false }); log({ event: 'retry_blocked', visitId: id, flowId: rec.flowId, error: String(e.message).slice(0, 200) }); throw new Error(`visit ${id}: HSP has not confirmed flow ${rec.flowId} failed; it is queried again, never paid twice`); }
    }
  }
  log({ event: 'pay_retry', visitId: id, by: who, previousFlow: rec.flowId || null });
  return startPay(vi, when, who === 'mina' ? 'confirmed by Mum, retried by you' : 'confirmed by Mum', { retry: true });
}

const upd = (id, patch) => { const st = load(); st.payments[id] = { ...(st.payments[id] || {}), ...patch }; save(st); return st; };

async function pay(vi, when, why) {
  const t0 = Date.now();
  try {
    if (ctx.net === 'mainnet' && HSP_MODE !== 'qa') throw new Error('mainnet records only real HSP payments: set HSP_MODE=qa');
    const m = await mandate(ctx, C, vi.mandateId);
    const payTo = process.env.AGENCY_PAYTO || m.agency;
    const amountUsd = AMOUNT_USD_OVERRIDE || usdFor(vi.amount, m.rawPerMillionWon);
    const maxRaw = recordLimitRaw(vi.amount, m.rawPerMillionWon);
    upd(vi.id, { usd: amountUsd, maxRaw: String(maxRaw) });
    log({ event: 'pay_start', visitId: vi.id, mode: HSP_MODE, network: HSP_NETWORK, payTo, payer: hspPayer.account.address, usd: amountUsd, won: String(vi.amount), rate: String(m.rawPerMillionWon), maxRaw: String(maxRaw) });
    const p = await payVisit({ visitId: vi.id, amountUsd, maxRaw, payTo, payer: hspPayer.account.address,
      signTypedData: (td) => hspPayer.account.signTypedData(td),
      log: (o) => {
        log({ event: 'hsp', visitId: vi.id, ...o });
        if (o.step === 'create_order') upd(vi.id, { flowId: o.flowId, paymentRequestId: o.prId });
        if (o.step === 'firewall_ok') upd(vi.id, { paidRaw: o.raw });
        if (o.step === 'submitted') upd(vi.id, { submitted: true });
        if (o.step === 'status') upd(vi.id, { hspStatus: o.status, txHash: o.tx || undefined });
      } });
    return await settled(vi, when, why, p, t0);
  } catch (e) { return failed(vi, when, e, t0); }
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
async function settled(vi, when, why, p, t0) {
  upd(vi.id, { ...p, status: p.status, submitted: true, retryable: false, settledAt: new Date().toISOString() });
  const paidRaw = BigInt(p.paidRaw || 0);
  const stx = HEX32.test(p.txHash || '') ? p.txHash : '0x' + '0'.repeat(64);
  const w = await sendLocked(agent, C, 'markPaid', [BigInt(vi.id), keccak256(toBytes(p.flowId)), paidRaw, stx]);
  const usd = (Number(paidRaw) / 1e6).toFixed(2);
  const st = upd(vi.id, { markPaidTx: w.hash });
  say(st, `${when}'s visit: ${why}, paid (${won(vi.amount)} won visit)${p.mode === 'mock' ? ' [HSP MOCK, test run]' : ` via HSP: $${usd} test USDC on ${p.network || HSP_NETWORK}`}.`, 'ok'); save(st);
  log({ event: 'paid', visitId: vi.id, flowId: p.flowId, status: p.status, network: p.network || HSP_NETWORK, txHash: p.txHash, paidRaw: String(paidRaw), markPaidTx: w.hash, s: Math.round((Date.now() - t0) / 1000) });
}

async function noteIssue(id, flowId, kind) {
  try { const w = await sendLocked(agent, C, 'notePaymentIssue', [BigInt(id), flowId ? keccak256(toBytes(String(flowId))) : '0x' + '0'.repeat(64), ISSUE[kind]]);
        upd(id, { issueTx: w.hash }); log({ event: 'issue_on_chain', visitId: id, kind, tx: w.hash }); }
  catch (e) { log({ event: 'issue_on_chain_error', visitId: id, kind, error: String(e.shortMessage || e.message).slice(0, 200) }); }
}

function failed(vi, when, e, t0) {
  const msg = String(e.shortMessage || e.message || e).slice(0, 300);
  const rec = load().payments[vi.id] || {};
  const fid = rec.flowId || e.flowId, txh = rec.txHash || e.txHash;
  const kind = e instanceof Refused ? 'RefusedBySigningFirewall' : e.code === 'UNSETTLED' ? 'Unsettled' : e.code === 'FAILED' ? 'HspPaymentFailed' : rec.submitted ? 'Unsettled' : 'FailedBeforeSubmit';
  // money may have moved only if HSP had the signed payment and did not call it failed: then never sign again, only query
  const retryable = kind === 'RefusedBySigningFirewall' || kind === 'FailedBeforeSubmit' || (kind === 'HspPaymentFailed' && !txh);
  const auto = retryable && kind !== 'RefusedBySigningFirewall' && (rec.autoRetries || 0) < AUTO_RETRY_DELAYS.length;
  const status = kind === 'Unsettled' ? 'unsettled' : auto ? 'retrying' : 'failed';
  const delay = auto ? AUTO_RETRY_DELAYS[rec.autoRetries || 0] : null;
  const st = upd(vi.id, { status, kind, retryable, error: msg, flowId: fid, txHash: txh, failedAt: new Date().toISOString(),
    ...(auto ? { autoRetries: (rec.autoRetries || 0) + 1, nextTryAt: new Date(Date.now() + delay).toISOString() } : { nextTryAt: null }) });
  const ref = fid ? ` HSP flow ${String(fid).slice(-12)}.` : '';
  const why = kind === 'HspPaymentFailed' ? 'HSP reports the payment failed; no money moved' : kind === 'Unsettled' ? 'HSP has not confirmed it yet; it is checked again and never paid twice'
    : kind === 'RefusedBySigningFirewall' ? 'your agent refused to sign: HSP asked for more than the mandate allows' : msg.replace(/ for flow \S+/, '').slice(0, 120);
  const next = auto ? ` Trying again in ${Math.round(delay / 60e3) || '<1'} min.` : status === 'failed' ? ' Nothing was paid; you can try again on your page.' : '';
  say(st, `${when}'s visit: confirmed, not paid yet (${why}).${ref}${next}`, 'warn'); save(st);
  log({ event: 'pay_error', visitId: vi.id, status, kind, retryable, flowId: fid || null, submitted: !!rec.submitted, error: msg, nextTryInMs: delay, s: Math.round((Date.now() - t0) / 1000) });
  // one on-chain record per flow and kind: re-queries of the same unsettled flow do not add records
  const key = `${fid || 'none'}:${kind}`;
  if (rec.issueNoted !== key) { upd(vi.id, { issueNoted: key }); noteIssue(vi.id, fid, kind); }
  if (status === 'unsettled' && fid && rec.paymentRequestId) setTimeout(() => resume(vi.id), Number(process.env.HSP_RESUME_MS || 60e3)).unref();
  if (auto) setTimeout(() => retryPay(vi.id, 'auto').catch((x) => log({ event: 'retry_error', visitId: vi.id, error: String(x.message).slice(0, 200) })), delay).unref();
}

// A flow that HSP accepted but had not settled (server restart, or HSP slower than HSP_SETTLE_MS): query only, never sign again.
async function resume(id) {
  const rec = load().payments[id];
  if (!rec || HSP_MODE !== 'qa' || !rec.submitted || !rec.flowId || !rec.paymentRequestId || ['payment-safe', 'payment-finalized'].includes(rec.status)) return;
  const vi = await visit(ctx, C, id), when = day(vi.visitTime), t0 = Date.now();
  if (vi.status !== 'Confirmed') return;
  log({ event: 'pay_resume', visitId: id, flowId: rec.flowId });
  upd(id, { status: 'paying' });
  payQueue = payQueue.then(async () => {
    try { const p = await waitSettled({ flowId: rec.flowId, prId: rec.paymentRequestId, network: HSP_NETWORK, log: (o) => log({ event: 'hsp', visitId: id, ...o }) });
      await settled(vi, when, 'confirmed', { ...p, paidRaw: rec.paidRaw }, t0); }
    catch (e) { failed(vi, when, e, t0); }
  }).catch(() => {});
}

async function approve({ visitId }) {
  if (!family) throw new Error('no family key on this server');
  const w = await sendLocked(family, C, 'approveExtra', [BigInt(visitId)]);
  const vi = await visit(ctx, C, visitId);
  log({ event: 'approved', visitId, status: vi.status, tx: w.hash });
  return reviewThenPay(vi, day(vi.visitTime), 'approved by you');
}

const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o, (k, v) => typeof v === 'bigint' ? v.toString() : v)); };
const STATIC = { '/mum': 'web/mum.html', '/mina': 'web/mina.html', '/web/eip712.js': 'web/eip712.js', '/web/style.css': 'web/style.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
function vendor(p) {   // the two audited noble libraries, served from node_modules (no CDN)
  if (p === '/vendor/secp256k1.js') return path.join(ROOT, 'node_modules/@noble/secp256k1/index.js');
  const m = p.match(/^\/vendor\/hashes\/([a-z0-9_]+\.js)$/); return m ? path.join(ROOT, 'node_modules/@noble/hashes/esm', m[1]) : null;
}

http.createServer(async (req, res) => {
  const t0 = Date.now(); let u;
  const api = () => u && u.pathname.startsWith('/api/');
  res.on('finish', () => { if (api() && !(req.method === 'GET' && res.statusCode === 200)) log({ event: 'http', method: req.method, path: u.pathname, code: res.statusCode, ms: Date.now() - t0 }); });
  try {
    u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/api/config') {
      const m = await mandate(ctx, C, M);
      return json(res, 200, { chainId: ctx.cfg.id, network: ctx.cfg.name, contract: C, mandateId: M, confirmer: m.confirmer, perVisitCap: String(m.perVisitCap), weeklyMax: m.weeklyMax, explorer: ctx.cfg.explorer, hspMode: HSP_MODE,
        hspNetwork: HSP_NETWORK, carePlan: PLAN, rawPerMillionWon: String(m.rawPerMillionWon), capUsd: (() => { try { return usdFor(m.perVisitCap, m.rawPerMillionWon); } catch { return null; } })(), fx: FX });
    }
    if (req.method === 'GET' && u.pathname === '/api/visits') return json(res, 200, await allVisits());
    if (req.method === 'GET' && u.pathname === '/api/messages') return json(res, 200, load().messages);
    if (req.method === 'POST' && ['/api/confirm', '/api/approve', '/api/retry', '/api/release'].includes(u.pathname)) {
      let body = ''; for await (const c of req) { body += c; if (body.length > 4096) return json(res, 413, { error: 'body too large' }); }
      let b; try { b = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      if (!b || !Number.isInteger(b.visitId) || b.visitId < 1) return json(res, 400, { error: 'visitId' });
      if (u.pathname === '/api/confirm' && !(Number.isInteger(Number(b.v)) && /^0x[0-9a-fA-F]{64}$/.test(String(b.r)) && /^0x[0-9a-fA-F]{64}$/.test(String(b.s)))) return json(res, 400, { error: 'signature' });
      log({ event: 'request', path: u.pathname, visitId: b.visitId, happened: u.pathname === '/api/confirm' ? !!b.happened : undefined });
      return json(res, 200, u.pathname === '/api/confirm' ? await confirm(b) : u.pathname === '/api/retry' ? await retryPay(b.visitId, 'mina') : u.pathname === '/api/release' ? await release(b) : await approve(b));
    }
    const f = STATIC[u.pathname] ? path.join(ROOT, STATIC[u.pathname]) : vendor(u.pathname);
    if (req.method === 'GET' && f && fs.existsSync(f)) { res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'text/plain' }); return res.end(fs.readFileSync(f)); }
    if (u.pathname === '/') { res.writeHead(302, { location: '/mina' }); return res.end(); }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    const msg = String(e.shortMessage || e.message || e).slice(0, 300);
    log({ event: 'error', path: u?.pathname, error: msg });
    json(res, 500, { error: msg });
  }
}).listen(Number(process.env.PORT || 8790), () => {
  log({ event: 'start', port: Number(process.env.PORT || 8790), net: ctx.net, contract: C, hspMode: HSP_MODE, hspNetwork: HSP_NETWORK, payTo: process.env.AGENCY_PAYTO || '(mandate agency)', payer: hspPayer.account.address, review: process.env.REVIEW_OFF === '1' ? 'OFF (test)' : process.env.REVIEW_LLM_KEY ? 'model+rules ' + (process.env.REVIEW_LLM_MODEL || 'openai/gpt-oss-20b') : 'rules only', plan: PLAN });
  console.log('caremandate on :' + (process.env.PORT || 8790), ctx.net, C);
  // payments left mid-way by an earlier run: resume the submitted ones (query only); flag the rest, never re-sign them
  const st = load(); let n = 0;
  for (const [id, p] of Object.entries(st.payments)) {
    if (p.status === 'retrying') { p.status = 'failed'; log({ event: 'pay_retry_pending', visitId: Number(id) }); continue; }   // Mina retries by hand after a restart
    if (p.status !== 'paying' && p.status !== 'unsettled') continue;
    if (p.submitted && p.flowId) { n++; resume(Number(id)); }
    else if (p.status === 'paying') { p.status = 'failed'; p.error = p.flowId ? 'interrupted before submit (flow ' + p.flowId + '): check HSP before paying again' : 'interrupted before HSP'; if (p.flowId) p.submitted = true; log({ event: 'pay_interrupted', visitId: Number(id), flowId: p.flowId || null }); }
  }
  save(st); if (n) log({ event: 'resuming', count: n });
});
