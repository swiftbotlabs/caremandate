# CareMandate

**Pay mum's carer only for the visits that happened.**

Mina works in Seoul. Her mother lives in Busan, and a carer comes three times a week. Mina pays per visit, but from 300 km away she
can't tell whether Tuesday's visit happened, and paying a month up front means paying for visits that were missed.

CareMandate gives each side an agent:
- the **care agency's agent** reports each visit (who came, when, what was done; the receipt's hash goes on chain);
- **Mum** answers one question on a big-button tablet page: "Did Ji-woo visit you on Tuesday?" Yes or No. The tablet signs her answer
  (EIP-712) with its own key; she needs no wallet and no gas;
- **Mina's agent** pays that one visit through **HSP** (HashKey Settlement Platform), and only after Mum says yes.

A missed visit is never paid. A fourth visit in a week waits for Mina. Nobody but Mina can change who gets paid or how much.

## What is here
| Path | What it does |
|---|---|
| `src/CareMandate.sol` | The rules on HSK Chain: Mina's mandate (agency, family agent, Mum's confirm key, per-visit cap, visits per week), visit receipts (each posted once), Mum's signed answer, the weekly limit (a 4th visit is held for Mina), and `markPaid` with the HSP payment reference. It holds no money. |
| `test/CareMandate.t.sol` | Foundry tests: confirmed visit paid once; unconfirmed or missed visits never paid; 4th visit held; stranger signatures, over-cap and replayed receipts refused; role checks; late and future confirmations refused; paused mandate. |
| `app/server.mjs` | Mina's agent: relays Mum's signed answer (it pays the gas), pays confirmed visits through HSP, records the HSP reference on chain, and serves Mum's page (`/mum`) and Mina's page (`/mina`). |
| `app/agency.mjs` | The agency's agent: posts one visit receipt. |
| `app/lib/hsp.mjs` | HSP Agentic Payment client (MCP over HTTP): order, then a **signing firewall** that checks HSP's EIP-712 data against our own order (payee = the agency, amount, token, chain, payer, time window, the x402 payload) before anything is signed, then finalize, submit and poll until HSP reports the payment safe. `HSP_MODE=mock` is a local stand-in, labelled MOCK everywhere and refused on mainnet. |
| `app/test/hsp.test.mjs` | Offline tests of the HSP flow on real replies from HSP's QA server (`app/test/fixtures`), with real signatures; each firewall rule has a test that fails when the rule is removed. |
| `app/test/e2e-local.sh` | The whole story on a local chain: deploy, mandate, 5 visits, Mum answers in the real page (yes, no, yes, yes, yes), Mina approves the held visit. |
| `app/test/e2e-testnet.sh` | The same on HSK Chain testnet with real HSP payments. |
| `app/hsp-probe.mjs` | One HSP payment, or `--dry` to stop before signing. |

## Run it
Needs Foundry and Node 20+.
```bash
forge test                         # contract tests
cd app && npm install && npm test  # HSP flow tests (offline)
bash test/e2e-local.sh             # local chain + Playwright (npm i playwright; npx playwright install chromium)
```
Environment for the server: `CM_NET` (local, testnet, mainnet), `CM_CONTRACT`, `CM_MANDATE`, `FAMILY_AGENT_PK`, `FAMILY_PK`,
`AGENCY_PAYTO`, `HSP_MODE` (qa or mock), `HSP_PAYER_PK`, `HSP_AMOUNT_USD` (default 0.01), `PORT`.

## HSP
HSP's QA environment is open to hackathon teams by IP allowlist. Its test payments settle in test USDC on Base Sepolia (HSK Chain
testnet USDC can't be minted by teams), so the visit records live on HSK Chain and the money moves through HSP. Every payment is reported
under the team name `Swift Bot Labs (CareMandate)`.

## Status
- Contract and app: working on a local chain (`e2e-local.sh` passes).
- HSP: client and tests ready; waiting for HSP to allowlist our IP for the QA server.
- HSK Chain mainnet deployment: after the testnet run with real HSP payments.

## License
MIT (see LICENSE). `lib/forge-std` is Foundry's standard library under its own license.
