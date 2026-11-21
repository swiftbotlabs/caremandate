// Deploy CareMandate (if CM_CONTRACT is unset) and create Mina's mandate. Usage:
//   node setup.mjs <confirmerAddress (Mum's tablet key)> [perVisitCapWon=45000] [weeklyMax=3]
// env: CM_NET, DEPLOYER_PK (deploy only), FAMILY_PK (creates the mandate), FAMILY_AGENT_ADDR, AGENCY_ADDR
import fs from 'node:fs';
import { connect, send, ABI } from './lib/chain.mjs';
const [confirmer, cap = '45000', weekly = '3'] = process.argv.slice(2);
const ctx = connect();
let address = process.env.CM_CONTRACT;
if (!address) {
  const art = JSON.parse(fs.readFileSync(new URL('../out/CareMandate.sol/CareMandate.json', import.meta.url), 'utf8'));
  const d = ctx.wallet(process.env.DEPLOYER_PK);
  const hash = await d.client.deployContract({ abi: ABI, bytecode: art.bytecode.object });
  const rc = await ctx.pub.waitForTransactionReceipt({ hash });
  address = rc.contractAddress; console.error('deployed', address, 'tx', hash, 'gas', rc.gasUsed.toString());
}
const fam = ctx.wallet(process.env.FAMILY_PK);
const r = await send(ctx, fam, address, 'createMandate', [process.env.FAMILY_AGENT_ADDR, process.env.AGENCY_ADDR, confirmer, BigInt(cap), Number(weekly)]);
const ev = r.events.find((e) => e.eventName === 'MandateCreated');
console.log(JSON.stringify({ contract: address, mandateId: Number(ev.args.mandateId), tx: r.hash }));
