#!/bin/bash
# HSK Chain TESTNET (133) end to end with REAL HSP payments (HSP QA, Circle test USDC on Ethereum Sepolia), for the moment HSP allowlists our IP.
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
export CM_NET=testnet HSP_MODE=qa HSP_POLL_MS=10000
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
MUMPK=0x$(openssl rand -hex 32); MUM=$(cast wallet address --private-key $MUMPK)
export CM_STATE=$OUTD/state.json CM_SHOTS=$OUTD CM_CLICK_TIMEOUT=120000 CM_SETTLE_WAIT=1800000   # 4 HSP payments, ~3 min each, one at a time
node hsp-probe.mjs --dry | tee $OUTD/probe.log | tail -1 | grep -q dry_stop || { echo "HSP not reachable (see $OUTD/probe.log)"; exit 2; }
OUT=$(node setup.mjs $MUM 45000 3); echo "$OUT" | tee $OUTD/setup.json
export CM_CONTRACT=$(echo "$OUT" | python3 -c "import json,sys;print(json.load(sys.stdin)['contract'])") CM_MANDATE=1 PORT=8791
node server.mjs > $OUTD/server.log 2>&1 & SV=$!; trap 'kill $SV 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:8791/api/config && break; kill -0 $SV 2>/dev/null || break; sleep 0.5; done
curl -sf -o /dev/null http://127.0.0.1:8791/api/config || { echo "SERVER DID NOT START ($OUTD/server.log):"; cat $OUTD/server.log; exit 3; }
NOW=$(cast block latest -f timestamp --rpc-url https://testnet.hsk.xyz)
i=0; for c in "Tue visit" "Thu visit" "Fri visit" "Sat visit" "Sun visit"; do i=$((i+1)); node agency.mjs 1 $((NOW-7200+i*60)) 45000 "Ji-woo" "$c: lunch, medicines, a short walk" | tee -a $OUTD/agency.log; done
MUMPK=$MUMPK node test/mum-clicks.cjs 2>&1 | tee $OUTD/result.log || true   # the gate below decides
python3 -c "
import json; s=json.load(open('$OUTD/state.json'))
for k,p in sorted(s['payments'].items()): print('visit',k,p.get('mode'),p.get('status'),p.get('flowId'),p.get('txHash'),p.get('markPaidTx'))" | tee $OUTD/payments.txt
N=$(grep -cE "^visit [0-9]+ qa payment-(safe|finalized) [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} 0x[0-9a-fA-F]{64} 0x[0-9a-fA-F]{64}$" $OUTD/payments.txt || true)
echo "real HSP flows settled and recorded on chain: $N/4 (server log: $OUTD/server.log)"
grep -q "E2E PASS" $OUTD/result.log && [ "$N" = 4 ] && ! grep -qi mock $OUTD/payments.txt && echo "testnet e2e PASS with real HSP ($OUTD)" || { echo "E2E FAILED ($OUTD)"; exit 1; }
