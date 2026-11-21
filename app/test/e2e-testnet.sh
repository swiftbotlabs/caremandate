#!/bin/bash
# HSK Chain TESTNET (133) end to end with REAL HSP payments (HSP QA, Base Sepolia test USDC), for the moment HSP allowlists our IP.
# Deploys CareMandate + Mina's mandate on HSK testnet, the agency posts 5 visits, Mum answers in the real page (yes/no/yes/yes/yes),
# Mina approves the held 4th visit; every confirmed visit is paid through HSP (HSP_MODE=qa) and the HSP flow id is recorded on chain.
# Gas: ~2.3M on HSK testnet (test HSK from the faucet). HSP: 4 x 0.01 USD of test USDC from the QA payer (holds ~19.9).
# Keys are read in-process from $CM_SECRETS and never printed. Run: bash test/e2e-testnet.sh   (first: node hsp-probe.mjs --dry)
set -euo pipefail
cd "$(dirname "$0")/.."
export TMPDIR=${TMPDIR:-/tmp}   # NODE_PATH / PLAYWRIGHT_BROWSERS_PATH: set them if playwright is installed outside app/
S=${CM_SECRETS:?set CM_SECRETS to the folder with the testnet key files (hashkey_paywall_keys.env, hsp_qa_payer.env)}
g() { grep "^$2=" "$S/$1" | cut -d= -f2-; }
export CM_NET=testnet HSP_MODE=qa HSP_POLL_MS=10000
export DEPLOYER_PK=$(g hashkey_paywall_keys.env HKPW_OPS_PK) FAMILY_PK=$(g hashkey_paywall_keys.env HKPW_OPS_PK)
export FAMILY_AGENT_PK=$(g hashkey_paywall_keys.env HKPW_PROVIDER_PK) AGENCY_PK=$(g hashkey_paywall_keys.env HKPW_PAYEE_PK)
export FAMILY_AGENT_ADDR=$(g hashkey_paywall_keys.env HKPW_PROVIDER_ADDR) AGENCY_ADDR=$(g hashkey_paywall_keys.env HKPW_PAYEE_ADDR)
export HSP_PAYER_PK=$(g hsp_qa_payer.env HSP_QA_KEY)
OUTD=${CM_RUNS:-$PWD/../runs}/testnet-$(date -u +%Y%m%dT%H%MZ); mkdir -p $OUTD
MUMPK=0x$(openssl rand -hex 32); MUM=$(cast wallet address --private-key $MUMPK)
export CM_STATE=$OUTD/state.json CM_SHOTS=$OUTD CM_CLICK_TIMEOUT=600000 CM_APPROVE_WAIT=240000
HSP_PAYER_ENV=$S/hsp_qa_payer.env HSP_MERCHANT_ENV=$S/hsp_qa_merchant.env node hsp-probe.mjs --dry | tee $OUTD/probe.log | tail -1 | grep -q dry_stop || { echo "HSP not reachable (see $OUTD/probe.log)"; exit 2; }
OUT=$(node setup.mjs $MUM 45000 3); echo "$OUT" | tee $OUTD/setup.json
export CM_CONTRACT=$(echo "$OUT" | python3 -c "import json,sys;print(json.load(sys.stdin)['contract'])") CM_MANDATE=1 PORT=8791
node server.mjs > $OUTD/server.log 2>&1 & SV=$!; trap 'kill $SV 2>/dev/null || true' EXIT; sleep 2
NOW=$(cast block latest -f timestamp --rpc-url https://testnet.hsk.xyz)
i=0; for c in "Tue visit" "Thu visit" "Fri visit" "Sat visit" "Sun visit"; do i=$((i+1)); node agency.mjs 1 $((NOW-7200+i*60)) 45000 "Ji-woo" "$c: lunch, medicines, a short walk" | tee -a $OUTD/agency.log; done
MUMPK=$MUMPK node test/mum-clicks.cjs | tee $OUTD/result.log
python3 -c "
import json; s=json.load(open('$OUTD/state.json'))
for k,p in sorted(s['payments'].items()): print('visit',k,p.get('mode'),p.get('status'),p.get('flowId'),p.get('txHash'),p.get('markPaidTx'))" | tee $OUTD/payments.txt
grep -q "E2E PASS" $OUTD/result.log && ! grep -q mock $OUTD/payments.txt && echo "testnet e2e PASS with real HSP ($OUTD)" || { echo "E2E FAILED ($OUTD)"; exit 1; }
