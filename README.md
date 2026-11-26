# CareMandate

**Pay mum's carer only for the visits that happened.**

> **Judge path (2 minutes).** Run `git clone https://github.com/swiftbotlabs/caremandate && cd caremandate/app && npm ci && npm test` (Node 20+, offline).
> Expect `# pass 39` and `# fail 0`: the HSP signing firewall on real HSP QA replies, the won-to-USDC limits, Mina's agent holding an odd visit note, and the agent-to-agent make-up rules (an offer outside Mina's rules is refused).
> Then open the record of the real run, re-checked on chain, with a "Check on HSK Chain now" button: https://apps.swiftbotlab.workers.dev/caremandate/

Mina works in Seoul. Her mother lives in Busan, and a carer comes three times a week. Mina pays per visit, but from 300 km away she
can't tell whether Tuesday's visit happened, and paying a month up front means paying for visits that were missed.

CareMandate gives each side an agent:
- the **care agency's agent** reports each visit (who came, when, what was done; the receipt's hash goes on chain);
- **Mum** answers one question on a big-button tablet page: "Did Ji-woo visit you on Tuesday?" Yes or No. The tablet signs her answer
  (EIP-712) with its own key; she needs no wallet and no gas;
- **Mina's agent** reads the carer's visit note, then pays that one visit through **HSP** (HashKey Settlement Platform), and only after
  Mum says yes. If the note looks wrong (a task skipped, the wrong time, a short visit, a fall, talk of cash on the side, text aimed at the
  agent) it **holds** the payment and tells Mina why; nothing is ordered from HSP until she presses "Pay anyway".

A missed visit is never paid. A fourth visit in a week waits for Mina. A visit priced over Mina's cap (45,000 won) is refused on chain.
Nobody but Mina can change who gets paid or how much. When HSP fails or is slow after Mum's yes, the visit stays **Confirmed and unpaid** on
chain, both pages say so, and it is never paid twice. The agency's agent checks each settlement itself and acknowledges it on chain.

## What is here
| Path | What it does |
|---|---|
| `src/CareMandate.sol` | The rules on HSK Chain: Mina's mandate (agency, family agent, Mum's confirm key, per-visit cap in won, visits per week, and the **won to USDC rate**), visit receipts (each posted once; over the cap refused), Mum's signed answer, the weekly limit (a 4th visit is held for Mina), `markPaid` with the HSP payment reference, the amount paid and the settlement tx (refused above the visit's won price at the mandate rate + 5%), `notePaymentIssue` (a failed or unsettled HSP attempt; the visit stays Confirmed and unpaid) and `ackPaid` (the agency's agent confirms receipt). It holds no money. |
| `test/CareMandate.t.sol` | Foundry tests (15): confirmed visit paid once; unconfirmed or missed visits never paid; 4th visit held; stranger signatures, over-cap and replayed receipts refused; the conversion (45,000 won -> at most 32,375 USDC units at the test rate) and an over-mandate payment refused; payment issues keep a visit unpaid, then it pays once; only the agency acknowledges, once, and never a mock payment; role checks; late and future confirmations; paused mandate. |
| `app/server.mjs` | Mina's agent: relays Mum's signed answer (it pays the gas), pays confirmed visits through HSP, records the HSP reference on chain, and serves Mum's page (`/mum`) and Mina's page (`/mina`). |
| `app/agency.mjs` | The agency's agent: posts one visit receipt with the carer's note (its hash goes on chain; exit 4 with the contract's reason when refused, e.g. over the cap). |
| `app/lib/review.mjs` | Mina's agent reads the note before paying. Rules always run (every task of her care plan reported done and not negated, arrival time = the visit time on chain, at least 60 minutes, no worrying words, no text addressed to the agent, note = the hash on chain). A language model (default `openai/gpt-oss-20b` on Groq's free tier, any OpenAI-style endpoint via `REVIEW_LLM_URL`/`REVIEW_LLM_MODEL`/`REVIEW_LLM_KEY`) reads it too. The model can only add a hold, never lift one; if it is off, slow or answers badly, the rules decide and the record says so. The decision, its source and the reasons go to `state.json` and `server.log` and show on both pages. |
| `app/test/review.test.mjs` | Note review tests (offline, the model stubbed): normal notes paid; the odd note held, and paid when the check is switched off (`REVIEW_OFF=1`, a local-only test switch); tampered or missing notes held; the model can add but not remove a hold; broken model replies fall back to the rules. `app/review-probe.mjs` runs the same notes against the live model (`evidence/review-probe-live-20261126.json`). |
| `app/agency-watch.mjs` | The agency's agent on its own: watches `PaymentSettled` / `PaymentIssue` on HSK Chain, checks the settlement transfer itself on HSP's network (one transfer of the right token, to its pay-to, for exactly the recorded amount) and only then calls `ackPaid`. One log line per check; exits non-zero after repeated failed checks. |
| `app/lib/fx.mjs` | Won to USDC: the same arithmetic as the contract. `setup.mjs` puts the rate on chain from today's ECB KRW/USD reference rate (`CM_FX_FETCH=1`) or `KRW_PER_USD`; testnet pays 1/1000 of the real price (`CM_TEST_SCALE`), so 45,000 won is $0.03 test USDC (about $33 at full scale). |
| `app/lib/hsp.mjs` | HSP Agentic Payment client (MCP over HTTP): order, then a **signing firewall** that checks HSP's EIP-712 data against our own order (payee = the agency, amount, token, chain, payer, time window, the x402 payload) before anything is signed, then finalize, submit and poll until HSP reports the payment safe. `HSP_MODE=mock` is a local stand-in, labelled MOCK everywhere and refused on mainnet. |
| `app/test/hsp.test.mjs` | Offline tests of the HSP flow on real replies from HSP's QA server (`app/test/fixtures`), with real signatures; each firewall rule has a test that fails when the rule is removed. |
| `app/test/e2e-local.sh` | The whole story on a local chain: deploy, mandate, 5 visits, Mum answers in the real page (yes, no, yes, yes, yes), Mina approves the held visit. |
| `app/test/e2e-offline-qa.sh` | One command, no network: anvil as chain 133 with a test EIP-3009 USDC at HSP's HSK-testnet USDC address, the real HSP client code path (`HSP_MODE=qa`, `HSP_NETWORK=hashkey-testnet`) against a local HSP stand-in (`app/test/mock-hsp.mjs`: checks every signature, its gateway settles the signed transfer on the local chain), the agency's watcher, a cap-trip visit and Mum's real page. Gate: `app/test/e2e-gate.mjs` reads the chain. Note review: `CM_SCENARIO=review` (visit 4's note is odd: held until Mina presses Pay anyway; with `REVIEW_OFF=1` the gate fails). Agent to agent: `CM_SCENARIO=a2a` (after Mum's No, the agency's agent offers make-up slots to Mina's agent: EIP-712 offers and answers signed with the mandate's keys, every answer anchored on chain; the evening offer in a full week is declined, a next-week slot accepted; the chain moves to the slot, the agreed make-up is paid, a second visit on the same agreement is held; with `A2A_RULES_OFF=1` the gate fails). Failure modes: `CM_SCENARIO=failed-once` (HSP payment-failed, automatic retry, paid once), `timeout` (never confirmed: the same flow is queried, never re-signed), `overcharge` (the signing firewall refuses). Control: `CM_DROP_PAYTO=1`. |
| `app/test/e2e-testnet.sh` | The same on HSK Chain testnet with real HSP payments, settling on HSK Chain (`hashkey-testnet`) when the payer holds that USDC, else on Sepolia. |
| `app/mainnet-visit.sh` | One visit cycle on HSK Chain mainnet against the deployed contract: the agency posts a visit with its note, Mum's tablet key signs yes (`app/mum-sign.mjs`, checked against the contract's `confirmDigest`), Mina's agent reads the note and pays through HSP, `markPaid`, then the agency's `ackPaid`; read back by `app/mainnet-visit-check.mjs`. `--fork` rehearses it on a local fork of mainnet with a local Sepolia stand-in (`evidence/fork-visit-20261126T042454Z/`: 4 txs, 341,508 gas, about 0.13-0.17 HSK). `--live` has guards: chain, gas price, roles, balances, once only, a spend cap. |
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
`AGENCY_PAYTO`, `HSP_MODE` (qa or mock), `HSP_PAYER_PK`, `HSP_NETWORK` (sepolia or hashkey-testnet), `CM_FX_JSON` (display only), `PORT`,
`CM_CARE_PLAN` (JSON: `tasks`, `minMinutes`, `startToleranceMin`; default lunch, medicines, walk, 60, 45), `REVIEW_LLM_KEY` (optional; without it the rules decide alone).
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
faucet, so the payer must be funded with it first. `CM_FORK_HSKTESTNET=1 bash app/test/e2e-offline-qa.sh` runs the whole flow on a local fork of
HSK testnet and settles through the real HSK-testnet USDC contract (`evidence/offline-ok-hskfork-20261126T042925Z/`). Otherwise payments settle in Circle test USDC on Ethereum Sepolia. Every payment is reported
under the team name `Swift Bot Labs (CareMandate)`.

## What's real, what's test money, what's simulated
| Part | In the published runs | Where to check |
|---|---|---|
| CareMandate contract | **Real**, on HSK Chain testnet (run) and HSK Chain **mainnet** (`0x1173…11c3`, source verified) | tx links on the record page |
| Mum's Yes/No | **Real** EIP-712 signature from the tablet page's own key, checked on chain (`confirmBySig`) | `confirmTx` per visit |
| HSP payments | **Real** HSP QA orders and settlements, paid in Circle **test** USDC on Ethereum Sepolia (no real-money value) | HSP flow id + Sepolia tx per visit |
| Agency's receipt check | **Real**: its agent reads the settlement transfer itself, then `ackPaid` on chain | `ackTx` per visit |
| Mina's note review | **Real**: rules always; a hosted model (`openai/gpt-oss-20b`, free tier) can add a hold, never lift one | `review` lines in `server.log` |
| People and visits | **Simulated**: Mina, Mum, Ji-woo and the agency are test personas; the visits are scripted by `app/test/e2e-testnet.sh` | the script |
| Won amounts | Mandate at real scale on mainnet (45,000 won); testnet runs at 1:1000 scale; the mainnet visit was a token 1,000 won | `setup.json`, `visit.json` |
| HSK-testnet settlement | **Not yet**: works on a local fork of HSK testnet through the real USDC contract; waits on HSK-testnet USDC | `evidence/offline-ok-hskfork-*` |

## Status
<!-- STATUS:BEGIN -->
- Full run on **HSK Chain testnet with real HSP QA payments settling in Circle test USDC on Ethereum Sepolia** (26 Nov 2026, 07:34-07:47 UTC (16:34-16:47 KST); contract `0xc9208fd8a7bc9601dc5f73d487c4f1468da6accf`):
  5 visits; Mum said Yes to 4 and No to 1; visits 1, 3, 4, 5 paid through HSP (each `payment-safe`, 0.12 test USDC in total, the
  settlement tx and the amount recorded by `markPaid` on HSK Chain); each payment acknowledged on chain by the agency's own agent after it
  checked the transfer itself; a 46,000-won visit refused by the contract (cap 45,000 won); mandate rate 743273 USDC units
  per 1,000,000 won (1345.4 KRW/USD, ECB reference rate via api.frankfurter.dev, 2026-11-25, testnet scale 1:1000).
  Mina's agent read every confirmed visit's note before paying (4 reviewed, 1 held for Mina: visit 4, paid only after she pressed Pay anyway). Record:
  https://apps.swiftbotlab.workers.dev/caremandate/ (built by `app/demo-page.mjs`, which re-checks every fact on chain first). Run files:
  `evidence/testnet-20261126T0733Z/`. Failure modes and the note review (offline, one command each): `evidence/offline-*/gate.json`.
- HSK Chain mainnet: CareMandate v2 at `0x1173198761ac17f8e40f97973a1e4ed0419a11c3` (deploy tx 0x637bdb78abf2b720f102e75a806f4435f2033ab237ce7c672419e6a10f48c03c, mandate tx 0xc3efa44c821848e6c75367660f9166a5ef4810cd205a22baf5b94b61a6579678; source verified: https://hsk.blockscout.com/address/0x1173198761ac17f8e40f97973a1e4ed0419a11c3), Mina's mandate at real scale (45,000 won a visit, 1345.4 KRW/USD on chain, at most $33.44 a visit); `evidence/mainnet-20261126T0242Z/`.
- One visit cycle on HSK Chain mainnet (26 Nov 2026, 04:37-04:40 UTC (13:37-13:40 KST)): the agency posted a 1,000-won visit, Mum's tablet signed yes, Mina's agent read the note (pay, model+rules) and paid it through HSP QA (flow `6e669cc5-4e6d-4eaa-9779-46066064a7c3`, 0.74 test USDC on Ethereum Sepolia), `markPaid` recorded it and the agency's agent acknowledged it on chain; `evidence/mainnet-visit-20261126T0437Z/`.
<!-- STATUS:END -->

**Visit by visit (26 Nov 07:34 UTC run):** 1 paid · 2 Mum said No, never paid (the two agents agreed a make-up for Thu 3 Dec 09:00 KST) · 3 paid · 4 Mum said Yes but Mina's agent held it for its note (wrong time, 20 minutes, no walk), paid only after Mina pressed Pay anyway · 5 the week's 4th visit, held by the contract (limit 3 a week) until Mina approved, then paid. So 4 paid + 1 not paid = 5. Separately, a 46,000-won visit was refused by the contract (over the 45,000-won cap) and never became a visit.
The mainnet visit cycle settled through HSP QA in **test USDC on Ethereum Sepolia**: no real money moved; mainnet holds the real-scale mandate and the visit records.

## License
MIT (see LICENSE). `lib/forge-std` is Foundry's standard library under its own license.
