#!/bin/bash
# OFFLINE end-to-end of the REAL HSP qa code path: anvil (local HSK stand-in) + deploy + mandate + server.mjs with HSP_MODE=qa pointed at
# test/mock-hsp.mjs (HSP's MCP replies, live-shaped; checks every signature) + the agency posts 5 visits + Mum answers in the real page
# (yes/no/yes/yes/yes) + Mina approves the held one. Same /api/confirm path and the same env names as test/e2e-testnet.sh. No network.
#   bash test/e2e-offline-qa.sh                      expect: E2E PASS, 4 payments payment-safe, 4 signatures verified by the mock
#   MOCK_HSP_FAIL=failed|query bash test/e2e-offline-qa.sh   control: the failure is logged in server.log and shown on both pages
#   CM_DROP_PAYTO=1 bash test/e2e-offline-qa.sh      control: no AGENCY_PAYTO -> the server refuses to start, says why, script fails
# Env: NODE_PATH / PLAYWRIGHT_BROWSERS_PATH if playwright is installed outside app/. Output: $CM_RUNS/offline-<time>/
set -euo pipefail
cd "$(dirname "$0")/.."
export TMPDIR=${TMPDIR:-/tmp}
[ -d /data/motion/node_modules/playwright ] && export NODE_PATH=${NODE_PATH:-/data/motion/node_modules} PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/data/motion/pw-browsers}
OUTD=${CM_RUNS:-$PWD/../runs}/offline-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUTD"
PIDS=(); trap 'kill ${PIDS[@]} 2>/dev/null || true' EXIT
anvil --port 8545 --silent & PIDS+=($!); sleep 2
# anvil's well-known public default test keys, used on the local anvil chain only
K=(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a)
export CM_NET=local DEPLOYER_PK=${K[0]} FAMILY_PK=${K[1]} FAMILY_AGENT_PK=${K[2]} AGENCY_PK=${K[3]}
export FAMILY_AGENT_ADDR=$(cast wallet address --private-key ${K[2]}) AGENCY_ADDR=$(cast wallet address --private-key ${K[3]})
export HSP_MODE=qa HSP_PAYER_PK=${K[4]} AGENCY_PAYTO=0x58232CF98671Bc0Bd0E7aaA7cd6adE9EdB2E64A6 HSP_POLL_MS=1000
[ -n "${CM_DROP_PAYTO:-}" ] && unset AGENCY_PAYTO
export MOCK_HSP_PORT=8795 MOCK_HSP_SETTLE_S=${MOCK_HSP_SETTLE_S:-8} HSP_MCP_URL=http://127.0.0.1:8795/
node test/mock-hsp.mjs > "$OUTD/mock-hsp.log" 2>&1 & PIDS+=($!)
MUMPK=0x$(openssl rand -hex 32); MUM=$(cast wallet address --private-key $MUMPK)
export CM_STATE=$OUTD/state.json CM_SHOTS=$OUTD CM_CLICK_TIMEOUT=60000 CM_SETTLE_WAIT=${CM_SETTLE_WAIT:-180000}
OUT=$(node setup.mjs $MUM 45000 3); echo "$OUT" > "$OUTD/setup.json"
export CM_CONTRACT=$(echo "$OUT" | python3 -c "import json,sys;print(json.load(sys.stdin)['contract'])") CM_MANDATE=1 PORT=8791
node ${CM_SERVER:-server.mjs} > "$OUTD/server.log" 2>&1 & SV=$!; PIDS+=($SV)
for i in $(seq 1 40); do curl -sf -o /dev/null http://127.0.0.1:8791/api/config && break; kill -0 $SV 2>/dev/null || break; sleep 0.25; done
curl -sf -o /dev/null http://127.0.0.1:8791/api/config || { echo "SERVER DID NOT START ($OUTD/server.log):"; cat "$OUTD/server.log"; exit 3; }
NOW=$(cast block latest -f timestamp --rpc-url http://127.0.0.1:8545)
i=0; for c in "Tue visit" "Thu visit" "Fri visit" "Sat visit" "Sun visit"; do i=$((i+1)); node agency.mjs 1 $((NOW-7200+i*60)) 45000 "Ji-woo" "$c: lunch, medicines, a short walk" >> "$OUTD/agency.log"; done
MUMPK=$MUMPK node test/mum-clicks.cjs 2>&1 | tee "$OUTD/result.log" || true   # the gate below decides
python3 -c "
import json; s=json.load(open('$OUTD/state.json'))
for k,p in sorted(s['payments'].items()): print('visit',k,p.get('mode'),p.get('status'),p.get('flowId'),p.get('txHash'),p.get('markPaidTx'))" | tee "$OUTD/payments.txt"
curl -s http://127.0.0.1:8795/stats | tee "$OUTD/mock-stats.json"; echo
echo "run dir: $OUTD"
N=$(grep -cE "^visit [0-9]+ qa payment-(safe|finalized) MOCKHSP-[0-9a-f-]{36} 0x[0-9a-f]{64} 0x[0-9a-f]{64}$" "$OUTD/payments.txt" || true)
grep -q "E2E PASS" "$OUTD/result.log" && [ "$N" = 4 ] && echo "offline qa e2e PASS: 4 HSP flows through the real qa path ($OUTD)" || { echo "offline qa e2e FAILED ($N/4 settled; $OUTD)"; exit 1; }
