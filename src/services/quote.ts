import { z } from "zod";
import { freshnessProblem } from "../kit/promises.ts";
import { defineGuarantee, type Violation } from "../kit/types.ts";

const ASSETS = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana" } as const;

export const QuoteRequest = z.object({
  asset: z.enum(["BTC", "ETH", "SOL"]),
  /** How old the price may be when delivered. The buyer chooses; the seller is held to it. */
  max_age_seconds: z.number().int().min(10).max(3600).default(120),
});
export type QuoteRequest = z.infer<typeof QuoteRequest>;

export const Quote = z.object({
  pair: z.string(),
  price: z.number(),
  as_of: z.string().describe("ISO timestamp of the price at the source"),
  source: z.string().min(1),
});
export type Quote = z.infer<typeof Quote>;

export function quoteRules({ asset, max_age_seconds }: QuoteRequest, q: Quote): Violation[] {
  const violations: Violation[] = [];
  if (q.pair !== `${asset}/USD`) violations.push({ rule: "pair", detail: `Asked for ${asset}/USD, got ${q.pair}` });
  if (!(q.price > 0)) violations.push({ rule: "price", detail: `Price must be positive, got ${q.price}` });
  const stale = freshnessProblem(q.as_of, max_age_seconds);
  if (stale) violations.push({ rule: "freshness", detail: `as_of ${stale}` });
  return violations;
}

// ---------- The work ----------

/**
 * Live price from CoinGecko's public API, with the source's own update time as as_of.
 * QUOTE_SOURCE=simulated (tests, offline demos) returns a clearly labelled simulated price.
 * Any failure returns null: the tribunal rejects it and the buyer isn't charged.
 */
async function fetchQuote({ asset }: QuoteRequest): Promise<Quote | null> {
  if (process.env.QUOTE_SOURCE === "simulated") {
    const base = { BTC: 65000, ETH: 3200, SOL: 150 }[asset];
    return { pair: `${asset}/USD`, price: base, as_of: new Date().toISOString(), source: "simulated (offline demo, not a market price)" };
  }
  const id = ASSETS[asset];
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_last_updated_at=true`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as Record<string, { usd?: number; last_updated_at?: number }>;
  const row = body[id];
  if (!row?.usd || !row.last_updated_at) return null;
  return { pair: `${asset}/USD`, price: row.usd, as_of: new Date(row.last_updated_at * 1000).toISOString(), source: "coingecko.com" };
}

const FAULTS = ["empty", "stale", "wrong_pair", "zero_price", "future_timestamp"] as const;

function injectFault(output: Quote | null, fault: string): unknown {
  if (fault === "empty" || !output) return null;
  const q = { ...output };
  switch (fault) {
    case "stale":
      // A cached price from 15 minutes ago: valid-looking, but not what was promised.
      q.as_of = new Date(Date.now() - 15 * 60_000).toISOString();
      break;
    case "wrong_pair":
      q.pair = q.pair.startsWith("BTC") ? "ETH/USD" : "BTC/USD";
      break;
    case "zero_price":
      q.price = 0;
      break;
    case "future_timestamp":
      q.as_of = new Date(Date.now() + 10 * 60_000).toISOString();
      break;
  }
  return q;
}

export const quoteService = defineGuarantee({
  id: "quote",
  title: "Fresh price quotes",
  description: "Spot price for BTC, ETH or SOL in USD, guaranteed fresher than the age you ask for.",
  price: process.env.PRICE_QUOTE ?? process.env.PRICE ?? "$0.01",
  input: QuoteRequest,
  output: Quote,
  guarantees: [
    "The pair is exactly the asset you asked for, in USD.",
    "The price is positive.",
    "as_of (the source's own update time) is no older than your max_age_seconds, and not in the future.",
    "If any guarantee fails, the response is 422 and your payment is never settled.",
  ],
  rules: quoteRules,
  // Every promise here is objective: no AI judge needed.
  run: async (input, { fault }) => {
    const output = await fetchQuote(input);
    return fault ? injectFault(output, fault) : output;
  },
  // A getter so the honest sample is always fresh when someone starts a challenge from it.
  get sample() {
    return {
      input: { asset: "BTC" as const, max_age_seconds: 120 },
      output: { pair: "BTC/USD", price: 65000, as_of: new Date().toISOString(), source: "example" },
    };
  },
  crashSuite: [
    { name: "Honest fresh quote", kind: "deterministic", expect: "pass" },
    { name: "Cached price from 15 minutes ago", kind: "deterministic", expect: "fail", mutate: (o) => { o.as_of = new Date(Date.now() - 15 * 60_000).toISOString(); } },
    { name: "Timestamp in the future", kind: "deterministic", expect: "fail", mutate: (o) => { o.as_of = new Date(Date.now() + 10 * 60_000).toISOString(); } },
    { name: "Wrong pair", kind: "deterministic", expect: "fail", mutate: (o) => { o.pair = "ETH/USD"; } },
    { name: "Zero price", kind: "deterministic", expect: "fail", mutate: (o) => { o.price = 0; } },
    { name: "Missing source", kind: "deterministic", expect: "fail", mutate: (o) => { o.source = ""; } },
    { name: "Garbage timestamp", kind: "edge", expect: "fail", mutate: (o) => { o.as_of = "yesterday-ish"; } },
    { name: "Just inside the age limit", kind: "edge", expect: "pass", mutate: (o) => { o.as_of = new Date(Date.now() - 100_000).toISOString(); } },
  ],
  faults: FAULTS,
});
