#!/bin/bash
# A missed visit and its agreed make-up, end to end, in two phases separated by real time (the make-up slot is in the future).
#   Phase 1: a fresh mandate; the agency posts one visit; Mum says No (signed, on chain); the agency's agent proposes make-up slots to
#            Mina's agent until one fits Mina's rules (each decision signed by both agents' mandate keys and anchored on chain).
#   Phase 2: inside the agreed slot, the agency posts the make-up visit carrying the signed agreement; Mum says Yes; Mina's agent checks
#            the claim against the agreement it signed, reads the note, pays through HSP and records markPaid; the agency's agent
#            checks the transfer itself and acknowledges it on chain.
# Modes:
#   bash test/makeup-live.sh --local                 REHEARSAL, no network: anvil (chain 133, started days in the past so the slot is
#                                                    behind the wall clock that EIP-3009 uses) + test USDC + the HSP stand-in; phase 1,
#                                                    the chain is moved into the slot, phase 2. Must print "makeup PASS (local)".
#   CM_MAKEUP_GO=yes bash test/makeup-live.sh --phase1          HSK testnet + real HSP QA. Writes runs/makeup-<time>/ and prints the slot.
#   CM_MAKEUP_GO=yes bash test/makeup-live.sh --phase2 <rundir> HSK testnet + real HSP QA; only inside the agreed slot.
# Testnet keys are read in-process from $CM_SECRETS and never printed. Mum's tablet key for this run is a throwaway testnet key kept in
# $CM_SECRETS/caremandate_makeup_mum.env (600) between the phases (the 26 Nov run's tablet key was a one-off and was not kept).
set -euo pipefail
cd "$(dirname "$0")/.."
export TMPDIR=${TMPDIR:-/tmp}
[ -d /data/motion/node_modules ] && export NODE_PATH=${NODE_PATH:-/data/motion/node_modules}
MODE=${1:-}; case $MODE in --local|--phase1|--phase2) ;; *) echo "usage: makeup-live.sh --local | --phase1 | --phase2 <rundir>"; exit 2;; esac
PIDS=(); trap 'kill ${PIDS[@]} 2>/dev/null || true' EXIT
export PORT=8791 CM_MANDATE=1 HSP_MODE=qa
NOTE() { node test/note.mjs "$1" "$2"; }

start_server() {   # $1 = run dir
  export CM_STATE=$1/state.json
  node server.mjs >> "$1/server.log" 2>&1 & SV=$!; PIDS+=($SV)
  for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:$PORT/api/config && break; kill -0 $SV 2>/dev/null || break; sleep 0.5; done
  curl -sf -o /dev/null http://127.0.0.1:$PORT/api/config || { echo "SERVER DID NOT START"; tail -5 "$1/server.log"; exit 3; }
}
start_watch() {    # $1 = run dir, $2 = from block, $3 = log name, $4 = exit after N acks (0 = never)
  SETTLE_RPC=$SRPC SETTLE_TOKEN=$STOK SETTLE_CHAIN_ID=$SCHAIN AGENCY_FROM_BLOCK=$2 AGENCY_WATCH_MS=$WATCH_MS AGENCY_MAX_FAILS=30 \
    FAMILY_AGENT_URL=http://127.0.0.1:$PORT AGENCY_A2A_OUT=$1/a2a-agency.jsonl AGENCY_EXIT_AFTER_ACKS=${4:-0} \
    node agency-watch.mjs >> "$1/$3" 2>&1 & AW=$!; PIDS+=($AW)
}

phase1() {         # $1 = run dir; needs MUMPK, chain env
  local D=$1 NOW VID
  MUM=$(cast wallet address --private-key $MUMPK)
  OUT=$(node setup.mjs $MUM 45000 3); echo "$OUT" > "$D/setup.json"
  export CM_CONTRACT=$(echo "$OUT" | jq -r .contract) CM_FX_JSON=$(echo "$OUT" | jq -c .fx)
  start_server "$D"; start_watch "$D" "$(cast block-number --rpc-url $RPC)" agency-watch-1.log
  NOW=$(cast block latest -f timestamp --rpc-url $RPC); T=$((NOW-600))
  node agency.mjs 1 $T 45000 "Ji-woo" "Tue visit: lunch, medicines, a short walk" "$(NOTE normal $T)" | tee "$D/agency-1.log"
  VID=$(jq -r .visitId "$D/agency-1.log"); [[ $VID =~ ^[0-9]+$ ]] || { echo "visit not posted"; exit 1; }
  CM_BASE=http://127.0.0.1:$PORT MUM_PK=$MUMPK node mum-sign.mjs $VID no | tee "$D/mum-1.json"
  for i in $(seq 1 120); do grep -q '"accept":true' "$D/a2a-agency.jsonl" 2>/dev/null && break; sleep 2; done
  grep '"accept":true' "$D/a2a-agency.jsonl" | head -1 > "$D/a2a-agreement.json" || { echo "phase 1: no agreement"; tail -5 "$D/agency-watch-1.log"; exit 1; }
  kill $AW $SV 2>/dev/null || true; wait $AW $SV 2>/dev/null || true
  jq -c '{missedVisitId, slotStart: .proposal.slotStart, slotEnd: .proposal.slotEnd, amount: .proposal.amount, anchorTx, proposals: 0}' "$D/a2a-agreement.json" \
    | jq -c --argjson n "$(wc -l < "$D/a2a-agency.jsonl")" '.proposals = $n' | tee "$D/phase1.json"
  echo "phase 1 done: make-up agreed for $(TZ=Asia/Seoul date -d @$(jq -r .slotStart "$D/phase1.json") '+%a %d %b %H:%M KST') ($(date -u -d @$(jq -r .slotStart "$D/phase1.json") '+%d %b %H:%MZ'))"
}

phase2() {         # $1 = run dir; needs MUMPK, chain env, the chain clock inside the slot
  local D=$1 S E NOW T VID
  S=$(jq -r .slotStart "$D/phase1.json"); E=$(jq -r .slotEnd "$D/phase1.json")
  export CM_CONTRACT=$(jq -r .contract "$D/setup.json") CM_FX_JSON=$(jq -c .fx "$D/setup.json")
  NOW=$(cast block latest -f timestamp --rpc-url $RPC)
  if [ -z "${CM_MAKEUP_CONTROL:-}" ]; then
    [ "$NOW" -ge "$S" ] && [ "$NOW" -le $((E-900)) ] || { echo "phase 2 runs only inside the agreed slot (chain time $NOW, slot $S..$E, 15 min margin)"; exit 2; }
  fi
  start_server "$D"; start_watch "$D" "$(cast block-number --rpc-url $RPC)" agency-watch-2.log 1
  T=$((NOW-60)); [ $T -ge $S ] || T=$S
  [ -n "${CM_MAKEUP_CONTROL:-}" ] && T=$((NOW-60))   # planted control (local only): the claim is posted after its slot
  AGENCY_MAKEUP_FILE=$D/a2a-agreement.json node agency.mjs 1 $T 45000 "Ji-woo" "Make-up for Tuesday's missed visit: lunch, medicines, a short walk" "$(NOTE normal $T)" | tee "$D/agency-2.log"
  VID=$(jq -r .visitId "$D/agency-2.log"); [[ $VID =~ ^[0-9]+$ ]] || { echo "make-up visit not posted"; exit 1; }
  CM_BASE=http://127.0.0.1:$PORT MUM_PK=$MUMPK node mum-sign.mjs $VID yes | tee "$D/mum-2.json"
  for i in $(seq 1 $WAIT); do kill -0 $AW 2>/dev/null || break; sleep 1; done
  kill -0 $AW 2>/dev/null && { kill $AW 2>/dev/null; echo "agency watcher: no ack within ${WAIT}s"; }
  set +e; wait $AW 2>/dev/null; AWRC=$?; set -e
  python3 - "$D" "$VID" <<'PY' | tee "$D/phase2.json"
import json, sys
d, vid = sys.argv[1], sys.argv[2]
s = json.load(open(f"{d}/state.json")); p = s.get("payments", {}).get(vid, {})
rv = [json.loads(l) for l in open(f"{d}/server.log") if '"event":"review"' in l]
rv = [r for r in rv if str(r.get("visitId")) == vid]
mk = (rv[-1].get("makeup") if rv else None) or {}
acks = [json.loads(l) for l in open(f"{d}/agency-watch-2.log") if '"event":"ack"' in l]
out = {"visitId": int(vid), "review": rv[-1].get("decision") if rv else None, "makeupMatched": bool(mk.get("matched")), "paid": p.get("status"),
       "flowId": p.get("flowId"), "settlementTx": p.get("txHash"), "markPaidTx": p.get("markPaidTx"), "acked": any(str(a.get("visitId")) == vid for a in acks)}
print(json.dumps(out))
sys.exit(0 if out["review"] == "pay" and out["makeupMatched"] and out["markPaidTx"] and out["acked"] else 1)
PY
  [ $AWRC = 0 ] || { echo "agency watcher rc $AWRC"; exit 1; }
}

if [ "$MODE" = --local ]; then
  D=${CM_RUNS:-$PWD/../runs}/makeup-local-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$D"
  RPC=http://127.0.0.1:8545
  anvil --port 8545 --chain-id 133 --silent --timestamp $(( $(date +%s) - 9*86400 )) & PIDS+=($!); sleep 2
  cast rpc anvil_nodeInfo --rpc-url $RPC >/dev/null 2>&1 || { echo "not a local anvil: stop"; exit 3; }
  K=(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba)
  export CM_NET=local CM_LOCAL_CHAIN_ID=133 HSP_NETWORK=hashkey-testnet DEPLOYER_PK=${K[0]} FAMILY_PK=${K[1]} FAMILY_AGENT_PK=${K[2]} AGENCY_PK=${K[3]}
  export FAMILY_AGENT_ADDR=$(cast wallet address --private-key ${K[2]}) AGENCY_ADDR=$(cast wallet address --private-key ${K[3]})
  export HSP_PAYER_PK=${K[4]} AGENCY_PAYTO=0x58232CF98671Bc0Bd0E7aaA7cd6adE9EdB2E64A6 HSP_POLL_MS=1000 KRW_PER_USD=1390 FX_SOURCE="fixed test rate (local rehearsal)"
  STOK=0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6; SRPC=$RPC; SCHAIN=133; WATCH_MS=2000; WAIT=180
  cast rpc anvil_setCode $STOK $(jq -r .deployedBytecode.object ../out/MockEIP3009.sol/MockEIP3009.json) --rpc-url $RPC > /dev/null
  cast send $STOK "mint(address,uint256)" $(cast wallet address --private-key ${K[4]}) 20000000 --private-key ${K[0]} --rpc-url $RPC > /dev/null
  MOCK_HSP_PORT=8795 MOCK_HSP_SETTLE_S=4 HSP_MCP_URL=http://127.0.0.1:8795/ MOCK_HSP_RPC=$RPC MOCK_HSP_GATEWAY_PK=${K[5]} node test/mock-hsp.mjs > "$D/mock-hsp.log" 2>&1 & PIDS+=($!)
  export HSP_MCP_URL=http://127.0.0.1:8795/
  MUMPK=0x$(openssl rand -hex 32)
  phase1 "$D"
  S=$(jq -r .slotStart "$D/phase1.json"); [ $((S + 600)) -lt $(date +%s) ] || { echo "slot ahead of the wall clock"; exit 1; }
  W=$((S + 600)); [ -n "${CM_MAKEUP_CONTROL:-}" ] && W=$(( $(jq -r .slotEnd "$D/phase1.json") + 300 ))
  cast rpc evm_setNextBlockTimestamp $W --rpc-url $RPC > /dev/null && cast rpc evm_mine --rpc-url $RPC > /dev/null
  if phase2 "$D"; then echo "makeup PASS (local${CM_MAKEUP_CONTROL:+, CONTROL}): $D"; [ -z "${CM_MAKEUP_CONTROL:-}" ] || exit 1; else echo "makeup FAIL (local${CM_MAKEUP_CONTROL:+, CONTROL}): $D"; exit 1; fi
  exit 0
fi

# HSK testnet + real HSP QA (same keys and routes as test/e2e-testnet.sh)
[ "${CM_MAKEUP_GO:-}" = yes ] || { echo "$MODE needs CM_MAKEUP_GO=yes"; exit 2; }
[ -z "${CM_MAKEUP_CONTROL:-}" ] || { echo "CM_MAKEUP_CONTROL is for --local only"; exit 2; }
S_=${CM_SECRETS:?set CM_SECRETS}
g() { local v; v=$(grep "^$2=" "$S_/$1" | cut -d= -f2-); case "$2" in *_PK|*_KEY) [[ $v == 0x* ]] || v=0x$v;; esac; printf %s "$v"; }
export CM_NET=testnet HSP_POLL_MS=10000 CM_FX_FETCH=1 HSP_NETWORK=sepolia
export DEPLOYER_PK=$(g hashkey_paywall_keys.env HKPW_OPS_PK) FAMILY_PK=$(g hashkey_paywall_keys.env HKPW_OPS_PK)
export FAMILY_AGENT_PK=$(g hashkey_paywall_keys.env HKPW_PROVIDER_PK) AGENCY_PK=$(g hashkey_paywall_keys.env HKPW_PAYEE_PK)
export FAMILY_AGENT_ADDR=$(g hashkey_paywall_keys.env HKPW_PROVIDER_ADDR) AGENCY_ADDR=$(g hashkey_paywall_keys.env HKPW_PAYEE_ADDR)
export HSP_PAYER_PK=$(g hsp_qa_payer.env HSP_QA_KEY) HSP_PAYER_ENV=$S_/hsp_qa_payer.env HSP_MERCHANT_ENV=$S_/hsp_qa_merchant.env
export AGENCY_PAYTO=$(g hsp_qa_merchant.env HSP_QA_ADDRESS)
[ -f "$S_/groq.env" ] && export REVIEW_LLM_KEY=$(grep '^GROQ_API_KEY=' "$S_/groq.env" | cut -d= -f2-)
RPC=https://testnet.hsk.xyz; SRPC=https://ethereum-sepolia-rpc.publicnode.com; STOK=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238; SCHAIN=11155111; WATCH_MS=10000; WAIT=1500
[ "$(cast chain-id --rpc-url $RPC)" = 133 ] || { echo "RPC is not HSK testnet"; exit 2; }
MF=$S_/caremandate_makeup_mum.env
if [ "$MODE" = --phase1 ]; then
  [ -e "$MF" ] && { echo "$MF exists: a make-up run is already in progress (finish phase 2 or move the file)"; exit 2; }
  ( umask 077; printf 'MAKEUP_MUM_PK=0x%s\n' "$(openssl rand -hex 32)" > "$MF" )
  node hsp-probe.mjs --dry 2>&1 | tail -1 | grep -q dry_stop || { echo "HSP not reachable"; exit 2; }
  D=${CM_RUNS:-$PWD/../runs}/makeup-$(date -u +%Y%m%dT%H%MZ); mkdir -p "$D"
  MUMPK=$(g caremandate_makeup_mum.env MAKEUP_MUM_PK)
  phase1 "$D"; echo "next: CM_MAKEUP_GO=yes bash app/test/makeup-live.sh --phase2 $D   (inside the slot)"
else
  D=${2:?run dir}; [ -f "$D/phase1.json" ] || { echo "no phase1.json in $D"; exit 2; }
  MUMPK=$(g caremandate_makeup_mum.env MAKEUP_MUM_PK)
  node hsp-probe.mjs --dry 2>&1 | tail -1 | grep -q dry_stop || { echo "HSP not reachable"; exit 2; }
  phase2 "$D" && echo "makeup PASS (testnet): $D"
fi
