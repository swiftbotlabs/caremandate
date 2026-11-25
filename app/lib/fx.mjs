// Won -> payment-token conversion for one visit. The authority is the mandate's on-chain rate (rawPerMillionWon: token smallest units
// per 1,000,000 won), set by the family when the mandate is created; CareMandate.markPaid refuses a payment above
// ceil(amountWon x rate / 1e6) x 1.05. Same arithmetic here and in the contract (maxPayRaw), tested in test/fx.test.mjs.
//
// The rate is built from a KRW-per-USD reference rate (setup.mjs fetches the ECB reference rate from api.frankfurter.dev, or takes
// KRW_PER_USD) and a TEST SCALE: on testnet the HSP QA payer holds ~20 test USDC, so the testnet mandate pays 1/1000 of the real
// price (45,000 won = $32.37 at 1,390 KRW/USD -> $0.03 test USDC). CM_TEST_SCALE=1 gives the real price (mainnet).
export const MILLION = 1_000_000n;
export const FX_ALLOWANCE_BPS = 500n;   // = CareMandate.FX_ALLOWANCE_BPS

/** rawPerMillionWon for a token with `decimals` at `krwPerUsd`, divided by `scale`. */
export function rateFrom({ krwPerUsd, scale = 1000, decimals = 6 }) {
  const k = Number(krwPerUsd), sc = Number(scale);
  if (!(k > 100 && k < 10_000)) throw new Error(`KRW per USD out of range: ${krwPerUsd}`);
  if (!(Number.isInteger(sc) && sc >= 1 && sc <= 1_000_000)) throw new Error(`bad test scale ${scale}`);
  const r = BigInt(Math.round((1e6 / k) * 10 ** decimals / sc));
  if (r <= 0n) throw new Error('rate rounds to 0');
  return r;
}
/** The contract's maxPayRaw: the visit's won price at the mandate rate, rounded up. */
export const maxPayRaw = (amountWon, rate) => (BigInt(amountWon) * BigInt(rate) + MILLION - 1n) / MILLION;
/** The most the contract lets markPaid record: maxPayRaw + 5%, rounded down. */
export const recordLimitRaw = (amountWon, rate) => (maxPayRaw(amountWon, rate) * (10_000n + FX_ALLOWANCE_BPS)) / 10_000n;
/** The USD amount the family agent asks HSP for: the converted price rounded DOWN to the cent (never ask for more than is owed). */
export function usdFor(amountWon, rate, decimals = 6) {
  const raw = maxPayRaw(amountWon, rate) - (BigInt(amountWon) * BigInt(rate) % MILLION ? 1n : 0n);  // exact value, floored
  const cents = (raw * 100n) / 10n ** BigInt(decimals);
  if (cents <= 0n) throw new Error(`visit price converts to less than one cent (${amountWon} won at ${rate} raw per 1M won)`);
  return (Number(cents) / 100).toFixed(2);
}
