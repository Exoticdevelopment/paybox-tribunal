# Buyer agent (official PayBox SDK)

The other side of Tribunal: an agent that **buys** from a guaranteed API with
[`@paybox-sh/sdk`](https://docs.paybox.sh/sdk-cli). Before it spends, it reads the seller's contract and trust
score. It pays through PayBox (non-custodial: the wallet key stays in PayBox, this machine only holds a paired
signing key) and prints what Tribunal decided.

```bash
cd agent
npm install
npx paybox login     # OAuth device code: approve in the browser, pick the wallets this agent may use
npx paybox connect   # pair a signing key (match the eight emoji in the PayBox app)
npm run demo         # scenario 1: promise kept → charged $0.01; scenario 2: broken promise → 422, $0
```

**Through the PayBox plugin** (`npm run plugin`): the agent discovers PayBox Tribunal with `discover_plugins`, checks the
guarantee with `check_guarantee`, buys through `get_price_quote` (the plugin proposes the x402 payment, PayBox prepares it,
the paired key signs it), and verifies both signed verdicts with `get_case`, inside the plugin.

`PAY_ON=evm` pays with USDC on Base instead of Solana. `MIN_TRUST=0.5` makes the agent refuse sellers below
that trust score. `TRIBUNAL_URL` points it at another Tribunal server.
