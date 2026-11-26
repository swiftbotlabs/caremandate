#!/bin/bash
# ONE visit cycle on HSK Chain MAINNET against the deployed CareMandate (evidence/mainnet-*/deploy.json):
#   the agency's agent posts a visit with the carer's note -> Mum's tablet key signs "yes" -> Mina's agent reads the note, pays the visit
#   through HSP QA (test USDC on Ethereum Sepolia) and records it with markPaid -> the agency's agent checks the transfer and calls ackPaid.
# Modes:
#   bash app/mainnet-visit.sh --fork   REHEARSAL. A local anvil fork of HSK mainnet (chain 177) + a local Sepolia stand-in with a test
#                                      EIP-3009 USDC + the local HSP stand-in (test/mock-hsp.mjs). Nothing leaves this machine.
#   CM_MAINNET_VISIT_GO=yes bash app/mainnet-visit.sh --live
#                                      REAL: 4 mainnet txs (~0.13 HSK of gas at 500 gwei) + one real HSP QA payment of test USDC.
# Keys are read in-process from $CM_SECRETS (caremandate_mainnet.env: MAINNET_CONFIRMER_PK = Mum's tablet, MAINNET_DEPLOYER_PK = Mina;
# hashkey_paywall_keys.env: HKPW_PROVIDER_PK = Mina's agent, HKPW_PAYEE_PK = the agency's agent; hsp_qa_payer.env, hsp_qa_merchant.env;
# optional groq.env for the note-reading model) and never printed. Output: evidence/mainnet-visit-<time>/ (live) or runs/fork-visit-<time>/.
# Guards (live): chain 177, gas price <= 1000 gwei, the mandate's roles = these keys, balances, once only (refuses if a mainnet visit.json
# exists), HSP dry probe first, spend cap MAX_GAS_HSK (default 0.30 HSK) checked against the balance change after the run.
set -euo pipefail
cd "$(dirname "$0")"
MODE=${1:-}; [ "$MODE" = --fork ] || [ "$MODE" = --live ] || { echo "usage: mainnet-visit.sh --fork | --live"; exit 2; }
S=${CM_SECRETS:?set CM_SECRETS}
for f in caremandate_mainnet.env hashkey_paywall_keys.env hsp_qa_payer.env hsp_qa_merchant.env; do [ -f "$S/$f" ] && [ ! -L "$S/$f" ] || { echo "no $S/$f (regular file)"; exit 2; }; done
g() { local v; v=$(grep "^$2=" "$S/$1" | cut -d= -f2-); case "$2" in *_PK|*_KEY) [[ $v == 0x* ]] || v=0x$v;; esac; printf %s "$v"; }
[ -d /data/motion/node_modules ] && export NODE_PATH=${NODE_PATH:-/data/motion/node_modules}
DEP=$(ls ../evidence/mainnet-2*/deploy.json | sort | tail -1); C=$(jq -r .contract $DEP)
WON=${CM_VISIT_WON:-1000}                     # a token 1,000-won visit (~$0.74 at the mandate rate) so the test USDC lasts
MAXGAS=${MAX_GAS_HSK:-0.30}
SEPUSDC=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
export CM_NET=mainnet CM_CONTRACT=$C CM_MANDATE=1 HSP_MODE=qa HSP_NETWORK=sepolia HSP_CAP_USD=0.80 PORT=${PORT:-8791}
export FAMILY_AGENT_PK=$(g hashkey_paywall_keys.env HKPW_PROVIDER_PK) AGENCY_PK=$(g hashkey_paywall_keys.env HKPW_PAYEE_PK)
export FAMILY_PK=$(g caremandate_mainnet.env MAINNET_DEPLOYER_PK) MUM_PK=$(g caremandate_mainnet.env MAINNET_CONFIRMER_PK)
export AGENCY_PAYTO=$(g hsp_qa_merchant.env HSP_QA_ADDRESS) CM_FX_JSON=$(jq -c .fx $DEP)
[ -f "$S/groq.env" ] && export REVIEW_LLM_KEY=$(grep '^GROQ_API_KEY=' "$S/groq.env" | cut -d= -f2-)
FA=$(cast wallet address --private-key $FAMILY_AGENT_PK); AG=$(cast wallet address --private-key $AGENCY_PK); MUM=$(cast wallet address --private-key $MUM_PK)
PIDS=(); trap 'kill ${PIDS[@]} 2>/dev/null || true' EXIT

if [ "$MODE" = --fork ]; then
  OUTD=${CM_RUNS:-$PWD/../runs}/fork-visit-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUTD"
  RPC=http://127.0.0.1:8556; SRPC=http://127.0.0.1:8557
  anvil --fork-url https://mainnet.hsk.xyz --port 8556 --silent & PIDS+=($!)
  anvil --port 8557 --chain-id 11155111 --silent & PIDS+=($!)
  for i in $(seq 1 60); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && cast chain-id --rpc-url $SRPC >/dev/null 2>&1 && break; sleep 1; done
  # fail closed unless BOTH RPCs are local anvil nodes (anvil_nodeInfo exists only on anvil): no tx can reach a public chain
  for u in $RPC $SRPC; do cast rpc anvil_nodeInfo --rpc-url $u >/dev/null 2>&1 || { echo "$u is not a local anvil: stop"; exit 3; }; done
  [ "$(cast chain-id --rpc-url $RPC)" = 177 ] || { echo "fork is not chain 177"; exit 3; }
  export CM_MAINNET_RPC=$RPC
  # the Sepolia stand-in: test EIP-3009 USDC at Circle's Sepolia USDC address; a test payer (anvil key) with 20 USDC; HSP stand-in
  K4=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a; K5=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba; K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  cast rpc anvil_setCode $SEPUSDC $(jq -r .deployedBytecode.object ../out/MockEIP3009Sepolia.sol/MockEIP3009Sepolia.json) --rpc-url $SRPC > /dev/null
  cast send $SEPUSDC "mint(address,uint256)" $(cast wallet address --private-key $K4) 20000000 --private-key $K0 --rpc-url $SRPC > /dev/null
  export HSP_PAYER_PK=$K4 HSP_POLL_MS=1000
  MOCK_HSP_PORT=8795 MOCK_HSP_SETTLE_S=5 MOCK_HSP_RPC=$SRPC MOCK_HSP_GATEWAY_PK=$K5 node test/mock-hsp.mjs > "$OUTD/mock-hsp.log" 2>&1 & PIDS+=($!)
  export HSP_MCP_URL=http://127.0.0.1:8795/
  WAIT=180
else
  [ "${CM_MAINNET_VISIT_GO:-}" = yes ] || { echo "--live needs CM_MAINNET_VISIT_GO=yes"; exit 2; }
  ls ../evidence/mainnet-visit-*/visit.json >/dev/null 2>&1 && [ -z "${CM_ALLOW_SECOND:-}" ] && { echo "a mainnet visit record exists already: refusing to run twice"; exit 2; }
  OUTD=../evidence/mainnet-visit-$(date -u +%Y%m%dT%H%MZ); mkdir -p "$OUTD"
  RPC=https://mainnet.hsk.xyz; SRPC=https://ethereum-sepolia-rpc.publicnode.com
  [ "$(cast chain-id --rpc-url $RPC)" = 177 ] || { echo "RPC is not HSK mainnet"; exit 2; }
  export HSP_PAYER_PK=$(g hsp_qa_payer.env HSP_QA_KEY) HSP_PAYER_ENV=$S/hsp_qa_payer.env HSP_MERCHANT_ENV=$S/hsp_qa_merchant.env HSP_POLL_MS=10000
  PAYER=$(cast wallet address --private-key $HSP_PAYER_PK)
  PB=$(cast call $SEPUSDC 'balanceOf(address)(uint256)' $PAYER --rpc-url $SRPC | awk '{print $1}')
  [ "$PB" -ge 1000000 ] || { echo "HSP payer holds $PB raw Sepolia USDC (< 1 USDC)"; exit 2; }
  node hsp-probe.mjs --dry > "$OUTD/probe.log" 2>&1; tail -1 "$OUTD/probe.log" | grep -q dry_stop || { echo "HSP not reachable (see $OUTD/probe.log)"; exit 2; }
  WAIT=1500
fi
SETTLE_TOKEN=$SEPUSDC; SETTLE_CHAIN=$(cast chain-id --rpc-url $SRPC)

# guards common to both modes: gas price, roles, balances
GP=$(cast gas-price --rpc-url $RPC); [ "$GP" -le 1000000000000 ] || { echo "gas price $GP wei > 1000 gwei: stop"; exit 2; }
M=$(cast call $C "mandates(uint64)(address,address,address,address,uint96,uint8,bool,uint64)" 1 --rpc-url $RPC | awk '{print $1}' | tr '\n' ' ')
read -r MF MFA MAG MCONF MCAP MWK MACT MRATE <<< "$M"
[ "${MFA,,}" = "${FA,,}" ] && [ "${MAG,,}" = "${AG,,}" ] && [ "${MCONF,,}" = "${MUM,,}" ] && [ "$MACT" = true ] || { echo "the mandate's roles do not match these keys (or it is paused): stop"; exit 2; }
[ "$WON" -ge 100 ] && [ "$WON" -le "$MCAP" ] || { echo "visit price $WON won outside 100..$MCAP"; exit 2; }
B0FA=$(cast balance $FA --rpc-url $RPC); B0AG=$(cast balance $AG --rpc-url $RPC)
python3 -c "import sys; sys.exit(0 if int('$B0FA') >= 5*10**16 and int('$B0AG') >= 2*10**16 else 1)" || { echo "family agent needs >= 0.05 HSK and the agency >= 0.02 HSK"; exit 2; }
echo "{\"mode\":\"$MODE\",\"contract\":\"$C\",\"visitWon\":$WON,\"gasPriceWei\":\"$GP\",\"familyAgent\":\"$FA\",\"agency\":\"$AG\",\"mum\":\"$MUM\",\"payTo\":\"$AGENCY_PAYTO\",\"maxGasHsk\":$MAXGAS}" | tee "$OUTD/plan.json"

export CM_STATE=$OUTD/state.json
node server.mjs > "$OUTD/server.log" 2>&1 & SV=$!; PIDS+=($SV)
for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:$PORT/api/config && break; kill -0 $SV 2>/dev/null || break; sleep 0.5; done
curl -sf -o /dev/null http://127.0.0.1:$PORT/api/config || { echo "SERVER DID NOT START"; tail -3 "$OUTD/server.log"; exit 3; }
FROM=$(cast block-number --rpc-url $RPC)
SETTLE_RPC=$SRPC SETTLE_TOKEN=$SETTLE_TOKEN SETTLE_CHAIN_ID=$SETTLE_CHAIN AGENCY_FROM_BLOCK=$FROM AGENCY_WATCH_MS=5000 AGENCY_MAX_FAILS=30 AGENCY_EXIT_AFTER_ACKS=1 \
  node agency-watch.mjs > "$OUTD/agency-watch.log" 2>&1 & AW=$!; PIDS+=($AW)
NOW=$(cast block latest -f timestamp --rpc-url $RPC); T=$((NOW-600))
node agency.mjs 1 $T $WON "Ji-woo" "lunch, medicines, a short walk" "$(node test/note.mjs normal $T)" | tee "$OUTD/agency.log"
VID=$(jq -r .visitId "$OUTD/agency.log"); [[ $VID =~ ^[0-9]+$ ]] || { echo "visit not posted"; exit 1; }
CM_BASE=http://127.0.0.1:$PORT node mum-sign.mjs $VID yes | tee "$OUTD/mum.json"
# wait for: paid on chain (markPaid) and the agency's ack (the watcher exits 0 after one ack)
for i in $(seq 1 $WAIT); do kill -0 $AW 2>/dev/null || break; sleep 1; done
wait $AW 2>/dev/null; AWRC=$?
[ $AWRC = 0 ] || { echo "agency watcher did not acknowledge (rc $AWRC); see $OUTD"; tail -3 "$OUTD/agency-watch.log"; exit 1; }
SETTLE_RPC=$SRPC SETTLE_TOKEN=$SETTLE_TOKEN SETTLE_LABEL="Ethereum Sepolia" GAS_PRICE_WEI=500000000000 node mainnet-visit-check.mjs "$OUTD" | tee "$OUTD/check.json"
B1FA=$(cast balance $FA --rpc-url $RPC); B1AG=$(cast balance $AG --rpc-url $RPC)
python3 - "$B0FA" "$B1FA" "$B0AG" "$B1AG" "$MAXGAS" "$OUTD/spend.json" <<'PY'
import sys, json
b0fa, b1fa, b0ag, b1ag, cap, out = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5]), sys.argv[6]
spent = (b0fa - b1fa + b0ag - b1ag) / 1e18
json.dump({'familyAgentHsk': (b0fa - b1fa) / 1e18, 'agencyHsk': (b0ag - b1ag) / 1e18, 'totalHsk': spent, 'capHsk': cap}, open(out, 'w'))
print(json.dumps({'spentHsk': round(spent, 6), 'capHsk': cap, 'withinCap': spent <= cap}))
sys.exit(0 if 0 <= spent <= cap else 1)
PY
echo "mainnet visit cycle PASS ($MODE): $OUTD"
