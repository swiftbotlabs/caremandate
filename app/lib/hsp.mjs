// HSP (HashKey Settlement Platform) payment for one confirmed visit, through HSP Agentic Payment: HashKey's MCP server for hackathon
// teams (Streamable HTTP JSON-RPC, QA environment, testnet stablecoins, egress IP allowlisted by HSP).
// The agency is the merchant: create_order with our team name, its pay_to address and a Cart Mandate for one visit. The family agent
// is the payer: get_order (must describe the order we created) -> prepare_payment -> our signing firewall checks the EIP-712 HSP
// returns -> sign -> finalize_payment -> submit_payment (HSP's Gateway broadcasts; the payer needs no gas) -> query_payment until
// payment-safe. Protocol shapes follow the live server's replies (test/fixtures/*.json), not only the published guide:
// get_chain_config is flat (networks + tokens joined by chain_id); domain.chainId is a hex string; results may be wrapped
// in {code,msg,data}.
// Modes: HSP_MODE=qa (real) or mock (a local stand-in, labelled MOCK in every id, the trace and the UI; never on mainnet).
import crypto from 'node:crypto';

const QA_URL = process.env.HSP_MCP_URL || 'https://mcp-qa.hashkeymerchant.com/';
export const MERCHANT = process.env.HSP_MERCHANT_NAME || 'Swift Bot Labs (CareMandate)';
const NETWORK = process.env.HSP_NETWORK || 'base-sepolia';   // HSP's QA config pays USDC on Base Sepolia (Circle's public faucet)
const PER_PAYMENT_CAP_USD = Number(process.env.HSP_CAP_USD || 0.05);
const FEE_ALLOWANCE = 1.05;                                  // HSP converts USD at a live rate (0.01 USD -> 10002 raw seen live)
const POLL_MS = Number(process.env.HSP_POLL_MS || 15000);

export class HspError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
export class Refused extends Error { constructor(rule, detail) { super(`refused to sign: ${rule}${detail ? ` (${detail})` : ''}`); this.rule = rule; } }

// ---------------------------------------------------------------- MCP client (initialize -> notifications/initialized -> tools/call)
export function mcpClient(url = QA_URL, fetchImpl = fetch) {
  let id = 0, session = null, ready = false;
  async function post(body, expectReply = true) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (session) headers['mcp-session-id'] = session;
    const r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    if (r.status === 403) throw new HspError('HSP QA refused our network (403): egress IP not on the allowlist', 403);
    if (!r.ok && r.status !== 202) throw new HspError(`HSP MCP HTTP ${r.status}`, r.status);
    const sid = r.headers.get('mcp-session-id');
    if (sid && /^[\x21-\x7e]{1,200}$/.test(sid)) session = sid;
    if (!expectReply) return null;
    const text = await r.text();
    const t = text.trim();
    const line = t.startsWith('{') ? t : (t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter((l) => l.includes('"id"')).pop() || '');
    if (!line) throw new HspError('HSP MCP: empty reply');
    const msg = JSON.parse(line);
    if (msg.error) throw new HspError(`HSP MCP error ${msg.error.code}: ${String(msg.error.message).slice(0, 200)}`, msg.error.code);
    return msg.result;
  }
  async function init() {
    await post({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'caremandate', version: '0.2' } } });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
    ready = true;
  }
  return {
    async tool(name, args) {
      if (!ready) await init();
      const res = await post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
      let data = res?.structuredContent;
      if (data === undefined) {
        const txt = (res?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        try { data = JSON.parse(txt); } catch { data = { text: txt }; }
      }
      if (res?.isError) throw new HspError(`HSP ${name} failed: ${JSON.stringify(data).slice(0, 300)}`);
      return unwrap(name, data);
    },
  };
}

// {code, msg, data} envelopes: code 0 / "0" / 200 means ok
function unwrap(name, p) {
  if (p && typeof p === 'object' && 'code' in p && Object.keys(p).every((k) => ['code', 'msg', 'message', 'data', 'success', 'trace_id', 'request_id', 'error'].includes(k))) {
    if (['0', '200'].includes(String(p.code)) && p.success !== false) return p.data ?? {};
    throw new HspError(`HSP ${name}: ${p.code} ${String(p.msg || p.message || '').slice(0, 200)}`, p.code);
  }
  return p;
}
// the (sub)object that holds `key`, breadth-first, up to depth 3 (servers wrap results differently)
export function holder(obj, key) {
  let level = [obj];
  for (let d = 0; d < 4; d++) {
    const next = [];
    for (const o of level) if (o && typeof o === 'object') { if (key in o) return o; next.push(...Object.values(o).filter((v) => v && typeof v === 'object' && !Array.isArray(v))); }
    level = next;
  }
  return obj || {};
}
const chainInt = (v) => typeof v === 'number' ? v : typeof v === 'string' ? (/^0x[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : /^\d+$/.test(v.replace(/^eip155:/, '')) ? Number(v.replace(/^eip155:/, '')) : NaN) : NaN;
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

// ---------------------------------------------------------------- chain config: the token we pay with
export function pickToken(cfgIn, network = NETWORK) {
  const cfg = holder(cfgIn, 'tokens');
  const nets = (cfg.networks || []).filter((n) => n.name === network);
  if (!nets.length) throw new HspError(`HSP chain config has no network ${network}`);
  const chainId = chainInt(nets[0].chain_id);
  const tok = (cfg.tokens || []).find((t) => chainInt(t.chain_id) === chainId && t.symbol === 'USDC' && t.payment_protocol === 'eip3009');
  if (!tok || !/^0x[0-9a-fA-F]{40}$/.test(tok.address)) throw new HspError(`HSP chain config has no EIP-3009 USDC on ${network}`);
  return { network, chainId, address: tok.address, decimals: Number(tok.decimals ?? 6), name: tok.name || 'USDC', version: String(tok.version || '2') };
}

// ---------------------------------------------------------------- the Cart Mandate for one visit
export function cart({ token, payTo, amountUsd, visitId, now = Date.now() }) {
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const prId = `CARE-PR-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  const value = Number(amountUsd).toFixed(2);
  return {
    prId,
    cart_mandate: { contents: {
      id: `CARE-${stamp}-${crypto.randomBytes(3).toString('hex')}`,
      user_cart_confirmation_required: false,
      payment_request: {
        method_data: [{ supported_methods: 'https://www.x402.org/', data: { x402Version: 2, network: token.network, chain_id: token.chainId, contract_address: token.address, pay_to: payTo, coin: 'USDC' } }],
        details: { id: prId, display_items: [{ label: `Home care visit #${visitId}`, amount: { currency: 'USD', value } }], total: { label: 'Total', amount: { currency: 'USD', value } } },
      },
      cart_expiry: new Date(now + 3600e3).toISOString().replace(/\.\d+Z$/, 'Z'),
      merchant_name: MERCHANT,
    } },
  };
}

// ---------------------------------------------------------------- the signing firewall: the EIP-712 HSP hands us must be exactly our order
export function firewall(prepIn, { payer, payTo, token, amountUsd, now = Date.now() }) {
  const prep = holder(prepIn, 'eip712');
  const td = prep.eip712;
  if (!td || td.primaryType !== 'TransferWithAuthorization') throw new Refused('primaryType', td?.primaryType);
  const d = td.domain || {}, m = td.message || {};
  if (chainInt(d.chainId) !== token.chainId) throw new Refused('chainId', d.chainId);
  if (!same(d.verifyingContract, token.address)) throw new Refused('token contract', d.verifyingContract);
  if (!same(m.from, payer)) throw new Refused('payer', m.from);
  if (!same(m.to, payTo)) throw new Refused('payee differs from the agency', m.to);
  const raw = BigInt(m.value ?? -1);
  const usd = Number(amountUsd);
  if (!(usd > 0) || usd > PER_PAYMENT_CAP_USD) throw new Refused('per-payment cap', String(amountUsd));
  const bound = BigInt(Math.ceil(usd * 10 ** token.decimals * FEE_ALLOWANCE));
  if (raw <= 0n || raw > bound) throw new Refused('amount', `${raw} raw > ${bound}`);
  const vb = Number(m.validBefore), va = Number(m.validAfter || 0);
  if (!(vb > now / 1000) || vb - now / 1000 > 2 * 3600 || va > now / 1000) throw new Refused('validity window', `${va}..${vb}`);
  if (!/^0x[0-9a-f]{64}$/i.test(String(m.nonce))) throw new Refused('nonce');
  const accepted = prep.payment_payload?.accepted;
  if (accepted && (!same(accepted.payTo, payTo) || !same(accepted.asset, token.address) || String(accepted.amount) !== String(m.value))) throw new Refused('x402 payload differs from the typed data');
  // viem wants a number chainId and bigint-able values
  return { domain: { ...d, chainId: token.chainId }, types: Object.fromEntries(Object.entries(td.types).filter(([k]) => k !== 'EIP712Domain')),
           primaryType: td.primaryType, message: { ...m, value: BigInt(m.value), validAfter: BigInt(m.validAfter || 0), validBefore: BigInt(m.validBefore) } };
}

const statusOf = (q) => { const h = holder(q, 'status'); const p = q?.payment || h?.payment || {}; return { st: h.status || p.status, tx: p.tx_signature || h.tx_signature || null, att: q?.attribution_verified ?? h.attribution_verified ?? p.attribution_verified }; };

/** Pay one visit. amountUsd like "0.01". Returns {mode, flowId, paymentRequestId, txHash, status, network, attributionVerified}. */
export async function payVisit({ mode = process.env.HSP_MODE || 'mock', visitId, amountUsd, payTo, payer, signTypedData, client, log = () => {}, now = Date.now }) {
  if (mode === 'mock') {
    const flowId = 'MOCK-' + crypto.randomUUID();
    return { mode, flowId, paymentRequestId: `MOCK-PR-${visitId}`, txHash: null, status: 'mock-settled' };
  }
  if (mode !== 'qa') throw new Error('HSP_MODE must be qa or mock');
  const hsp = client || mcpClient();
  const token = pickToken(await hsp.tool('get_chain_config', {}));
  const { prId, cart_mandate } = cart({ token, payTo, amountUsd, visitId, now: now() });
  const order = holder(await hsp.tool('create_order', { merchant_name: MERCHANT, pay_to: payTo, cart_mandate }), 'flow_id');
  const flowId = order.flow_id;
  if (typeof flowId !== 'string' || !flowId) throw new HspError('create_order returned no flow_id');
  if (order.payment_request_id && order.payment_request_id !== prId) throw new HspError('create_order changed the payment_request_id');
  log({ step: 'create_order', flowId, prId });
  const got = holder(await hsp.tool('get_order', { flow_id: flowId }), 'merchant_name');
  if (got.merchant_name !== MERCHANT || (got.payment_request_id && got.payment_request_id !== prId)) throw new Refused('get_order is not our order', got.merchant_name);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const prep = await hsp.tool('prepare_payment', { flow_id: flowId, payer, protocol: 'eip3009' });
    const typed = firewall(prep, { payer, payTo, token, amountUsd, now: now() });   // throws Refused: nothing is signed
    const p = holder(prep, 'eip712');
    log({ step: 'firewall_ok', flowId, raw: String(typed.message.value) });
    const signature = await signTypedData(typed);
    let fin;
    try {
      fin = holder(await hsp.tool('finalize_payment', { signature, payment_payload: p.payment_payload, payment_mandate_contents: p.payment_mandate_contents, cart_hash: p.cart_hash }), 'payment_mandate_json');
    } catch (e) { if (/quote|expired/i.test(e.message) && attempt < 3) continue; throw e; }
    if (!fin.payment_mandate_json) throw new HspError('finalize_payment returned no payment_mandate_json');
    try {
      await hsp.tool('submit_payment', { payment_mandate_json: fin.payment_mandate_json });
    } catch (e) {
      if (/quote|expired/i.test(e.message) && attempt < 3) continue;
      if (!(e instanceof HspError) || e.code === 403) throw e;   // a gateway answer: fall through to one query, never resubmit
    }
    log({ step: 'submitted', flowId });
    for (let i = 0; i < 40; i++) {
      let q;
      try { q = await hsp.tool('query_payment', { flow_id: flowId, payment_request_id: prId, expected_merchant_name: MERCHANT }); }
      catch (e) { if (i >= 4) throw e; await new Promise((r) => setTimeout(r, POLL_MS)); continue; }
      const { st, tx, att } = statusOf(q);
      if (st === 'payment-safe' || st === 'payment-finalized') return { mode, flowId, paymentRequestId: prId, txHash: tx, status: st, network: token.network, attributionVerified: att === true };
      if (st === 'payment-failed') throw new HspError('HSP payment failed for flow ' + flowId);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new HspError('HSP payment not settled in 10 min: query flow ' + flowId + ' later; never pay twice');
  }
  throw new HspError('quote kept expiring');
}
