// The care agency's agent: posts one visit receipt to CareMandate. Usage:
//   node agency.mjs <mandateId> <visitUnixTime> <amountWon> "<carer>" "<tasks>" ["<visit note>"]   (env: CM_NET, CM_CONTRACT, AGENCY_PK, CM_STATE)
// The visit note (what the carer wrote: times, what was done) is part of the receipt, so its hash on chain binds it: Mina's agent
// reads it before paying and holds anything odd (lib/review.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { connect, send, receiptHash } from './lib/chain.mjs';
const [mid, t, amt, carer, tasks, note] = process.argv.slice(2);
if (note !== undefined && note.length > 2000) { console.error('visit note over 2000 characters'); process.exit(2); }
const ctx = connect(), w = ctx.wallet(process.env.AGENCY_PK);
// AGENCY_MAKEUP_FILE=<a2a line JSON>: this visit is the make-up agreed with Mina's agent; the signed proposal and decision go into the
// receipt, so the receipt hash on chain binds the agreement (lib/a2a.mjs). Only an accepted agreement for this mandate is used.
let makeup;
if (process.env.AGENCY_MAKEUP_FILE) {
  const f = process.env.AGENCY_MAKEUP_FILE; if (fs.statSync(f).size > 20000) { console.error('makeup file too large'); process.exit(2); }
  const a = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!a.accept || Number(a.proposal?.mandateId) !== Number(mid)) { console.error('makeup file: not an accepted agreement for this mandate'); process.exit(2); }
  makeup = { missedVisitId: Number(a.missedVisitId), proposal: a.proposal, proposalSig: a.proposalSig, decision: a.decision, decisionSig: a.decisionSig, anchorTx: a.anchorTx };
}
const receipt = { mandateId: Number(mid), visitTime: Number(t), amountWon: Number(amt), carer, tasks, agency: w.account.address, ...(note !== undefined ? { note } : {}), ...(makeup ? { makeup } : {}) };
const h = receiptHash(receipt);
const STATE = process.env.CM_STATE || path.join(path.dirname(new URL(import.meta.url).pathname), 'state.json');
let st; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { st = { messages: [], receipts: {}, payments: {} }; }
// The contract refuses a visit over Mina's per-visit cap (and bad times, replays, a paused mandate): print why and exit 4, nothing stored.
let r;
try { r = await send(ctx, w, process.env.CM_CONTRACT, 'postVisit', [BigInt(mid), BigInt(t), BigInt(amt), h]); }
catch (e) {
  const named = typeof e.walk === 'function' ? e.walk((x) => x?.data?.errorName)?.data?.errorName : null;   // the contract's custom error
  const why = named || String(e.shortMessage || e.message).match(/BadInput|BadState|NotAllowed/)?.[0] || String(e.shortMessage || e.message).slice(0, 160);
  console.log(JSON.stringify({ refused: true, amountWon: Number(amt), reason: why, receiptHash: h })); process.exit(4);
}
try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { /* keep */ }   // re-read: the server may have written meanwhile
st.receipts[h] = receipt; fs.writeFileSync(STATE, JSON.stringify(st, null, 1));   // the receipt text Mum reads; its hash is on chain
const ev = r.events.find((e) => e.eventName === 'VisitPosted');
console.log(JSON.stringify({ visitId: Number(ev.args.visitId), tx: r.hash, receiptHash: h }));
