import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { MiddlewareHandler } from "hono";
import { ARTICLE, GOOD_INVOICE } from "./fixtures.ts";

// Config is read at import time, so set the environment first.
process.env.DEMO_FAULTS = "1";
process.env.ANTHROPIC_API_KEY = "";
process.env.LLM_BACKEND = "off";
process.env.DATA_FILE = ":memory:";
process.env.VOUCHER_SECRET = "test-secret";
process.env.QUOTE_SOURCE = "simulated";

const { createApp } = await import("../src/app.ts");
const { VOUCHER_HEADER, FAULT_HEADER } = await import("../src/kit/tribunal.ts");
const { Db } = await import("../src/store/db.ts");
const { Vouchers } = await import("../src/kit/vouchers.ts");
type JudgeRuling = import("../src/kit/types.ts").JudgeRuling;

/** Stand-in for the x402 middleware: 402 without a payment header, pass-through with one. */
const fakePaywall: MiddlewareHandler = async (c, next) => {
  if (!c.req.header("payment-signature")) return c.json({ error: "payment required" }, 402);
  await next();
};

let ruling: JudgeRuling;
let db: InstanceType<typeof Db>;
let app: ReturnType<typeof createApp>;
let vouchers: InstanceType<typeof Vouchers>;

beforeEach(() => {
  ruling = { status: "abstained", reasoning: "test" };
  db = new Db(":memory:");
  app = createApp({ db, paywall: fakePaywall, judge: async () => ruling });
  vouchers = new Vouchers(db, "test-secret");
});

const call = (service: string, body: object, headers: Record<string, string> = {}) =>
  app.request(`/${service}`, {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": "paid", ...headers },
    body: JSON.stringify(body),
  });
const invoice = (headers: Record<string, string> = {}) => call("invoice", { document: GOOD_INVOICE }, headers);
const summary = (headers: Record<string, string> = {}) => call("summary", { text: ARTICLE, max_words: 40 }, headers);
const breach: JudgeRuling = { status: "breach", reasoning: "wrong", findings: ["descriptions swapped"] };

test("unpaid request gets 402 from the paywall", async () => {
  const res = await app.request("/invoice", { method: "POST", body: "{}" });
  assert.equal(res.status, 402);
});

test("good invoice is delivered with a receipt", async () => {
  const res = await invoice();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.decision, "delivered");
  assert.equal(body.data.total, 50456);
  assert.ok(body.receipt);
});

test("wrong total returns 422 so payment never settles", async () => {
  const res = await invoice({ [FAULT_HEADER]: "wrong_total" });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.charged, false);
  assert.equal(body.verdict.rules.violations[0].rule, "total");
});

test("invented vendor is rejected by grounding without the judge", async () => {
  const body = await (await invoice({ [FAULT_HEADER]: "hallucinated" })).json();
  assert.equal(body.decision, "rejected");
  assert.equal(body.verdict.judge.status, "skipped");
});

test("swapped items pass rules; the judge decides", async () => {
  const abstained = await invoice({ [FAULT_HEADER]: "swapped_items" });
  assert.equal(abstained.status, 200);

  ruling = breach;
  const caught = await invoice({ [FAULT_HEADER]: "swapped_items" });
  assert.equal(caught.status, 422);
  assert.match((await caught.json()).verdict.summary, /descriptions swapped/);
});

test("faults are ignored for unknown names", async () => {
  assert.equal((await invoice({ [FAULT_HEADER]: "not_a_fault" })).status, 200);
});

test("invalid request body is 400 and uncharged", async () => {
  assert.equal((await call("invoice", { document: "too short" })).status, 400);
});

test("summary service delivers and enforces its own contract", async () => {
  assert.equal((await summary()).status, 200);
  const invented = await (await summary({ [FAULT_HEADER]: "invented_number" })).json();
  assert.equal(invented.verdict.rules.violations[0].rule, "invented_numbers");
  assert.equal((await summary({ [FAULT_HEADER]: "too_long" })).status, 422);
});

test("unsupported claim in a summary is only caught by the judge", async () => {
  assert.equal((await summary({ [FAULT_HEADER]: "unsupported_claim" })).status, 200);
  ruling = breach;
  assert.equal((await summary({ [FAULT_HEADER]: "unsupported_claim" })).status, 422);
});

test("voucher survives a rejected attempt and is spent on delivery", async () => {
  const { token } = vouchers.issue("seed-case", "invoice", "0xabc");
  const free = { [VOUCHER_HEADER]: token, "payment-signature": "" };

  const failed = await invoice({ ...free, [FAULT_HEADER]: "missing_field" });
  assert.equal(failed.status, 422);
  assert.match((await failed.json()).message, /credit was returned/);

  assert.equal((await invoice(free)).status, 200);

  const reused = await invoice(free);
  assert.equal(reused.status, 402);
  assert.equal((await reused.json()).reason, "voucher already redeemed");
});

test("voucher only works on the service it was issued for", async () => {
  const { token } = vouchers.issue("seed-case", "invoice", null);
  const res = await summary({ [VOUCHER_HEADER]: token, "payment-signature": "" });
  assert.equal(res.status, 402);
  assert.match((await res.json()).reason, /invoice service/);
});

test("forged voucher is refused", async () => {
  const { voucher } = vouchers.issue("seed-case", "invoice", null);
  assert.equal((await invoice({ [VOUCHER_HEADER]: `${voucher.id}.forged`, "payment-signature": "" })).status, 402);
});

test("upheld appeal issues a credit that buys a free retry", async () => {
  const delivered = await (await invoice()).json();
  const appeal = (receipt: string) =>
    app.request("/appeal", {
      method: "POST",
      body: JSON.stringify({ caseId: delivered.caseId, receipt, complaint: "Line descriptions are attached to the wrong items." }),
    });

  assert.equal((await appeal("x".repeat(20))).status, 404);

  ruling = breach;
  const body = await (await appeal(delivered.receipt)).json();
  assert.equal(body.ruling.status, "breach");
  assert.ok(body.credit.voucher);

  ruling = { status: "abstained", reasoning: "test" };
  assert.equal((await invoice({ [VOUCHER_HEADER]: body.credit.voucher, "payment-signature": "" })).status, 200);
  assert.equal((await appeal(delivered.receipt)).status, 409);
});

test("trust is reported per service and counts overturned deliveries", async () => {
  await invoice();
  await invoice({ [FAULT_HEADER]: "empty" });
  await summary();
  const trust = await (await app.request("/trust")).json();
  assert.equal(trust.services.invoice.attempts, 2);
  assert.equal(trust.services.invoice.rejectedBeforeCharge, 1);
  assert.equal(trust.services.summary.delivered, 1);
  assert.equal(trust.overall.chargedFailures, 0);
});

test("public verdicts never expose the buyer's input or data", async () => {
  await invoice();
  const feed = await (await app.request("/verdicts")).json();
  assert.equal(feed.length, 1);
  const text = JSON.stringify(feed);
  assert.ok(!text.includes("Panadería"));
  assert.ok(!("input" in feed[0]) && !("output" in feed[0]));
});

test("contracts are published for every service", async () => {
  const all = await (await app.request("/contracts")).json();
  assert.deepEqual(all.map((c: { service: string }) => c.service), ["invoice", "summary", "quote"]);
  const one = await (await app.request("/summary/contract")).json();
  assert.equal(one.settlement, "after-validation");
  assert.ok(one.output.properties.key_points);
  assert.equal((await app.request("/nope/contract")).status, 404);
});

test("dashboard is served to browsers, JSON to agents", async () => {
  const html = await app.request("/", { headers: { accept: "text/html" } });
  assert.match(await html.text(), /PayBox Tribunal/);
  const json = await (await app.request("/")).json();
  assert.equal(json.services.length, 3);
});

// ---------- Proof-Carrying Payments certificates ----------

const { verifyCertificate, canonicalJson } = await import("../src/kit/certificate.ts");
const post = (path: string, body: unknown) => app.request(path, { method: "POST", body: JSON.stringify(body) });

test("canonical JSON ignores key order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
});

test("every case carries a signed certificate anyone can verify with the public key", async () => {
  const delivered = await (await invoice()).json();
  const { certificate, signature } = await (await app.request(delivered.certificateUrl)).json();
  const { publicKey } = await (await app.request("/certificates/key")).json();

  assert.equal(certificate.decision, "delivered");
  assert.ok(verifyCertificate(certificate, signature, publicKey));
  assert.equal((await (await post("/certificates/verify", { certificate, signature })).json()).valid, true);

  const tampered = { ...certificate, decision: "rejected" };
  assert.equal(verifyCertificate(tampered, signature, publicKey), false);
  assert.equal((await (await post("/certificates/verify", { certificate: tampered, signature })).json()).valid, false);
});

test("the certificate pins the exact contract version and hash", async () => {
  const delivered = await (await invoice()).json();
  const { certificate } = await (await app.request(delivered.certificateUrl)).json();
  const contract = await (await app.request("/invoice/contract")).json();
  assert.equal(certificate.contract.hash, contract.contractHash);
  assert.equal(certificate.contract.version, contract.version);
});

test("buyer can prove the delivered output is exactly what was evaluated", async () => {
  const delivered = await (await invoice()).json();
  const match = await (await post(`/certificates/${delivered.caseId}/check-output`, { output: delivered.data })).json();
  assert.equal(match.matches, true);
  assert.equal(match.hash, delivered.evaluatedOutputHash);

  const altered = await (await post(`/certificates/${delivered.caseId}/check-output`, { output: { ...delivered.data, total: 1 } })).json();
  assert.equal(altered.matches, false);
});

test("payment status is separate from the quality decision", async () => {
  const rejected = await (await invoice({ [FAULT_HEADER]: "empty" })).json();
  const delivered = await (await invoice()).json();
  const r = await (await app.request(`/verdicts/${rejected.caseId}`)).json();
  const d = await (await app.request(`/verdicts/${delivered.caseId}`)).json();
  assert.equal(r.payment.status, "not_attempted");
  assert.equal(d.payment.status, "pending");
  assert.equal(r.certificate.decision, "rejected");
});

// ---------- Break my guarantee ----------

test("each service publishes a sample for the challenge form", async () => {
  const s = await (await app.request("/invoice/sample")).json();
  assert.equal(s.output.total, 50456);
  assert.ok(s.input.document.includes("Panadería"));
});

test("a challenge with an invented vendor is caught, free and recorded", async () => {
  const { input, output } = await (await app.request("/invoice/sample")).json();
  const res = await post("/invoice/challenge", { input, output: { ...output, vendor_name: "Globex Corporation" }, note: "Invent the vendor" });
  const body = await res.json();
  assert.equal(body.caught, true);
  assert.equal(body.verdict.rules.violations[0].rule, "grounding");

  const stats = await (await app.request("/invoice/challenges")).json();
  assert.equal(stats.total, 1);
  assert.equal(stats.caught, 1);
  assert.equal(stats.recent[0].note, "Invent the vendor");
  assert.ok(!JSON.stringify(stats).includes("Globex"), "challenge payloads are not stored publicly");
});

test("an honest output is not caught, and slips are counted publicly", async () => {
  const { input, output } = await (await app.request("/summary/sample")).json();
  const body = await (await post("/summary/challenge", { input, output })).json();
  assert.equal(body.caught, false);
  assert.equal((await (await app.request("/summary/challenges")).json()).notCaught, 1);
});

test("challenges never create cases or touch payments", async () => {
  const { input, output } = await (await app.request("/invoice/sample")).json();
  await post("/invoice/challenge", { input, output });
  assert.equal((await (await app.request("/verdicts")).json()).length, 0);
});

test("challenge input must match the service's input schema", async () => {
  assert.equal((await post("/invoice/challenge", { input: { document: "x" }, output: {} })).status, 400);
});

// ---------- Certificates bound to the payment ----------

const { encodePaymentSignatureHeader } = await import("@x402/core/http");

test("the certificate is bound to the exact signed payment and its nonce", async () => {
  const nonce = "0x" + "ab".repeat(32);
  const header = encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: { scheme: "exact", network: "eip155:84532", amount: "10000", asset: "0x0", payTo: "0x0", maxTimeoutSeconds: 300, extra: {} },
    payload: { signature: "0xsig", authorization: { from: "0xBuyer", to: "0x0", value: "10000", validAfter: "0", validBefore: "9999999999", nonce } },
  } as never);
  const body = await (await invoice({ "payment-signature": header })).json();
  const { certificate } = await (await app.request(body.certificateUrl)).json();
  assert.equal(certificate.payment.nonce, nonce);
  assert.equal(certificate.payment.payer, "0xBuyer");
  assert.match(certificate.payment.ref, /^sha256:[0-9a-f]{64}$/);
});

// ---------- Fresh price quotes ----------

const quote = (headers: Record<string, string> = {}) => call("quote", { asset: "BTC", max_age_seconds: 60 }, headers);

test("a fresh quote is delivered; a stale one is rejected without charge", async () => {
  const ok = await (await quote()).json();
  assert.equal(ok.decision, "delivered");
  assert.equal(ok.data.pair, "BTC/USD");

  const stale = await quote({ [FAULT_HEADER]: "stale" });
  assert.equal(stale.status, 422);
  assert.equal((await stale.json()).verdict.rules.violations[0].rule, "freshness");
});

test("quote rejects wrong pairs, zero prices and future timestamps", async () => {
  for (const fault of ["wrong_pair", "zero_price", "future_timestamp"]) {
    assert.equal((await quote({ [FAULT_HEADER]: fault })).status, 422, fault);
  }
});

// ---------- Idempotency, replay and reconciliation ----------

const signedPayment = (nonce: string, validBefore = "9999999999") =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: { scheme: "exact", network: "eip155:84532", amount: "10000", asset: "0xUSDC", payTo: "0x0", maxTimeoutSeconds: 300, extra: {} },
    payload: { signature: "0xsig", authorization: { from: "0xBuyer", to: "0x0", value: "10000", validAfter: "0", validBefore, nonce } },
  } as never);

test("a retry with the same Idempotency-Key returns the original result and is never charged", async () => {
  const first = await invoice({ "idempotency-key": "order-42" });
  assert.equal(first.status, 200);
  const original = await first.json();

  const retry = await invoice({ "idempotency-key": "order-42", "payment-signature": signedPayment("0x" + "01".repeat(32)) });
  assert.equal(retry.status, 409);
  const body = await retry.json();
  assert.equal(body.charged, false);
  assert.equal(body.original.body.caseId, original.caseId);
  assert.equal(body.original.body.receipt, undefined, "the appeal receipt is not handed to retries");
});

test("a payment signature can only be used once", async () => {
  const header = signedPayment("0x" + "02".repeat(32));
  assert.equal((await invoice({ "payment-signature": header })).status, 200);
  const replay = await invoice({ "payment-signature": header });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, "payment_already_used");
});

test("every case carries a payment timeline separate from the verdict", async () => {
  const rejected = await (await invoice({ [FAULT_HEADER]: "empty" })).json();
  const v = await (await app.request(`/verdicts/${rejected.caseId}`)).json();
  assert.deepEqual(v.payment.timeline.map((e: { state: string }) => e.state), ["authorized", "judged", "not_charged"]);
});

test("reconciliation asks the chain instead of assuming", async () => {
  let used = false;
  const recDb = new Db(":memory:");
  const recApp = createApp({ db: recDb, paywall: fakePaywall, judge: async () => ruling, chain: { authorizationUsed: async () => used } });
  const res = await recApp.request("/invoice", {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": signedPayment("0x" + "03".repeat(32)) },
    body: JSON.stringify({ document: GOOD_INVOICE }),
  });
  const { caseId } = await res.json();
  const reconcile = async () => (await recApp.request(`/cases/${caseId}/reconcile`, { method: "POST" })).json();

  const pending = await reconcile();
  assert.equal(pending.changed, false);
  assert.match(pending.note, /still valid/);

  used = true;
  const settled = await reconcile();
  assert.equal(settled.changed, true);
  assert.equal(settled.payment.status, "settled");
  assert.equal(settled.payment.timeline.at(-1).state, "reconciled_settled");
});

test("an expired, unused authorization is reconciled as never charged", async () => {
  const recDb = new Db(":memory:");
  const recApp = createApp({ db: recDb, paywall: fakePaywall, judge: async () => ruling, chain: { authorizationUsed: async () => false } });
  const res = await recApp.request("/invoice", {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": signedPayment("0x" + "04".repeat(32), "1") },
    body: JSON.stringify({ document: GOOD_INVOICE }),
  });
  const { caseId } = await res.json();
  const r = await (await recApp.request(`/cases/${caseId}/reconcile`, { method: "POST" })).json();
  assert.equal(r.payment.status, "not_attempted");
  assert.equal(r.payment.timeline.at(-1).state, "expired_unsettled");
});

test("each case records what its AI review cost; rules-only cases cost nothing", async () => {
  const { recordUsage } = await import("../src/kit/cost.ts");
  const meteredApp = createApp({
    db,
    paywall: fakePaywall,
    // Like the real judge: services without an AI judge never reach the model.
    judge: async (g) => {
      if (!g.judge) return { status: "abstained", reasoning: "rules only" };
      recordUsage("gemini-2.5-flash", 1000, 200);
      return { status: "upheld", reasoning: "ok", findings: [] };
    },
  });
  const res = await meteredApp.request("/summary", {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": "paid" },
    body: JSON.stringify({ text: ARTICLE, max_words: 40 }),
  });
  const { caseId } = await res.json();
  const v = await (await meteredApp.request(`/verdicts/${caseId}`)).json();
  assert.deepEqual(v.reviewCost, { aiCalls: 1, inputTokens: 1000, outputTokens: 200, estimatedUsd: 0.0008 });

  const quote = await meteredApp.request("/quote", {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": "paid-2" },
    body: JSON.stringify({ asset: "BTC", max_age_seconds: 120 }),
  });
  const q = await (await meteredApp.request(`/verdicts/${(await quote.json()).caseId}`)).json();
  assert.equal(q.reviewCost.aiCalls, 0, "the quote service is rules only");
});

test("AI review pauses when it costs more than its share of the price; rules then decide", async () => {
  const { recordUsage } = await import("../src/kit/cost.ts");
  let judgeCalls = 0;
  const pricey = createApp({
    db,
    paywall: fakePaywall,
    judge: async () => {
      judgeCalls++;
      recordUsage("gemini-2.5-flash", 1_000_000, 0); // $0.30 for a $0.01 call
      return { status: "upheld", reasoning: "ok", findings: [] };
    },
  });
  const buy = (sig: string) =>
    pricey.request("/summary", {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": sig },
      body: JSON.stringify({ text: ARTICLE, max_words: 40 }),
    });
  await buy("p1");
  const second = await (await buy("p2")).json();
  assert.equal(judgeCalls, 1, "the second case is not sent to the AI");
  assert.equal(second.decision, "delivered");
  assert.match(second.verdict.judge.reasoning, /AI review paused/);
  const contract = await (await pricey.request("/summary/contract", { headers: { accept: "application/json" } })).json();
  assert.equal(contract.adjudication.aiJudge, "off", "LLM is off in tests, so the contract reports off");
  assert.ok(contract.adjudication.measured.shareOfPrice > 0.3);
});

test("demo faults are recorded on the case, so demos are never mistaken for real failures", async () => {
  const res = await invoice({ [FAULT_HEADER]: "wrong_total" });
  const { caseId } = await res.json();
  const v = await (await app.request(`/verdicts/${caseId}`)).json();
  assert.equal(v.demoFault, "wrong_total");
});
