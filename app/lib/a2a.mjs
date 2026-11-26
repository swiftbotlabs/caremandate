// Agent to agent: rescheduling a missed visit.
// When Mum says a visit did not happen (Rejected on chain), the agency's agent proposes a make-up slot to Mina's agent. Mina's agent
// accepts or declines under Mina's rules: the weekly limit on chain (weeklyMax), her hours (09:00 to 18:00 Korea time by default),
// a make-up within 7 days of the missed visit, 60 to 180 minutes, never dearer than the missed visit, one make-up per missed visit.
// Both messages are EIP-712 typed data signed by each agent's own key: the proposal by the mandate's agency address, the decision by
// the mandate's familyAgent address (both read from the contract, so anyone can check who signed). Every decision is put on HSK Chain
// at the moment it is made: a 0-value transaction from Mina's agent to itself whose input is ANCHOR_TAG + decision digest + proposal
// digest. The make-up visit's receipt carries the signed proposal and decision; its hash goes on chain with postVisit, and Mina's agent
// pays a visit that claims to be a make-up only when it matches an agreement it signed (slot, price, missed visit, used once).
// The CareMandate contract is unchanged: the deployed contracts (testnet and mainnet) keep working, and the agreement lives in the
// receipt hash and the anchor transaction.
import { hashTypedData, recoverTypedDataAddress, toHex, concat, size } from 'viem';

export const A2A_TYPES = {
  MakeupProposal: [
    { name: 'mandateId', type: 'uint64' }, { name: 'missedVisitId', type: 'uint256' },
    { name: 'slotStart', type: 'uint64' }, { name: 'slotEnd', type: 'uint64' },
    { name: 'amount', type: 'uint96' }, { name: 'carer', type: 'string' },
    { name: 'nonce', type: 'uint64' }, { name: 'expires', type: 'uint64' },
  ],
  MakeupDecision: [
    { name: 'proposal', type: 'bytes32' }, { name: 'accept', type: 'bool' },
    { name: 'reasons', type: 'string' }, { name: 'decidedAt', type: 'uint64' },
  ],
};
export const ANCHOR_TAG = toHex('CMA2A1');   // 6 bytes; then 32 bytes decision digest, 32 bytes proposal digest
export const WEEK = 604800;
export const DEFAULT_MAKEUP_RULES = Object.freeze({
  startHour: 9, endHour: 18,   // Korea time: the make-up starts and ends inside these hours, on one day
  maxDaysAfter: 7,             // starts within 7 days of the missed visit
  minMinutes: 60, maxMinutes: 180,
  maxExpirySec: 86400,         // a proposal is answered within a day, or it lapses
  maxProposals: 3,             // per missed visit; more are refused without a signature
  tz: 'Asia/Seoul',
});

export const domain = (chainId, contract) => ({ name: 'CareMandate A2A', version: '1', chainId: Number(chainId), verifyingContract: contract });
const U64 = 2n ** 64n, U96 = 2n ** 96n;
const CARER = /^[\p{L}\p{M} .'-]{1,40}$/u, SIG = /^0x[0-9a-fA-F]{130}$/, H32 = /^0x[0-9a-fA-F]{64}$/;
const big = (v, max, k) => { const s = String(v); if (!/^\d{1,30}$/.test(s)) throw new Error(`${k}: not an unsigned integer`); const b = BigInt(s); if (b >= max) throw new Error(`${k}: too large`); return b; };

/** Parse an untrusted proposal (JSON numbers or decimal strings) into the typed-data message. Throws on any bad field. */
export function parseProposal(p) {
  if (!p || typeof p !== 'object') throw new Error('proposal: not an object');
  const keys = Object.keys(p).sort().join(',');
  if (keys !== 'amount,carer,expires,mandateId,missedVisitId,nonce,slotEnd,slotStart') throw new Error('proposal: unexpected fields');
  if (typeof p.carer !== 'string' || !CARER.test(p.carer)) throw new Error('proposal: carer');
  return { mandateId: big(p.mandateId, U64, 'mandateId'), missedVisitId: big(p.missedVisitId, U64, 'missedVisitId'), slotStart: big(p.slotStart, U64, 'slotStart'),
    slotEnd: big(p.slotEnd, U64, 'slotEnd'), amount: big(p.amount, U96, 'amount'), carer: p.carer, nonce: big(p.nonce, U64, 'nonce'), expires: big(p.expires, U64, 'expires') };
}
export const plain = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v]));

export const proposalDigest = (dom, msg) => hashTypedData({ domain: dom, types: A2A_TYPES, primaryType: 'MakeupProposal', message: msg });
export const decisionDigest = (dom, msg) => hashTypedData({ domain: dom, types: A2A_TYPES, primaryType: 'MakeupDecision', message: msg });
export const signProposal = (account, dom, msg) => account.signTypedData({ domain: dom, types: A2A_TYPES, primaryType: 'MakeupProposal', message: msg });
export const signDecision = (account, dom, msg) => account.signTypedData({ domain: dom, types: A2A_TYPES, primaryType: 'MakeupDecision', message: msg });
export async function proposalSigner(dom, msg, sig) {
  if (!SIG.test(String(sig))) throw new Error('signature shape');
  return recoverTypedDataAddress({ domain: dom, types: A2A_TYPES, primaryType: 'MakeupProposal', message: msg, signature: sig });
}
export async function decisionSigner(dom, msg, sig) {
  if (!SIG.test(String(sig))) throw new Error('signature shape');
  return recoverTypedDataAddress({ domain: dom, types: A2A_TYPES, primaryType: 'MakeupDecision', message: msg, signature: sig });
}
export const parseDecision = (d) => {
  if (!d || typeof d !== 'object' || !H32.test(String(d.proposal)) || typeof d.accept !== 'boolean' || typeof d.reasons !== 'string' || d.reasons.length > 200) throw new Error('decision: bad fields');
  return { proposal: d.proposal, accept: d.accept, reasons: d.reasons, decidedAt: big(d.decidedAt, U64, 'decidedAt') };
};
export function anchorData(decisionHash, proposalHash) {
  if (!H32.test(decisionHash) || !H32.test(proposalHash)) throw new Error('anchor: digests');
  return concat([ANCHOR_TAG, decisionHash, proposalHash]);
}
/** Read an anchor tx input back: { decision, proposal } or null when it is not an anchor. */
export function readAnchor(input) {
  const s = String(input || '').toLowerCase();
  if (!s.startsWith(ANCHOR_TAG.toLowerCase()) || size(s) !== 6 + 64) return null;
  return { decision: '0x' + s.slice(14, 78), proposal: '0x' + s.slice(78, 142) };
}

const parts = (t, tz) => { const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(t * 1000));
  const g = (k) => Number(f.find((x) => x.type === k).value); return { day: `${g('year')}-${g('month')}-${g('day')}`, min: (g('hour') % 24) * 60 + g('minute') }; };
export const weekOf = (t) => Math.floor(Number(t) / WEEK);
const hh = (h) => `${String(h).padStart(2, '0')}:00`;
export const kst = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(Number(t) * 1000));

/**
 * Mina's agent decides on one proposal. Pure: no network. Inputs come from the chain (missed visit, mandate, week loads, now = latest
 * block time) and the agent's own records (agreements it already signed). Returns { accept, reasons: [{code, text}], hints }.
 * rulesOff = true is the planted-control switch for tests only: it skips Mina's rules (never the signature or the missed-visit check).
 */
export function decideMakeup({ p, missed, mandate, weekLoad, agreed = [], now, rules = DEFAULT_MAKEUP_RULES, rulesOff = false }) {
  const out = [], add = (code, text) => out.push({ code, text }), hints = {};
  const s = Number(p.slotStart), e = Number(p.slotEnd), N = Number(now);
  if (Number(p.mandateId) !== Number(mandate.id)) add('wrong_mandate', 'The proposal is for another mandate.');
  if (!missed || missed.status !== 'Rejected' || Number(missed.mandateId) !== Number(mandate.id)) add('not_missed', `Visit ${p.missedVisitId} is not a missed visit on chain${missed ? ` (it is ${missed.status})` : ''}.`);
  if (agreed.some((a) => a.missedVisitId === Number(p.missedVisitId))) add('already_agreed', `A make-up for visit ${p.missedVisitId} is already agreed.`);
  if (Number(p.expires) <= N) add('expired', 'The proposal has expired.');
  else if (Number(p.expires) - N > rules.maxExpirySec) add('expiry_too_long', 'The proposal must be answered within a day.');
  if (out.length && out.some((x) => ['wrong_mandate', 'not_missed', 'already_agreed'].includes(x.code))) return { accept: false, reasons: out, hints };
  if (rulesOff) return { accept: out.length === 0, reasons: out, hints, rulesOff: true };
  if (!(e > s)) add('bad_slot', 'The slot ends before it starts.');
  if (s <= N) add('slot_past', 'The slot has already started.');
  if (missed && s <= missed.visitTime) add('slot_past', 'The slot is before the missed visit.');
  if (missed && s > missed.visitTime + rules.maxDaysAfter * 86400) { add('too_late', `A make-up must start within ${rules.maxDaysAfter} days of the missed visit.`); hints.notAfter = missed.visitTime + rules.maxDaysAfter * 86400; }
  const mins = (e - s) / 60;
  if (mins < rules.minMinutes || mins > rules.maxMinutes) add('bad_length', `A make-up lasts ${rules.minMinutes} to ${rules.maxMinutes} minutes (this one: ${Math.round(mins)}).`);
  const a = parts(s, rules.tz), b = parts(e, rules.tz);
  if (a.day !== b.day || a.min < rules.startHour * 60 || b.min > rules.endHour * 60) { add('outside_hours', `Mina's hours for visits are ${hh(rules.startHour)} to ${hh(rules.endHour)} Korea time; the slot is ${kst(s)} to ${kst(e).slice(-5)}.`); hints.hours = [rules.startHour, rules.endHour]; }
  if (missed && BigInt(p.amount) > BigInt(missed.amount)) add('over_price', `A make-up may not cost more than the missed visit (${missed.amount} won).`);
  if (BigInt(p.amount) > BigInt(mandate.perVisitCap)) add('over_cap', `Over Mina's per-visit cap (${mandate.perVisitCap} won).`);
  if (BigInt(p.amount) === 0n) add('bad_price', 'The price is zero.');
  const w = weekOf(s), load = (weekLoad(w) || 0) + agreed.filter((x) => weekOf(x.slotStart) === w).length;
  if (load >= mandate.weeklyMax) { add('week_full', `That week already has ${load} visits booked; Mina's limit is ${mandate.weeklyMax} a week.`); hints.notBefore = (w + 1) * WEEK; }
  return { accept: out.length === 0, reasons: out, hints };
}

/** The agency's slot picker: the first slot of `minutes` that starts at or after `from`, inside [startHour, endHour) Korea time. */
export function nextSlot(from, { startHour = DEFAULT_MAKEUP_RULES.startHour, endHour = DEFAULT_MAKEUP_RULES.endHour, minutes = 90 } = {}) {
  const KST = 9 * 3600;
  let t = Math.ceil(Number(from) / 1800) * 1800;   // half-hour grid
  for (let i = 0; i < 48 * 14; i++, t += 1800) {
    const local = (t + KST) % 86400, startOk = local >= startHour * 3600, endOk = local + minutes * 60 <= endHour * 3600;
    if (startOk && endOk) return { slotStart: t, slotEnd: t + minutes * 60 };
  }
  throw new Error('no slot in two weeks');
}

/**
 * Check a visit that claims to be a make-up (receipt.makeup) against the agreements Mina's agent signed. Pure. Returns { hold: [...] }
 * (empty = it is the agreed make-up) and the agreement's decision digest.
 */
export function checkMakeupClaim({ receipt, visitId, visitTime, amount, mandateId, dom, agreements, used }) {
  const hold = [], mk = receipt && receipt.makeup;
  if (!mk) return { hold, claim: false };
  let p, d, ph, dh;
  try { p = parseProposal(mk.proposal); d = parseDecision(mk.decision); ph = proposalDigest(dom, p); dh = decisionDigest(dom, d); }
  catch (e) { return { claim: true, hold: [{ code: 'makeup_malformed', text: 'The visit says it is a make-up, but its agreement cannot be read.' }] }; }
  const mine = agreements.find((a) => a.decisionHash === dh && a.accept);
  if (!mine || d.proposal !== ph || !d.accept) hold.push({ code: 'makeup_unknown', text: 'The visit says it is a make-up, but I never agreed to it.' });
  if (Number(p.mandateId) !== Number(mandateId)) hold.push({ code: 'makeup_unknown', text: 'The make-up agreement is for another mandate.' });
  if (visitTime < Number(p.slotStart) || visitTime > Number(p.slotEnd)) hold.push({ code: 'makeup_outside_slot', text: `The make-up was agreed for ${kst(p.slotStart)} to ${kst(p.slotEnd).slice(-5)} Korea time; this visit is at ${kst(visitTime)}.` });
  if (BigInt(amount) > p.amount) hold.push({ code: 'makeup_over_price', text: `The make-up was agreed at ${p.amount} won; this visit asks ${amount}.` });
  const u = used[dh]; if (u !== undefined && Number(u) !== Number(visitId)) hold.push({ code: 'makeup_reused', text: `This make-up agreement was already used by visit ${u}.` });
  return { claim: true, hold, decisionHash: dh, proposalHash: ph, missedVisitId: Number(p.missedVisitId) };
}
