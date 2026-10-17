import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What adjudication costs. Every AI call reports its tokens; the cost is estimated at the model's
 * list price (override with LLM_PRICE_IN_PER_MTOK / LLM_PRICE_OUT_PER_MTOK). Rules are plain code
 * and cost nothing, so a case judged only by rules has no review cost at all.
 */
export type ReviewCost = { calls: number; inputTokens: number; outputTokens: number; usd: number; models: string[] };

/** USD per million tokens, by model family. Estimates at list price; set the env vars for exact numbers. */
const PRICES: [RegExp, { in: number; out: number }][] = [
  [/gemini.*flash-lite/i, { in: 0.1, out: 0.4 }],
  [/gemini.*flash/i, { in: 0.3, out: 2.5 }],
  [/gemini/i, { in: 1.25, out: 10 }],
  [/haiku/i, { in: 1, out: 5 }],
  [/sonnet/i, { in: 3, out: 15 }],
  [/opus/i, { in: 5, out: 25 }],
];

export function priceOf(model: string): { in: number; out: number } {
  const envIn = Number(process.env.LLM_PRICE_IN_PER_MTOK);
  const envOut = Number(process.env.LLM_PRICE_OUT_PER_MTOK);
  if (envIn > 0 && envOut > 0) return { in: envIn, out: envOut };
  return PRICES.find(([re]) => re.test(model))?.[1] ?? { in: 1, out: 5 };
}

const meter = new AsyncLocalStorage<ReviewCost>();
const recent: ReviewCost[] = [];

/** Runs fn and returns what its AI calls cost (zero calls when only rules ran). */
export async function metered<T>(fn: () => Promise<T>): Promise<{ result: T; cost: ReviewCost }> {
  const cost: ReviewCost = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, models: [] };
  const result = await meter.run(cost, fn);
  cost.usd = Number(cost.usd.toFixed(6));
  return { result, cost };
}

/** Called by the LLM layer after each successful call. */
export function recordUsage(model: string, inputTokens: number, outputTokens: number) {
  const p = priceOf(model);
  const usd = (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
  const call: ReviewCost = { calls: 1, inputTokens, outputTokens, usd, models: [model] };
  recent.push(call);
  if (recent.length > 50) recent.shift();
  const current = meter.getStore();
  if (!current) return;
  current.calls++;
  current.inputTokens += inputTokens;
  current.outputTokens += outputTokens;
  current.usd += usd;
  if (!current.models.includes(model)) current.models.push(model);
}

/** Average of the last AI calls, for /ai/status. */
export function recentUsage() {
  if (!recent.length) return null;
  const sum = recent.reduce((a, c) => ({ in: a.in + c.inputTokens, out: a.out + c.outputTokens, usd: a.usd + c.usd }), { in: 0, out: 0, usd: 0 });
  return {
    calls: recent.length,
    avgInputTokens: Math.round(sum.in / recent.length),
    avgOutputTokens: Math.round(sum.out / recent.length),
    avgUsdPerCall: Number((sum.usd / recent.length).toFixed(6)),
  };
}

/** "$0.01" → 0.01 */
export function priceUsd(price: string): number {
  const n = Number(price.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * The budget rule that keeps a guarantee from costing more than the payment: the AI judge stays on
 * only while its measured average cost per judged case is at most `maxShare` of the price.
 * Above that the service runs on rules alone (which are free) until the average comes back down.
 */
export function judgeBudget(costs: (ReviewCost | null | undefined)[], price: string, maxShare: number) {
  const reviewed = costs.filter((c): c is ReviewCost => !!c && c.calls > 0).slice(-50);
  const p = priceUsd(price);
  const avgUsd = reviewed.length ? reviewed.reduce((a, c) => a + c.usd, 0) / reviewed.length : 0;
  const share = p > 0 ? avgUsd / p : 0;
  return {
    priceUsd: p,
    reviewedCases: reviewed.length,
    avgReviewUsd: Number(avgUsd.toFixed(6)),
    shareOfPrice: Number(share.toFixed(4)),
    maxShare,
    aiAllowed: share <= maxShare,
  };
}
