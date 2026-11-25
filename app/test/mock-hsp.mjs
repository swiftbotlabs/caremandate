// A local stand-in for the HSP QA MCP server, for OFFLINE end-to-end runs of the real qa code path (lib/hsp.mjs: MCP handshake,
// create_order, get_order, prepare_payment, the signing firewall, a real EIP-712 signature, finalize, submit, query_payment).
// Shapes follow the live replies in test/fixtures. Nothing here touches a chain: flow ids start with MOCKHSP- and tx hashes are fake.
// It checks every signature it receives (recovers the payer) and settles a flow MOCK_HSP_SETTLE_S seconds after submit.
//   MOCK_HSP_PORT (8795), MOCK_HSP_SETTLE_S (8), MOCK_HSP_FAIL = query (query_payment always errors) | failed (payment-failed) | ''
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { recoverTypedDataAddress, keccak256, toBytes } from 'viem';

const CFG = JSON.parse(fs.readFileSync(new URL('./fixtures/live_chain_config.json', import.meta.url))).config;
const NET = process.env.HSP_NETWORK || 'sepolia';
const chainId = CFG.networks.find((n) => n.name === NET).chain_id;
const USDC = CFG.tokens.find((t) => Number(t.chain_id) === chainId && t.symbol === 'USDC' && t.payment_protocol === 'eip3009');
const SETTLE_S = Number(process.env.MOCK_HSP_SETTLE_S || 8), FAIL = process.env.MOCK_HSP_FAIL || '';
const orders = new Map(); const stats = { orders: 0, signaturesOk: 0, signaturesBad: 0, submits: 0, queries: 0 };
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const ok = (data) => ({ structuredContent: { code: 0, msg: 'success', data } });
const bad = (msg) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 40000, msg }) }] });

async function tool(name, a) {
  if (name === 'get_chain_config') return ok(CFG);
  if (name === 'create_order') {
    const c = a.cart_mandate?.contents, prId = c?.payment_request?.details?.id;
    if (!/^0x[0-9a-fA-F]{40}$/.test(a.pay_to || '') || !prId || c.merchant_name !== a.merchant_name) return bad('bad order');
    const flowId = 'MOCKHSP-' + crypto.randomUUID(); orders.set(flowId, { prId, payTo: a.pay_to, merchant: a.merchant_name, usd: c.payment_request.details.total.amount.value }); stats.orders++;
    return ok({ flow_id: flowId, payment_request_id: prId, payment_url: 'http://127.0.0.1/mock-pay?f=' + flowId });
  }
  const o = orders.get(a.flow_id || '');
  if (name === 'get_order') return o ? ok({ flow_id: a.flow_id, merchant_name: o.merchant, payment_request_id: o.prId, method_data: [] }) : bad('no such flow');
  if (name === 'prepare_payment') {
    if (!o) return bad('no such flow');
    const raw = String(Math.round(Number(o.usd) * 1e6) + 2), vb = String(Math.floor(Date.now() / 1000) + 3600), nonce = '0x' + crypto.randomBytes(32).toString('hex');
    const message = { from: a.payer, to: o.payTo, value: raw, validAfter: '0', validBefore: vb, nonce };
    o.typed = { domain: { chainId: '0x' + chainId.toString(16), name: USDC.name || 'USDC', verifyingContract: USDC.address, version: String(USDC.version || '2') }, message, primaryType: 'TransferWithAuthorization',
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] } };
    return ok({ eip712: o.typed, cart_hash: crypto.createHash('sha256').update(o.prId).digest('hex'), payer: a.payer, pay_to: o.payTo, payment_request_id: o.prId, token_total_raw: raw,
      payment_payload: { x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:' + chainId, asset: USDC.address, payTo: o.payTo, amount: raw }, payload: { authorization: message, signature: '' } },
      payment_mandate_contents: { payment_mandate_id: o.prId } });
  }
  if (name === 'finalize_payment') {
    const f = [...orders.entries()].find(([, x]) => x.typed && x.prId === a.payment_mandate_contents?.payment_mandate_id);
    if (!f) return bad('no prepared flow');
    const t = f[1].typed, td = { domain: { ...t.domain, chainId }, types: { TransferWithAuthorization: t.types.TransferWithAuthorization }, primaryType: t.primaryType, message: { ...t.message, value: BigInt(t.message.value), validAfter: 0n, validBefore: BigInt(t.message.validBefore) } };
    let who = null; try { who = await recoverTypedDataAddress({ ...td, signature: a.signature }); } catch { /* bad signature */ }
    if (!who || who.toLowerCase() !== t.message.from.toLowerCase()) { stats.signaturesBad++; return bad('signature does not recover to the payer'); }
    stats.signaturesOk++; f[1].signed = true;
    return ok({ payment_mandate_json: JSON.stringify({ flow_id: f[0] }) });
  }
  if (name === 'submit_payment') {
    let fid; try { fid = JSON.parse(a.payment_mandate_json).flow_id; } catch { return bad('bad mandate'); }
    const x = orders.get(fid); if (!x?.signed) return bad('not finalized');
    if (x.submittedAt) return bad('already submitted');
    x.submittedAt = Date.now(); x.tx = keccak256(toBytes(fid)); stats.submits++;
    return ok({ status: 'payment-submitted' });
  }
  if (name === 'query_payment') {
    stats.queries++;
    if (FAIL === 'query') throw Object.assign(new Error('mock: query_payment down'), { http: 502 });
    if (!o) return bad('no such flow');
    if (!o.submittedAt) return ok({ status: 'payment-required', merchant_name: o.merchant, attribution_verified: o.merchant === a.expected_merchant_name });
    if (FAIL === 'failed') return ok({ status: 'payment-failed', merchant_name: o.merchant });
    const age = (Date.now() - o.submittedAt) / 1000;
    const status = age >= SETTLE_S ? 'payment-safe' : age >= SETTLE_S / 2 ? 'payment-included' : 'payment-processing';
    return ok({ status, payment: { status, tx_signature: status === 'payment-processing' ? null : o.tx }, merchant_name: o.merchant, attribution_verified: o.merchant === a.expected_merchant_name });
  }
  return bad('unknown tool ' + name);
}

http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) { body += c; if (body.length > 65536) { res.writeHead(413); return res.end(); } }
  if (req.method === 'GET' && req.url === '/stats') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(stats)); }
  let m; try { m = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
  if (m.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
  const reply = (result, extra = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); };
  if (m.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock-hsp', version: '1' } }, { 'mcp-session-id': 'mock-' + crypto.randomUUID() });
  if (m.method === 'tools/call') {
    try { const r = await tool(m.params.name, m.params.arguments || {}); log({ tool: m.params.name, flow: m.params.arguments?.flow_id, error: r.isError || undefined }); return reply(r); }
    catch (e) { log({ tool: m.params.name, http: e.http || 500 }); res.writeHead(e.http || 500); return res.end('mock error'); }
  }
  res.writeHead(404); res.end();
}).listen(Number(process.env.MOCK_HSP_PORT || 8795), '127.0.0.1', () => log({ event: 'mock-hsp up', port: Number(process.env.MOCK_HSP_PORT || 8795), network: NET, settleS: SETTLE_S, fail: FAIL || null }));
