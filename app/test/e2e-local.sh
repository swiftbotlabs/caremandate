#!/bin/bash
# Local end-to-end: anvil + deploy + mandate + server + agency posts + Mum answers in a real browser page + Mina approves.
set -euo pipefail
cd "$(dirname "$0")/.."
export TMPDIR=${TMPDIR:-/tmp}   # NODE_PATH / PLAYWRIGHT_BROWSERS_PATH: set them if playwright is installed outside app/
anvil --port 8545 --silent & AN=$!; trap 'kill $AN $SV 2>/dev/null || true' EXIT; sleep 2
# anvil's well-known public default test keys, used on the local anvil chain only
K=(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6)
export CM_NET=local DEPLOYER_PK=${K[0]} FAMILY_PK=${K[1]} FAMILY_AGENT_PK=${K[2]} AGENCY_PK=${K[3]}
export FAMILY_AGENT_ADDR=$(cast wallet address --private-key ${K[2]}) AGENCY_ADDR=$(cast wallet address --private-key ${K[3]})
MUMPK=0x$(openssl rand -hex 32); MUM=$(cast wallet address --private-key $MUMPK)
export CM_STATE=$TMPDIR/cm-e2e-state.json; rm -f $CM_STATE
OUT=$(KRW_PER_USD=1390 FX_SOURCE="fixed test rate (local run)" node setup.mjs $MUM 45000 3); echo "$OUT"
export CM_CONTRACT=$(echo "$OUT" | python3 -c "import json,sys;print(json.load(sys.stdin)['contract'])") CM_MANDATE=1 HSP_MODE=mock PORT=8791
node server.mjs & SV=$!; sleep 1.5
NOW=$(cast block latest -f timestamp --rpc-url http://127.0.0.1:8545)
i=0; for c in "Tue visit" "Thu visit" "Fri visit" "Sat visit" "Sun visit"; do i=$((i+1)); T=$((NOW-7200+i*60)); K=$(node test/note.mjs key $i "${CM_ODD_VISIT:-0}"); node agency.mjs 1 $T 45000 "Ji-woo" "$c: lunch, medicines, a short walk" "$(node test/note.mjs $K $T)"; done
MUMPK=$MUMPK node test/mum-clicks.cjs
