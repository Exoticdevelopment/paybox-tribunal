# PayBox Tribunal

**x402 says what it costs. Tribunal says what you're guaranteed, and enforces it before you're charged.**

> **In one sentence: if the API doesn't keep its promise, the agent doesn't pay.** Everything else below is how that is proven.

### Try it in 2 minutes (no wallet needed)

1. **See it live:** open <https://paybox-tribunal.onrender.com>. Live trust scores, real verdicts, the full flow.
2. **Watch it refuse bad output:** on the home page, section "Before you trust a guarantee, we try to break it". Tribunal attacks its own
   contract (wrong totals, invented vendor, swapped lines…) and shows that every attack is caught **before** payment (raw data: `/invoice/crash-test`).
3. **Write a guarantee:** on the home page, "Write your guarantee in plain words", press compile. Each promise comes back
   labelled *deterministic*, *heuristic*, *probabilistic* or *not guaranteed*.
4. **Try to break it yourself:** "Don't trust the demo. Attack it." on the home page. Submit any output you like.
5. **With PayBox:** install the plugin, ask the agent for a price quote → charged (200). Ask again with
   `demo_fault: "stale"` → **422, never charged**. Then `get_case` shows the signed verdict, verified inside the plugin.

x402 payments are final: the agent pays, then hopes the response is good. Agents pay unattended, so
bad responses get paid for constantly. Tribunal is a **guarantee kit for x402 sellers**: each service
publishes a contract, and every result is checked against it **before** the payment settles.

1. The agent signs an x402 payment (through PayBox, with passkey approval).
2. The server **verifies** the signature but does **not** settle yet.
3. It runs the service, then judges the output against the published contract:
   schema → objective rules (math, limits, grounding) → AI judge (what rules can't see).
4. **Pass → 200, payment settles. Fail → 422 with a public verdict, payment is never settled.**
5. Delivered results can be appealed for 24h; upheld appeals earn a single-use credit. A trust score
   per service is computed from every real transaction.

Three example services ship with the kit, to show it works for any API:

| Service | What it promises | Caught by rules | Caught only by the AI judge |
|---|---|---|---|
| `POST /invoice` Invoice & receipt extraction | Schema, line math, totals, every value grounded in the document | wrong totals, empty fields, invented vendor | values attached to the wrong lines |
| `POST /summary` Faithful summaries | Word limits, 1–5 unique key points, no invented numbers | too long, invented figures | unsupported claims |
| `POST /quote` Fresh price quotes (live CoinGecko data) | Right pair, positive price, `as_of` no older than the buyer's `max_age_seconds` | stale or future timestamps, wrong pair, zero price | n/a: every promise is objective |

## Promise compiler: guarantees in plain language

Sellers write their promises in plain language. Tribunal compiles them into checks from a **closed
catalog of 9 rule types**, so the AI never writes code that runs:
`required_fields`, `schema_type`, `numeric_bounds`, `length_limit`, `language`, `source_grounding`,
`numeric_grounding`, `freshness`, `semantic_claim`.

```
"El resumen debe estar en español, máximo 25 palabras, no inventa cifras,
 nunca contradice el texto, con tono profesional"

 heuristic      "summary" is written in es
 deterministic  "summary" has at most 25 words
 deterministic  every number in summary, key_points[] appears in "text"
 probabilistic  AI judge checks: "nunca contradice el texto"
 NOT GUARANTEED "con tono profesional": subjective, no reproducible check
```

- Every promise shows **how sure** the check is: deterministic, heuristic or probabilistic.
- Subjective promises, and promises about fields the service doesn't have, are **refused, never invented**.
- Nothing is enforced until the seller **confirms**. Each publish is a new contract version (1.1.0, 1.2.0…);
  every case pins the version it was judged under, and appeals use those promises, never newer ones.
- **Languages.** Without AI, a rule-based parser understands common phrasings in **English and Spanish**
  ("at most 25 words" / "máximo 25 palabras", "between 0 and 60" / "entre 0 y 60", "never invents figures" /
  "no inventa cifras", "no older than 60 seconds" / "menos de 60 segundos de antigüedad", "always includes X" /
  "siempre incluye X"). Wording it doesn't recognise becomes a promise for the AI judge or is marked *not
  guaranteed*; it never invents a rule. With an AI backend configured (Gemini live, or Claude), the AI compiles any wording in any language
  into the same closed catalog.

`POST /<service>/promises/compile { text }` → draft · `POST /<service>/promises/publish { draftId, confirm: true }`
(needs `x-admin-token` when deployed) · `GET /<service>/promises` → current version and history.

## Crash Test

Before buyers rely on a contract version, Tribunal attacks it: a fixed battery per service, plus one
targeted attack generated from every promise the seller published. Expected outcomes are fixed before
anything runs, and results are always labelled as a simulation (they show what the contract catches,
not production accuracy).

Current results with the AI judge **off** (`GET /<service>/crash-test`):

| Service | Deterministic attacks caught | Semantic attacks caught | Honest outputs wrongly rejected |
|---|---|---|---|
| invoice | 7 / 7 | 0 / 1 (needs the AI judge) | 0 / 2 |
| summary | 4 / 4 | 0 / 1 (needs the AI judge) | 0 / 2 |
| quote | 5 / 5 | n/a (all promises objective) | 0 / 2 |

Semantic promises with no reliable automatic attack are reported as *untested*, never faked.

## Break my guarantee

Don't trust the demo, attack it. Anyone (judges included) can submit a deliberately bad output from the
showcase page or the API and see whether Tribunal catches it. Free, rate-limited (20/hour), and it never
creates a case or touches a payment.

- **Caught** → the guarantee held.
- **Not caught** → counted publicly as a possible weakness (e.g. "swapped lines" slips through when the
  AI judge is off, because only the judge can see it).
- Only the verdict and the attack name are stored, never the submitted payload.

`GET /<service>/sample` (honest input/output to start from) · `POST /<service>/challenge { input, output, note }`
· `GET /<service>/challenges` (caught vs slipped through).

## Showcase page

`GET /` in a browser serves a single page: pitch, the promise compiler, "break my guarantee", trust per
service and the live verdict feed with signed certificates. Plain HTML + JS against the JSON endpoints
(`src/kit/page.html`), no build step, works on mobile.

## Proof-Carrying Payments certificates

Every case gets a certificate signed with the server's Ed25519 key, binding the **promise** (contract
version + hash), the **evidence** (input hash, evaluated-output hash, rule results, judge outcome) and the
**decision**. Payment state (`not_attempted | pending | settled | failed`) is tracked separately, so a
failed settlement is never confused with a quality rejection.

- `GET /certificates/key`: public key. Anyone can verify a certificate offline.
- `GET /certificates/:id`: certificate + signature + payment state.
- `POST /certificates/:id/check-output`: the buyer proves what they received is exactly what was judged, without publishing it.
- Contracts are versioned and hashed; each case pins the version it was judged under.
- Each certificate is bound to one payment: `payment.ref` is the hash of the signed x402 authorization and
  `payment.nonce` its EIP-3009 nonce, so a certificate can't be reused for another payment.

A certificate proves *this server evaluated this exact output against this exact contract and decided
this*. It does not prove the output is true, and it does not stop a seller from settling outside Tribunal.

## The PayBox plugin

[`paybox-plugin/`](paybox-plugin/) is the marketplace plugin (MCP server, bundled to `dist/plugin.mjs` with the
official starter 1.0.2). It gives any PayBox agent seven tools:

| Tool | Kind | What it does |
|---|---|---|
| `check_guarantee` | read | Contract, price, trust score and Crash Test of a service, before paying |
| `extract_invoice`, `summarize_text`, `get_price_quote` | x402 proposal (Base USDC, max 0.01) | Paid, guaranteed calls: settled only if the result keeps the contract |
| `list_guaranteed_apis`, `call_guaranteed_api` | read / x402 proposal | Any third-party API a seller guaranteed through `/guard` |
| `get_case` | read | Promise, evidence and payment of a case, with the Ed25519 certificate **verified inside the plugin** |

Configure in the portal: network host = your Tribunal host, env `TRIBUNAL_URL=https://<host>`.

## Verified on-chain

`npm run testnet:run` pays with real x402 v2 signatures on Base Sepolia through the public facilitator and
checks balances on-chain. **8/8 checks pass** ([full report](docs/testnet-report.md)):

- **Honest invoice:** HTTP 200, settled on-chain ([tx](https://sepolia.basescan.org/tx/0x3b85177da15cee82a822943b2c156f71341a457e9c8fb5c631ccce0fe6a3af6c)), buyer −0.01 USDC, seller +0.01 USDC.
- **Replay of that exact signed payment:** HTTP 409 `payment_already_used`, no second charge.
- **Faulty invoice (total inflated):** HTTP 422, **never settled**. The buyer's signed authorization was never
  submitted; balances unchanged after 30s. Its certificate is bound to that unused nonce.
- **Bonus, a real failure:** on one run the public facilitator itself failed to submit a settlement. Tribunal
  recorded `settle_failed` (separate from the passing verdict), the buyer kept their money, and an on-chain
  read of `authorizationState` confirmed the nonce was never used ([x402#1062](https://github.com/x402-foundation/x402/issues/1062)).

**With real money, through PayBox, on Solana mainnet (Oct 17, 2026).** A PayBox wallet paid Tribunal through
PayBox's own x402 gateway (`use_service`), approved in the PayBox signing window:

- **Price quote, promise kept:** HTTP 200, **settled on Solana mainnet**
  ([tx](https://solscan.io/tx/iQUR6yw9cFUULva267JKWwQokrUWFwxvLFLjENr3dJnHdCyJMM8JyrwWsF5uC9aKgUibnfz6bYfYt7WGnrdwC2q)),
  seller +0.01 USDC. Timeline: authorized → judged → settling → settled.
- **Price quote, promise broken:** the service returned no quote. HTTP 422, rule `non_empty` failed,
  **never settled**: the seller's USDC balance did not move, and PayBox reported no money left the wallet.

## Two payment rails: Base and Solana

USDC on **Base** is the primary rail. Set `PAY_TO_SOLANA` and every paid route also offers **USDC on Solana**
(`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, exact SVM scheme, fees sponsored by the PayAI facilitator), the two
rails PayBox supports for x402. The plugin's paid tools take `pay_on: "base" | "solana"`. Pay-on-validation works
the same on both: a 422 is never settled. The on-chain fraud audit covers both: on Base it reads EIP-3009
`authorizationState`; on Solana it looks for the buyer's own payment signature among the buyer's transactions (a
settled payment always carries it, and an unsettled one can never land after its blockhash expires).

## Payment safety

- **Payment timeline per case**, separate from the verdict: `authorized → judged → not_charged | settling →
  settled | settle_failed → reconciled_settled | expired_unsettled`.
- **On-chain reconciliation** (`POST /cases/:id/reconcile`, also automatic for stale cases): reads USDC's
  `authorizationState(payer, nonce)` instead of assuming a timeout means "not charged".
- **Idempotency-Key:** an agent retrying with the same key gets the original answer (409), never a second payment.
- **Replay protection:** a signed payment already used on a case is refused before reaching the paywall.

## Instant guarantee for any API

**This is the answer to adoption.** A guarantee layer only matters if sellers use it, and most won't rewrite their API
for it. They don't have to: paste a URL, write the promise in plain language, done, with no code on the seller's side.
A seller can put a guarantee in front of an existing API in about a minute, start earning from agents that
refuse to pay unguaranteed services, and build a public trust score from day one.

```
POST /guard { title, url, method, promise, sample? }   → calls the API once, infers its JSON shape,
                                                          compiles the promise, crash-tests it
POST /guard/:id/activate { confirm: true }              → live at POST /g/<slug>, paid via x402
```

Tribunal then sits in front of the API: every paid call is forwarded, the upstream response is judged against
the compiled promise, and the payment settles only if it holds. Verified live against Open-Meteo's public weather
API (3/3 crash-test attacks caught). Safety: public HTTPS only, DNS-checked against private ranges (no SSRF),
no redirects, 8s timeout, 256 KB cap.

## Every case, explained in five seconds

`/cases/:id` shows **Promise** (contract version and guarantees), **Evidence** (every rule, the judge, output hash)
and **Payment** (charged or not, the full timeline, the transaction), plus one-click signature verification.

## Why it fits PayBox

- Standard x402 v2 `exact` payments, the scheme PayBox's `pay_x402` / `use_service` already sign. No escrow contract, no custom wallet flow.
- Settle-after-validation uses the official `@x402/hono` middleware: a handler response ≥ 400 cancels settlement. Tribunal sets that status from the verdict.
- PayBox's rule ("submit once, then poll; never repeat the call") stays safe: a rejected call costs nothing.
- The agent skill reads the contract and trust score **before** asking the user to approve a payment.

## How it compares

> **PayBox controls who can spend. Tribunal controls what must be delivered before the seller gets paid.**

The x402 community names this gap itself: [x402-foundation/x402#2887](https://github.com/x402-foundation/x402/issues/2887)
("Correctness/dispute layer as the missing piece downstream of settlement") is open with ~100 comments.

| | Recourse (ETHOnline '26) | x402r | x402Disputes | vet402 / ScoutScore | **Tribunal** |
|---|---|---|---|---|---|
| When it acts | After payment (escrow + dispute window) | After payment (escrow) | After payment | Periodic external probes | **Before settlement** |
| Buyer action on failure | Open a dispute, post a 10% bond | File a dispute | File a dispute | None (signal only) | **None: never charged** |
| Infrastructure | Hedera + Chainlink CRE + CCIP | Custom escrow scheme | Standard | n/a | **Standard x402 `exact` on Base, what PayBox signs today** |
| Meaning-level failures | Not judged (deterministic only) | Arbiter | AI ruling | n/a | **Rules first, AI judge only for what rules can't see** |
| Public evidence | Verdict on-chain | n/a | n/a | Probe scores | **Signed certificates, live challenges, trust from real transactions** |

Recourse is the closest prior work (machine-checkable SLA, hash in the 402, LLM-assisted SLA writing).
Tribunal's difference: objective failures are stopped *before* any money moves, with no escrow, dispute or bond,
and it works with the payment flow PayBox already supports. On-chain escrow remains the stronger guarantee
for high-value calls; Tribunal complements it (see Roadmap).

## Add your own guaranteed service

```ts
import { z } from "zod";
import { defineGuarantee } from "./src/kit/types.ts";

export const myService = defineGuarantee({
  id: "translate",
  title: "Guaranteed translation",
  description: "…",
  price: "$0.02",
  input: z.object({ text: z.string(), to: z.string() }),
  output: z.object({ translation: z.string().min(1) }),
  guarantees: ["Never empty", "Every number preserved"],
  rules: (input, out) => [/* objective checks → { rule, detail }[] */],
  judge: { instructions: "Breach if meaning changed.", evidence: (i, o) => `<source>${i.text}</source><output>${JSON.stringify(o)}</output>` },
  run: async (input) => {/* do the work */},
});
```

Add it to `src/services/index.ts`: it's priced, paywalled, judged, listed in `/contracts`, tracked in
`/trust`, and shown on the dashboard.

## Endpoints

| Method | Path | |
|---|---|---|
| GET | `/` | Live dashboard in a browser, JSON index for agents |
| GET | `/contracts`, `/<service>/contract` | Price, network, input/output JSON schemas, guarantees |
| POST | `/<service>` | Paid via x402, or free with `x-tribunal-voucher` |
| POST | `/appeal` | `{ caseId, receipt, complaint }` within 24h of delivery |
| GET | `/verdicts`, `/verdicts/:id` | Public verdict feed (never the buyer's input or data) |
| GET | `/trust` | Trust score per service: Wilson lower bound of deliveries not overturned |
| GET | `/certificates/key`, `/certificates/:id` | Signing key and signed certificate per case |
| POST | `/certificates/verify`, `/certificates/:id/check-output` | Verify a signature; check a received output against the evaluated hash |
| GET | `/credits/:address` | Unspent credits for a wallet |

## Run

Requires Node ≥ 22.18 (runs TypeScript natively, no build step).

```bash
npm install
cp .env.example .env   # set PAY_TO to a fresh test wallet's public address
npm test
npm run dev            # open http://localhost:4021
```

**AI backend (`LLM_BACKEND`)**
- `off` (default without a key): deterministic extraction/summaries; the judge abstains, rules decide. Free.
- `cli`: uses your local Claude Code login (`claude -p`) for free local testing. Refused when deployed.
- `gemini`: Google Gemini (`GEMINI_API_KEY`, free tier). Used by the live deployment.
- `api`: Anthropic API (`ANTHROPIC_API_KEY`), `claude-opus-5-5` by default with structured outputs and
  server-side refusal fallback. Set `LLM_MODEL=claude-haiku-5-5` to keep cost per call below the price.

**AI reliability.** The AI is never on the payment's critical path for objective promises: schema, math,
limits, grounding and freshness are checked by code. For the rest:
- identical requests return the identical cached answer instantly (temperature 0, successful answers only);
- busy or rate-limited models fall back to other models, two rounds with a pause, before giving up;
- the demos on the public page are pre-computed when the server starts;
- if the AI is still unavailable, the compiler uses its rule parser and the judge **abstains**, so the rules
  decide. Nothing breaks and nobody is charged on an AI guess. `GET /ai/status` reports the live state.

`DEMO_FAULTS=1` honours an `x-demo-fault` header to force each failure path on camera:
invoice `empty | wrong_total | missing_field | hallucinated | swapped_items`,
summary `empty | too_long | invented_number | unsupported_claim`,
quote `empty | stale | wrong_pair | zero_price | future_timestamp`. `QUOTE_SOURCE=simulated` serves a
clearly labelled simulated price for offline demos.

## Deploy

`render.yaml` is a Render blueprint (free plan): New → Blueprint → this repo, then fill `PAY_TO`
(and optionally `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`). Health check: `/trust`.

## Design notes and limits

- **Seller-side enforcement, audited on-chain.** Not settling is enforced by this server's code, not a contract,
  so a dishonest seller could still submit a rejected buyer's authorization within its window (300s). Tribunal
  catches it: every rejected x402 case is audited on-chain (USDC's `authorizationState` on Base, the buyer's payment
  signature on Solana) (on view, every 5 minutes,
  or `POST /audit`). A used nonce flags the case `settled_despite_rejection` publicly, counts as a charged failure
  and drops the service's trust score to 0. Escrow-backed refunds remain on the roadmap.
- **Consensus judge.** The AI judge can only reject when two independent reviews agree: a second reviewer argues
  the seller's side and must independently confirm a concrete problem. Disagreement means abstain, and the objective
  rules decide. Upheld results cost one review; only breaches cost two.
- **Rules before AI.** Rules are deterministic and can't be argued with. The judge only rejects on a
  concrete finding, treats all inputs as evidence (not instructions), and abstains on failure.
- **Credits are bearer tokens** (HMAC-signed, single-use, 7-day expiry, scoped to one service), never
  balances keyed by wallet address, because addresses are public.
- **Storage** is a JSON file for the demo; verdicts never expose the buyer's input publicly. Real paid cases are
  backed up every minute to the `evidence` branch (inputs and outputs redacted, certificates still verify) and
  restored on boot, so the public record survives restarts on a free host with an ephemeral disk.

## Roadmap

- Anchor verdict hashes on Base (ERC-8004 Validation Registry) so the record can't be rewritten.
- Escrow mode via x402r for high-value calls: Tribunal decides, escrow guarantees.
- Contract format proposed as an x402 extension, alongside Bazaar discovery metadata.

## Layout

```
src/
  kit/                 the reusable guarantee kit
    types.ts           Guarantee definition
    tribunal.ts        routes: paid services, appeals, verdicts, trust, credits
    verdict.ts         schema → rules → judge
    judge.ts           AI judge (any backend)
    vouchers.ts        single-use credits
    trust.ts           trust score
    text.ts            grounding helpers
    dashboard.ts       live verdicts page
  services/            example guaranteed services (invoice, summary)
  llm.ts               AI backend: Gemini, Claude API, local Claude CLI, or off
  server.ts            x402 middleware, facilitator, settlement hook
plugin/                PayBox marketplace manifest + agent skill (draft until official format)
test/                  node:test suite
docs/                  plan and full explanation (Spanish)
```

## Disclosure

Scaffolding was prepared on 2026-10-15, before Chapter 1 opened, as permitted by the program terms
(pre-existing materials allowed with disclosure).

---

Designed and built by [exoticdev](https://github.com/Exoticdevelopment).
