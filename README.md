# CareMandate

**Pay mum's carer only for the visits that happened.**

Mina works in Seoul. Her mother lives in Busan, and a carer comes three times a week. Mina pays per visit, but from 300 km away she
can't tell whether Tuesday's visit happened, and paying a month up front means paying for visits that were missed.

CareMandate gives each side an agent:
- the **care agency's agent** reports each visit (who came, when, what was done; the receipt's hash goes on chain);
- **Mum** answers one question on a big-button tablet page: "Did Ji-woo visit you on Tuesday?" Yes or No. The tablet signs her answer
  (EIP-712) with its own key; she needs no wallet and no gas;
- **Mina's agent** pays that one visit through **HSP** (HashKey Settlement Platform), and only after Mum says yes.

A missed visit is never paid. A fourth visit in a week waits for Mina. A visit priced over Mina's cap (45,000 won) is refused on chain.
Nobody but Mina can change who gets paid or how much. When HSP fails or is slow after Mum's yes, the visit stays **Confirmed and unpaid** on
chain, both pages say so, and it is never paid twice. The agency's agent checks each settlement itself and acknowledges it on chain.

## What is here
| Path | What it does |
|---|---|
| `src/CareMandate.sol` | The rules on HSK Chain: Mina's mandate (agency, family agent, Mum's confirm key, per-visit cap in won, visits per week, and the **won to USDC rate**), visit receipts (each posted once; over the cap refused), Mum's signed answer, the weekly limit (a 4th visit is held for Mina), `markPaid` with the HSP payment reference, the amount paid and the settlement tx (refused above the visit's won price at the mandate rate + 5%), `notePaymentIssue` (a failed or unsettled HSP attempt; the visit stays Confirmed and unpaid) and `ackPaid` (the agency's agent confirms receipt). It holds no money. |
| `test/CareMandate.t.sol` | Foundry tests (15): confirmed visit paid once; unconfirmed or missed visits never paid; 4th visit held; stranger signatures, over-cap and replayed receipts refused; the conversion (45,000 won -> at most 32,375 USDC units at the test rate) and an over-mandate payment refused; payment issues keep a visit unpaid, then it pays once; only the agency acknowledges, once, and never a mock payment; role checks; late and future confirmations; paused mandate. |
| `app/server.mjs` | Mina's agent: relays Mum's signed answer (it pays the gas), pays confirmed visits through HSP, records the HSP reference on chain, and serves Mum's page (`/mum`) and Mina's page (`/mina`). |
| `app/agency.mjs` | The agency's agent: posts one visit receipt (exit 4 with the contract's reason when refused, e.g. over the cap). |
| `app/agency-watch.mjs` | The agency's agent on its own: watches `PaymentSettled` / `PaymentIssue` on HSK Chain, checks the settlement transfer itself on HSP's network (one transfer of the right token, to its pay-to, for exactly the recorded amount) and only then calls `ackPaid`. One log line per check; exits non-zero after repeated failed checks. |
| `app/lib/fx.mjs` | Won to USDC: the same arithmetic as the contract. `setup.mjs` puts the rate on chain from today's ECB KRW/USD reference rate (`CM_FX_FETCH=1`) or `KRW_PER_USD`; testnet pays 1/1000 of the real price (`CM_TEST_SCALE`), so 45,000 won is $0.03 test USDC (about $33 at full scale). |
| `app/lib/hsp.mjs` | HSP Agentic Payment client (MCP over HTTP): order, then a **signing firewall** that checks HSP's EIP-712 data against our own order (payee = the agency, amount, token, chain, payer, time window, the x402 payload) before anything is signed, then finalize, submit and poll until HSP reports the payment safe. `HSP_MODE=mock` is a local stand-in, labelled MOCK everywhere and refused on mainnet. |
| `app/test/hsp.test.mjs` | Offline tests of the HSP flow on real replies from HSP's QA server (`app/test/fixtures`), with real signatures; each firewall rule has a test that fails when the rule is removed. |
| `app/test/e2e-local.sh` | The whole story on a local chain: deploy, mandate, 5 visits, Mum answers in the real page (yes, no, yes, yes, yes), Mina approves the held visit. |
| `app/test/e2e-offline-qa.sh` | One command, no network: anvil as chain 133 with a test EIP-3009 USDC at HSP's HSK-testnet USDC address, the real HSP client code path (`HSP_MODE=qa`, `HSP_NETWORK=hashkey-testnet`) against a local HSP stand-in (`app/test/mock-hsp.mjs`: checks every signature, its gateway settles the signed transfer on the local chain), the agency's watcher, a cap-trip visit and Mum's real page. Gate: `app/test/e2e-gate.mjs` reads the chain. Failure modes: `CM_SCENARIO=failed-once` (HSP payment-failed, automatic retry, paid once), `timeout` (never confirmed: the same flow is queried, never re-signed), `overcharge` (the signing firewall refuses). Control: `CM_DROP_PAYTO=1`. |
| `app/test/e2e-testnet.sh` | The same on HSK Chain testnet with real HSP payments, settling on HSK Chain (`hashkey-testnet`) when the payer holds that USDC, else on Sepolia. |
| `app/test/fork-mainnet-rehearsal.sh` | The mainnet deploy rehearsed on a fork of HSK Chain mainnet (chain 177) at real scale, priced in USD from live gas and HSK prices. |
| `app/hsp-probe.mjs` | One HSP payment, or `--dry` to stop before signing. |
| `app/demo-page.mjs` | Builds the read-only record page of a run (`demo/`): every value re-checked on HSK Chain and Sepolia first. |

## Run it
Needs Foundry and Node 20+.
```bash
forge test                         # contract tests
cd app && npm install && npm test  # HSP flow tests (offline)
bash test/e2e-local.sh             # local chain + Playwright (npm i playwright; npx playwright install chromium)
bash test/e2e-offline-qa.sh        # local chain + the real HSP client against a local HSP stand-in
```
Environment for the server: `CM_NET` (local, testnet, mainnet), `CM_CONTRACT`, `CM_MANDATE`, `FAMILY_AGENT_PK`, `FAMILY_PK`,
`AGENCY_PAYTO`, `HSP_MODE` (qa or mock), `HSP_PAYER_PK`, `HSP_NETWORK` (sepolia or hashkey-testnet), `CM_FX_JSON` (display only), `PORT`.
The amount asked of HSP comes from the visit's won price at the mandate's on-chain rate, rounded down to the cent. With `HSP_MODE=qa` the server will not
start without `AGENCY_PAYTO` and `HSP_PAYER_PK`. A real HSP payment takes about 3 minutes to reach `payment-safe`, so Mum's answer is
acknowledged as soon as it is on chain and the payment runs in the background, shown as pending on both pages. `server.log` has one JSON
line per request and per payment step (never keys); the HSP flow id is saved before the payment is signed, so a visit is never paid twice.

When HSP fails after Mum's yes (`app/server.mjs`):
| What happened | Money moved? | What the agent does |
|---|---|---|
| The signing firewall refused HSP's quote | no, nothing signed | `PaymentIssue(RefusedBySigningFirewall)` on chain; Mina can retry on her page |
| Failed before HSP had the signed payment | no | `PaymentIssue(FailedBeforeSubmit)`; automatic retry (1 min, then 5 min), then Mina's button |
| HSP says `payment-failed`, no tx | no | `PaymentIssue(HspPaymentFailed)`; automatic retry with a new flow |
| HSP has not confirmed in 20 min | unknown | `PaymentIssue(Unsettled)`; the same flow is queried again every minute; never signed again |
A retry of a flow HSP already had first asks HSP about that flow: if it settled after all, it is recorded as paid and no new payment is made.

## HSP
HSP's QA environment is open to hackathon teams by IP allowlist. Its live `get_chain_config` (read 25 Nov 2026) offers sepolia, hashkey-testnet,
bsc-testnet, base-sepolia and arbitrum-sepolia; on `hashkey-testnet` (chain 133) the EIP-3009 token is USDC `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6`
(`app/test/fixtures/live_chain_config_20261125.json`). `HSP_NETWORK=hashkey-testnet` settles on HSK Chain itself; that USDC has no public
faucet, so the payer must be funded with it first. Otherwise payments settle in Circle test USDC on Ethereum Sepolia. Every payment is reported
under the team name `Swift Bot Labs (CareMandate)`.

## Status
<!-- STATUS:BEGIN -->
- Full run on **HSK Chain testnet with real HSP QA payments settling in Circle test USDC on Ethereum Sepolia** (25 Nov 2026, contract `0xa95ac53799f6770a2a907487edc367c26795fd26`):
  5 visits; Mum said Yes to 4 and No to 1; visits 1, 3, 4, 5 paid through HSP (each `payment-safe`, 0.12 test USDC in total, the
  settlement tx and the amount recorded by `markPaid` on HSK Chain); each payment acknowledged on chain by the agency's own agent after it
  checked the transfer itself; a 46,000-won visit refused by the contract (cap 45,000 won); mandate rate 743273 USDC units
  per 1,000,000 won (1345.4 KRW/USD, ECB reference rate via api.frankfurter.dev, 2026-11-25, testnet scale 1:1000). Record:
  https://apps.swiftbotlab.workers.dev/caremandate/ (built by `app/demo-page.mjs`, which re-checks every fact on chain first). Run files:
  `evidence/testnet-20261125T1718Z/`. Failure modes (offline, one command each): `evidence/offline-*/gate.json`.
- HSK Chain mainnet: rehearsed on a fork of mainnet (`app/test/fork-mainnet-rehearsal.sh`, `evidence/fork-mainnet-*/rehearsal.json`); deployed when we are selected for the demo, as the rules require of demo teams.
<!-- STATUS:END -->

## License
MIT (see LICENSE). `lib/forge-std` is Foundry's standard library under its own license.
