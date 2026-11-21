// Mum's answer, signed in her own browser with her page key (it never leaves the device; no wallet, no gas).
// EIP-712 digest exactly as CareMandate.confirmBySig rebuilds it.
import * as secp from '/vendor/secp256k1.js';
import { keccak_256 } from '/vendor/hashes/sha3.js';
import { hmac } from '/vendor/hashes/hmac.js';
import { sha256 } from '/vendor/hashes/sha2.js';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

const enc = new TextEncoder();
const hex = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
const word = (n) => { const b = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(v & 255n); v >>= 8n; } return b; };
const addrWord = (a) => { const b = new Uint8Array(32); b.set(unhex(a), 12); return b; };
const cat = (...xs) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };
const k = (x) => keccak_256(typeof x === 'string' ? enc.encode(x) : x);

export function digest(chainId, contract, visitId, happened) {
  const domain = k(cat(k('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), k('CareMandate'), k('1'), word(chainId), addrWord(contract)));
  const struct = k(cat(k('Confirm(uint256 visitId,bool happened)'), word(visitId), word(happened ? 1 : 0)));
  return k(cat(Uint8Array.from([0x19, 0x01]), domain, struct));
}

export function pageKey() {
  let pk = null; try { pk = localStorage.getItem('caremandate.pagekey'); } catch { /* storage blocked */ }
  if (!pk) { pk = hex(secp.utils.randomPrivateKey()); try { localStorage.setItem('caremandate.pagekey', pk); } catch { /* storage blocked */ } }
  return pk;
}
export function address(pk) {
  const pub = secp.getPublicKey(unhex(pk), false).slice(1);
  return '0x' + hex(k(pub)).slice(-40);
}
export function sign(pk, d) {
  const s = secp.sign(d, unhex(pk), { lowS: true });
  return { v: 27 + s.recovery, r: '0x' + s.r.toString(16).padStart(64, '0'), s: '0x' + s.s.toString(16).padStart(64, '0') };
}
