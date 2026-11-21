// CareMandate demo server: Mum's page, Mina's page, and the family agent behind them.
// The family agent relays Mum's signed answer to the contract (it pays the gas), then, only for a visit the contract marks Confirmed,
// pays that one visit through HSP and records the HSP reference on chain. Env: CM_NET, CM_CONTRACT, CM_MANDATE, FAMILY_AGENT_PK,
// FAMILY_PK (Mina's own key, used only for her "approve an extra visit" button), AGENCY_PAYTO, HSP_MODE (mock|qa), HSP_PAYER_PK, PORT.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { keccak256, toBytes } from 'viem';
import { connect, send, visit, mandate, ABI } from './lib/chain.mjs';
import { payVisit } from './lib/hsp.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const ctx = connect();
const C = process.env.CM_CONTRACT, M = Number(process.env.CM_MANDATE || 1);
const agent = ctx.wallet(process.env.FAMILY_AGENT_PK);
const family = process.env.FAMILY_PK ? ctx.wallet(process.env.FAMILY_PK) : null;
// HSP pays on its own testnet (Base Sepolia USDC in QA): the family agent's HSP payer key, separate from its HSK Chain key.
const hspPayer = process.env.HSP_PAYER_PK ? ctx.wallet(process.env.HSP_PAYER_PK) : agent;
const STATE = process.env.CM_STATE || path.join(ROOT, 'state.json');
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { messages: [], receipts: {}, payments: {} }; } };
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));
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
  const st = load();
  await send(ctx, agent, C, 'confirmBySig', [BigInt(visitId), !!happened, Number(v), r, sig]);
  const vi = await visit(ctx, C, visitId), when = day(vi.visitTime);
  if (vi.status === 'Rejected') { say(st, `${when}'s visit: Mum says it did not happen. Nothing paid.`, 'warn'); save(st); return vi; }
  if (vi.status === 'Held') { say(st, `${when}'s visit is the 4th this week. It waits for you: approve it on your page if you want it paid.`, 'warn'); save(st); return vi; }
  if (vi.status === 'Confirmed') return pay(vi, st, when, 'confirmed by Mum');
  throw new Error('unexpected status ' + vi.status);
}

async function pay(vi, st, when, why) {
  if (ctx.net === 'mainnet' && (process.env.HSP_MODE || 'mock') !== 'qa') throw new Error('mainnet records only real HSP payments: set HSP_MODE=qa');
  if (st.payments[vi.id]) throw new Error('already paid: ' + st.payments[vi.id].flowId);   // never pay twice, even if the chain write failed after HSP paid
  const m = await mandate(ctx, C, vi.mandateId);
  const p = await payVisit({ visitId: vi.id, amountUsd: process.env.HSP_AMOUNT_USD || '0.01', payTo: process.env.AGENCY_PAYTO || m.agency,
    payer: hspPayer.account.address, signTypedData: (td) => hspPayer.account.signTypedData(td) });
  st.payments[vi.id] = p; save(st);
  const ref = keccak256(toBytes(p.flowId));
  const w = await send(ctx, agent, C, 'markPaid', [BigInt(vi.id), ref]);
  st.payments[vi.id].markPaidTx = w.hash;
  say(st, `${when}'s visit: ${why}, paid (${won(vi.amount)} won visit)${p.mode === 'mock' ? ' [HSP MOCK, test run]' : ` via HSP, test payment $${process.env.HSP_AMOUNT_USD || '0.01'}`}.`, 'ok');
  save(st); return await visit(ctx, C, vi.id);
}

async function approve({ visitId }) {
  if (!family) throw new Error('no family key on this server');
  const st = load();
  await send(ctx, family, C, 'approveExtra', [BigInt(visitId)]);
  const vi = await visit(ctx, C, visitId);
  return pay(vi, st, day(vi.visitTime), 'approved by you');
}

const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o, (k, v) => typeof v === 'bigint' ? v.toString() : v)); };
const STATIC = { '/mum': 'web/mum.html', '/mina': 'web/mina.html', '/web/eip712.js': 'web/eip712.js', '/web/style.css': 'web/style.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
function vendor(p) {   // the two audited noble libraries, served from node_modules (no CDN)
  if (p === '/vendor/secp256k1.js') return path.join(ROOT, 'node_modules/@noble/secp256k1/index.js');
  const m = p.match(/^\/vendor\/hashes\/([a-z0-9_]+\.js)$/); return m ? path.join(ROOT, 'node_modules/@noble/hashes/esm', m[1]) : null;
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/api/config') {
      const m = await mandate(ctx, C, M);
      return json(res, 200, { chainId: ctx.cfg.id, network: ctx.cfg.name, contract: C, mandateId: M, confirmer: m.confirmer, perVisitCap: String(m.perVisitCap), weeklyMax: m.weeklyMax, explorer: ctx.cfg.explorer, hspMode: process.env.HSP_MODE || 'mock' });
    }
    if (req.method === 'GET' && u.pathname === '/api/visits') return json(res, 200, await allVisits());
    if (req.method === 'GET' && u.pathname === '/api/messages') return json(res, 200, load().messages);
    if (req.method === 'POST' && (u.pathname === '/api/confirm' || u.pathname === '/api/approve')) {
      let body = ''; for await (const c of req) { body += c; if (body.length > 4096) throw new Error('body too large'); }
      const b = JSON.parse(body || '{}');
      if (!Number.isInteger(b.visitId) || b.visitId < 1) return json(res, 400, { error: 'visitId' });
      return json(res, 200, u.pathname === '/api/confirm' ? await confirm(b) : await approve(b));
    }
    const f = STATIC[u.pathname] ? path.join(ROOT, STATIC[u.pathname]) : vendor(u.pathname);
    if (req.method === 'GET' && f && fs.existsSync(f)) { res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'text/plain' }); return res.end(fs.readFileSync(f)); }
    if (u.pathname === '/') { res.writeHead(302, { location: '/mina' }); return res.end(); }
    res.writeHead(404); res.end('not found');
  } catch (e) { json(res, 500, { error: String(e.shortMessage || e.message || e).slice(0, 300) }); }
}).listen(Number(process.env.PORT || 8790), () => console.log('caremandate on :' + (process.env.PORT || 8790), ctx.net, C));
