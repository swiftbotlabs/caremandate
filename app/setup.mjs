// Deploy CareMandate (if CM_CONTRACT is unset) and create Mina's mandate. Usage:
//   node setup.mjs <confirmerAddress (Mum's tablet key)> [perVisitCapWon=45000] [weeklyMax=3]
// env: CM_NET, DEPLOYER_PK (deploy only), FAMILY_PK (creates the mandate), FAMILY_AGENT_ADDR, AGENCY_ADDR
// The won -> payment-token rate goes on chain with the mandate (lib/fx.mjs):
//   KRW_PER_USD=<n> [FX_SOURCE=<text>]      a reference rate you give, or
//   CM_FX_FETCH=1                           fetch today's ECB reference rate (api.frankfurter.dev, USD->KRW; read-only GET)
//   CM_TEST_SCALE (default 1000 off mainnet, 1 on mainnet): testnet pays 1/1000 of the real price (the QA payer holds ~20 test USDC)
import fs from 'node:fs';
import { connect, send, ABI } from './lib/chain.mjs';
import { rateFrom, usdFor } from './lib/fx.mjs';
const [confirmer, cap = '45000', weekly = '3'] = process.argv.slice(2);
const ctx = connect();

async function fx() {
  if (process.env.CM_FX_FETCH === '1') {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?from=USD&to=KRW', { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('FX fetch HTTP ' + r.status);
    const t = await r.text(); if (t.length > 2000) throw new Error('FX reply too large');
    const j = JSON.parse(t); const k = Number(j?.rates?.KRW);
    if (!(k > 100 && k < 10000) || !/^\d{4}-\d{2}-\d{2}$/.test(String(j.date))) throw new Error('FX reply has no sane USD->KRW rate');
    return { krwPerUsd: k, source: 'ECB reference rate via api.frankfurter.dev', date: j.date };
  }
  const k = Number(process.env.KRW_PER_USD);
  if (!(k > 100 && k < 10000)) throw new Error('set KRW_PER_USD (e.g. 1390) or CM_FX_FETCH=1');
  return { krwPerUsd: k, source: process.env.FX_SOURCE || 'KRW_PER_USD given to setup.mjs', date: process.env.FX_DATE || new Date().toISOString().slice(0, 10) };
}
const f = await fx();
const scale = Number(process.env.CM_TEST_SCALE || (ctx.net === 'mainnet' ? 1 : 1000));
const rate = rateFrom({ krwPerUsd: f.krwPerUsd, scale });
const FX = { ...f, scale, rawPerMillionWon: String(rate), token: 'USDC (6 decimals)', capWon: Number(cap), capUsd: usdFor(cap, rate) };
console.error(`fx: ${f.krwPerUsd} KRW/USD (${f.source}, ${f.date}), scale 1:${scale} -> ${rate} raw per 1M won; ${Number(cap).toLocaleString('en-US')} won -> $${FX.capUsd}`);

let address = process.env.CM_CONTRACT, deployTx = null, deployGas = null;
if (!address) {
  const art = JSON.parse(fs.readFileSync(new URL('../out/CareMandate.sol/CareMandate.json', import.meta.url), 'utf8'));
  const d = ctx.wallet(process.env.DEPLOYER_PK);
  const hash = await d.client.deployContract({ abi: ABI, bytecode: art.bytecode.object });
  const rc = await ctx.pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('deploy reverted ' + hash);
  address = rc.contractAddress; deployTx = hash; deployGas = rc.gasUsed.toString(); console.error('deployed', address, 'tx', hash, 'gas', deployGas);
}
const fam = ctx.wallet(process.env.FAMILY_PK);
const r = await send(ctx, fam, address, 'createMandate', [process.env.FAMILY_AGENT_ADDR, process.env.AGENCY_ADDR, confirmer, BigInt(cap), Number(weekly), rate]);
const ev = r.events.find((e) => e.eventName === 'MandateCreated');
console.log(JSON.stringify({ contract: address, mandateId: Number(ev.args.mandateId), tx: r.hash, deployTx, deployGas, mandateGas: r.receipt.gasUsed.toString(), fx: FX }));
