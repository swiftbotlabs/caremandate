#!/bin/bash
# OFFLINE end-to-end of the REAL HSP qa code path, settling ON the local chain like HSP_NETWORK=hashkey-testnet would on HSK Chain:
#   anvil --chain-id 133 (local HSK-testnet stand-in) + a test EIP-3009 USDC installed at the HSK-testnet USDC address HSP's live
#   chain config names (0x8FE3cB71...) + CareMandate + Mina's mandate (45,000 won cap, rate from KRW_PER_USD at 1:1000)
#   + test/mock-hsp.mjs (HSP's MCP replies, live-shaped; checks every signature; its "gateway" broadcasts the signed
#   transferWithAuthorization on the local chain) + server.mjs (HSP_MODE=qa) + agency-watch.mjs (the agency's agent, on its own)
#   + the agency posts 5 visits and one over the cap (refused on chain) + Mum answers in the real page + Mina approves the held one.
#   bash test/e2e-offline-qa.sh                          expect: offline qa e2e PASS (scenario ok)
#   CM_SCENARIO=failed-once|timeout|overcharge bash ...  failure modes (gate: test/e2e-gate.mjs); each must PASS its own gate
#   CM_SCENARIO=review bash ...                          visit 4 has an odd note: Mina's agent holds it (no HSP order) until Mina
#                                                        presses "Pay anyway"; control: + REVIEW_OFF=1 -> paid unread, gate FAILS
#   CM_DROP_PAYTO=1 bash ...                             control: no AGENCY_PAYTO -> the server refuses to start, script fails
# No network. Output: $CM_RUNS/offline-<scenario>-<time>/
set -euo pipefail
cd "$(dirname "$0")/.."
export TMPDIR=${TMPDIR:-/tmp}
[ -d /data/motion/node_modules/playwright ] && export NODE_PATH=${NODE_PATH:-/data/motion/node_modules} PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/data/motion/pw-browsers}
SCEN=${CM_SCENARIO:-ok}
case $SCEN in ok|failed-once) MF=$SCEN;; timeout|overcharge) MF=$SCEN;; review) MF=ok; export CM_ODD_VISIT=${CM_ODD_VISIT:-4};; *) echo "unknown CM_SCENARIO $SCEN"; exit 2;; esac
[ "$MF" = ok ] && MF=''
OUTD=${CM_RUNS:-$PWD/../runs}/offline-$SCEN-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUTD"
PIDS=(); trap 'kill ${PIDS[@]} 2>/dev/null || true' EXIT
RPC=http://127.0.0.1:8545
anvil --port 8545 --chain-id 133 --silent & PIDS+=($!); sleep 2
export CM_LOCAL_CHAIN_ID=133 HSP_NETWORK=hashkey-testnet
# anvil's well-known public default test keys, used on the local anvil chain only
K=(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba)
export CM_NET=local DEPLOYER_PK=${K[0]} FAMILY_PK=${K[1]} FAMILY_AGENT_PK=${K[2]} AGENCY_PK=${K[3]}
export FAMILY_AGENT_ADDR=$(cast wallet address --private-key ${K[2]}) AGENCY_ADDR=$(cast wallet address --private-key ${K[3]})
export HSP_MODE=qa HSP_PAYER_PK=${K[4]} AGENCY_PAYTO=0x58232CF98671Bc0Bd0E7aaA7cd6adE9EdB2E64A6 HSP_POLL_MS=1000
PAYER=$(cast wallet address --private-key ${K[4]})
# the test USDC at HSP's HSK-testnet USDC address; 20 test USDC to the payer (like the QA payer's ~20 on Sepolia)
USDC=0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6
cast rpc anvil_setCode $USDC $(jq -r .deployedBytecode.object ../out/MockEIP3009.sol/MockEIP3009.json) --rpc-url $RPC > /dev/null
cast send $USDC "mint(address,uint256)" $PAYER 20000000 --private-key ${K[0]} --rpc-url $RPC > /dev/null
[ "$(cast call $USDC 'balanceOf(address)(uint256)' $PAYER --rpc-url $RPC | awk '{print $1}')" = 20000000 ] || { echo "test USDC not installed"; exit 3; }
[ -n "${CM_DROP_PAYTO:-}" ] && unset AGENCY_PAYTO
export MOCK_HSP_PORT=8795 MOCK_HSP_SETTLE_S=${MOCK_HSP_SETTLE_S:-6} HSP_MCP_URL=http://127.0.0.1:8795/ MOCK_HSP_FAIL=$MF MOCK_HSP_RPC=$RPC MOCK_HSP_GATEWAY_PK=${K[5]}
export HSP_RETRY_DELAYS_MS=3000,3000 HSP_RESUME_MS=4000
[ "$SCEN" = timeout ] && export HSP_SETTLE_MS=15000
node test/mock-hsp.mjs > "$OUTD/mock-hsp.log" 2>&1 & PIDS+=($!)
MUMPK=0x$(openssl rand -hex 32); MUM=$(cast wallet address --private-key $MUMPK)
export CM_STATE=$OUTD/state.json CM_SHOTS=$OUTD CM_CLICK_TIMEOUT=60000 CM_SETTLE_WAIT=${CM_SETTLE_WAIT:-180000}
OUT=$(KRW_PER_USD=1390 FX_SOURCE="fixed test rate (offline run)" node setup.mjs $MUM 45000 3); echo "$OUT" > "$OUTD/setup.json"
export CM_CONTRACT=$(echo "$OUT" | jq -r .contract) CM_MANDATE=1 PORT=8791 CM_FX_JSON=$(echo "$OUT" | jq -c .fx)
node ${CM_SERVER:-server.mjs} > "$OUTD/server.log" 2>&1 & SV=$!; PIDS+=($SV)
for i in $(seq 1 40); do curl -sf -o /dev/null http://127.0.0.1:8791/api/config && break; kill -0 $SV 2>/dev/null || break; sleep 0.25; done
curl -sf -o /dev/null http://127.0.0.1:8791/api/config || { echo "SERVER DID NOT START ($OUTD/server.log):"; cat "$OUTD/server.log"; exit 3; }
# the agency's own agent: watches PaymentSettled on chain, checks the transfer itself, acknowledges
SETTLE_RPC=$RPC SETTLE_TOKEN=$USDC SETTLE_CHAIN_ID=133 AGENCY_FROM_BLOCK=0 AGENCY_WATCH_MS=2000 node agency-watch.mjs > "$OUTD/agency-watch.log" 2>&1 & AW=$!; PIDS+=($AW)
NOW=$(cast block latest -f timestamp --rpc-url $RPC)
# each visit carries the carer's note (test/review-fixtures.mjs, re-timed to the visit); CM_ODD_VISIT=<n> gives visit n an odd note
i=0; for c in "Tue visit" "Thu visit" "Fri visit" "Sat visit" "Sun visit"; do i=$((i+1)); T=$((NOW-7200+i*60)); K=$(node test/note.mjs key $i "${CM_ODD_VISIT:-0}"); node agency.mjs 1 $T 45000 "Ji-woo" "$c: lunch, medicines, a short walk" "$(node test/note.mjs $K $T)" >> "$OUTD/agency.log"; done
# cap trip: a visit priced over Mina's 45,000-won cap must be refused by the contract (exit 4)
set +e; node agency.mjs 1 $((NOW-600)) 46000 "Ji-woo" "Mon visit, priced 46,000 won" > "$OUTD/captrip.json"; RC=$?; set -e
[ $RC = 4 ] || { echo "cap trip: expected refusal rc 4, got $RC"; cat "$OUTD/captrip.json"; exit 1; }
MUMPK=$MUMPK node test/mum-clicks.cjs 2>&1 | tee "$OUTD/result.log" || true   # the gate below decides
# give the agency's agent time to see the last settlement and acknowledge it (it polls every 2 s)
for i in $(seq 1 20); do [ "$(grep -c '"event":"ack"' "$OUTD/agency-watch.log" || true)" -ge "$(python3 -c "import json;print(sum(1 for p in json.load(open('$OUTD/state.json'))['payments'].values() if p.get('markPaidTx')))")" ] && break; sleep 1; done
curl -s http://127.0.0.1:8795/stats > "$OUTD/mock-stats.json"
[ "$SCEN" = timeout ] && { sleep 12; curl -s http://127.0.0.1:8795/stats > "$OUTD/mock-stats-later.json"; cp "$OUTD/state.json" "$OUTD/state-later.json"; }
python3 -c "
import json; s=json.load(open('$OUTD/state.json'))
for k,p in sorted(s['payments'].items()): print('visit',k,p.get('mode'),p.get('status'),p.get('kind'),p.get('flowId'),p.get('paidRaw'),p.get('txHash'),p.get('markPaidTx'),'attempts',len(p.get('attempts',[])))" | tee "$OUTD/payments.txt"
echo "mock: $(cat "$OUTD/mock-stats.json")"
kill -0 $AW 2>/dev/null || { echo "agency-watch exited early"; tail -3 "$OUTD/agency-watch.log"; exit 1; }
echo "run dir: $OUTD"
if [ "$SCEN" = ok ] || [ "$SCEN" = failed-once ] || [ "$SCEN" = review ]; then grep -q "E2E PASS" "$OUTD/result.log" || { echo "offline qa e2e FAILED (pages; $OUTD)"; exit 1; }; fi
# optional: build the record page from this offline run while the local chain is still up (tests app/demo-page.mjs + its tamper control)
if [ -n "${CM_DEMO_OUT:-}" ]; then
  DEMO_NET=local DEMO_SETTLE_RPC=$RPC DEMO_OFFLINE_GATES=${CM_DEMO_GATES:-} node demo-page.mjs "$OUTD" "$CM_DEMO_OUT" | tee "$OUTD/demo-page.log"
  if DEMO_TAMPER=1 DEMO_NET=local DEMO_SETTLE_RPC=$RPC node demo-page.mjs "$OUTD" "$OUTD/demo-tamper" > "$OUTD/demo-tamper.log" 2>&1; then echo "demo-page tamper control did NOT fail"; exit 1; fi
  grep -q "GATE FAIL" "$OUTD/demo-tamper.log" || { echo "demo-page tamper control failed for the wrong reason"; cat "$OUTD/demo-tamper.log"; exit 1; }
  echo "demo-page: built + tamper control fails closed"
fi
SETTLE_RPC=$RPC SETTLE_TOKEN=$USDC node test/e2e-gate.mjs "$OUTD" $SCEN | tee "$OUTD/gate.json" && echo "offline qa e2e PASS ($SCEN): $OUTD" || { echo "offline qa e2e FAILED ($SCEN; $OUTD)"; exit 1; }
