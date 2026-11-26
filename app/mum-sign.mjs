// Mum's tablet without the browser: signs her answer for one visit (EIP-712, the same typed data as web/eip712.js) and hands it to
// Mina's agent (POST /api/confirm), as the tablet page does. Used by the mainnet one-visit cycle (mainnet-visit.sh).
//   MUM_PK=0x... CM_BASE=http://127.0.0.1:8791 node mum-sign.mjs <visitId> yes|no
// The digest is first compared with the contract's own confirmDigest(visitId, happened); a mismatch stops before anything is sent.
import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData, parseSignature } from 'viem';
import { connect, ABI } from './lib/chain.mjs';

const [idArg, ans] = process.argv.slice(2);
const visitId = Number(idArg), happened = ans === 'yes';
if (!Number.isInteger(visitId) || visitId < 1 || !['yes', 'no'].includes(ans)) { console.error('usage: mum-sign.mjs <visitId> yes|no'); process.exit(2); }
if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.MUM_PK || '')) { console.error('MUM_PK missing'); process.exit(2); }
const BASE = process.env.CM_BASE || 'http://127.0.0.1:8791';
const mum = privateKeyToAccount(process.env.MUM_PK);
const cfg = await (await fetch(BASE + '/api/config')).json();
if (cfg.confirmer.toLowerCase() !== mum.address.toLowerCase()) { console.error('this key is not the mandate\'s confirmer'); process.exit(3); }
const td = { domain: { name: 'CareMandate', version: '1', chainId: cfg.chainId, verifyingContract: cfg.contract },
  types: { Confirm: [{ name: 'visitId', type: 'uint256' }, { name: 'happened', type: 'bool' }] }, primaryType: 'Confirm',
  message: { visitId: BigInt(visitId), happened } };
const ctx = connect();
const onchain = await ctx.pub.readContract({ address: cfg.contract, abi: ABI, functionName: 'confirmDigest', args: [BigInt(visitId), happened] });
if (onchain.toLowerCase() !== hashTypedData(td).toLowerCase()) { console.error('digest differs from the contract\'s confirmDigest: not sending'); process.exit(3); }
const sig = parseSignature(await mum.signTypedData(td));
const res = await fetch(BASE + '/api/confirm', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ visitId, happened, v: Number(sig.v ?? (sig.yParity + 27)), r: sig.r, s: sig.s }) });
const out = await res.json().catch(() => ({}));
console.log(JSON.stringify({ visitId, happened, http: res.status, status: out.status || null, paying: !!out.paying, reviewHeld: !!out.reviewHeld, error: out.error || null }));
process.exit(res.ok ? 0 : 1);
