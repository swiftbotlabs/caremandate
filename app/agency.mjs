// The care agency's agent: posts one visit receipt to CareMandate. Usage:
//   node agency.mjs <mandateId> <visitUnixTime> <amountWon> "<carer>" "<tasks>"      (env: CM_NET, CM_CONTRACT, AGENCY_PK, CM_STATE)
import fs from 'node:fs';
import path from 'node:path';
import { connect, send, receiptHash } from './lib/chain.mjs';
const [mid, t, amt, carer, tasks] = process.argv.slice(2);
const ctx = connect(), w = ctx.wallet(process.env.AGENCY_PK);
const receipt = { mandateId: Number(mid), visitTime: Number(t), amountWon: Number(amt), carer, tasks, agency: w.account.address };
const h = receiptHash(receipt);
const STATE = process.env.CM_STATE || path.join(path.dirname(new URL(import.meta.url).pathname), 'state.json');
let st; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { st = { messages: [], receipts: {}, payments: {} }; }
st.receipts[h] = receipt; fs.writeFileSync(STATE, JSON.stringify(st, null, 1));   // the receipt text Mum reads; its hash is on chain
const r = await send(ctx, w, process.env.CM_CONTRACT, 'postVisit', [BigInt(mid), BigInt(t), BigInt(amt), h]);
const ev = r.events.find((e) => e.eventName === 'VisitPosted');
console.log(JSON.stringify({ visitId: Number(ev.args.visitId), tx: r.hash, receiptHash: h }));
