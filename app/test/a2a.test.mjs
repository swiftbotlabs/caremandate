// Agent to agent make-up negotiation (lib/a2a.mjs): signatures, Mina's rules, the planted controls, the make-up claim check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { domain, parseProposal, plain, proposalDigest, decisionDigest, signProposal, signDecision, proposalSigner, decisionSigner,
  decideMakeup, nextSlot, checkMakeupClaim, anchorData, readAnchor, WEEK, DEFAULT_MAKEUP_RULES } from '../lib/a2a.mjs';

// anvil's public test keys (local only)
const agency = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const famAgent = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const stranger = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
const dom = domain(133, '0x5FbDB2315678afecb367f032d93F642f64180aa3');
const KST = 9 * 3600;
// a fixed clock: the missed visit Tue 24 Nov 2026 11:00 KST; "now" an hour later
const missedAt = Date.UTC(2026, 10, 24, 2, 0) / 1000, now = missedAt + 3600;
const at = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000 - KST;   // a Korea-time wall clock -> unix
const missed = { id: 2, mandateId: 1, status: 'Rejected', visitTime: missedAt, amount: 45000n };
const mandate = { id: 1, weeklyMax: 3, perVisitCap: 45000n };
const prop = (o = {}) => parseProposal({ mandateId: 1, missedVisitId: 2, slotStart: at(2026, 11, 25, 10), slotEnd: at(2026, 11, 25, 11, 30), amount: 45000, carer: 'Ji-woo', nonce: 1, expires: now + 3600, ...o });
const lightWeek = () => 1;

test('proposal and decision: signed by each agent, recovered from the typed data', async () => {
  const p = prop(), sig = await signProposal(agency, dom, p);
  assert.equal((await proposalSigner(dom, p, sig)).toLowerCase(), agency.address.toLowerCase());
  const forged = await signProposal(stranger, dom, p);
  assert.notEqual((await proposalSigner(dom, p, forged)).toLowerCase(), agency.address.toLowerCase());
  // a signed proposal cannot be edited: change the slot and the signer is someone else
  assert.notEqual((await proposalSigner(dom, prop({ slotStart: at(2026, 11, 25, 9) }), sig)).toLowerCase(), agency.address.toLowerCase());
  const d = { proposal: proposalDigest(dom, p), accept: true, reasons: '', decidedAt: BigInt(now) };
  const ds = await signDecision(famAgent, dom, d);
  assert.equal((await decisionSigner(dom, d, ds)).toLowerCase(), famAgent.address.toLowerCase());
  // another contract (domain) gives another digest: a decision cannot be replayed on another deployment
  assert.notEqual(decisionDigest(domain(177, '0x1173198761ac17f8e40f97973a1e4ed0419a11c3'), d), decisionDigest(dom, d));
});

test('a daytime slot within the week limit is accepted', () => {
  const r = decideMakeup({ p: prop(), missed, mandate, weekLoad: lightWeek, now });
  assert.deepEqual(r.reasons, []); assert.equal(r.accept, true);
});

test('PLANTED CONTROL: an evening slot (outside Mina\'s hours) is refused; with the rules off it would be accepted', () => {
  const evening = prop({ slotStart: at(2026, 11, 25, 19, 30), slotEnd: at(2026, 11, 25, 21) });
  const on = decideMakeup({ p: evening, missed, mandate, weekLoad: lightWeek, now });
  assert.equal(on.accept, false); assert.deepEqual(on.reasons.map((x) => x.code), ['outside_hours']); assert.deepEqual(on.hints.hours, [9, 18]);
  const off = decideMakeup({ p: evening, missed, mandate, weekLoad: lightWeek, now, rulesOff: true });
  assert.equal(off.accept, true, 'with the rules off the bad proposal passes: the guard is what refuses it');
});

test('PLANTED CONTROL: a slot in a full week is refused, with the next week as the hint', () => {
  const full = (w) => (w === Math.floor(at(2026, 11, 25, 10) / WEEK) ? 4 : 0);
  const r = decideMakeup({ p: prop(), missed, mandate, weekLoad: full, now });
  assert.equal(r.accept, false); assert.deepEqual(r.reasons.map((x) => x.code), ['week_full']);
  assert.equal(r.hints.notBefore % WEEK, 0); assert.ok(r.hints.notBefore > at(2026, 11, 25, 10));
  // an agreement already made in that week counts too
  const r2 = decideMakeup({ p: prop({ missedVisitId: 3 }), missed: { ...missed, id: 3 }, mandate, weekLoad: () => 2, agreed: [{ missedVisitId: 2, slotStart: at(2026, 11, 25, 10) }], now });
  assert.deepEqual(r2.reasons.map((x) => x.code), ['week_full']);
  // the agency's next slot from the hint is inside Mina's hours, in the next week, within 7 days: accepted
  const s = nextSlot(r.hints.notBefore);
  const r3 = decideMakeup({ p: prop({ slotStart: s.slotStart, slotEnd: s.slotEnd }), missed, mandate, weekLoad: full, now });
  assert.equal(r3.accept, true, JSON.stringify(r3.reasons));
});

test('other rules: price, length, too late, past, expiry, not missed, one make-up per missed visit', () => {
  const codes = (o, extra = {}) => decideMakeup({ p: prop(o), missed, mandate, weekLoad: lightWeek, now, ...extra }).reasons.map((x) => x.code);
  assert.deepEqual(codes({ amount: 46000 }), ['over_price', 'over_cap']);
  assert.deepEqual(codes({ slotEnd: at(2026, 11, 25, 10, 30) }), ['bad_length']);
  assert.deepEqual(codes({ slotStart: at(2026, 12, 3, 10), slotEnd: at(2026, 12, 3, 11, 30) }), ['too_late']);
  assert.deepEqual(codes({ slotStart: now - 600, slotEnd: now + 4800 }), ['slot_past']);
  assert.deepEqual(codes({ expires: now - 1 }), ['expired']);
  assert.deepEqual(codes({ expires: now + 3 * 86400 }), ['expiry_too_long']);
  assert.deepEqual(codes({}, { missed: { ...missed, status: 'Paid' } }), ['not_missed']);
  assert.deepEqual(codes({}, { missed: null }), ['not_missed']);
  assert.deepEqual(codes({}, { agreed: [{ missedVisitId: 2, slotStart: at(2026, 11, 26, 10) }] }), ['already_agreed']);
  // rulesOff never skips the missed-visit check
  assert.deepEqual(codes({}, { missed: { ...missed, status: 'Paid' }, rulesOff: true }), ['not_missed']);
});

test('untrusted proposal input: extra fields, bad carer, oversized numbers are refused', () => {
  const base = { mandateId: 1, missedVisitId: 2, slotStart: 1, slotEnd: 2, amount: 1, carer: 'Ji-woo', nonce: 1, expires: 3 };
  assert.throws(() => parseProposal({ ...base, extra: 1 }));
  assert.throws(() => parseProposal({ ...base, carer: '<script>' }));
  assert.throws(() => parseProposal({ ...base, carer: 'x'.repeat(41) }));
  assert.throws(() => parseProposal({ ...base, amount: '1e30' }));
  assert.throws(() => parseProposal({ ...base, mandateId: String(2n ** 64n) }));
  assert.throws(() => parseProposal({ ...base, slotStart: -1 }));
  assert.equal(parseProposal({ ...base, carer: '김지우' }).carer, '김지우');
});

test('nextSlot: inside 09:00-18:00 Korea time', () => {
  const s = nextSlot(at(2026, 11, 25, 19, 30));
  assert.equal(s.slotStart, at(2026, 11, 26, 9)); assert.equal(s.slotEnd - s.slotStart, 90 * 60);
  assert.equal(nextSlot(at(2026, 11, 26, 16, 45)).slotStart, at(2026, 11, 27, 9));
  assert.equal(nextSlot(at(2026, 11, 26, 10, 10)).slotStart, at(2026, 11, 26, 10, 30));
});

test('anchor input round trip', () => {
  const d = '0x' + 'ab'.repeat(32), p = '0x' + 'cd'.repeat(32);
  assert.deepEqual(readAnchor(anchorData(d, p)), { decision: d, proposal: p });
  assert.equal(readAnchor('0x1234'), null);
  assert.throws(() => anchorData('0x12', p));
});

test('make-up claim: only the agreed slot, price and missed visit, once; anything else is held', async () => {
  const p = prop(), psig = await signProposal(agency, dom, p);
  const d = { proposal: proposalDigest(dom, p), accept: true, reasons: '', decidedAt: BigInt(now) }, dsig = await signDecision(famAgent, dom, d);
  const dh = decisionDigest(dom, d);
  const receipt = { makeup: { missedVisitId: 2, proposal: plain(p), proposalSig: psig, decision: plain(d), decisionSig: dsig } };
  const agreements = [{ decisionHash: dh, accept: true }];
  const chk = (o = {}) => checkMakeupClaim({ receipt, visitId: 6, visitTime: Number(p.slotStart), amount: 45000n, mandateId: 1, dom, agreements, used: {}, ...o });
  assert.deepEqual(chk().hold, []); assert.equal(chk().decisionHash, dh);
  assert.deepEqual(chk({ visitTime: Number(p.slotEnd) + 1800 }).hold.map((x) => x.code), ['makeup_outside_slot']);
  assert.deepEqual(chk({ amount: 46000n }).hold.map((x) => x.code), ['makeup_over_price']);
  assert.deepEqual(chk({ used: { [dh]: 6 } }).hold, [], 'the same visit re-checked is fine');
  assert.deepEqual(chk({ visitId: 7, used: { [dh]: 6 } }).hold.map((x) => x.code), ['makeup_reused']);
  assert.deepEqual(chk({ agreements: [] }).hold.map((x) => x.code), ['makeup_unknown']);
  // a declined decision cannot be used as an agreement even when listed
  const dn = { ...d, accept: false }, rn = { makeup: { ...receipt.makeup, decision: plain(dn) } };
  assert.deepEqual(checkMakeupClaim({ receipt: rn, visitId: 6, visitTime: Number(p.slotStart), amount: 45000n, mandateId: 1, dom, agreements: [{ decisionHash: decisionDigest(dom, dn), accept: false }], used: {} }).hold.map((x) => x.code), ['makeup_unknown']);
  assert.deepEqual(checkMakeupClaim({ receipt: { makeup: { proposal: { x: 1 } } }, visitId: 6, visitTime: 0, amount: 1n, mandateId: 1, dom, agreements, used: {} }).hold.map((x) => x.code), ['makeup_malformed']);
  assert.equal(checkMakeupClaim({ receipt: { note: 'x' }, visitId: 1, visitTime: 0, amount: 1n, mandateId: 1, dom, agreements, used: {} }).claim, false);
});

test('defaults are Mina\'s published rules', () => {
  assert.deepEqual({ ...DEFAULT_MAKEUP_RULES }, { startHour: 9, endHour: 18, maxDaysAfter: 7, minMinutes: 60, maxMinutes: 180, maxExpirySec: 86400, maxProposals: 3, tz: 'Asia/Seoul' });
});
