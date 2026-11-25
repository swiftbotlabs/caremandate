// Builds the public, read-only record page of one testnet run (demo/index.html + live.js + style.css + shots).
// Every value on the page comes from the run's own files AND is re-checked on chain first (HSK Chain testnet reads,
// Ethereum Sepolia receipts). Any mismatch -> exit 1 and no page. The page holds no keys and cannot pay: it is static
// HTML; the optional live.js only makes eth_call reads of visits(id).
// Usage: node demo-page.mjs <runDir> <outDir>     (env DEMO_TAMPER=1 flips one flow id: the gate must then fail)
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, http, keccak256, toBytes, toFunctionSelector, parseAbiItem, decodeEventLog } from 'viem';
import { connect, visit, mandate, CHAINS } from './lib/chain.mjs';

const [runDir, outDir] = process.argv.slice(2);
if (!runDir || !outDir) { console.error('usage: node demo-page.mjs <runDir> <outDir>'); process.exit(2); }
const R = (f) => fs.readFileSync(path.join(runDir, f), 'utf8');
const MAX = 2_000_000;
for (const f of ['payments.txt', 'server.log', 'agency.log', 'setup.json', 'state.json']) {
  if (fs.statSync(path.join(runDir, f)).size > MAX) throw new Error(`${f} too large`);
}
const HEX32 = /^0x[0-9a-f]{64}$/i, ADDR = /^0x[0-9a-f]{40}$/i, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const must = (ok, msg) => { if (!ok) { console.error('GATE FAIL: ' + msg); process.exit(1); } };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jl = (txt) => txt.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

// ---- the run's own records
const setup = JSON.parse(R('setup.json'));
const state = JSON.parse(R('state.json'));
const server = jl(R('server.log'));
const agency = jl(R('agency.log'));
const start = server.find((e) => e.event === 'start');
must(start && start.net === 'testnet' && start.hspMode === 'qa', 'server.log start line: testnet + qa');
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
  visits.push({ id, post: a.tx, receiptHash: a.receiptHash, rc, conf, appr, paid, p, ps });
}
must(visits.length >= 1, '0 visits in agency.log');
if (process.env.DEMO_TAMPER === '1') { const v = visits.find((x) => x.p); const f = '00000000-0000-4000-8000-000000000000'; v.p = { ...v.p, flowId: f }; v.paid = { ...v.paid, flowId: f }; }

// ---- re-check everything on chain
const hsk = connect('testnet');
const sep = createPublicClient({ transport: http('https://ethereum-sepolia-rpc.publicnode.com', { timeout: 30_000, retryCount: 4, retryDelay: 1_500 }) });
const SEPOLIA_USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
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
    v.usdc = await usdcTransfer(v.p.txHash, `visit ${v.id} Sepolia`);
  } else {
    must(on.status === 'Rejected' && !v.p, `visit ${v.id}: Rejected on chain and never paid`);
    must(/^0x0{64}$/.test(on.paymentRef), `visit ${v.id}: no payment reference`);
    checks++;
  }
}
if (PROBE) { must(UUID.test(PROBE.flowId), 'probe flow id'); PROBE.usdc = await usdcTransfer(PROBE.txHash, 'standalone probe'); }
must(checks >= visits.length * 3, `too few checks (${checks})`);
console.log(`chain checks passed: ${checks} (visits ${visits.length}, paid ${visits.filter((v) => v.p).length})`);

// ---- render
const EX = CHAINS.testnet.explorer, SEP = 'https://sepolia.etherscan.io';
const hx = (h, n = 8) => `${h.slice(0, n)}…${h.slice(-6)}`;
const txl = (h, base = EX) => `<a href="${base}/tx/${esc(h)}" rel="noopener">${esc(hx(h))}</a>`;
const fmt = (d, opt) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', ...opt }).format(d);
const kst = (iso) => fmt(new Date(iso), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const day = (sec) => fmt(new Date(sec * 1000), { weekday: 'long', day: 'numeric', month: 'short' });
const hm = (sec) => fmt(new Date(sec * 1000), { hour: '2-digit', minute: '2-digit', hour12: false });
const usd = (v) => `$${(Number(v) / 1e6).toFixed(2)}`;
const won = (n) => `${Number(n).toLocaleString('en-US')} won`;
const secs = (a, b) => Math.round((new Date(b) - new Date(a)) / 1000);
const paidN = visits.filter((v) => v.p).length, noN = visits.filter((v) => !v.conf.happened).length, heldN = visits.filter((v) => v.appr).length;
const runStart = start.at, runEnd = server.filter((e) => e.event === 'paid').map((e) => e.at).sort().pop();
const sel = toFunctionSelector('visits(uint256)');

const card = (v) => {
  const yes = v.conf.happened;
  const pill = yes ? '<span class="pill Paid">paid</span>' : '<span class="pill Rejected">not paid</span>';
  const rows = [
    ['Agency agent posts the visit', `${txl(v.post)}<span class="h">receipt ${esc(hx(v.receiptHash, 10))}</span>`],
    ['Mum answers on her tablet', `<b class="${yes ? 'ok' : 'no'}">${yes ? 'Yes' : 'No'}</b> · ${txl(v.conf.tx)}<span class="h">${kst(v.conf.at)} KST, signed by the tablet, relayed by Mina's agent</span>`],
  ];
  if (v.appr) rows.push(['4th visit this week: held', `Mina approved · ${txl(v.appr.tx)}<span class="h">${kst(v.appr.at)} KST</span>`]);
  if (yes) {
    rows.push(['HSP Agentic Payment', `<b class="ok">payment-safe</b>, ${secs(v.ps.at, v.p.settledAt)} s after the order was created<span class="h">flow <code>${esc(v.p.flowId)}</code></span><span class="h">request <code>${esc(v.p.paymentRequestId)}</code></span>`]);
    rows.push(['Money moved (Ethereum Sepolia)', `${usd(v.usdc)} test USDC · ${txl(v.p.txHash, SEP)}`]);
    rows.push(['Paid, recorded on HSK Chain', `markPaid · ${txl(v.p.markPaidTx)}<span class="h">paymentRef = keccak256(flow id) = <code>${esc(hx(v.on.paymentRef, 10))}</code></span>`]);
  } else {
    rows.push(['Payment', '<b class="no">none</b><span class="h">The contract marks the visit Rejected; it can never be paid.</span>']);
  }
  return `<article class="card visit" id="visit-${v.id}" data-visit="${v.id}" data-status="${esc(v.on.status)}" data-ref="${esc(v.on.paymentRef.toLowerCase())}">
<div class="vh"><div><h3>Visit ${v.id}</h3><p class="small">${esc(day(v.rc.visitTime))}, ${esc(hm(v.rc.visitTime))} KST · ${esc(v.rc.carer)} · ${esc(won(v.rc.amountWon))}</p></div>${pill}</div>
<dl>${rows.map(([k, val]) => `<div><dt>${k}</dt><dd>${val}</dd></div>`).join('')}</dl>
<p class="live small" aria-live="polite"></p></article>`;
};

const shots = [
  ['mum-question.png', "Mum's tablet: one question, Yes or No"],
  ['mum-paying.png', 'After Yes: paying Ji-woo via HSP, about 3 minutes'],
  ['mum-done.png', "Mum's tablet when the payments are safe"],
  ['mina-held.png', "Mina's page: 4th visit waits for her Approve"],
  ['mina-after.png', "Mina's page at the end: 4 paid, 1 not paid"],
];
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

<section class="card note"><p><b>This page is the record of one real run.</b> ${esc(fmt(new Date(runStart), { day: 'numeric', month: 'short', year: 'numeric' }))}, ${kst(runStart)} to ${kst(runEnd)} KST, on <b>HSK Chain testnet</b> with <b>real HSP QA payments</b> (HSP's QA environment settles in Circle test USDC on Ethereum Sepolia). It is read-only: it holds no keys and cannot pay anyone.</p></section>

<section class="card"><h2>The run in 71 seconds</h2><video controls preload="none" playsinline width="1920" height="1080" poster="poster.jpg" src="caremandate-demo.mp4"></video><p class="small">Captions only, no sound. <a href="caremandate-demo.mp4">Open the video file</a>.</p></section>

<section class="card stat" aria-label="Run summary"><div><b>${visits.length}</b>visits</div><div><b>${paidN}</b>paid via HSP</div><div><b>${noN}</b>not paid</div><div><b>${heldN}</b>held for Mina</div></section>

<section class="card"><h2>Mina's rules, on chain</h2>
<dl><div><dt>Contract (HSK Chain testnet)</dt><dd><a href="${EX}/address/${CONTRACT}" rel="noopener"><code>${CONTRACT}</code></a></dd></div>
${DEPLOY_TX ? `<div><dt>Deployed</dt><dd>${txl(DEPLOY_TX)}</dd></div>` : ''}
<div><dt>Mandate ${setup.mandateId}</dt><dd>${txl(setup.tx)}<span class="h">at most ${m.weeklyMax} visits a week, at most ${esc(won(m.perVisitCap))} a visit; only the agency <code>${esc(hx(m.agency, 6))}</code> can be paid; only Mum's tablet key <code>${esc(hx(m.confirmer, 6))}</code> can confirm</span></dd></div></dl>
<p class="small">The contract holds no money: HSP moves it. The contract decides what may be paid, and records each HSP payment against its visit.</p></section>

<h2 class="sec">Every visit</h2>
${visits.map(card).join('\n')}

<section class="card"><h2>What you see on the phones</h2><p class="small">Screenshots taken by the end-to-end test during this run (390 px wide, the size of a phone).</p>
<div class="shots">${shots.map(([f, c]) => `<figure><img src="shots/${f}" alt="${esc(c)}" loading="lazy" width="390"><figcaption>${esc(c)}</figcaption></figure>`).join('')}</div></section>

${PROBE ? `<section class="card"><h2>First real HSP payment</h2><p>Before the full run, one standalone HSP QA payment: flow <code>${esc(PROBE.flowId)}</code>, request <code>${esc(PROBE.prId)}</code>, ${usd(PROBE.usdc)} test USDC, <b class="ok">payment-safe</b> · ${txl(PROBE.txHash, SEP)}</p></section>` : ''}

<section class="card"><h2>Check it yourself</h2>
<p class="small">Every link above opens a public explorer. This button reads <code>visits(id)</code> from the contract right now (HSK Chain testnet RPC, read-only) and compares each status and payment reference with this page.</p>
<button id="check" class="go" type="button" data-rpc="${CHAINS.testnet.rpc}" data-contract="${CONTRACT}" data-sel="${sel}" hidden>Check on HSK Chain now</button>
<noscript><p class="small">The check needs JavaScript; the explorer links work without it.</p></noscript>
<p id="checkout" class="small" aria-live="polite"></p></section>

<footer class="small"><p>Code: <a href="https://github.com/swiftbotlabs/caremandate" rel="noopener">github.com/swiftbotlabs/caremandate</a> · Built by Swift Bot Labs for HSK Chain Horizon · Seoul. Times are Korea time (KST). HSK Chain mainnet deployment follows the results: the organiser covers winning teams' mainnet gas.</p>
<p>All ${checks} on-chain facts on this page were re-checked against HSK Chain testnet and Ethereum Sepolia when it was built.</p></footer>
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
`;

// live.js: read-only eth_call of visits(id). Strict input checks; no other network target; nothing signed or sent.
const live = `'use strict';
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
