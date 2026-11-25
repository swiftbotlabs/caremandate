// Rewrites README.md between <!-- STATUS:BEGIN --> and <!-- STATUS:END --> from a testnet run's own files (after its gate passed).
// Usage: node readme-status.mjs <evidenceRunDir> [README path]. Facts only from setup.json, network.json, gate.json, agency.log, state.json.
import fs from 'node:fs';
import path from 'node:path';
const [dir, readme = new URL('../README.md', import.meta.url).pathname] = process.argv.slice(2);
const J = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const setup = J('setup.json'), net = J('network.json'), gate = J('gate.json'), st = J('state.json');
if (gate.failed !== 0 || gate.scenario !== 'testnet' || gate.paid !== 4 || gate.acked !== 4) throw new Error('gate.json is not a passing testnet gate with 4 paid + 4 acks');
const label = { 'hashkey-testnet': 'HSK Chain testnet USDC (`0x8FE3cB71...`)', sepolia: 'Circle test USDC on Ethereum Sepolia' }[net.hspNetwork];
if (!label) throw new Error('unknown network');
const paid = Object.entries(st.payments).filter(([, p]) => p.markPaidTx).map(([k]) => k).sort((a, b) => a - b);
const usd = (Number(gate.sumRaw) / 1e6).toFixed(2);
const run = path.basename(path.resolve(dir));
const d = new Date(run.replace(/^testnet-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z?$/, '$1-$2-$3T$4:$5:00Z'));
const when = isNaN(d) ? run : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const block = `<!-- STATUS:BEGIN -->
- Full run on **HSK Chain testnet with real HSP QA payments settling in ${label}** (${when}, contract \`${setup.contract}\`):
  5 visits; Mum said Yes to 4 and No to 1; visits ${paid.join(', ')} paid through HSP (each \`payment-safe\`, ${usd} test USDC in total, the
  settlement tx and the amount recorded by \`markPaid\` on HSK Chain); each payment acknowledged on chain by the agency's own agent after it
  checked the transfer itself; a 46,000-won visit refused by the contract (cap 45,000 won); mandate rate ${setup.fx.rawPerMillionWon} USDC units
  per 1,000,000 won (${setup.fx.krwPerUsd} KRW/USD, ${setup.fx.source}, ${setup.fx.date}, testnet scale 1:${setup.fx.scale}). Record:
  https://apps.swiftbotlab.workers.dev/caremandate/ (built by \`app/demo-page.mjs\`, which re-checks every fact on chain first). Run files:
  \`evidence/${run}/\`. Failure modes (offline, one command each): \`evidence/offline-*/gate.json\`.
- HSK Chain mainnet: rehearsed on a fork of mainnet (\`app/test/fork-mainnet-rehearsal.sh\`, \`evidence/fork-mainnet-*/rehearsal.json\`); deployed when we are selected for the demo, as the rules require of demo teams.
<!-- STATUS:END -->`;
const s = fs.readFileSync(readme, 'utf8');
const a = s.indexOf('<!-- STATUS:BEGIN -->'), b = s.indexOf('<!-- STATUS:END -->');
if (a < 0 || b < a) throw new Error('STATUS markers not found');
fs.writeFileSync(readme, s.slice(0, a) + block + s.slice(b + '<!-- STATUS:END -->'.length));
console.log('README status updated from', run);
