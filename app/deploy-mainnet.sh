#!/bin/bash
# HSK Chain MAINNET deploy of CareMandate + Mina's mandate at REAL scale (45,000 won cap, today's ECB KRW/USD rate, CM_TEST_SCALE=1).
# Run ONLY by the local agent under its COND task (queue/exec/hold/*-hsk-mainnet-deploy-when-funded.md). Sends 2 mainnet txs.
#   CM_SECRETS=~/agent/secrets bash app/deploy-mainnet.sh [--estimate]
# Keys (read in-process, never printed): $CM_SECRETS/caremandate_mainnet.env with MAINNET_DEPLOYER_PK (deploys and is Mina's family key),
# MAINNET_FAMILY_AGENT_ADDR, MAINNET_AGENCY_ADDR, MAINNET_CONFIRMER_ADDR. Guards: chain 177, gas price <= 1000 gwei, deployer balance
# >= 1.2 HSK, refuses if a mainnet deploy record already exists. Rehearsed on a fork: app/test/fork-mainnet-rehearsal.sh.
set -euo pipefail
cd "$(dirname "$0")"
RPC=${CM_MAINNET_RPC:-https://mainnet.hsk.xyz}   # CM_MAINNET_RPC: fork test only
S=${CM_SECRETS:?set CM_SECRETS}; F=$S/caremandate_mainnet.env
[ -f "$F" ] && [ ! -L "$F" ] || { echo "no $F (regular file)"; exit 2; }
g() { grep "^$1=" "$F" | cut -d= -f2-; }
ls ../evidence/mainnet-*/deploy.json >/dev/null 2>&1 && { echo "a mainnet deploy record exists already: refusing to deploy twice"; exit 2; }
[ "$(cast chain-id --rpc-url $RPC)" = 177 ] || { echo "RPC is not HSK mainnet"; exit 2; }
GP=$(cast gas-price --rpc-url $RPC); [ "$GP" -le 1000000000000 ] || { echo "gas price $GP wei > 1000 gwei: stop"; exit 2; }
DEP=$(cast wallet address --private-key "$(g MAINNET_DEPLOYER_PK)")
BAL=$(cast balance $DEP --rpc-url $RPC)
NEED=$(python3 -c "print(int(1718289*$GP*1.4))")
echo "{\"deployer\":\"$DEP\",\"balanceWei\":\"$BAL\",\"gasPriceWei\":\"$GP\",\"needWei\":\"$NEED\"}"
python3 -c "import sys; sys.exit(0 if int('$BAL') >= max(int('$NEED'), 12*10**17) else 1)" || { echo "deployer balance too low (need >= 1.2 HSK)"; exit 2; }
[ "${1:-}" = --estimate ] && { echo "estimate only: nothing sent"; exit 0; }
OUTD=${DEPLOY_OUT:-../evidence/mainnet-$(date -u +%Y%m%dT%H%MZ)}; mkdir -p $OUTD   # DEPLOY_OUT: fork test only
export CM_NET=mainnet CM_FX_FETCH=1 CM_TEST_SCALE=1 DEPLOYER_PK=$(g MAINNET_DEPLOYER_PK) FAMILY_PK=$(g MAINNET_DEPLOYER_PK)
export FAMILY_AGENT_ADDR=$(g MAINNET_FAMILY_AGENT_ADDR) AGENCY_ADDR=$(g MAINNET_AGENCY_ADDR)
OUT=$(node setup.mjs "$(g MAINNET_CONFIRMER_ADDR)" 45000 3); echo "$OUT" | tee $OUTD/deploy.json
C=$(echo "$OUT" | jq -r .contract)
# read-backs on mainnet: code present, mandate as set, an over-cap post still refused (read-only simulation)
[ "$(cast code $C --rpc-url $RPC | wc -c)" -gt 1000 ] || { echo "no code at $C"; exit 1; }
cast call $C "mandates(uint64)(address,address,address,address,uint96,uint8,bool,uint64)" 1 --rpc-url $RPC | tee $OUTD/mandate.txt
if cast call $C "postVisit(uint64,uint64,uint96,bytes32)(uint256)" 1 $(( $(date +%s) - 60 )) 46000 0x$(openssl rand -hex 32) --from $AGENCY_ADDR --rpc-url $RPC > /dev/null 2>&1; then echo "over-cap post NOT refused"; exit 1; fi
echo "over-cap 46,000-won post refused (read-only simulation)" | tee -a $OUTD/mandate.txt
echo "mainnet deploy OK: $C ($OUTD)"
