// One real HSP QA payment probe, for the moment HSP allowlists our egress IP. Testnet USDC only (Circle USDC on Ethereum Sepolia by default; HSP_NETWORK to change), 0.01 USD.
//   node hsp-probe.mjs --dry     reach HSP, create the order, run the signing firewall, STOP before signing (nothing paid)
//   node hsp-probe.mjs           the same, then sign, submit and poll to payment-safe; prints the flow id and tx
// Env: HSP_PAYER_ENV = an env file with HSP_QA_KEY (the payer's testnet key), HSP_PAYTO = the address to pay (or HSP_MERCHANT_ENV,
// an env file whose HSP_QA_ADDRESS is used). Keys are read in-process and never printed.
import fs from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { payVisit, mcpClient, MERCHANT } from './lib/hsp.mjs';

const env = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
if (!process.env.HSP_PAYER_ENV) { console.error('set HSP_PAYER_ENV to the env file holding HSP_QA_KEY'); process.exit(2); }
const payerEnv = env(process.env.HSP_PAYER_ENV);
const payer = privateKeyToAccount(payerEnv.HSP_QA_KEY);
const payTo = process.env.HSP_PAYTO || (process.env.HSP_MERCHANT_ENV && env(process.env.HSP_MERCHANT_ENV).HSP_QA_ADDRESS);
if (!/^0x[0-9a-fA-F]{40}$/.test(payTo || '')) { console.error('set HSP_PAYTO (or HSP_MERCHANT_ENV)'); process.exit(2); }
const dry = process.argv.includes('--dry');
const t0 = Date.now();
const log = (o) => console.log(JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(1), ...o }));
log({ merchant: MERCHANT, payer: payer.address, payTo, dry });
try {
  const r = await payVisit({ mode: 'qa', visitId: `probe-${Date.now()}`, amountUsd: '0.01', payTo, payer: payer.address, client: mcpClient(), log,
    signTypedData: async (td) => { if (dry) { log({ step: 'dry_stop', value: String(td.message.value), to: td.message.to }); process.exit(0); } return payer.signTypedData(td); } });
  log({ step: 'done', ...r });
} catch (e) { log({ step: 'error', error: e.message }); process.exit(1); }
