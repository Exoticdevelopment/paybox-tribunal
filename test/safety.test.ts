import { test } from "node:test";
import assert from "node:assert/strict";
import type { MiddlewareHandler } from "hono";
import { GOOD_INVOICE } from "./fixtures.ts";

process.env.DEMO_FAULTS = "1";
process.env.LLM_BACKEND = "off";
process.env.ANTHROPIC_API_KEY = "";
process.env.DATA_FILE = ":memory:";
process.env.VOUCHER_SECRET = "test-secret";

const { createApp } = await import("../src/app.ts");
const { Db } = await import("../src/store/db.ts");
const { createClaudeJudge } = await import("../src/kit/judge.ts");
const { invoiceService } = await import("../src/services/invoice.ts");
const { encodePaymentSignatureHeader } = await import("@x402/core/http");

const pass: MiddlewareHandler = async (_c, next) => next();
const signed = (nonce: string) =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: { scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0xUSDC", payTo: "0x0", maxTimeoutSeconds: 300, extra: {} },
    payload: { signature: "0xsig", authorization: { from: "0xBuyer", to: "0x0", value: "10000", validAfter: "0", validBefore: "9999999999", nonce } },
  } as never);

// ---------- Fraud detector ----------

test("a seller who settles a rejected payment is caught on-chain and loses all trust", async () => {
  const usedNonces = new Set<string>();
  const app = createApp({
    db: new Db(":memory:"),
    paywall: pass,
    judge: async () => ({ status: "abstained", reasoning: "test" }),
    chain: { authorizationUsed: async ({ nonce }) => usedNonces.has(nonce) },
  });
  const call = (headers: Record<string, string>) =>
    app.request("/invoice", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ document: GOOD_INVOICE }) });

  await call({ "payment-signature": signed("0x" + "11".repeat(32)) }); // honest delivery
  const rejected = await (await call({ "payment-signature": signed("0x" + "22".repeat(32)), "x-demo-fault": "wrong_total" })).json();

  const clean = await (await app.request("/audit", { method: "POST" })).json();
  assert.equal(clean.fraud, 0);
  assert.equal(clean.pending, 1, "rejected, still valid, not used: nothing to flag yet");

  // The dishonest seller submits the buyer's authorization outside Tribunal.
  usedNonces.add("0x" + "22".repeat(32));
  const caught = await (await app.request("/audit", { method: "POST" })).json();
  assert.equal(caught.fraud, 1);

  const v = await (await app.request(`/verdicts/${rejected.caseId}`)).json();
  assert.equal(v.payment.status, "settled_despite_rejection");
  assert.equal(v.payment.timeline.at(-1).state, "settled_despite_rejection");

  const trust = await (await app.request("/trust")).json();
  assert.equal(trust.services.invoice.score, 0);
  assert.equal(trust.services.invoice.settledDespiteRejection, 1);
  assert.equal(trust.services.invoice.chargedFailures, 1);
});

// ---------- Consensus judge ----------

type Ask = Parameters<typeof createClaudeJudge>[0];
const scripted = (...rulings: ({ breach: boolean } | null)[]): Ask => {
  let i = 0;
  return (async () => {
    const r = rulings[i++];
    return r && { breach: r.breach, findings: r.breach ? ["descriptions swapped"] : [], reasoning: r.breach ? "wrong" : "fine" };
  }) as Ask;
};
const judgeWith = (ask: Ask) => createClaudeJudge(ask, () => true)(invoiceService, { input: { document: GOOD_INVOICE }, output: {} });

test("consensus: a breach needs two agreeing reviews", async () => {
  assert.equal((await judgeWith(scripted({ breach: true }, { breach: true }))).status, "breach");
});

test("consensus: if the second review disagrees, the judge abstains and rules decide", async () => {
  const r = await judgeWith(scripted({ breach: true }, { breach: false }));
  assert.equal(r.status, "abstained");
  assert.match(r.reasoning, /disagreed/);
});

test("consensus: an upheld result needs only one review (no extra cost)", async () => {
  let calls = 0;
  const counting = (async () => {
    calls++;
    return { breach: false, findings: [], reasoning: "fine" };
  }) as Ask;
  assert.equal((await judgeWith(counting)).status, "upheld");
  assert.equal(calls, 1);
});

test("consensus: a missing second review never produces a breach", async () => {
  assert.equal((await judgeWith(scripted({ breach: true }, null))).status, "abstained");
});
