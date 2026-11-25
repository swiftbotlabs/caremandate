// CareMandate demo server: Mum's page, Mina's page, and the family agent behind them.
// The family agent relays Mum's signed answer to the contract (it pays the gas), then, only for a visit the contract marks Confirmed,
// pays that one visit through HSP and records the HSP reference on chain. Env: CM_NET, CM_CONTRACT, CM_MANDATE, FAMILY_AGENT_PK,
// FAMILY_PK (Mina's own key, used only for her "approve an extra visit" button), AGENCY_PAYTO, HSP_MODE (mock|qa), HSP_PAYER_PK, PORT.
// HSP_MODE=qa needs HSP_PAYER_PK and AGENCY_PAYTO (the agency's HSP merchant pay-to address): the server refuses to start without them.
// A real HSP payment takes ~3 min to reach payment-safe, so /api/confirm answers as soon as Mum's answer is on chain and the payment
// runs in a serial background queue; its state (paying -> paid | failed | unsettled, with the HSP flow id) is in state.json, on both
// pages and in server.log (one JSON line per request and per payment step; keys are never logged).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { keccak256, toBytes } from 'viem';
import { connect, send, visit, mandate, ABI } from './lib/chain.mjs';
import { payVisit, waitSettled } from './lib/hsp.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const HSP_MODE = process.env.HSP_MODE || 'mock';
const AMOUNT_USD = process.env.HSP_AMOUNT_USD || '0.01';
const ADDR = /^0x[0-9a-fA-F]{40}$/;
function refuseStart(why) { log({ event: 'refuse_start', error: why }); console.error('caremandate: ' + why); process.exit(2); }
if (!['qa', 'mock'].includes(HSP_MODE)) refuseStart('HSP_MODE must be qa or mock');
if (!ADDR.test(process.env.CM_CONTRACT || '')) refuseStart('CM_CONTRACT is not an address');
if (HSP_MODE === 'qa') {   // fail closed: a missing pay-to or payer key must stop the server, not surface 3 minutes into Mum's first payment
  if (!ADDR.test(process.env.AGENCY_PAYTO || '')) refuseStart('HSP_MODE=qa needs AGENCY_PAYTO (the HSP merchant pay-to address, e.g. HSP_QA_ADDRESS from the merchant env)');
  if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.HSP_PAYER_PK || '')) refuseStart('HSP_MODE=qa needs HSP_PAYER_PK (0x + 64 hex)');
}
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
  for (let i = 1; i <= n; i++) { const v = await visit(ctx, C, i); if (v.mandateId === M) out.push({ ...v, amount: String(v.amount), receipt: s.receipts[v.receiptHash] || null, payment: s.payments[i] || null }); }
  return out;
}

async function confirm({ visitId, happened, v, r, s: sig }) {
  const w = await sendLocked(agent, C, 'confirmBySig', [BigInt(visitId), !!happened, Number(v), r, sig]);
  const vi = await visit(ctx, C, visitId), when = day(vi.visitTime);
  log({ event: 'confirmed', visitId, happened: !!happened, status: vi.status, tx: w.hash });
  const st = load();
  if (vi.status === 'Rejected') { say(st, `${when}'s visit: Mum says it did not happen. Nothing paid.`, 'warn'); save(st); return vi; }
  if (vi.status === 'Held') { say(st, `${when}'s visit is the 4th this week. It waits for you: approve it on your page if you want it paid.`, 'warn'); save(st); return vi; }
  if (vi.status === 'Confirmed') return startPay(vi, when, 'confirmed by Mum');
  throw new Error('unexpected status ' + vi.status);
}

// Payments: one at a time, in the background. The record is written BEFORE any HSP call and updated at each step, so a crash or a
// slow HSP never loses the flow id, and a visit that has any record (except a failure before submit) is never paid again.
let payQueue = Promise.resolve();
function startPay(vi, when, why) {
  const st = load();
  const prev = st.payments[vi.id];
  if (prev && !(prev.status === 'failed' && !prev.submitted)) throw new Error(`visit ${vi.id} already has a payment (${prev.status}${prev.flowId ? ' ' + prev.flowId : ''}); never pay twice`);
  st.payments[vi.id] = { mode: HSP_MODE, status: 'paying', startedAt: new Date().toISOString() }; save(st);
  log({ event: 'pay_queued', visitId: vi.id, mode: HSP_MODE });
  payQueue = payQueue.then(() => pay(vi, when, why)).catch(() => {});
  return { ...vi, paying: true };
}

const upd = (id, patch) => { const st = load(); st.payments[id] = { ...(st.payments[id] || {}), ...patch }; save(st); return st; };

async function pay(vi, when, why) {
  const t0 = Date.now();
  try {
    if (ctx.net === 'mainnet' && HSP_MODE !== 'qa') throw new Error('mainnet records only real HSP payments: set HSP_MODE=qa');
    const m = await mandate(ctx, C, vi.mandateId);
    const payTo = process.env.AGENCY_PAYTO || m.agency;
    log({ event: 'pay_start', visitId: vi.id, mode: HSP_MODE, payTo, payer: hspPayer.account.address, usd: AMOUNT_USD });
    const p = await payVisit({ visitId: vi.id, amountUsd: AMOUNT_USD, payTo, payer: hspPayer.account.address,
      signTypedData: (td) => hspPayer.account.signTypedData(td),
      log: (o) => {
        log({ event: 'hsp', visitId: vi.id, ...o });
        if (o.step === 'create_order') upd(vi.id, { flowId: o.flowId, paymentRequestId: o.prId });
        if (o.step === 'submitted') upd(vi.id, { submitted: true });
        if (o.step === 'status') upd(vi.id, { hspStatus: o.status, txHash: o.tx || undefined });
      } });
    return await settled(vi, when, why, p, t0);
  } catch (e) { return failed(vi, when, e, t0); }
}

async function settled(vi, when, why, p, t0) {
  upd(vi.id, { ...p, status: p.status, submitted: true, settledAt: new Date().toISOString() });
  const w = await sendLocked(agent, C, 'markPaid', [BigInt(vi.id), keccak256(toBytes(p.flowId))]);
  const st = upd(vi.id, { markPaidTx: w.hash });
  say(st, `${when}'s visit: ${why}, paid (${won(vi.amount)} won visit)${p.mode === 'mock' ? ' [HSP MOCK, test run]' : ` via HSP, test payment $${AMOUNT_USD}`}.`, 'ok'); save(st);
  log({ event: 'paid', visitId: vi.id, flowId: p.flowId, status: p.status, txHash: p.txHash, markPaidTx: w.hash, s: Math.round((Date.now() - t0) / 1000) });
}

function failed(vi, when, e, t0) {
  const msg = String(e.shortMessage || e.message || e).slice(0, 300);
  const rec = load().payments[vi.id] || {};
  const status = e.code === 'UNSETTLED' ? 'unsettled' : 'failed';
  const st = upd(vi.id, { status, error: msg, flowId: rec.flowId || e.flowId, txHash: rec.txHash || e.txHash, failedAt: new Date().toISOString() });
  const fid = rec.flowId || e.flowId, ref = fid ? ` HSP flow ${String(fid).slice(-12)}.` : '';
  const why = e.code === 'FAILED' ? 'HSP reports the payment failed' : status === 'unsettled' ? 'HSP has not confirmed it yet; it is checked again and never paid twice' : msg.replace(/ for flow \S+/, '').slice(0, 120);
  say(st, `${when}'s visit: the payment did not go through yet (${why}).${ref}`, 'warn'); save(st);
  log({ event: 'pay_error', visitId: vi.id, status, flowId: rec.flowId || null, submitted: !!rec.submitted, error: msg, s: Math.round((Date.now() - t0) / 1000) });
  if (status === 'unsettled' && rec.flowId && rec.paymentRequestId) setTimeout(() => resume(vi.id), 60e3).unref();
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
    try { const p = await waitSettled({ flowId: rec.flowId, prId: rec.paymentRequestId, log: (o) => log({ event: 'hsp', visitId: id, ...o }) });
      await settled(vi, when, 'confirmed', p, t0); }
    catch (e) { failed(vi, when, e, t0); }
  }).catch(() => {});
}

async function approve({ visitId }) {
  if (!family) throw new Error('no family key on this server');
  const w = await sendLocked(family, C, 'approveExtra', [BigInt(visitId)]);
  const vi = await visit(ctx, C, visitId);
  log({ event: 'approved', visitId, status: vi.status, tx: w.hash });
  return startPay(vi, day(vi.visitTime), 'approved by you');
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
      return json(res, 200, { chainId: ctx.cfg.id, network: ctx.cfg.name, contract: C, mandateId: M, confirmer: m.confirmer, perVisitCap: String(m.perVisitCap), weeklyMax: m.weeklyMax, explorer: ctx.cfg.explorer, hspMode: HSP_MODE });
    }
    if (req.method === 'GET' && u.pathname === '/api/visits') return json(res, 200, await allVisits());
    if (req.method === 'GET' && u.pathname === '/api/messages') return json(res, 200, load().messages);
    if (req.method === 'POST' && (u.pathname === '/api/confirm' || u.pathname === '/api/approve')) {
      let body = ''; for await (const c of req) { body += c; if (body.length > 4096) return json(res, 413, { error: 'body too large' }); }
      let b; try { b = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      if (!b || !Number.isInteger(b.visitId) || b.visitId < 1) return json(res, 400, { error: 'visitId' });
      if (u.pathname === '/api/confirm' && !(Number.isInteger(Number(b.v)) && /^0x[0-9a-fA-F]{64}$/.test(String(b.r)) && /^0x[0-9a-fA-F]{64}$/.test(String(b.s)))) return json(res, 400, { error: 'signature' });
      log({ event: 'request', path: u.pathname, visitId: b.visitId, happened: u.pathname === '/api/confirm' ? !!b.happened : undefined });
      return json(res, 200, u.pathname === '/api/confirm' ? await confirm(b) : await approve(b));
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
  log({ event: 'start', port: Number(process.env.PORT || 8790), net: ctx.net, contract: C, hspMode: HSP_MODE, payTo: process.env.AGENCY_PAYTO || '(mandate agency)', payer: hspPayer.account.address });
  console.log('caremandate on :' + (process.env.PORT || 8790), ctx.net, C);
  // payments left mid-way by an earlier run: resume the submitted ones (query only); flag the rest, never re-sign them
  const st = load(); let n = 0;
  for (const [id, p] of Object.entries(st.payments)) {
    if (p.status !== 'paying' && p.status !== 'unsettled') continue;
    if (p.submitted && p.flowId) { n++; resume(Number(id)); }
    else if (p.status === 'paying') { p.status = 'failed'; p.error = p.flowId ? 'interrupted before submit (flow ' + p.flowId + '): check HSP before paying again' : 'interrupted before HSP'; if (p.flowId) p.submitted = true; log({ event: 'pay_interrupted', visitId: Number(id), flowId: p.flowId || null }); }
  }
  save(st); if (n) log({ event: 'resuming', count: n });
});
