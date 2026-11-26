// Read-back of the mainnet one-visit cycle (mainnet-visit.sh): reads the chain, never writes. Exit 0 only if every check holds.
//   node mainnet-visit-check.mjs <runDir>    env: CM_NET, CM_CONTRACT, SETTLE_RPC, SETTLE_TOKEN, AGENCY_PAYTO, [GAS_PRICE_WEI for pricing]
// Writes <runDir>/visit.json (the facts the record page and README read) and <runDir>/cost.json (gas of each tx).
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, http, keccak256, toBytes, parseAbiItem, decodeEventLog } from 'viem';
import { connect, visit, payment } from './lib/chain.mjs';

const dir = process.argv[2];
const jl = (f) => fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) : [];
const fails = []; let checks = 0; const must = (ok, m) => { checks++; if (!ok) fails.push(m); };
const ctx = connect(), C = process.env.CM_CONTRACT;
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const post = jl('agency.log').find((x) => x.visitId), srv = jl('server.log'), watch = jl('agency-watch.log');
must(post, 'agency.log has the posted visit');
const id = post?.visitId, rec = st.payments[String(id)] || {}, rv = (st.reviews || {})[String(id)] || null;
const conf = srv.find((e) => e.event === 'confirmed' && e.visitId === id), ack = watch.find((e) => e.event === 'ack' && e.visitId === id);
const v = await visit(ctx, C, id), oc = await payment(ctx, C, id);
must(v.status === 'Paid', `visit ${id} Paid on chain (is ${v.status})`);
must(oc.agencyAck === true, 'agency acknowledged on chain');
must(rec.flowId && v.paymentRef.toLowerCase() === keccak256(toBytes(rec.flowId)).toLowerCase(), 'paymentRef = keccak256(HSP flow id)');
must(String(oc.paidRaw) === String(rec.paidRaw) && oc.settlementTx.toLowerCase() === String(rec.txHash).toLowerCase(), 'payments(id) = the HSP payment record');
must(rv && rv.decision === 'pay', `note reviewed and paid without a hold (${rv ? rv.decision + '/' + rv.source : 'no review'})`);
must(conf && conf.happened === true && rec.markPaidTx && ack?.ackTx, 'tx hashes present: confirm, markPaid, ack');
// the settlement transfer on HSP's network: one transfer of the token to the agency's pay-to, exactly paidRaw
const settle = createPublicClient({ transport: http(process.env.SETTLE_RPC, { timeout: 30_000, retryCount: 4 }) });
const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', TR = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
let src = { status: 'missing', logs: [] };
try { src = await settle.getTransactionReceipt({ hash: oc.settlementTx }); } catch (e) { fails.push('settlement tx not found: ' + String(e.shortMessage || e.message).slice(0, 80)); }
const t = src.logs.filter((l) => l.address.toLowerCase() === process.env.SETTLE_TOKEN.toLowerCase() && l.topics[0] === T0).map((l) => decodeEventLog({ abi: [TR], data: l.data, topics: l.topics }).args).filter((x) => x.to.toLowerCase() === process.env.AGENCY_PAYTO.toLowerCase());
must(src.status === 'success' && t.length === 1 && t[0].value === oc.paidRaw, 'one settlement transfer to the agency pay-to = paidRaw');
// gas of the four HSK Chain transactions
const txs = { postTx: post?.tx, confirmTx: conf?.tx, markPaidTx: rec.markPaidTx, ackTx: ack?.ackTx };
const gas = {}; let total = 0n, paidWei = 0n;
for (const [k, h] of Object.entries(txs)) {
  if (!h) continue;
  let r; try { r = await ctx.pub.getTransactionReceipt({ hash: h }); } catch { must(false, `${k} receipt not found`); continue; }
  must(r.status === 'success', `${k} succeeded`);
  gas[k] = String(r.gasUsed); total += r.gasUsed; paidWei += r.gasUsed * r.effectiveGasPrice;
}
const gp = BigInt(process.env.GAS_PRICE_WEI || '500000000000');
const cost = { gas, totalGas: String(total), feePaidHsk: (Number(paidWei) / 1e18).toFixed(6), atGasPriceGwei: Number(gp / 1_000_000_000n), atGasPriceHsk: (Number(total * gp) / 1e18).toFixed(6) };
fs.writeFileSync(path.join(dir, 'cost.json'), JSON.stringify(cost, null, 1));
const receipt = st.receipts[v.receiptHash] || {};
const visitJson = { contract: C, network: ctx.cfg.name, chainId: ctx.cfg.id, visitId: id, amountWon: Number(v.amount), note: receipt.note || null,
  review: rv ? `${rv.decision}, ${rv.source}` : null, flowId: rec.flowId, paidRaw: String(oc.paidRaw), settlementTx: oc.settlementTx,
  settleLabel: process.env.SETTLE_LABEL || 'Ethereum Sepolia', ...txs, startedAt: srv.find((e) => e.event === 'start')?.at, at: ack?.at || new Date().toISOString() };
if (!fails.length) fs.writeFileSync(path.join(dir, 'visit.json'), JSON.stringify(visitJson, null, 1));
console.log(JSON.stringify({ checks, failed: fails.length, fails, visitId: id, cost }));
process.exit(fails.length || checks < 8 ? 1 : 0);
