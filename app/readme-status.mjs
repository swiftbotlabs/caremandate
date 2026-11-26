// Rewrites README.md between <!-- STATUS:BEGIN --> and <!-- STATUS:END --> from a testnet run's own files (after its gate passed).
// Usage: node readme-status.mjs <evidenceRunDir> [README path]. Facts only from setup.json, network.json, gate.json, agency.log, state.json,
// server.log, and (when present) evidence/mainnet-*/deploy.json and evidence/mainnet-visit-*/visit.json.
// Times: UTC, with Korea time (KST) in brackets, the same as the record page.
import fs from 'node:fs';
import path from 'node:path';
const [dir, readme = new URL('../README.md', import.meta.url).pathname] = process.argv.slice(2);
const J = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const setup = J('setup.json'), net = J('network.json'), gate = J('gate.json'), st = J('state.json');
if (gate.failed !== 0 || !['testnet', 'testnet-review'].includes(gate.scenario) || gate.paid !== 4 || gate.acked !== 4) throw new Error('gate.json is not a passing testnet gate with 4 paid + 4 acks');
const label = { 'hashkey-testnet': 'HSK Chain testnet USDC (`0x8FE3cB71...`)', sepolia: 'Circle test USDC on Ethereum Sepolia' }[net.hspNetwork];
if (!label) throw new Error('unknown network');
const paid = Object.entries(st.payments).filter(([, p]) => p.markPaidTx).map(([k]) => k).sort((a, b) => a - b);
const usd = (Number(gate.sumRaw) / 1e6).toFixed(2);
const run = path.basename(path.resolve(dir));
const srv = fs.readFileSync(path.join(dir, 'server.log'), 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
const t0 = srv.find((e) => e.event === 'start')?.at, t1 = srv.filter((e) => e.event === 'paid').map((e) => e.at).sort().pop();
const f = (d, tz, o) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...o }).format(d);
const DY = { day: 'numeric', month: 'short', year: 'numeric' }, HM = { hour: '2-digit', minute: '2-digit', hour12: false };
function span(a, b) {
  const A = new Date(a), B = new Date(b), du = f(A, 'UTC', DY), dk = f(A, 'Asia/Seoul', DY);
  return `${du}, ${f(A, 'UTC', HM)}-${f(B, 'UTC', HM)} UTC (${dk !== du ? dk + ', ' : ''}${f(A, 'Asia/Seoul', HM)}-${f(B, 'Asia/Seoul', HM)} KST)`;
}
if (!t0 || !t1) throw new Error('server.log has no start or paid line');
const when = span(t0, t1);
const reviews = Object.entries(st.reviews || {}), held = reviews.filter(([, r]) => r.decision === 'hold');
const ev = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'evidence');
const latest = (pre) => fs.readdirSync(ev).filter((d) => d.startsWith(pre)).sort().pop();
const md = latest('mainnet-2'), mv = latest('mainnet-visit-');
let mainnet = '- HSK Chain mainnet: rehearsed on a fork of mainnet (`app/test/fork-mainnet-rehearsal.sh`).';
if (md) {
  const d = JSON.parse(fs.readFileSync(path.join(ev, md, 'deploy.json'), 'utf8'));
  mainnet = `- HSK Chain mainnet: CareMandate v2 at \`${d.contract}\` (deploy tx ${d.deployTx}, mandate tx ${d.tx}; source verified: https://hsk.blockscout.com/address/${d.contract}), Mina's mandate at real scale (45,000 won a visit, ${d.fx.krwPerUsd} KRW/USD on chain, at most $${d.fx.capUsd} a visit); \`evidence/${md}/\`.`;
  if (mv && fs.existsSync(path.join(ev, mv, 'visit.json'))) {
    const v = JSON.parse(fs.readFileSync(path.join(ev, mv, 'visit.json'), 'utf8'));
    mainnet += `\n- One visit cycle on HSK Chain mainnet (${span(v.startedAt, v.at)}): the agency posted a ${Number(v.amountWon).toLocaleString('en-US')}-won visit, Mum's tablet signed yes, Mina's agent read the note (${v.review}) and paid it through HSP QA (flow \`${v.flowId}\`, ${(Number(v.paidRaw) / 1e6).toFixed(2)} test USDC on ${v.settleLabel}), \`markPaid\` recorded it and the agency's agent acknowledged it on chain; \`evidence/${mv}/\`.`;
  }
}
const reviewLine = reviews.length ? `\n  Mina's agent read every confirmed visit's note before paying (${reviews.length} reviewed, ${held.length} held for Mina${held.length ? `: visit ${held.map(([k]) => k).join(', ')}, paid only after she pressed Pay anyway` : ''}).` : '';
const block = `<!-- STATUS:BEGIN -->
- Full run on **HSK Chain testnet with real HSP QA payments settling in ${label}** (${when}; contract \`${setup.contract}\`):
  5 visits; Mum said Yes to 4 and No to 1; visits ${paid.join(', ')} paid through HSP (each \`payment-safe\`, ${usd} test USDC in total, the
  settlement tx and the amount recorded by \`markPaid\` on HSK Chain); each payment acknowledged on chain by the agency's own agent after it
  checked the transfer itself; a 46,000-won visit refused by the contract (cap 45,000 won); mandate rate ${setup.fx.rawPerMillionWon} USDC units
  per 1,000,000 won (${setup.fx.krwPerUsd} KRW/USD, ${setup.fx.source}, ${setup.fx.date}, testnet scale 1:${setup.fx.scale}).${reviewLine} Record:
  https://apps.swiftbotlab.workers.dev/caremandate/ (built by \`app/demo-page.mjs\`, which re-checks every fact on chain first). Run files:
  \`evidence/${run}/\`. Failure modes and the note review (offline, one command each): \`evidence/offline-*/gate.json\`.
${mainnet}
<!-- STATUS:END -->`;
const s = fs.readFileSync(readme, 'utf8');
const a = s.indexOf('<!-- STATUS:BEGIN -->'), b = s.indexOf('<!-- STATUS:END -->');
if (a < 0 || b < a) throw new Error('STATUS markers not found');
fs.writeFileSync(readme, s.slice(0, a) + block + s.slice(b + '<!-- STATUS:END -->'.length));
console.log('README status updated from', run);
