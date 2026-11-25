#!/bin/bash
# HSK Chain TESTNET (133) end to end with REAL HSP payments (HSP QA). v2 (2026-11-25):
#  - settlement network: HSP_NETWORK=hashkey-testnet (USDC 0x8FE3cB71... on HSK Chain itself, offered by HSP's live get_chain_config)
#    when the HSP payer holds >= 0.20 of it; otherwise sepolia (Circle USDC), and the run says why. Force with HSP_NETWORK=...
#  - the mandate carries today's ECB KRW/USD rate (CM_FX_FETCH=1) at testnet scale 1:1000: each 45,000-won visit pays ~$0.03
#  - a 46,000-won visit is posted and must be refused by the contract (cap trip)
#  - agency-watch.mjs (the agency's own agent) acknowledges each payment on chain after checking the transfer itself
#  - gate: test/e2e-gate.mjs testnet (reads the chain and the settlement network, not printed text)
# Deploys CareMandate + Mina's mandate on HSK testnet, the agency posts 5 visits, Mum answers in the real page (yes/no/yes/yes/yes),
# Mina approves the held 4th visit; every confirmed visit is paid through HSP (HSP_MODE=qa) and the HSP flow id is recorded on chain.
# Gas: ~2.3M on HSK testnet (test HSK from the faucet). HSP: 4 x 0.01 USD of test USDC from the QA payer (holds ~19.9).
# Keys are read in-process from $CM_SECRETS and never printed. Run: bash test/e2e-testnet.sh   (first: node hsp-probe.mjs --dry)
set -euo pipefail
cd "$(dirname "$0")/.."
export TMPDIR=${TMPDIR:-/tmp}
# playwright lives outside app/ on this VM (set NODE_PATH / PLAYWRIGHT_BROWSERS_PATH yourself elsewhere)
[ -d /data/motion/node_modules/playwright ] && export NODE_PATH=${NODE_PATH:-/data/motion/node_modules} PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/data/motion/pw-browsers}
S=${CM_SECRETS:?set CM_SECRETS to the folder with the testnet key files (hashkey_paywall_keys.env, hsp_qa_payer.env)}
g() { local v; v=$(grep "^$2=" "$S/$1" | cut -d= -f2-); case "$2" in *_PK|*_KEY) [[ $v == 0x* ]] || v=0x$v;; esac; printf %s "$v"; }  # keys may be stored without 0x; viem needs it
export CM_NET=testnet HSP_MODE=qa HSP_POLL_MS=10000 CM_FX_FETCH=1
export DEPLOYER_PK=$(g hashkey_paywall_keys.env HKPW_OPS_PK) FAMILY_PK=$(g hashkey_paywall_keys.env HKPW_OPS_PK)
export FAMILY_AGENT_PK=$(g hashkey_paywall_keys.env HKPW_PROVIDER_PK) AGENCY_PK=$(g hashkey_paywall_keys.env HKPW_PAYEE_PK)
export FAMILY_AGENT_ADDR=$(g hashkey_paywall_keys.env HKPW_PROVIDER_ADDR) AGENCY_ADDR=$(g hashkey_paywall_keys.env HKPW_PAYEE_ADDR)
export HSP_PAYER_PK=$(g hsp_qa_payer.env HSP_QA_KEY)
# HSP pays the agency at the HSP merchant's QA pay-to address (the one the live probe paid with attribution verified), not the
# agency's HSK Chain address; the server refuses to start in qa mode without it.
export HSP_PAYER_ENV=$S/hsp_qa_payer.env HSP_MERCHANT_ENV=$S/hsp_qa_merchant.env
export AGENCY_PAYTO=$(g hsp_qa_merchant.env HSP_QA_ADDRESS)
[[ $AGENCY_PAYTO =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "no HSP_QA_ADDRESS in $S/hsp_qa_merchant.env"; exit 2; }
OUTD=${CM_RUNS:-$PWD/../runs}/testnet-$(date -u +%Y%m%dT%H%MZ); mkdir -p $OUTD
PAYER=$(g hsp_qa_payer.env HSP_QA_ADDRESS)
HSKUSDC=0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6; SEPUSDC=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
SEPRPC=https://ethereum-sepolia-rpc.publicnode.com; HSKRPC=https://testnet.hsk.xyz
bal() { for i in 1 2 3; do v=$(cast call $1 'balanceOf(address)(uint256)' $PAYER --rpc-url $2 2>/dev/null | awk '{print $1}') && [ -n "$v" ] && { echo $v; return; }; sleep 3; done; echo -1; }
HB=$(bal $HSKUSDC $HSKRPC); SB=$(bal $SEPUSDC $SEPRPC)
if [ -z "${HSP_NETWORK:-}" ]; then
  if [ "$HB" -ge 200000 ]; then HSP_NETWORK=hashkey-testnet; WHY="payer holds $HB raw HSK-testnet USDC"; else HSP_NETWORK=sepolia; WHY="payer holds $HB raw HSK-testnet USDC (< 200000; no public mint), $SB raw Sepolia USDC"; fi
else WHY="forced by HSP_NETWORK"; fi
export HSP_NETWORK
case $HSP_NETWORK in hashkey-testnet) SRPC=$HSKRPC STOK=$HSKUSDC NEED=$HB;; sepolia) SRPC=$SEPRPC STOK=$SEPUSDC NEED=$SB;; *) echo "unsupported HSP_NETWORK $HSP_NETWORK"; exit 2;; esac
echo "{\"hspNetwork\":\"$HSP_NETWORK\",\"why\":\"$WHY\",\"payerRaw\":{\"hashkey-testnet\":$HB,\"sepolia\":$SB}}" | tee $OUTD/network.json
[ "$NEED" -ge 200000 ] || { echo "HSP payer holds $NEED raw on $HSP_NETWORK: needs >= 200000 (4 x ~0.03 + margin)"; exit 2; }
MUMPK=0x$(openssl rand -hex 32); MUM=$(cast wallet address --private-key $MUMPK)
export CM_STATE=$OUTD/state.json CM_SHOTS=$OUTD CM_CLICK_TIMEOUT=120000 CM_SETTLE_WAIT=1800000   # 4 HSP payments, ~3 min each, one at a time
node hsp-probe.mjs --dry | tee $OUTD/probe.log | tail -1 | grep -q dry_stop || { echo "HSP not reachable (see $OUTD/probe.log)"; exit 2; }
FROMBLK=$(cast block-number --rpc-url $HSKRPC)
OUT=$(node setup.mjs $MUM 45000 3); echo "$OUT" | tee $OUTD/setup.json
export CM_CONTRACT=$(echo "$OUT" | jq -r .contract) CM_MANDATE=1 PORT=8791 CM_FX_JSON=$(echo "$OUT" | jq -c .fx)
node server.mjs > $OUTD/server.log 2>&1 & SV=$!; trap 'kill $SV 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:8791/api/config && break; kill -0 $SV 2>/dev/null || break; sleep 0.5; done
curl -sf -o /dev/null http://127.0.0.1:8791/api/config || { echo "SERVER DID NOT START ($OUTD/server.log):"; cat $OUTD/server.log; exit 3; }
# the agency's own agent: watches PaymentSettled, checks the transfer on $HSP_NETWORK itself, acknowledges on chain
SETTLE_RPC=$SRPC SETTLE_TOKEN=$STOK AGENCY_FROM_BLOCK=$FROMBLK AGENCY_WATCH_MS=10000 AGENCY_MAX_FAILS=30 node agency-watch.mjs > $OUTD/agency-watch.log 2>&1 & AW=$!
trap 'kill $SV $AW 2>/dev/null || true' EXIT
NOW=$(cast block latest -f timestamp --rpc-url $HSKRPC)
i=0; for c in "Tue visit" "Thu visit" "Fri visit" "Sat visit" "Sun visit"; do i=$((i+1)); node agency.mjs 1 $((NOW-7200+i*60)) 45000 "Ji-woo" "$c: lunch, medicines, a short walk" | tee -a $OUTD/agency.log; done
set +e; node agency.mjs 1 $((NOW-600)) 46000 "Ji-woo" "Mon visit, priced 46,000 won" > $OUTD/captrip.json; RC=$?; set -e
cat $OUTD/captrip.json; [ $RC = 4 ] || { echo "cap trip: expected refusal rc 4, got $RC"; exit 1; }
MUMPK=$MUMPK node test/mum-clicks.cjs 2>&1 | tee $OUTD/result.log || true   # the gate below decides
python3 -c "
import json; s=json.load(open('$OUTD/state.json'))
for k,p in sorted(s['payments'].items()): print('visit',k,p.get('mode'),p.get('status'),p.get('flowId'),p.get('txHash'),p.get('markPaidTx'))" | tee $OUTD/payments.txt
for i in $(seq 1 60); do [ "$(grep -c '"event":"ack"' $OUTD/agency-watch.log || true)" -ge 4 ] && break; kill -0 $AW 2>/dev/null || break; sleep 5; done   # acks: up to 5 min
N=$(grep -cE "^visit [0-9]+ qa payment-(safe|finalized) [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} 0x[0-9a-fA-F]{64} 0x[0-9a-fA-F]{64}$" $OUTD/payments.txt || true)
echo "real HSP flows settled and recorded on chain: $N/4 (server log: $OUTD/server.log)"
grep -q "E2E PASS" $OUTD/result.log && [ "$N" = 4 ] && ! grep -qi mock $OUTD/payments.txt \
  && SETTLE_RPC=$SRPC SETTLE_TOKEN=$STOK node test/e2e-gate.mjs $OUTD testnet | tee $OUTD/gate.json \
  && echo "testnet e2e PASS with real HSP on $HSP_NETWORK ($OUTD)" || { echo "E2E FAILED ($OUTD)"; exit 1; }
