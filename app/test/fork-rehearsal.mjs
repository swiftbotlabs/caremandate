// The HSK Chain mainnet deploy, rehearsed on a local fork of mainnet (chain 177): deploy CareMandate, create the mandate at REAL scale
// (CM_TEST_SCALE=1: 45,000 won = ~$32 USDC), and one full visit (post -> Mum's signed yes -> markPaid -> agency ack) plus the cap trip.
// Prices it in USD from mainnet's live gas price and HSK's USD price. Writes JSON to stdout. Nothing is sent to mainnet: CM_NET=local
// with CM_LOCAL_RPC pointing at `anvil --fork-url https://mainnet.hsk.xyz`; keys are anvil's public test keys (funded only on the fork).
import { keccak256, toBytes, createPublicClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';
import { connect, send, ABI, visit, payment } from '../lib/chain.mjs';
import { rateFrom, usdFor, recordLimitRaw } from '../lib/fx.mjs';

const K = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'];
const ctx = connect('local');
const chainId = await ctx.pub.getChainId();
if (chainId !== 177) throw new Error(`not a fork of HSK mainnet (chain ${chainId})`);
const main = createPublicClient({ transport: http('https://mainnet.hsk.xyz', { timeout: 30_000, retryCount: 3 }) });
const gasPrice = await main.getGasPrice();
const hskUsd = Number(process.env.HSK_USD);
if (!(hskUsd > 0 && hskUsd < 1000)) throw new Error('set HSK_USD (HSK price in USD)');
const [dep, fam, fagent, agency] = K.map((k) => ctx.wallet(k));
const mum = privateKeyToAccount('0x' + 'a1'.repeat(32));
const krw = Number(process.env.KRW_PER_USD || 1390), rate = rateFrom({ krwPerUsd: krw, scale: 1 });
const steps = [];
const rec = (name, rc) => steps.push({ name, gas: Number(rc.gasUsed), tx: rc.transactionHash });

const art = JSON.parse(fs.readFileSync(new URL('../../out/CareMandate.sol/CareMandate.json', import.meta.url), 'utf8'));
const h = await dep.client.deployContract({ abi: ABI, bytecode: art.bytecode.object, chain: ctx.chain });
const drc = await ctx.pub.waitForTransactionReceipt({ hash: h }); rec('deploy CareMandate', drc);
const C = drc.contractAddress;
rec('createMandate (45,000 won cap, 3/week, real-scale rate)', (await send(ctx, fam, C, 'createMandate', [fagent.account.address, agency.account.address, mum.address, 45000n, 3, rate])).receipt);
const now = (await ctx.pub.getBlock()).timestamp;
rec('postVisit (agency agent)', (await send(ctx, agency, C, 'postVisit', [1n, now - 3600n, 45000n, keccak256(toBytes('fork visit 1'))])).receipt);
let trip = null;
try { await send(ctx, agency, C, 'postVisit', [1n, now - 60n, 46000n, keccak256(toBytes('fork visit over cap'))]); } catch (e) { trip = e.walk?.((x) => x?.data?.errorName)?.data?.errorName || 'reverted'; }
const dg = await ctx.pub.readContract({ address: C, abi: ABI, functionName: 'confirmDigest', args: [1n, true] });
const sig = await mum.sign({ hash: dg });
const r = sig.slice(0, 66), s = '0x' + sig.slice(66, 130), v = parseInt(sig.slice(130, 132), 16);
rec("confirmBySig (Mum's yes, relayed by the family agent)", (await send(ctx, fagent, C, 'confirmBySig', [1n, true, v, r, s])).receipt);
const paidRaw = BigInt(Math.round(Number(usdFor(45000, rate)) * 1e6 * 1.0002));
rec('markPaid (paidRaw + settlement tx)', (await send(ctx, fagent, C, 'markPaid', [1n, keccak256(toBytes('fork-flow-1')), paidRaw, keccak256(toBytes('fork-settlement-tx'))])).receipt);
rec('ackPaid (agency agent)', (await send(ctx, agency, C, 'ackPaid', [1n])).receipt);
const vi = await visit(ctx, C, 1), pay = await payment(ctx, C, 1);
const usd = (g) => Number(formatEther(BigInt(g) * gasPrice)) * hskUsd;
const deployOnly = steps.slice(0, 2).reduce((a, x) => a + x.gas, 0), all = steps.reduce((a, x) => a + x.gas, 0);
console.log(JSON.stringify({
  fork: { chainId, block: Number(drc.blockNumber) }, contract: C, captrip: trip, visit1: { status: vi.status, paidRaw: String(pay.paidRaw), limitRaw: String(recordLimitRaw(45000, rate)), agencyAck: pay.agencyAck },
  fx: { krwPerUsd: krw, scale: 1, rawPerMillionWon: String(rate), capUsd: usdFor(45000, rate) },
  price: { gasPriceGwei: Number(gasPrice) / 1e9, hskUsd, source: process.env.HSK_USD_SOURCE || 'HSK_USD' },
  steps: steps.map((x) => ({ ...x, hsk: Number(formatEther(BigInt(x.gas) * gasPrice)).toFixed(5), usd: usd(x.gas).toFixed(4) })),
  totals: { deployAndMandateGas: deployOnly, deployAndMandateUsd: usd(deployOnly).toFixed(4), fullCycleGas: all, fullCycleUsd: usd(all).toFixed(4),
            perVisitGas: all - deployOnly, perVisitUsd: usd(all - deployOnly).toFixed(4) },
}, null, 1));
