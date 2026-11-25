#!/bin/bash
# Rehearse the HSK Chain MAINNET deploy on a local fork (anvil --fork-url https://mainnet.hsk.xyz, chain 177) and price it in USD.
# Nothing is sent to mainnet. Output: $CM_RUNS/fork-mainnet-<time>/rehearsal.json   Needs: anvil, cast, network (read-only RPC + price).
set -euo pipefail
cd "$(dirname "$0")/.."
OUTD=${CM_RUNS:-$PWD/../runs}/fork-mainnet-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUTD"
PORT=${FORK_PORT:-8555}
anvil --fork-url https://mainnet.hsk.xyz --port $PORT --silent & AP=$!; trap 'kill $AP 2>/dev/null || true' EXIT
for i in $(seq 1 60); do cast chain-id --rpc-url http://127.0.0.1:$PORT >/dev/null 2>&1 && break; sleep 1; done
[ "$(cast chain-id --rpc-url http://127.0.0.1:$PORT)" = 177 ] || { echo "fork did not start as chain 177"; exit 3; }
P=$(curl -sf -m 20 'https://api.coingecko.com/api/v3/simple/price?ids=hashkey-ecopoints&vs_currencies=usd' | python3 -c "import json,sys;print(json.load(sys.stdin)['hashkey-ecopoints']['usd'])")
CM_LOCAL_RPC=http://127.0.0.1:$PORT CM_LOCAL_CHAIN_ID=177 HSK_USD=$P HSK_USD_SOURCE="CoinGecko hashkey-ecopoints $(date -u +%FT%H:%MZ)" \
  node test/fork-rehearsal.mjs | tee "$OUTD/rehearsal.json"
python3 - "$OUTD/rehearsal.json" <<'PY'
import json,sys; r=json.load(open(sys.argv[1]))
ok = r['fork']['chainId']==177 and r['captrip']=='BadInput' and r['visit1']['status']=='Paid' and r['visit1']['agencyAck'] is True and len(r['steps'])==6
print('fork rehearsal', 'PASS' if ok else 'FAIL', '- deploy+mandate $'+r['totals']['deployAndMandateUsd'], 'full cycle $'+r['totals']['fullCycleUsd'])
sys.exit(0 if ok else 1)
PY
