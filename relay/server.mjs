// HSP QA relay: a tiny fixed-egress forwarder for the HSP Agentic Payment QA MCP server, which allowlists callers by egress IP.
// Runs on a host whose outbound IPs are fixed (e.g. a Render web service); our app points HSP_MCP_URL at it.
// It forwards ONLY POST / to the one upstream URL, ONLY with the right x-relay-token, and passes through just the MCP headers.
// No keys live here: signing stays in the app. Zero dependencies (Node >= 20).
import http from 'node:http';
import crypto from 'node:crypto';

const UPSTREAM = process.env.UPSTREAM || 'https://mcp-qa.hashkeymerchant.com/';
const TOKEN = process.env.RELAY_TOKEN || '';
const PORT = Number(process.env.PORT || 10000);
const MAX_BODY = 256 * 1024;
const PASS_REQ = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'];
const PASS_RES = ['content-type', 'mcp-session-id'];

if (TOKEN.length < 32) { console.error('RELAY_TOKEN missing or shorter than 32 chars; refusing to start'); process.exit(1); }
const tokenOk = (t) => typeof t === 'string' && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));

export const server = http.createServer(async (req, res) => {
  const send = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(msg); };
  if (req.method === 'GET' && req.url === '/health') return send(200, 'ok');
  if (req.method !== 'POST' || req.url !== '/') return send(404, 'not found');
  if (!tokenOk(req.headers['x-relay-token'])) return send(401, 'unauthorized');
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(413, 'too large'); chunks.push(c); }
  const headers = {};
  for (const h of PASS_REQ) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];
  let up;
  try { up = await fetch(UPSTREAM, { method: 'POST', headers, body: Buffer.concat(chunks), signal: AbortSignal.timeout(55000) }); }
  catch (e) { return send(502, 'upstream unreachable'); }
  const out = {};
  for (const h of PASS_RES) { const v = up.headers.get(h); if (v) out[h] = v; }
  res.writeHead(up.status, out);
  res.end(Buffer.from(await up.arrayBuffer()));
});
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT, () => console.log(`hsp relay on :${PORT} -> ${new URL(UPSTREAM).host}`));
}
