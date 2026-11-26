// Chain access for the CareMandate agents: one contract, read and write through viem.
import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, defineChain, keccak256, toBytes, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const ABI = JSON.parse(fs.readFileSync(new URL('../abi.json', import.meta.url), 'utf8'));
// HSK testnet RPC sometimes times out on connect (run d, 11-25): longer timeout + retries. A retried raw-tx send is safe (same nonce -> 'already known').
const RPC_OPTS = { timeout: 30_000, retryCount: 5, retryDelay: 1_000 };
export const STATUS = ['None', 'Posted', 'Confirmed', 'Held', 'Paid', 'Rejected'];

export const CHAINS = {
  // the offline runs start anvil with --chain-id 133 (CM_LOCAL_CHAIN_ID) so the local chain is a faithful HSK-testnet stand-in
  local: { id: Number(process.env.CM_LOCAL_CHAIN_ID || 31337), name: 'anvil', rpc: process.env.CM_LOCAL_RPC || 'http://127.0.0.1:8545', explorer: null },
  testnet: { id: 133, name: 'HashKey Chain Testnet', rpc: 'https://testnet.hsk.xyz', explorer: 'https://testnet-explorer.hskchain.net' },
  mainnet: { id: 177, name: 'HashKey Chain', rpc: process.env.CM_MAINNET_RPC || 'https://mainnet.hsk.xyz', explorer: 'https://hsk.blockscout.com' },   // CM_MAINNET_RPC: fork tests only
};

export function connect(net = process.env.CM_NET || 'local') {
  const c = CHAINS[net]; if (!c) throw new Error('unknown network ' + net);
  const chain = defineChain({ id: c.id, name: c.name, nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } });
  const pub = createPublicClient({ chain, transport: http(c.rpc, RPC_OPTS) });
  const wallet = (pk) => { const account = privateKeyToAccount(pk); return { account, client: createWalletClient({ account, chain, transport: http(c.rpc, RPC_OPTS) }) }; };
  return { net, chain, cfg: c, pub, wallet };
}

/** Write a contract call, wait for it, and return the receipt plus its decoded CareMandate events. Fails loudly on a revert. */
export async function send(ctx, w, address, functionName, args) {
  const { request } = await ctx.pub.simulateContract({ address, abi: ABI, functionName, args, account: w.account });
  const hash = await w.client.writeContract(request);
  const rc = await ctx.pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${functionName} reverted in ${hash}`);
  return { hash, receipt: rc, events: parseEventLogs({ abi: ABI, logs: rc.logs }) };
}

export async function visit(ctx, address, id) {
  const [mandateId, visitTime, amount, status, receiptHash, paymentRef] = await ctx.pub.readContract({ address, abi: ABI, functionName: 'visits', args: [BigInt(id)] });
  return { id: Number(id), mandateId: Number(mandateId), visitTime: Number(visitTime), amount, status: STATUS[status], receiptHash, paymentRef };
}

export async function mandate(ctx, address, id) {
  const [family, familyAgent, agency, confirmer, perVisitCap, weeklyMax, active, rawPerMillionWon] = await ctx.pub.readContract({ address, abi: ABI, functionName: 'mandates', args: [BigInt(id)] });
  return { id: Number(id), family, familyAgent, agency, confirmer, perVisitCap, weeklyMax: Number(weeklyMax), active, rawPerMillionWon };
}

/** What was paid for a visit (v2): paidRaw, settlementTx, issues (failed/unsettled attempts recorded), agencyAck. */
export async function payment(ctx, address, id) {
  const [paidRaw, settlementTx, issues, agencyAck] = await ctx.pub.readContract({ address, abi: ABI, functionName: 'payments', args: [BigInt(id)] });
  return { paidRaw, settlementTx, issues: Number(issues), agencyAck };
}

export const ISSUE = { FailedBeforeSubmit: 1, HspPaymentFailed: 2, Unsettled: 3, RefusedBySigningFirewall: 4 };

/** Canonical receipt hash: keys sorted, no whitespace, so the agency, the family and Mum's page all hash the same bytes. */
export function receiptHash(receipt) {
  const canon = JSON.stringify(Object.keys(receipt).sort().reduce((o, k) => (o[k] = receipt[k], o), {}));
  return keccak256(toBytes(canon));
}
