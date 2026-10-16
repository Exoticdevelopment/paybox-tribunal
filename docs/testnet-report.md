# Testnet end-to-end report

Run at 2026-10-16T03:51:27.146Z on Base Sepolia with the public x402 testnet facilitator. Testnet USDC, no real money.

| | Address | Before | After |
|---|---|---|---|
| Buyer | [0xc33aa895471E995524D0eA9a8C84A1f6e4113CAD](https://sepolia.basescan.org/address/0xc33aa895471E995524D0eA9a8C84A1f6e4113CAD) | 19.99 USDC | 19.98 USDC |
| Seller | [0x1A2a7b75Ae9C49B351D4076200c71BbE60D520Ff](https://sepolia.basescan.org/address/0x1A2a7b75Ae9C49B351D4076200c71BbE60D520Ff) | 0.01 USDC | 0.02 USDC |

**Case A, honest invoice:** HTTP 200, delivered. Settlement: [0x3b85177da15cee82a822943b2c156f71341a457e9c8fb5c631ccce0fe6a3af6c](https://sepolia.basescan.org/tx/0x3b85177da15cee82a822943b2c156f71341a457e9c8fb5c631ccce0fe6a3af6c).

**Case C, replay of case A's signed payment:** HTTP 409, payment_already_used. Refused before reaching the paywall: no second charge.

**Case B, total inflated by 100:** HTTP 422, rejected. Reason: Failed 2 contract check(s): total, grounding. Settlement: none. The buyer signed a payment authorization (nonce `0x46948025979e4d6486dc911baf7a3d656a727c97a083d8c0c49b67134dc8ecee`) that was never submitted and expires unused.

## Checks

- ✅ Case A returned 200 and was delivered
- ✅ Case A settled on-chain (tx hash returned)
- ✅ Buyer paid exactly once (0.01 USDC)
- ✅ Seller received exactly once (0.01 USDC)
- ✅ Case C replayed payment refused with 409, no second charge
- ✅ Case B returned 422 and was rejected
- ✅ Case B was never settled (no tx)
- ✅ Case B certificate is bound to its signed (unused) payment nonce

**Overall: PASS**

## Bonus: a real settlement failure, handled correctly

On an earlier run the same day, the public x402 testnet facilitator failed to submit case A's settlement
(`replacement transaction underpriced`, an error in the facilitator's own wallet). Tribunal:

1. Recorded the case as `settle_failed`, separate from its quality verdict (which had passed).
2. Returned no data as paid: the middleware answered 402, and the buyer's balance did not change.
3. Did not assume anything: reading `authorizationState(payer, nonce)` on the USDC contract confirmed the
   authorization nonce `0x9655457a…023cb7` was **never used**, so the buyer was never charged.

This is the failure mode reported in [x402-foundation/x402#1062](https://github.com/x402-foundation/x402/issues/1062)
(payment and delivery out of sync), and why Tribunal reconciles on-chain instead of trusting timeouts.
