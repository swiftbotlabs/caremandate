import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
// fake upstream that echoes what it got
const up = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
  res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'S1', 'set-cookie': 'x=1' });
  res.end(JSON.stringify({ path: req.url, body: b, sid: req.headers['mcp-session-id'] || null, tok: req.headers['x-relay-token'] || null })); }); });
await new Promise((r) => up.listen(0, r));
process.env.UPSTREAM = `http://127.0.0.1:${up.address().port}/`;
process.env.RELAY_TOKEN = 'a'.repeat(40);
const { server } = await import('./server.mjs');
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); up.close(); });
const T = { 'x-relay-token': 'a'.repeat(40), 'content-type': 'application/json' };

test('forwards POST with token, passes MCP headers only, drops the token upstream', async () => {
  const r = await fetch(base + '/', { method: 'POST', headers: { ...T, 'mcp-session-id': 'abc' }, body: '{"x":1}' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('mcp-session-id'), 'S1');
  assert.equal(r.headers.get('set-cookie'), null);
  const j = await r.json();
  assert.deepEqual(j, { path: '/', body: '{"x":1}', sid: 'abc', tok: null });
});
test('wrong or missing token -> 401', async () => {
  assert.equal((await fetch(base + '/', { method: 'POST', headers: { 'x-relay-token': 'b'.repeat(40) }, body: '{}' })).status, 401);
  assert.equal((await fetch(base + '/', { method: 'POST', body: '{}' })).status, 401);
});
test('other paths and methods -> 404; health ok', async () => {
  assert.equal((await fetch(base + '/etc', { method: 'POST', headers: T, body: '{}' })).status, 404);
  assert.equal((await fetch(base + '/')).status, 404);
  assert.equal(await (await fetch(base + '/health')).text(), 'ok');
});
test('body cap -> 413', async () => {
  const r = await fetch(base + '/', { method: 'POST', headers: T, body: 'x'.repeat(300 * 1024) }).catch(() => null);
  assert.ok(!r || r.status === 413);
});
