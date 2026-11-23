# HSP QA relay

HSP's QA MCP server admits callers by egress IP. A home connection's IP changes every few days, so the app reaches HSP through
this relay, deployed on a host with fixed outbound addresses, and those host addresses go on HSP's allowlist.

- Forwards only `POST /` to `UPSTREAM` (default `https://mcp-qa.hashkeymerchant.com/`), only with header `x-relay-token: $RELAY_TOKEN`.
- Passes through `content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version`; nothing else. `GET /health` answers `ok`.
- Holds no keys: the payer signs in the app; the relay sees only the JSON-RPC traffic.
- Zero dependencies, Node 20+. Tests: `npm test` (fake upstream, 4 cases).

Deploy (Render, free web service): root directory `relay`, build command empty, start command `node server.mjs`, env `RELAY_TOKEN`
(40+ random chars). Then the app runs with `HSP_MCP_URL=https://<service>.onrender.com/ HSP_RELAY_TOKEN=<same token>`.
