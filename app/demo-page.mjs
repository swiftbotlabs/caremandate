// Builds the public, read-only record page of one testnet run (demo/index.html + live.js + style.css + shots).
// Every value on the page comes from the run's own files AND is re-checked on chain first (HSK Chain testnet reads,
// receipts on HSP's settlement network: HSK Chain testnet when the run used HSP_NETWORK=hashkey-testnet, else Ethereum Sepolia).
// v2 runs (setup.json has fx) also check: the mandate's on-chain won->USDC rate, payments(id).paidRaw = the settlement transfer
// <= the mandate limit, the agency's own AgencyAck per paid visit (agency-watch.log), the over-cap visit refused (re-simulated
// live against the contract), and list the offline failure-mode gates (DEMO_OFFLINE_GATES=<gate.json,...>). Any mismatch -> exit 1. The page holds no keys and cannot pay: it is static
// HTML; the optional live.js only makes eth_call reads of visits(id).
// Usage: node demo-page.mjs <runDir> <outDir>     (env DEMO_TAMPER=1 flips one flow id: the gate must then fail)
// v3 (2026-11-26): times in UTC with Korea time in brackets; the family agent's note review per visit (state.json reviews, when the
// run has them); DEMO_REVIEW_PROBE=<probe.json> (review-probe.mjs on the live model); DEMO_MAINNET=<evidence/mainnet-* dir> (the
// mainnet deploy, re-read on HSK Chain mainnet) and DEMO_MAINNET_VISIT=<evidence/mainnet-visit-* dir> (a mainnet visit cycle, re-read).
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, http, keccak256, toBytes, toFunctionSelector, parseAbiItem, decodeEventLog } from 'viem';
import { connect, visit, mandate, payment, CHAINS, ABI } from './lib/chain.mjs';
import { maxPayRaw, recordLimitRaw, usdFor } from './lib/fx.mjs';
import { NOTES } from './test/review-fixtures.mjs';
import { domain as a2aDomain, parseProposal, parseDecision, proposalDigest, decisionDigest, proposalSigner, decisionSigner, anchorData, DEFAULT_MAKEUP_RULES } from './lib/a2a.mjs';

const [runDir, outDir] = process.argv.slice(2);
if (!runDir || !outDir) { console.error('usage: node demo-page.mjs <runDir> <outDir>'); process.exit(2); }
const R = (f) => fs.readFileSync(path.join(runDir, f), 'utf8');
const MAX = 2_000_000;
for (const f of ['payments.txt', 'server.log', 'agency.log', 'setup.json', 'state.json']) {
  if (fs.statSync(path.join(runDir, f)).size > MAX) throw new Error(`${f} too large`);
}
for (const f of ['agency-watch.log', 'captrip.json', 'a2a-agency.jsonl', 'agency-makeup.log']) if (fs.existsSync(path.join(runDir, f)) && fs.statSync(path.join(runDir, f)).size > MAX) throw new Error(`${f} too large`);
const HEX32 = /^0x[0-9a-f]{64}$/i, ADDR = /^0x[0-9a-f]{40}$/i;
// real HSP flow ids are UUIDs; the offline stand-in's MOCKHSP-<uuid> is accepted only when building from a local (offline) run
const UUID = process.env.DEMO_NET === 'local' ? /^(MOCKHSP-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const must = (ok, msg) => { if (!ok) { console.error('GATE FAIL: ' + msg); process.exit(1); } };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jl = (txt) => txt.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

// ---- the run's own records
const setup = JSON.parse(R('setup.json'));
const state = JSON.parse(R('state.json'));
const server = jl(R('server.log'));
const agency = jl(R('agency.log'));
const start = server.find((e) => e.event === 'start');
const NET = process.env.DEMO_NET || 'testnet';   // DEMO_NET=local only to test this builder on an offline run
must(start && start.net === NET && start.hspMode === 'qa', `server.log start line: ${NET} + qa`);
const V2 = !!setup.fx;
const HSPNET = start.hspNetwork || 'sepolia';
const SETTLE = {
  sepolia: { label: 'Ethereum Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', token: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', ex: 'https://sepolia.etherscan.io' },
  'hashkey-testnet': { label: 'HSK Chain testnet', rpc: CHAINS.testnet.rpc, token: '0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6', ex: CHAINS.testnet.explorer },
}[HSPNET];
must(SETTLE, `known HSP network ${HSPNET}`);
if (process.env.DEMO_SETTLE_RPC) SETTLE.rpc = process.env.DEMO_SETTLE_RPC;   // offline builder test only
const CONTRACT = setup.contract;
must(ADDR.test(CONTRACT) && CONTRACT.toLowerCase() === start.contract.toLowerCase(), 'contract matches server start');
const DEPLOY_TX = process.env.DEMO_DEPLOY_TX || '';
const PROBE = JSON.parse(process.env.DEMO_PROBE || 'null'); // {flowId, prId, txHash, at} of the standalone probe (optional)

const visits = [];
for (const a of agency) {
  const id = a.visitId;
  const conf = server.find((e) => e.event === 'confirmed' && e.visitId === id);
  const appr = server.find((e) => e.event === 'approved' && e.visitId === id);
  const paid = server.find((e) => e.event === 'paid' && e.visitId === id);
  const rc = state.receipts[a.receiptHash];
  must(rc && conf, `visit ${id}: receipt + Mum's answer present`);
  const p = state.payments[String(id)] || null;
  const ps = server.find((e) => e.event === 'pay_start' && e.visitId === id);
  const rv = (state.reviews || {})[String(id)] || null;
  if (rv) { must(['pay', 'hold'].includes(rv.decision), `visit ${id}: review decision`); must(server.some((e) => e.event === 'review' && e.visitId === id && e.decision === rv.decision), `visit ${id}: review in server.log`);
    if (rv.decision === 'hold' && p) must(rv.released && Date.parse(p.startedAt) >= Date.parse(rv.released.at), `visit ${id}: held visit paid only after Mina's release`); }
  visits.push({ id, post: a.tx, receiptHash: a.receiptHash, rc, conf, appr, paid, p, ps, rv });
}
must(visits.length >= 1, '0 visits in agency.log');
if (process.env.DEMO_TAMPER === '1') { const v = visits.find((x) => x.p); const f = '00000000-0000-4000-8000-000000000000'; v.p = { ...v.p, flowId: f }; v.paid = { ...v.paid, flowId: f }; }

// ---- re-check everything on chain
const hsk = connect(NET);
const sep = createPublicClient({ transport: http(SETTLE.rpc, { timeout: 30_000, retryCount: 4, retryDelay: 1_500 }) });
const SEPOLIA_USDC = SETTLE.token;   // the settlement token (name kept from v1)
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
let checks = 0;
async function okTx(client, hash, label) {
  must(HEX32.test(hash || ''), `${label}: tx hash shape`);
  const rc = await client.getTransactionReceipt({ hash });
  must(rc.status === 'success', `${label}: ${hash} status ${rc.status}`);
  checks++; return rc;
}
async function usdcTransfer(hash, label) {
  const rc = await okTx(sep, hash, label);
  const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const t = rc.logs.filter((l) => l.address.toLowerCase() === SEPOLIA_USDC && l.topics[0] === T0).map((l) => decodeEventLog({ abi: [TRANSFER], data: l.data, topics: l.topics }).args);
  must(t.length === 1 && t[0].to.toLowerCase() === start.payTo.toLowerCase() && t[0].from.toLowerCase() === start.payer.toLowerCase(), `${label}: one USDC transfer payer -> agency pay-to`);
  checks++; return t[0].value;
}
const m = await mandate(hsk, CONTRACT, setup.mandateId);
const acks = V2 ? R('agency-watch.log').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((x) => x.event === 'ack') : [];
let trip = null, gates = [];
if (V2) {
  must(String(m.rawPerMillionWon) === setup.fx.rawPerMillionWon && usdFor(m.perVisitCap, m.rawPerMillionWon) === setup.fx.capUsd, 'mandate rate on chain = setup fx');
  checks++;
  trip = JSON.parse(R('captrip.json'));
  must(trip.refused === true && trip.reason === 'BadInput' && trip.amountWon > Number(m.perVisitCap), 'cap trip refused (BadInput) in the run');
  // re-run the refusal now, read-only: the agency posting the same over-cap price must still revert
  let rev = null;
  try { await hsk.pub.simulateContract({ address: CONTRACT, abi: ABI, functionName: 'postVisit', args: [BigInt(setup.mandateId), BigInt((await hsk.pub.getBlock()).timestamp - 60n), BigInt(trip.amountWon), keccak256(toBytes('demo-page cap check ' + Date.now()))], account: m.agency }); }
  catch (e) { rev = typeof e.walk === 'function' ? e.walk((x) => x?.data?.errorName)?.data?.errorName : null; }
  must(rev === 'BadInput', `over-cap post re-simulated now: reverts BadInput (got ${rev})`);
  checks++;
  for (const g of (process.env.DEMO_OFFLINE_GATES || '').split(',').filter(Boolean)) {
    const j = JSON.parse(fs.readFileSync(g, 'utf8'));
    must(j.failed === 0 && j.checks >= 8, `offline gate ${j.scenario}: PASS`);
    gates.push(j);
  }
}
await okTx(hsk.pub, setup.tx, 'mandate tx');
if (DEPLOY_TX) { const d = await okTx(hsk.pub, DEPLOY_TX, 'deploy tx'); must((d.contractAddress || '').toLowerCase() === CONTRACT.toLowerCase(), 'deploy tx created the contract'); }
for (const v of visits) {
  const on = await visit(hsk, CONTRACT, v.id);
  v.on = on;
  must(on.receiptHash.toLowerCase() === v.receiptHash.toLowerCase(), `visit ${v.id}: receipt hash on chain`);
  must(on.visitTime === v.rc.visitTime && Number(on.amount) === v.rc.amountWon, `visit ${v.id}: time + amount on chain`);
  await okTx(hsk.pub, v.post, `visit ${v.id} post`);
  await okTx(hsk.pub, v.conf.tx, `visit ${v.id} Mum's answer`);
  if (v.appr) await okTx(hsk.pub, v.appr.tx, `visit ${v.id} Mina's approval`);
  if (v.conf.happened) {
    must(on.status === 'Paid', `visit ${v.id}: Paid on chain (is ${on.status})`);
    must(v.p && v.paid && v.p.status === 'payment-safe' && v.p.hspStatus === 'payment-safe', `visit ${v.id}: HSP payment-safe in records`);
    must(UUID.test(v.p.flowId) && v.ps, `visit ${v.id}: flow id shape + pay_start logged`);
    must(v.p.flowId === v.paid.flowId && v.p.txHash === v.paid.txHash && v.p.markPaidTx === v.paid.markPaidTx, `visit ${v.id}: state.json = server.log`);
    must(on.paymentRef.toLowerCase() === keccak256(toBytes(v.p.flowId)).toLowerCase(), `visit ${v.id}: on-chain paymentRef = keccak256(HSP flow id)`);
    checks++;
    await okTx(hsk.pub, v.p.markPaidTx, `visit ${v.id} markPaid`);
    v.usdc = await usdcTransfer(v.p.txHash, `visit ${v.id} ${SETTLE.label}`);
    if (V2) {
      const oc = await payment(hsk, CONTRACT, v.id); v.oc = oc;
      must(oc.paidRaw === v.usdc && oc.settlementTx.toLowerCase() === v.p.txHash.toLowerCase(), `visit ${v.id}: payments(id) on chain = the settlement transfer`);
      must(oc.paidRaw <= recordLimitRaw(on.amount, m.rawPerMillionWon), `visit ${v.id}: paid within the mandate (won x rate + 5%)`);
      must(oc.agencyAck === true, `visit ${v.id}: the agency acknowledged on chain`);
      v.ack = acks.find((a) => a.visitId === v.id);
      must(v.ack, `visit ${v.id}: ack line in agency-watch.log`);
      await okTx(hsk.pub, v.ack.ackTx, `visit ${v.id} agency ack`);
      checks += 3;
    }
  } else {
    must(on.status === 'Rejected' && !v.p, `visit ${v.id}: Rejected on chain and never paid`);
    must(/^0x0{64}$/.test(on.paymentRef), `visit ${v.id}: no payment reference`);
    checks++;
  }
}
// ---- agent to agent (v4 runs): the make-up exchange after Mum's No, re-checked: both signatures against the mandate's keys on chain,
// every decision's anchor tx on chain, and (offline a2a runs) the make-up visits that claimed the agreement
let A2A = null;
if (fs.existsSync(path.join(runDir, 'a2a-agency.jsonl'))) {
  const dom = a2aDomain(hsk.cfg.id, CONTRACT), sdec = state.a2a?.decisions || [];
  const lines = jl(R('a2a-agency.jsonl'));
  must(lines.length >= 1 && lines.length <= 3, 'a2a: 1-3 proposals');
  for (const x of lines) {
    const p = parseProposal(x.proposal), d = parseDecision(x.decision), ph = proposalDigest(dom, p), dh = decisionDigest(dom, d);
    must(ph === x.proposalHash && dh === x.decisionHash && d.proposal === ph && d.accept === x.accept, `a2a ${x.n}: digests`);
    must((await proposalSigner(dom, p, x.proposalSig)).toLowerCase() === m.agency.toLowerCase(), `a2a ${x.n}: proposal signed by the mandate's agency`);
    must((await decisionSigner(dom, d, x.decisionSig)).toLowerCase() === m.familyAgent.toLowerCase(), `a2a ${x.n}: decision signed by the mandate's familyAgent`);
    const tx = await hsk.pub.getTransaction({ hash: x.anchorTx }); await okTx(hsk.pub, x.anchorTx, `a2a ${x.n} anchor`);
    must(tx.from.toLowerCase() === m.familyAgent.toLowerCase() && tx.to.toLowerCase() === m.familyAgent.toLowerCase() && tx.input.toLowerCase() === anchorData(dh, ph).toLowerCase(), `a2a ${x.n}: anchor input = decision + proposal digests`);
    const own = sdec.find((y) => y.decisionHash === dh); must(own && !own.rulesOff, `a2a ${x.n}: in Mina's agent's records, rules on`);
    x.text = own.reasons; checks += 3;
  }
  const ag = lines.find((x) => x.accept);
  const mks = fs.existsSync(path.join(runDir, 'agency-makeup.log')) ? jl(R('agency-makeup.log')).filter((x) => x.visitId) : [];
  for (const k of mks) {
    k.on = await visit(hsk, CONTRACT, k.visitId); k.rv = (state.reviews || {})[String(k.visitId)] || null; k.rc = state.receipts[k.receiptHash]; k.p = state.payments[String(k.visitId)] || null;
    must(k.rc && k.on.receiptHash.toLowerCase() === k.receiptHash.toLowerCase(), `make-up visit ${k.visitId}: receipt on chain`);
    await okTx(hsk.pub, k.tx, `make-up visit ${k.visitId} post`);
    if (k.on.status === 'Paid') { must(k.rv?.makeup?.matched && k.rv.makeup.decisionHash === ag?.decisionHash, `make-up visit ${k.visitId}: paid only as the agreed make-up`);
      k.oc = await payment(hsk, CONTRACT, k.visitId); must(k.oc.agencyAck && k.p?.txHash, `make-up visit ${k.visitId}: acknowledged`); k.usdc = await usdcTransfer(k.p.txHash, `make-up visit ${k.visitId}`); }
    else must(k.rv?.decision === 'hold' && !k.p, `make-up visit ${k.visitId}: not the agreement -> held, nothing paid`);
    checks += 2;
  }
  A2A = { lines, ag, mks };
}
if (PROBE) { must(UUID.test(PROBE.flowId), 'probe flow id'); PROBE.usdc = await usdcTransfer(PROBE.txHash, 'standalone probe'); }
must(checks >= visits.length * 3, `too few checks (${checks})`);
console.log(`chain checks passed: ${checks} (visits ${visits.length}, paid ${visits.filter((v) => v.p).length})`);

const rgate = gates.find((g) => g.scenario === 'review'), hgates = gates.filter((g) => g.scenario !== 'review');
// ---- the family agent's note review on the live model (optional evidence file from review-probe.mjs)
let probe = null;
if (process.env.DEMO_REVIEW_PROBE) {
  probe = JSON.parse(fs.readFileSync(process.env.DEMO_REVIEW_PROBE, 'utf8'));
  must(Array.isArray(probe.results) && probe.results.length >= 3 && probe.results.every((r) => r.decision === r.want && r.source === 'model+rules'), 'review probe: every note decided as expected by model + rules');
}
// ---- HSK Chain mainnet (optional): the deploy and a visit cycle, re-read on mainnet now
let MAIN = null;
if (process.env.DEMO_MAINNET) {
  const md = JSON.parse(fs.readFileSync(path.join(process.env.DEMO_MAINNET, 'deploy.json'), 'utf8'));
  const mn = connect('mainnet');
  must(ADDR.test(md.contract) && (await mn.pub.getBytecode({ address: md.contract }) || '0x').length > 1000, 'mainnet: contract code present');
  const mm = await mandate(mn, md.contract, md.mandateId);
  must(String(mm.rawPerMillionWon) === md.fx.rawPerMillionWon && mm.perVisitCap === 45000n && mm.active, 'mainnet: mandate rate + cap as deployed');
  await okTx(mn.pub, md.deployTx, 'mainnet deploy tx'); await okTx(mn.pub, md.tx, 'mainnet mandate tx');
  MAIN = { ...md, m: mm, visit: null };
  if (process.env.DEMO_MAINNET_VISIT) {
    const mv = JSON.parse(fs.readFileSync(path.join(process.env.DEMO_MAINNET_VISIT, 'visit.json'), 'utf8'));
    must(mv.contract.toLowerCase() === md.contract.toLowerCase() && Number.isInteger(mv.visitId), 'mainnet visit: same contract');
    const on = await visit(mn, md.contract, mv.visitId), oc = await payment(mn, md.contract, mv.visitId);
    must(on.status === 'Paid' && oc.agencyAck === true && String(oc.paidRaw) === String(mv.paidRaw) && oc.settlementTx.toLowerCase() === mv.settlementTx.toLowerCase(), 'mainnet visit: Paid + agency ack on chain = visit.json');
    must(on.paymentRef.toLowerCase() === keccak256(toBytes(mv.flowId)).toLowerCase(), 'mainnet visit: paymentRef = keccak256(HSP flow id)');
    for (const k of ['postTx', 'confirmTx', 'markPaidTx', 'ackTx']) await okTx(mn.pub, mv[k], 'mainnet ' + k);
    mv.usdc = await usdcTransfer(mv.settlementTx, 'mainnet visit settlement');
    must(mv.usdc === oc.paidRaw, 'mainnet visit: settlement transfer = paidRaw');
    MAIN.visit = mv; checks += 4;
  }
}

// ---- render
const EX = CHAINS.testnet.explorer, SEP = SETTLE.ex;
const hx = (h, n = 8) => `${h.slice(0, n)}…${h.slice(-6)}`;
const txl = (h, base = EX) => `<a href="${base}/tx/${esc(h)}" rel="noopener">${esc(hx(h))}</a>`;
const fmt = (d, opt) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', ...opt }).format(d);
const fmtU = (d, opt) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opt }).format(d);
const HMS = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }, HM = { hour: '2-digit', minute: '2-digit', hour12: false }, DM = { day: 'numeric', month: 'short' };
// one time, UTC first and Korea time in brackets; the KST date is shown when it differs from the UTC date
const at2 = (d, o = HMS) => { const du = fmtU(d, DM), dk = fmt(d, DM); return `${du}, ${fmtU(d, o)} UTC (${dk !== du ? dk + ', ' : ''}${fmt(d, o)} KST)`; };
const tm2 = (iso) => `${fmtU(new Date(iso), HMS)} UTC (${fmt(new Date(iso), HMS)} KST)`;
const visitAt2 = (sec) => at2(new Date(sec * 1000), HM);
const span2 = (a, b) => { const A = new Date(a), B = new Date(b); const du = fmtU(A, { ...DM, year: 'numeric' }), dk = fmt(A, { ...DM, year: 'numeric' });
  return `${du}, ${fmtU(A, HM)} to ${fmtU(B, HM)} UTC (${dk !== du ? dk + ', ' : ''}${fmt(A, HM)} to ${fmt(B, HM)} KST)`; };
const usd = (v) => `$${(Number(v) / 1e6).toFixed(2)}`;
const won = (n) => `${Number(n).toLocaleString('en-US')} won`;
const secs = (a, b) => Math.round((new Date(b) - new Date(a)) / 1000);
const paidN = visits.filter((v) => v.p).length, noN = visits.filter((v) => !v.conf.happened).length, heldN = visits.filter((v) => v.appr).length;
const runStart = start.at, runEnd = server.filter((e) => e.event === 'paid').map((e) => e.at).sort().pop();
const sel = toFunctionSelector('visits(uint256)');
const FILM_OTHER = process.env.DEMO_FILM_RUN && process.env.DEMO_FILM_RUN !== path.basename(path.resolve(runDir)) ? process.env.DEMO_FILM_RUN : '';

const card = (v) => {
  const yes = v.conf.happened;
  const pill = yes ? '<span class="pill Paid">paid</span>' : '<span class="pill Rejected">not paid</span>';
  const rows = [
    ['Agency agent posts the visit', `${txl(v.post)}<span class="h">receipt ${esc(hx(v.receiptHash, 10))}</span>`],
    ['Mum answers on her tablet', `<b class="${yes ? 'ok' : 'no'}">${yes ? 'Yes' : 'No'}</b> · ${txl(v.conf.tx)}<span class="h">${tm2(v.conf.at)}, signed by the tablet, relayed by Mina's agent</span>`],
  ];
  if (v.rc.note) rows.push(["Carer's note", `<span class="q">“${esc(v.rc.note)}”</span><span class="h">part of the receipt whose hash is on chain</span>`]);
  if (v.rv) {
    const src = v.rv.source === 'model+rules' ? `model (${esc(v.rv.model?.name || '')}) + rules` : 'rules (model unavailable)';
    rows.push(["Mina's agent reads the note", v.rv.decision === 'pay' ? `<b class="ok">pay</b> · nothing unusual<span class="h">${src}; ${tm2(v.rv.at)}</span>`
      : `<b class="no">held for Mina</b><ul class="h">${(v.rv.reasons || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul><span class="h">${src}; ${tm2(v.rv.at)}. ${v.rv.released ? `Mina read it and pressed Pay anyway at ${tm2(v.rv.released.at)}; nothing was ordered from HSP before that.` : 'Not paid.'}</span>`]);
  }
  if (v.appr) rows.push(['4th visit this week: held', `Mina approved · ${txl(v.appr.tx)}<span class="h">${tm2(v.appr.at)}</span>`]);
  if (yes) {
    rows.push(['HSP Agentic Payment', `<b class="ok">payment-safe</b>, ${secs(v.ps.at, v.p.settledAt)} s after the order was created<span class="h">flow <code>${esc(v.p.flowId)}</code></span><span class="h">request <code>${esc(v.p.paymentRequestId)}</code></span>`]);
    rows.push([`Money moved (${SETTLE.label})`, `${usd(v.usdc)} test USDC · ${txl(v.p.txHash, SEP)}${V2 ? `<span class="h">${esc(won(v.rc.amountWon))} at the mandate rate = at most ${usd(maxPayRaw(v.rc.amountWon, m.rawPerMillionWon))}; asked HSP for $${esc(usdFor(v.rc.amountWon, m.rawPerMillionWon))}</span>` : ''}`]);
    rows.push(['Paid, recorded on HSK Chain', `markPaid · ${txl(v.p.markPaidTx)}<span class="h">paymentRef = keccak256(flow id) = <code>${esc(hx(v.on.paymentRef, 10))}</code></span>`]);
    if (v.ack) rows.push(["Agency's agent confirms receipt", `ackPaid · ${txl(v.ack.ackTx)}<span class="h">after checking the ${esc(SETTLE.label)} transfer itself; ${tm2(v.ack.at)}</span>`]);
  } else {
    rows.push(['Payment', '<b class="no">none</b><span class="h">The contract marks the visit Rejected; it can never be paid.</span>']);
  }
  return `<article class="card visit" id="visit-${v.id}" data-visit="${v.id}" data-status="${esc(v.on.status)}" data-ref="${esc(v.on.paymentRef.toLowerCase())}">
<div class="vh"><div><h3>Visit ${v.id}</h3><p class="small">${esc(visitAt2(v.rc.visitTime))} · ${esc(v.rc.carer)} · ${esc(won(v.rc.amountWon))}</p></div>${pill}</div>
<dl>${rows.map(([k, val]) => `<div><dt>${k}</dt><dd>${val}</dd></div>`).join('')}</dl>
<p class="live small" aria-live="polite"></p></article>`;
};

const shots = [
  ['mum-question.png', "Mum's tablet: one question, Yes or No"],
  ['mum-paying.png', 'After Yes: paying Ji-woo via HSP, about 3 minutes'],
  ['mum-done.png', "Mum's tablet when the payments are safe"],
  ['mina-held.png', "Mina's page: 4th visit waits for her Approve"],
  ['mina-after.png', "Mina's page at the end: 4 paid, 1 not paid"],
  ['mina-review-held.png', "Mina's page: her agent held a visit after reading the note"],
].filter(([f]) => fs.existsSync(path.join(runDir, f)));
const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CareMandate: the testnet run</title>
<meta name="description" content="Pay mum's carer only for the visits that happened. The full record of one run on HSK Chain testnet with real HSP QA payments.">
<meta name="referrer" content="strict-origin-when-cross-origin">
<link rel="stylesheet" href="style.css">
</head><body><main>
<p class="eyebrow">CareMandate · HSK Chain + HSP</p>
<h1>Pay mum's carer only for the visits that happened.</h1>
<p class="sub">Mina works in Seoul. Her mother lives in Busan, and a carer visits her. Mum answers one question after each visit, and Mina's agent pays the agency's agent through HSP only for the visits Mum confirms.</p>

<section class="card note"><p><b>This page is the record of one real run.</b> ${esc(span2(runStart, runEnd))}, on <b>HSK Chain testnet</b> with <b>real HSP QA payments</b> (HSP's QA environment settles in test USDC on ${esc(SETTLE.label)}). It is read-only: it holds no keys and cannot pay anyone.</p></section>

${FILM_OTHER ? `<section class="card"><h2>The first testnet run, filmed (71 s)</h2>` : `<section class="card"><h2>The run in 71 seconds</h2>`}<video controls preload="none" playsinline width="1920" height="1080" poster="poster.jpg" src="caremandate-demo.mp4"></video><p class="small">Captions only, no sound. ${FILM_OTHER ? `Filmed on an earlier run (<code>${esc(FILM_OTHER)}</code>, before the payment-record, cap and agency-receipt features); the record below is of this run. ` : ''}<a href="caremandate-demo.mp4">Open the video file</a>.</p></section>

${MAIN?.visit ? `<section class="card judge" id="mainnet-check"><h2>Check the mainnet visit in 30 seconds</h2>
<p class="small">One visit ran end to end on <b>HSK Chain mainnet</b>. This button reads it from the mainnet contract right now (<code>visits(${MAIN.visit.visitId})</code> and <code>payments(${MAIN.visit.visitId})</code>, read-only calls to ${esc(CHAINS.mainnet.rpc.replace(/^https:\/\//, ''))}) and compares each field with what this page says.</p>
<dl class="expect"><div><dt>This page says</dt><dd>status <b>Paid</b> · paymentRef <code>${esc(hx(keccak256(toBytes(MAIN.visit.flowId)), 10))}</code> (keccak256 of HSP flow ${esc(MAIN.visit.flowId.slice(0, 8))}…) · paid ${esc(String(MAIN.visit.paidRaw))} USDC units (${usd(MAIN.visit.paidRaw)}) · settlement tx <code>${esc(hx(MAIN.visit.settlementTx, 10))}</code> · agency acknowledged <b>yes</b></dd></div></dl>
<button id="mcheck" class="go" type="button" data-rpc="${CHAINS.mainnet.rpc}" data-chain="0xb1" data-contract="${esc(MAIN.contract)}" data-mvisit="${MAIN.visit.visitId}"
 data-status="Paid" data-ref="${esc(keccak256(toBytes(MAIN.visit.flowId)).toLowerCase())}" data-paid="${esc(String(MAIN.visit.paidRaw))}" data-stx="${esc(MAIN.visit.settlementTx.toLowerCase())}" data-ack="true"
 data-sel-visits="${toFunctionSelector('visits(uint256)')}" data-sel-payments="${toFunctionSelector('payments(uint256)')}" hidden>Re-check on HSK Chain mainnet</button>
<noscript><p class="small">The check needs JavaScript. Without it: open the <a href="${CHAINS.mainnet.explorer}/address/${esc(MAIN.contract)}?tab=read_contract" rel="noopener">contract on the explorer</a>, read visits(${MAIN.visit.visitId}) and payments(${MAIN.visit.visitId}).</p></noscript>
<ul id="mcheckout" class="checks small" aria-live="polite"></ul></section>` : ''}

<section class="card stat" aria-label="Run summary"><div><b>${visits.length}</b>visits</div><div><b>${paidN}</b>paid via HSP</div><div><b>${noN}</b>not paid</div><div><b>${heldN}</b>held for Mina</div></section>

<section class="card"><h2>Mina's rules, on chain</h2>
<dl><div><dt>Contract (HSK Chain testnet)</dt><dd><a href="${EX}/address/${CONTRACT}" rel="noopener"><code>${CONTRACT}</code></a></dd></div>
${DEPLOY_TX ? `<div><dt>Deployed</dt><dd>${txl(DEPLOY_TX)}</dd></div>` : ''}
<div><dt>Mandate ${setup.mandateId}</dt><dd>${txl(setup.tx)}<span class="h">at most ${m.weeklyMax} visits a week, at most ${esc(won(m.perVisitCap))} a visit; only the agency <code>${esc(hx(m.agency, 6))}</code> can be paid; only Mum's tablet key <code>${esc(hx(m.confirmer, 6))}</code> can confirm</span></dd></div>
${V2 ? `<div><dt>Won to test USDC, on chain</dt><dd>${esc(String(m.rawPerMillionWon))} USDC units per 1,000,000 won<span class="h">${esc(String(setup.fx.krwPerUsd))} won per dollar (${esc(setup.fx.source)}, ${esc(setup.fx.date)}), testnet scale 1:${esc(String(setup.fx.scale))}: ${esc(won(m.perVisitCap))} = $${esc(setup.fx.capUsd)} test USDC (at full scale $${esc(usdFor(m.perVisitCap, m.rawPerMillionWon * BigInt(setup.fx.scale)))}). The contract refuses to record a payment above a visit's won price at this rate + 5%.</span></dd></div>
<div><dt>Over the cap: refused</dt><dd><b class="no">${esc(won(trip.amountWon))} visit refused</b> by the contract (<code>${esc(trip.reason)}</code>); it never became a visit<span class="h">Re-checked when this page was built: the agency posting ${esc(won(trip.amountWon))} to this contract still reverts.</span></dd></div>` : ''}</dl>
<p class="small">The contract holds no money: HSP moves it. The contract decides what may be paid, and records each HSP payment against its visit.</p></section>

${probe ? `<section class="card"><h2>Mina's agent reads every note</h2><p class="small">Mum's yes says the carer came; the note says what happened. Before it pays, Mina's agent reads the carer's note against her care plan (lunch, medicines, a walk; at least 60 minutes; arrival near the booked time). Rules always run; a language model (${esc(probe.model)}, free tier) reads the note too and can only add a hold, never lift one. The note is untrusted text written by the other side. A held visit stays unpaid, nothing is ordered from HSP, and Mina sees why and decides. The live model's answers, ${esc(at2(new Date(probe.at), HM))}:</p>
<dl>${probe.results.map((r) => `<div><dt>${r.decision === 'pay' ? '<b class="ok">pay</b>' : '<b class="no">hold</b>'}</dt><dd><span class="q">“${esc(NOTES[r.note] || r.note)}”</span><span class="h">rules: ${r.rules.length ? esc(r.rules.join(', ')) : 'nothing'}${r.model?.reasons?.length ? ` · model: ${esc(r.model.reasons.join('; '))}` : ' · model: pay'}</span></dd></div>`).join('')}</dl>
${rgate ? `<p class="small"><b class="ok">PASS</b>, ${rgate.checks} checks: an offline end-to-end run (<code>CM_SCENARIO=review bash app/test/e2e-offline-qa.sh</code>) where Mum says yes to a visit whose note says 20 minutes, the wrong time and no walk. The agent held it; HSP was asked for nothing until Mina pressed Pay anyway. With the check switched off (<code>REVIEW_OFF=1</code>) the same run pays it unread and the gate fails.</p>` : ''}</section>` : ''}

${A2A ? (() => {
  const R0 = DEFAULT_MAKEUP_RULES, slot = (x) => span2(Number(x.proposal.slotStart) * 1000, Number(x.proposal.slotEnd) * 1000);
  return `<section class="card" id="a2a"><h2>A missed visit: the two agents agree a make-up</h2>
<p class="small">Mum said visit ${esc(String(A2A.lines[0].missedVisitId))} did not happen, so it is never paid. The agency's agent then offers a make-up visit to Mina's agent. Mina's agent answers under her rules: ${String(R0.startHour).padStart(2, "0")}:00 to ${R0.endHour}:00 Korea time, within ${R0.maxDaysAfter} days, ${R0.minMinutes} to ${R0.maxMinutes} minutes, never dearer than the missed visit, and inside her limit of ${m.weeklyMax} visits a week (read from the contract). Each offer is EIP-712 typed data signed with the agency's key from the mandate; each answer is signed with the key of Mina's agent from the mandate, and put on HSK Chain before the agency hears it (a transaction from Mina's agent whose input is the two digests). The contract is unchanged: the make-up visit's receipt, whose hash goes on chain when it is posted, carries both signed messages, and Mina's agent pays a visit that says it is a make-up only if it matches what it agreed.</p>
<dl>${A2A.lines.map((x) => `<div><dt>Offer ${x.n}${x.n === 1 ? ' (the carer\'s free evening)' : ''}</dt><dd>${esc(slot(x))}, ${esc(won(x.proposal.amount))}<span class="h">${x.accept ? '<b class="ok">accepted</b>: fits every rule.' : `<b class="no">declined</b>: ${esc((x.text || []).map((r) => r.text).join(' '))}`}</span><span class="h">answer on chain ${txl(x.anchorTx)} · offer signed by the agency <code>${esc(hx(m.agency, 6))}</code>, answer by Mina's agent <code>${esc(hx(m.familyAgent, 6))}</code> (both re-checked when this page was built)</span></dd></div>`).join('')}
${A2A.mks.map((k) => `<div><dt>Visit ${k.visitId}: ${k.on.status === 'Paid' ? 'the agreed make-up' : 'a second visit claiming the same agreement'}</dt><dd>${k.on.status === 'Paid' ? `<b class="ok">paid</b> · Mum said yes, it matched the agreed slot and price · ${usd(k.usdc)} via HSP · ${txl(k.p.markPaidTx)}` : `<b class="no">held for Mina, nothing ordered from HSP</b><ul class="h">${(k.rv.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`}<span class="h">${esc(visitAt2(k.rc.visitTime))} · post ${txl(k.tx)}</span></dd></div>`).join('')}</dl>
${A2A.mks.length ? '' : `<p class="small">The agreed slot is after this run ended, so the make-up visit itself is not in this record. The offline test <code>CM_SCENARIO=a2a bash app/test/e2e-offline-qa.sh</code> moves a local chain to the slot: the agreed make-up is paid, and a second visit claiming the same agreement outside its slot is held.</p>`}</section>`; })() : ''}

<h2 class="sec">Every visit</h2>
${visits.map(card).join('\n')}

<section class="card"><h2>What you see on the phones</h2><p class="small">Screenshots taken by the end-to-end test during this run (390 px wide, the size of a phone).</p>
<div class="shots">${shots.map(([f, c]) => `<figure><img src="shots/${f}" alt="${esc(c)}" loading="lazy" width="390"><figcaption>${esc(c)}</figcaption></figure>`).join('')}</div></section>

${PROBE ? `<section class="card"><h2>First real HSP payment</h2><p>Before the full run, one standalone HSP QA payment: flow <code>${esc(PROBE.flowId)}</code>, request <code>${esc(PROBE.prId)}</code>, ${usd(PROBE.usdc)} test USDC, <b class="ok">payment-safe</b> · ${txl(PROBE.txHash, SEP)}</p></section>` : ''}

${hgates.length ? `<section class="card"><h2>When HSP fails</h2><p class="small">Offline end-to-end tests (local chain, a stand-in HSP that settles real EIP-3009 transfers), run from the repo with <code>CM_SCENARIO=&lt;name&gt; bash app/test/e2e-offline-qa.sh</code>. In each, Mum's yes leaves the visit <b>Confirmed and unpaid</b> on chain with a PaymentIssue record, both pages say so, and nothing is ever paid twice.</p>
<dl>${hgates.map((g) => `<div><dt>${esc({ 'failed-once': 'HSP payment-failed, then an automatic retry', timeout: 'HSP never confirms (timeout)', overcharge: 'HSP quotes more than the mandate', ok: 'All payments settle', review: 'An odd visit note: held for Mina' }[g.scenario] || g.scenario)}</dt><dd><b class="ok">PASS</b>, ${g.checks} checks · paid ${g.paid}, issues recorded on chain ${g.issues}<span class="h">${esc({ 'failed-once': 'The first flow fails with no money moved; a new flow pays the visit once. 5 signatures, 4 transfers.', timeout: 'The flow stays unsettled; the server keeps querying the same flow and never signs or submits again.', overcharge: 'The signing firewall refuses before anything is signed; Mina can retry by hand.', ok: '4 transfers, 4 agency acknowledgements.', review: 'Mum says yes, but the note says 20 minutes, the wrong time and no walk: the agent orders nothing from HSP until Mina presses Pay anyway. With the check switched off the same run pays it unread and the gate fails.' }[g.scenario] || '')}</span></dd></div>`).join('')}</dl></section>` : ''}

${MAIN ? `<section class="card"><h2>HSK Chain mainnet</h2><dl>
<div><dt>Contract (HSK Chain mainnet, source verified)</dt><dd><a href="${CHAINS.mainnet.explorer}/address/${esc(MAIN.contract)}" rel="noopener"><code>${esc(MAIN.contract)}</code></a></dd></div>
<div><dt>Mina's mandate, real scale</dt><dd><a href="${CHAINS.mainnet.explorer}/tx/${esc(MAIN.tx)}" rel="noopener">${esc(hx(MAIN.tx))}</a><span class="h">45,000 won a visit, 3 a week; ${esc(String(MAIN.fx.krwPerUsd))} won per dollar (${esc(MAIN.fx.date)}) stored on chain: at most $${esc(MAIN.fx.capUsd)} a visit</span></dd></div>
${MAIN.visit ? `<div><dt>One visit, end to end on mainnet</dt><dd><b class="ok">Paid</b> · post <a href="${CHAINS.mainnet.explorer}/tx/${esc(MAIN.visit.postTx)}" rel="noopener">${esc(hx(MAIN.visit.postTx))}</a> · Mum's yes <a href="${CHAINS.mainnet.explorer}/tx/${esc(MAIN.visit.confirmTx)}" rel="noopener">${esc(hx(MAIN.visit.confirmTx))}</a> · markPaid <a href="${CHAINS.mainnet.explorer}/tx/${esc(MAIN.visit.markPaidTx)}" rel="noopener">${esc(hx(MAIN.visit.markPaidTx))}</a> · agency ack <a href="${CHAINS.mainnet.explorer}/tx/${esc(MAIN.visit.ackTx)}" rel="noopener">${esc(hx(MAIN.visit.ackTx))}</a><span class="h">${esc(won(MAIN.visit.amountWon))} visit at the mandate rate; HSP flow <code>${esc(MAIN.visit.flowId)}</code> settled ${usd(MAIN.visit.usdc)} in HSP QA test USDC on ${esc(MAIN.visit.settleLabel || 'Ethereum Sepolia')} (${txl(MAIN.visit.settlementTx, SETTLE.ex)}); ${esc(tm2(MAIN.visit.at))}</span></dd></div>` : ''}
</dl></section>` : ''}

<section class="card"><h2>Check it yourself</h2>
<p class="small">Every link above opens a public explorer. This button reads <code>visits(id)</code> from the contract right now (HSK Chain testnet RPC, read-only) and compares each status and payment reference with this page.</p>
<button id="check" class="go" type="button" data-rpc="${CHAINS.testnet.rpc}" data-contract="${CONTRACT}" data-sel="${sel}" hidden>Check on HSK Chain now</button>
<noscript><p class="small">The check needs JavaScript; the explorer links work without it.</p></noscript>
<p id="checkout" class="small" aria-live="polite"></p></section>

<footer class="small"><p>Code: <a href="https://github.com/swiftbotlabs/caremandate" rel="noopener">github.com/swiftbotlabs/caremandate</a> · Built by Swift Bot Labs for HSK Chain Horizon · Seoul. Times are UTC, with Korea time (KST, UTC+9) in brackets. ${MAIN ? `Mainnet: CareMandate is deployed on HSK Chain mainnet (above), re-read when this page was built.` : 'Mainnet: rehearsed on a fork of HSK Chain mainnet (chain 177).'}</p>
<p>All ${checks} on-chain facts on this page were re-checked against HSK Chain testnet${HSPNET === 'sepolia' ? ' and Ethereum Sepolia' : ''} when it was built.</p></footer>
</main><script src="live.js" defer></script></body></html>
`;

const css = `:root{--ink:#1d2433;--soft:#5b6476;--bg:#fbf7f1;--card:#fff;--ok:#1f7a4d;--okbg:#e3f4ea;--no:#a3312b;--nobg:#fbe7e5;--wait:#8a5a00;--waitbg:#fdf1d8;--line:#e8e1d6;--link:#2a5bd7}
@media (prefers-color-scheme:dark){:root{--ink:#eef0f4;--soft:#a9b0bd;--bg:#14171d;--card:#1c2028;--ok:#5cc98f;--okbg:#173326;--no:#f08a83;--nobg:#3a1d1b;--wait:#f0c264;--waitbg:#3a2f14;--line:#2c323d;--link:#8fb0ff}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans KR",sans-serif;background:var(--bg);color:var(--ink);line-height:1.45}
main{max-width:640px;margin:0 auto;padding:24px 16px 56px}
.eyebrow{font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ok);margin:0 0 6px}
h1{font-size:clamp(26px,7vw,36px);line-height:1.15;letter-spacing:-.015em;margin:0 0 10px}
h2{font-size:19px;margin:0 0 10px}h2.sec{margin:26px 0 12px}h3{font-size:18px;margin:0}
.sub{color:var(--soft);margin:0 0 18px;font-size:17px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 2px 10px rgba(29,36,51,.05);margin-bottom:14px}
.note{border-left:5px solid var(--ok)}.note p{margin:0}
.stat{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;text-align:center;font-size:13px;color:var(--soft)}
.stat b{display:block;font-size:28px;color:var(--ink)}
@media(max-width:380px){.stat{grid-template-columns:repeat(2,1fr);row-gap:12px}}
.vh{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px}
.pill{font-size:13px;font-weight:700;border-radius:999px;padding:4px 10px;white-space:nowrap}
.Paid{background:var(--okbg);color:var(--ok)}.Rejected{background:var(--nobg);color:var(--no)}
dl{margin:0}dl>div{padding:10px 0;border-top:1px solid var(--line)}dl>div:first-child{border-top:0}
dt{font-size:13px;font-weight:700;color:var(--soft);margin-bottom:2px}dd{margin:0;overflow-wrap:anywhere}
.h{display:block;font-size:13px;color:var(--soft)}
.q{font-style:italic;overflow-wrap:anywhere} ul.h{margin:4px 0 4px 18px;padding:0}
b.ok{color:var(--ok)}b.no{color:var(--no)}
.small{font-size:14px;color:var(--soft)}a{color:var(--link)}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;word-break:break-all}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
figure{margin:0}figure img{width:100%;height:auto;max-height:420px;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:12px;display:block;background:#fff}
figcaption{font-size:13px;color:var(--soft);margin-top:4px}
button.go{font:inherit;font-weight:700;border:0;border-radius:12px;padding:12px 16px;background:var(--ink);color:var(--bg);cursor:pointer;min-height:44px}
button.go[disabled]{opacity:.55;cursor:wait}button:focus-visible,a:focus-visible{outline:3px solid #f2b53a;outline-offset:2px}
.live:empty{display:none}.live{margin:8px 0 0}.live.ok{color:var(--ok)}.live.bad{color:var(--no)}
video{width:100%;height:auto;border-radius:12px;display:block;background:#000;margin:4px 0 8px}
footer{margin-top:22px}footer p{margin:6px 0}
.judge{border:2px solid var(--ok)}ul.checks{list-style:none;margin:10px 0 0;padding:0}ul.checks li{padding:4px 0;overflow-wrap:anywhere}ul.checks li.ok{color:var(--ok)}ul.checks li.bad{color:var(--no)}ul.checks li b{color:inherit}
`;

// live.js: read-only eth_calls. (1) the mainnet visit: visits(id) + payments(id) on HSK Chain mainnet vs the page's numbers;
// (2) every testnet visit: visits(id). Strict input checks; only the two fixed RPC origins; nothing signed or sent.
const live = `'use strict';
(function () {
  var b = document.getElementById('mcheck'); if (!b) return;
  var out = document.getElementById('mcheckout'), d = b.dataset;
  var ST = ['None', 'Posted', 'Confirmed', 'Held', 'Paid', 'Rejected'];
  if (d.rpc !== 'https://mainnet.hsk.xyz' || !/^0x[0-9a-f]{40}$/i.test(d.contract) || !/^[0-9]{1,6}$/.test(d.mvisit) || !/^0x[0-9a-f]{8}$/.test(d.selVisits) || !/^0x[0-9a-f]{8}$/.test(d.selPayments)) return;
  b.hidden = false;
  function rpc(method, params, words) {
    var ctl = new AbortController(); var t = setTimeout(function () { ctl.abort(); }, 15000);
    return fetch(d.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }) })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (s) { if (s.length > 10000) throw new Error('reply too large'); var j = JSON.parse(s);
        var re = words ? new RegExp('^0x[0-9a-f]{' + (64 * words) + '}$', 'i') : /^0x[0-9a-f]{1,16}$/i;
        if (typeof j.result !== 'string' || !re.test(j.result)) throw new Error('unexpected reply'); return j.result.slice(2).toLowerCase(); });
  }
  function call(sel, words) { return rpc('eth_call', [{ to: d.contract, data: sel + parseInt(d.mvisit, 10).toString(16).padStart(64, '0') }, 'latest'], words); }
  function line(ok, label, page, chain) { var li = document.createElement('li'); li.className = ok ? 'ok' : 'bad';
    li.textContent = (ok ? 'match: ' : 'MISMATCH: ') + label + (ok ? ' = ' + chain : ' (page ' + page + ', chain ' + chain + ')'); out.appendChild(li); return ok; }
  b.addEventListener('click', function () {
    b.disabled = true; out.textContent = ''; var t0 = Date.now();
    var li = document.createElement('li'); li.textContent = 'Reading visit ' + d.mvisit + ' from HSK Chain mainnet…'; out.appendChild(li);
    Promise.all([rpc('eth_chainId', [], 0), call(d.selVisits, 6), call(d.selPayments, 4)]).then(function (r) {
      out.textContent = ''; var n = 0, w = r[1], p = r[2];
      n += line(r[0] === 'b1', 'chain id', '177', String(parseInt(r[0], 16)));
      n += line(ST[parseInt(w.slice(64 * 3, 64 * 4), 16)] === d.status, 'status', d.status, ST[parseInt(w.slice(64 * 3, 64 * 4), 16)] || '?');
      var ref = '0x' + w.slice(64 * 5, 64 * 6); n += line(ref === d.ref, 'paymentRef (keccak256 of the HSP flow id)', d.ref.slice(0, 12) + '…', ref.slice(0, 12) + '…');
      var paid = BigInt('0x' + p.slice(0, 64)).toString(); n += line(paid === d.paid, 'paid (USDC units)', d.paid, paid);
      var stx = '0x' + p.slice(64, 128); n += line(stx === d.stx, 'settlement tx', d.stx.slice(0, 12) + '…', stx.slice(0, 12) + '…');
      var ack = parseInt(p.slice(192, 256), 16) === 1; n += line(String(ack) === d.ack, 'agency acknowledged', 'yes', ack ? 'yes' : 'no');
      var s = document.createElement('li'); s.className = n === 6 ? 'ok' : 'bad';
      s.innerHTML = '<b>' + (n === 6 ? 'All 6 match' : (6 - n) + ' of 6 do not match') + '</b> (HSK Chain mainnet, ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s).'; out.appendChild(s);
    }).catch(function (e) { out.textContent = ''; line(false, 'read', 'visit ' + d.mvisit, e.message); })
      .then(function () { b.disabled = false; });
  });
})();
(function () {
  var b = document.getElementById('check'); if (!b) return;
  var out = document.getElementById('checkout');
  var RPC = b.dataset.rpc, C = b.dataset.contract, SEL = b.dataset.sel;
  var ST = ['None', 'Posted', 'Confirmed', 'Held', 'Paid', 'Rejected'];
  if (RPC !== 'https://testnet.hsk.xyz' || !/^0x[0-9a-f]{40}$/i.test(C) || !/^0x[0-9a-f]{8}$/.test(SEL)) return;
  b.hidden = false;
  function call(id) {
    var data = SEL + id.toString(16).padStart(64, '0');
    var ctl = new AbortController(); var t = setTimeout(function () { ctl.abort(); }, 15000);
    return fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: C, data: data }, 'latest'] }) })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (s) { if (s.length > 10000) throw new Error('reply too large'); var j = JSON.parse(s);
        if (typeof j.result !== 'string' || !/^0x[0-9a-f]{384}$/i.test(j.result)) throw new Error('unexpected reply'); return j.result.slice(2); });
  }
  b.addEventListener('click', function () {
    var cards = Array.prototype.slice.call(document.querySelectorAll('[data-visit]')).slice(0, 50);
    b.disabled = true; out.textContent = 'Reading ' + cards.length + ' visits from HSK Chain testnet…'; var good = 0, done = 0;
    cards.forEach(function (c) {
      var id = parseInt(c.dataset.visit, 10), el = c.querySelector('.live');
      call(id).then(function (w) {
        var st = ST[parseInt(w.slice(64 * 3, 64 * 4), 16)] || '?', ref = '0x' + w.slice(64 * 5, 64 * 6).toLowerCase();
        var ok = st === c.dataset.status && ref === c.dataset.ref;
        if (ok) good++;
        el.className = 'live small ' + (ok ? 'ok' : 'bad');
        el.textContent = ok ? 'On chain now: ' + st + (st === 'Paid' ? ', payment reference matches this page.' : ', never paid.') : 'On chain now: ' + st + ' (does not match this page).';
      }).catch(function (e) { el.className = 'live small bad'; el.textContent = 'Could not read visit ' + id + ': ' + e.message; })
        .then(function () { if (++done === cards.length) { b.disabled = false; out.textContent = good + ' of ' + cards.length + ' visits match the chain right now.'; } });
    });
  });
})();
`;

fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), html);
fs.writeFileSync(path.join(outDir, 'style.css'), css);
fs.writeFileSync(path.join(outDir, 'live.js'), live);
for (const [f] of shots) {
  const src = path.join(runDir, f), st = fs.lstatSync(src);
  must(st.isFile() && !st.isSymbolicLink() && st.size < 1_000_000, `${f}: regular file < 1 MB`);
  const buf = fs.readFileSync(src); must(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${f}: PNG by content`);
  fs.writeFileSync(path.join(outDir, 'shots', f), buf);
}
console.log(`wrote ${outDir}/index.html (${html.length} bytes), style.css, live.js, ${shots.length} shots`);
