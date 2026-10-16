import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { config } from "../config.ts";
import { llmAvailable } from "../llm.ts";
import { NO_PAYMENT, readPayment, type PaymentInfo } from "../payment.ts";
import type { Case, Db, PaymentEvent, Voucher } from "../store/db.ts";
import { viemChainReader, type ChainReader } from "./chain.ts";
import {
  buildCertificate,
  sha256,
  Signer,
  verifyCertificate,
  type Certificate,
  type SettlementStatus,
} from "./certificate.ts";
import { compilePromises } from "./compiler.ts";
import { runCrashTest, type CrashReport } from "./crashtest.ts";
import { callUpstream, inferSchema, proxyGuarantee, proxyInputSchema, slugify, ProxyInput, type ProxyDef } from "./proxy.ts";
import { caseHtml, contractsHtml, dashboardHtml } from "./dashboard.ts";
import { CERTAINTY_NOTE, type Promise_ } from "./promises.ts";
import { TRUST_METHOD, trustReport } from "./trust.ts";
import type { AnyGuarantee, JudgeFn } from "./types.ts";
import { decide } from "./verdict.ts";
import { Vouchers } from "./vouchers.ts";

const LOGO = readFileSync(new URL("../../plugin/assets/logo.svg", import.meta.url), "utf8");

export const VOUCHER_HEADER = "x-tribunal-voucher";
export const FAULT_HEADER = "x-demo-fault";
export const IDEMPOTENCY_HEADER = "idempotency-key";

export type TribunalDeps = {
  db: Db;
  guarantees: AnyGuarantee[];
  /** x402 payment middleware covering POST /<id> for every guarantee. Injected so tests can fake it. */
  paywall: MiddlewareHandler;
  judge: JudgeFn;
  /** On-chain reads for reconciliation. Injected so tests don't need an RPC. */
  chain?: ChainReader;
};

type Env = { Variables: { attemptId: string; voucher?: Voucher; guarantee: AnyGuarantee; idempotencyKey?: string } };

const AppealRequest = z.object({
  caseId: z.string().uuid(),
  receipt: z.string().min(10),
  complaint: z.string().min(10).max(2000),
});

/** x402 route config for every guarantee, ready for paymentMiddleware(). */
export function paywallRoutes(guarantees: AnyGuarantee[]) {
  return Object.fromEntries(
    guarantees.map((g) => [
      `POST /${g.id}`,
      {
        accepts: [{ scheme: "exact" as const, price: g.price, network: config.network, payTo: config.payTo }],
        description: `${g.title}. Pay-on-validation: settles only if the output passes the contract at GET /${g.id}/contract.`,
        mimeType: "application/json",
      },
    ]),
  );
}

/** Payment state, kept separate from the quality decision. */
export function settlementStatus(c: Case): SettlementStatus {
  if (c.verdict.decision === "rejected" || c.via === "voucher") return "not_attempted";
  if (c.settlement) return "settled";
  if (c.events?.some((e) => e.state === "expired_unsettled")) return "not_attempted";
  if (c.settlementFailure) return "failed";
  return "pending";
}

const CertificateRequest = z.object({ certificate: z.record(z.string(), z.unknown()), signature: z.string() });
const OutputCheckRequest = z.object({ output: z.unknown() });

/** Public projection of a case: verdict, certificate and settlement, never the buyer's input or data. */
function publicCase(c: Case) {
  return {
    caseId: c.id,
    service: c.service,
    createdAt: new Date(c.createdAt).toISOString(),
    via: c.via,
    decision: c.verdict.decision,
    verdict: c.verdict,
    charged: c.settlement !== null,
    payment: { status: settlementStatus(c), settlement: c.settlement, failure: c.settlementFailure, timeline: c.events ?? [] },
    // The seller promises in force when this case was judged (text and certainty only).
    sellerPromises: (c.promises ?? []).map((p) => ({ text: p.text, interpretation: p.interpretation, certainty: p.certainty })),
    certificate: c.certificate,
    signature: c.signature,
    appeal: c.appeal && { filedAt: new Date(c.appeal.filedAt).toISOString(), ruling: c.appeal.ruling },
  };
}

export function createTribunal({ db, guarantees, paywall, judge, chain = viemChainReader }: TribunalDeps) {
  const app = new Hono<Env>();
  const vouchers = new Vouchers(db, config.voucherSecret);
  const byId = new Map(guarantees.map((g) => [g.id, g]));
  const allowLocalUpstream = !config.isHosted;
  const proxyPrice = process.env.PRICE_PROXY ?? process.env.PRICE ?? "$0.01";
  const proxyCache = new Map<string, { def: ProxyDef; g: AnyGuarantee }>();
  const proxyGuaranteeOf = (def: ProxyDef) => {
    const hit = proxyCache.get(def.id);
    if (hit && hit.def === def) return hit.g;
    const g = proxyGuarantee(def, proxyPrice, allowLocalUpstream);
    proxyCache.set(def.id, { def, g });
    return g;
  };
  /** Built-in services first, then any API a seller guaranteed through /guard. */
  const lookup = (id: string): AnyGuarantee | undefined => {
    const builtIn = byId.get(id);
    if (builtIn) return builtIn;
    const def = db.getProxy(id);
    return def?.active ? proxyGuaranteeOf(def) : undefined;
  };
  const allGuarantees = () => [...guarantees, ...db.activeProxies().map(proxyGuaranteeOf)];

  const receiptFor = (caseId: string) =>
    createHmac("sha256", config.voucherSecret).update(`receipt:${caseId}`).digest("base64url");
  const receiptValid = (caseId: string, receipt: string) => {
    const a = Buffer.from(receiptFor(caseId));
    const b = Buffer.from(receipt);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const signer = new Signer(config.voucherSecret);

  // ---------- Contract = built-in guarantees + the seller's latest published promises ----------
  // Every case pins the exact version + hash it was judged under, so publishing new promises
  // can never rewrite the terms of an earlier payment.

  const schemasOf = (g: AnyGuarantee) => {
    const def = db.getProxy(g.id);
    if (def) return { input: proxyInputSchema(def.sampleInput), output: def.outputSchema };
    return { input: z.toJSONSchema(g.input), output: z.toJSONSchema(g.output) };
  };
  const currentSet = (g: AnyGuarantee) => db.promiseHistory(g.id).at(-1);
  const promisesOf = (g: AnyGuarantee) => currentSet(g)?.compiled.promises ?? [];
  const versionOf = (g: AnyGuarantee) => {
    const [major, minor] = (g.version ?? "1.0.0").split(".").map(Number);
    return `${major}.${minor + db.promiseHistory(g.id).length}.0`;
  };

  /** The guarantee as actually enforced: semantic promises are handed to the AI judge. */
  const effective = (g: AnyGuarantee, promises: Promise_[] = promisesOf(g)): AnyGuarantee => {
    const claims = promises.flatMap((p) => (p.rule.type === "semantic_claim" ? [p.rule.statement] : []));
    if (!claims.length) return g;
    return {
      ...g,
      judge: {
        instructions: `${g.judge?.instructions ?? ""}\nThe seller also promised the following; any of them broken is a breach:\n${claims.map((c) => `- ${c}`).join("\n")}`,
        evidence:
          g.judge?.evidence ??
          ((input: unknown, output: unknown) =>
            `<input>\n${JSON.stringify(input, null, 2)}\n</input>\n\n<output>\n${JSON.stringify(output, null, 2)}\n</output>`),
      },
    };
  };

  const contractBody = (g: AnyGuarantee) => ({
    service: g.id,
    version: versionOf(g),
    sellerPromises: promisesOf(g).map((p) => ({ text: p.text, interpretation: p.interpretation, certainty: p.certainty, rule: p.rule })),
    notGuaranteed: currentSet(g)?.compiled.unverifiable ?? [],
    title: g.title,
    description: g.description,
    endpoint: `POST /${g.id}`,
    price: g.price,
    network: config.network,
    payTo: config.payTo,
    settlement: "after-validation",
    input: schemasOf(g).input,
    output: schemasOf(g).output,
    guarantees: g.guarantees,
    // True only when a judge is defined for this service AND an AI backend is actually configured.
    aiJudge: Boolean(effective(g).judge) && llmAvailable(),
    appealWindowHours: config.appealWindowMs / 3_600_000,
    creditHeader: VOUCHER_HEADER,
  });
  const contractRef = (g: AnyGuarantee) => {
    const body = contractBody(g);
    return { version: body.version, hash: sha256(body) };
  };
  const contractOf = (g: AnyGuarantee) => {
    const body = contractBody(g);
    return { ...body, contractHash: sha256(body) };
  };

  // ---------- Discovery ----------

  app.get("/", (c) => {
    if (c.req.header("accept")?.includes("text/html")) return c.html(dashboardHtml());
    return c.json({
      name: "PayBox Tribunal",
      tagline: "x402 says what it costs. Tribunal says what you're guaranteed, and enforces it before you're charged.",
      services: allGuarantees().map((g) => ({ id: g.id, title: g.title, price: g.price, contract: `/${g.id}/contract` })),
      endpoints: {
        "GET /contracts": "Every service's terms, schemas and guarantees. Read before paying.",
        "POST /<service>": "Paid via x402 (settles only if the output passes), or free with a credit voucher.",
        "POST /appeal": "Dispute a delivered result within 24h. Upheld appeals earn a credit voucher.",
        "GET /verdicts": "Public verdict feed. GET /verdicts/:id for one case.",
        "GET /trust": "Trust score per service, computed from every verdict.",
        "GET /credits/:address": "Unspent credits issued to a wallet.",
        "GET /dashboard": "Live verdicts page.",
      },
    });
  });

  app.get("/dashboard", (c) => c.html(dashboardHtml()));
  app.get("/cases/:id", (c) => c.html(caseHtml()));
  app.get("/logo.svg", (c) => c.body(LOGO, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }));
  app.get("/contracts", (c) => {
    if (c.req.header("accept")?.includes("text/html")) return c.html(contractsHtml());
    return c.json(allGuarantees().map(contractOf));
  });
  app.get("/:service/contract", (c) => {
    const g = lookup(c.req.param("service"));
    return g ? c.json(contractOf(g)) : c.json({ error: "unknown_service" }, 404);
  });

  // ---------- Promise compiler: natural language → typed, versioned guarantees ----------

  const CompileRequest = z.object({ text: z.string().min(5).max(4000) });
  const PublishRequest = z.object({ draftId: z.string().uuid(), confirm: z.literal(true) });

  const describeCompiled = (compiled: Awaited<ReturnType<typeof compilePromises>>) => ({
    engine: compiled.engine,
    promises: compiled.promises.map((p) => ({ ...p, certaintyNote: CERTAINTY_NOTE[p.certainty] })),
    notGuaranteed: compiled.unverifiable,
    summary: {
      deterministic: compiled.promises.filter((p) => p.certainty === "deterministic").length,
      heuristic: compiled.promises.filter((p) => p.certainty === "heuristic").length,
      probabilistic: compiled.promises.filter((p) => p.certainty === "probabilistic").length,
      notGuaranteed: compiled.unverifiable.length,
    },
  });

  app.post("/:service/promises/compile", async (c) => {
    const g = lookup(c.req.param("service"));
    if (!g) return c.json({ error: "unknown_service" }, 404);
    const body = CompileRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues }, 400);

    const compiled = await compilePromises(body.data.text, schemasOf(g));
    const draft = { id: randomUUID(), service: g.id, text: body.data.text, compiled, createdAt: Date.now() };
    db.saveDraft(draft);
    return c.json({
      draftId: draft.id,
      service: g.id,
      ...describeCompiled(compiled),
      next: `Review every interpretation, then POST /${g.id}/promises/publish with { "draftId": "${draft.id}", "confirm": true }. Nothing is enforced until you confirm.`,
    });
  });

  app.post("/:service/promises/publish", async (c) => {
    const g = lookup(c.req.param("service"));
    if (!g) return c.json({ error: "unknown_service" }, 404);
    // Only the seller may change their promises. Locally (no ADMIN_TOKEN, not deployed) it's open for testing.
    if (config.adminToken ? c.req.header("x-admin-token") !== config.adminToken : config.isHosted) {
      return c.json({ error: "forbidden", detail: "Publishing promises needs the seller's x-admin-token." }, 403);
    }
    const body = PublishRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request", detail: "Send { draftId, confirm: true }." }, 400);
    const draft = db.getDraft(body.data.draftId);
    if (!draft || draft.service !== g.id) return c.json({ error: "draft_not_found" }, 404);
    if (!draft.compiled.promises.length) return c.json({ error: "nothing_to_publish", detail: "No promise in this draft can be verified." }, 409);

    const [major, minor] = versionOf(g).split(".").map(Number);
    db.publishPromises(g.id, { version: `${major}.${minor + 1}.0`, text: draft.text, compiled: draft.compiled, publishedAt: Date.now(), draftId: draft.id });
    return c.json({ published: true, contract: contractRef(g), ...describeCompiled(draft.compiled) });
  });

  app.get("/:service/promises", (c) => {
    const g = lookup(c.req.param("service"));
    if (!g) return c.json({ error: "unknown_service" }, 404);
    return c.json({
      service: g.id,
      current: contractRef(g),
      history: db.promiseHistory(g.id).map((s) => ({ version: s.version, text: s.text, publishedAt: new Date(s.publishedAt).toISOString() })),
      ...(currentSet(g) ? describeCompiled(currentSet(g)!.compiled) : { promises: [], notGuaranteed: [] }),
    });
  });

  // ---------- "Break my guarantee": public, free challenges against the live validator ----------
  // Anyone submits an input and a deliberately bad output. Caught → the guarantee held.
  // Not caught → published as a possible weakness. Free, rate-limited, never touches payments.

  const ChallengeRequest = z.object({ input: z.unknown(), output: z.unknown(), note: z.string().max(280).default("") });
  const CHALLENGE_LIMIT = 20;
  const challengeLog = new Map<string, number[]>();
  const allowChallenge = (who: string) => {
    const hourAgo = Date.now() - 3_600_000;
    const recent = (challengeLog.get(who) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= CHALLENGE_LIMIT) return false;
    challengeLog.set(who, [...recent, Date.now()]);
    return true;
  };

  app.get("/:service/sample", (c) => {
    const g = lookup(c.req.param("service"));
    if (!g?.sample) return c.json({ error: "no_sample" }, 404);
    return c.json({ service: g.id, ...g.sample, faults: g.faults ?? [] });
  });

  app.post("/:service/challenge", async (c) => {
    const g = lookup(c.req.param("service"));
    if (!g) return c.json({ error: "unknown_service" }, 404);
    const who = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (!allowChallenge(who)) return c.json({ error: "rate_limited", detail: `Max ${CHALLENGE_LIMIT} challenges per hour.` }, 429);

    const body = ChallengeRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request", detail: "Send { input, output, note? }." }, 400);
    const input = g.input.safeParse(body.data.input);
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);

    const promises = promisesOf(g);
    const verdict = await decide(effective(g, promises), input.data, body.data.output, judge, promises);
    const challenge = {
      id: randomUUID(),
      service: g.id,
      at: Date.now(),
      contractVersion: versionOf(g),
      note: body.data.note,
      caught: verdict.decision === "rejected",
      rulesHit: [...new Set(verdict.rules.violations.map((v) => v.rule))],
      judge: verdict.judge.status,
      summary: verdict.summary,
    };
    db.saveChallenge(challenge);
    return c.json({
      caught: challenge.caught,
      message: challenge.caught
        ? "Caught. This output would be rejected and the buyer never charged."
        : "Not caught. This output would pass. It's now listed publicly as a possible weakness.",
      verdict,
      contractVersion: challenge.contractVersion,
    });
  });

  // ---------- Crash Test: Tribunal attacks each contract before buyers rely on it ----------
  // Cached per contract version so repeated page loads don't re-run (and re-pay) the AI judge.

  const CRASH_TTL_MS = 5 * 60_000;
  const crashCache = new Map<string, { at: number; report: CrashReport & { contract: { version: string; hash: string } } }>();

  app.get("/:service/crash-test", async (c) => {
    const g = lookup(c.req.param("service"));
    if (!g?.sample) return c.json({ error: "unknown_service" }, 404);
    const contract = contractRef(g);
    const cached = crashCache.get(g.id);
    if (cached && cached.report.contract.hash === contract.hash && Date.now() - cached.at < CRASH_TTL_MS) {
      return c.json({ ...cached.report, cached: true });
    }
    const promises = promisesOf(g);
    const report = { ...(await runCrashTest(effective(g, promises), promises, judge, g.crashSuite ?? [])), contract };
    crashCache.set(g.id, { at: Date.now(), report });
    return c.json({ ...report, cached: false });
  });

  app.get("/:service/challenges", (c) => {
    const g = lookup(c.req.param("service"));
    if (!g) return c.json({ error: "unknown_service" }, 404);
    const all = db.challengesFor(g.id);
    return c.json({
      service: g.id,
      total: all.length,
      caught: all.filter((x) => x.caught).length,
      notCaught: all.filter((x) => !x.caught).length,
      recent: all.slice(-20).reverse().map((x) => ({ ...x, at: new Date(x.at).toISOString() })),
    });
  });

  // ---------- Paid services ----------

  /**
   * Runs before the x402 paywall, so nothing here can ever trigger a charge:
   * - Idempotency-Key retries get the original answer back (409), never a second payment.
   * - A payment signature that was already used on a case is refused outright.
   * - A credit voucher replaces payment entirely.
   */
  const guard = (resolve: (c: Context<Env>) => AnyGuarantee | undefined): MiddlewareHandler<Env> => async (c, next) => {
    const g = resolve(c);
    if (!g) return c.json({ error: "unknown_service" }, 404);
    c.set("guarantee", g);
    c.set("attemptId", randomUUID());

    const idemKey = c.req.header(IDEMPOTENCY_HEADER)?.slice(0, 200);
    if (idemKey) {
      const prior = db.findCaseByIdempotencyKey(g.id, idemKey);
      if (prior) {
        return c.json({ duplicate: true, charged: false, message: "Same Idempotency-Key: returning the original result. You were not charged again.", original: prior.response ?? null, caseId: prior.id }, 409);
      }
      c.set("idempotencyKey", idemKey);
    }

    const signed = readPayment(c.req.header("payment-signature") ?? c.req.header("x-payment"));
    if (signed.key && db.findCaseByPaymentKey(signed.key)) {
      return c.json({ error: "payment_already_used", charged: false, detail: "This signed payment was already used for another request." }, 409);
    }

    const token = c.req.header(VOUCHER_HEADER);
    if (!token) return paywall(c, next);

    const reserved = vouchers.reserve(token, g.id, c.get("attemptId"));
    if (!reserved.ok) return c.json({ error: "voucher_rejected", reason: reserved.reason }, 402);
    c.set("voucher", reserved.voucher);
    return next();
  };

  const servePaid = async (c: Context<Env>) => {
    const g = c.get("guarantee");
    const id = c.get("attemptId");
    const voucher = c.get("voucher");
    const events: PaymentEvent[] = [];
    const log = (state: PaymentEvent["state"], note: string) => events.push({ state, at: Date.now(), note });

    const body = g.input.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      if (voucher) vouchers.release(voucher);
      // 4xx: the x402 middleware cancels settlement, so a malformed request costs nothing.
      return c.json({ error: "invalid_request", issues: body.error.issues, charged: false }, 400);
    }

    // Demo faults can come as a header or ?fault= (PayBox x402 proposals cannot set custom headers).
    const requested = c.req.header(FAULT_HEADER) ?? c.req.query("fault");
    const fault = config.demoFaults && requested && g.faults?.includes(requested) ? requested : undefined;

    const payment: PaymentInfo = voucher
      ? { ...NO_PAYMENT, payer: voucher.payer }
      : readPayment(c.req.header("payment-signature") ?? c.req.header("x-payment"));
    if (voucher) log("voucher", "Free attempt with a credit voucher.");
    else if (payment.key) log("authorized", "Payment signature verified by the facilitator. Not settled.");
    else log("authorized", "No payment signature (local test mode with PAYWALL=off).");

    let output: unknown;
    try {
      output = await g.run(body.data, { fault });
    } catch (error) {
      console.error(`${g.id} failed`, error);
      output = null;
    }

    const promises = promisesOf(g);
    const verdict = await decide(effective(g, promises), body.data, output, judge, promises);
    const via = voucher ? "voucher" : "x402";
    log("judged", `${verdict.decision}: ${verdict.summary}`);
    if (verdict.decision === "rejected") log("not_charged", "HTTP 422: settlement cancelled. The signed authorization expires unused.");
    else if (!voucher) log("settling", "HTTP 200: submitting the payment to the facilitator.");

    const certificate = buildCertificate({
      caseId: id,
      service: g.id,
      contract: contractRef(g),
      input: body.data,
      output,
      verdict,
      via,
      payer: payment.payer,
      paymentRef: payment.key,
      paymentNonce: payment.nonce,
    });
    const proof = { certificateUrl: `/certificates/${id}`, caseUrl: `/cases/${id}`, evaluatedOutputHash: certificate.evaluated_output_hash };

    let status: 200 | 422;
    let response: Record<string, unknown>;
    if (verdict.decision === "rejected") {
      if (voucher) vouchers.release(voucher);
      status = 422;
      response = {
        caseId: id,
        service: g.id,
        decision: "rejected",
        charged: false,
        message: voucher ? "Result failed the contract. Your credit was returned." : "Result failed the contract. Your payment was not settled.",
        verdict,
        verdictUrl: `/verdicts/${id}`,
        ...proof,
      };
    } else {
      if (voucher) vouchers.commit(voucher, id);
      status = 200;
      response = {
        caseId: id,
        service: g.id,
        decision: "delivered",
        data: output,
        verdict,
        receipt: receiptFor(id),
        verdictUrl: `/verdicts/${id}`,
        ...proof,
        appeal: { url: "/appeal", deadline: new Date(Date.now() + config.appealWindowMs).toISOString() },
      };
    }

    db.saveCase({
      id,
      service: g.id,
      createdAt: Date.now(),
      payer: payment.payer,
      via,
      paymentKey: payment.key,
      payment,
      idempotencyKey: c.get("idempotencyKey") ?? null,
      // What an Idempotency-Key retry gets back. The buyer's data stays out of the receipt-less copy.
      response: { status, body: { ...response, receipt: undefined } },
      events,
      input: body.data,
      output,
      verdict,
      promises,
      certificate,
      signature: signer.sign(certificate),
      settlement: null,
      settlementFailure: null,
      appeal: null,
    });
    return c.json(response, status);
  };

  for (const g of guarantees) app.post(`/${g.id}`, guard(() => g), servePaid);

  // ---------- Instant guarantee for any API ----------
  // URL + promise in plain language → compiled rules → crash test against a live sample →
  // confirm → a paid x402 endpoint at POST /g/<slug> that only settles when the promise holds.

  const GuardRequest = z.object({
    title: z.string().min(3).max(80),
    url: z.string().url(),
    method: z.enum(["GET", "POST"]).default("GET"),
    promise: z.string().min(5).max(4000),
    sample: ProxyInput.default({}),
  });

  const sellerOnly = (c: Context<Env>) =>
    config.adminToken ? c.req.header("x-admin-token") !== config.adminToken : config.isHosted;

  app.post("/guard", async (c) => {
    if (sellerOnly(c)) return c.json({ error: "forbidden", detail: "Registering an API needs the x-admin-token." }, 403);
    const body = GuardRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues }, 400);
    const { title, url, method, promise, sample } = body.data;

    let sampleOutput: unknown;
    try {
      sampleOutput = await callUpstream({ url, method }, sample, allowLocalUpstream);
    } catch (error) {
      return c.json({ error: "unsafe_or_unreachable_url", detail: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (sampleOutput === null || sampleOutput === undefined) {
      return c.json({ error: "upstream_failed", detail: "The API did not answer with JSON (2xx, under 8s and 256 KB)." }, 422);
    }

    let slug = slugify(title);
    for (let i = 2; lookup(`g-${slug}`) || db.getProxy(`g-${slug}`)?.active; i++) slug = `${slugify(title)}-${i}`;
    const outputSchema = inferSchema(sampleOutput);
    const compiled = await compilePromises(promise, { input: proxyInputSchema(sample), output: outputSchema });
    const def: ProxyDef = { id: `g-${slug}`, slug, title, url, method, promise, compiled, sampleInput: sample, sampleOutput, outputSchema, createdAt: Date.now(), active: false };
    db.saveProxy(def);

    const g = proxyGuaranteeOf(def);
    const crash = await runCrashTest(effective(g, compiled.promises), compiled.promises, judge, g.crashSuite ?? []);
    return c.json({
      draftId: def.id,
      endpoint: `POST /g/${slug}`,
      sampleOutput,
      ...describeCompiled(compiled),
      crashTest: { label: crash.label, metrics: crash.metrics, untestedPromises: crash.untestedPromises, results: crash.results },
      next: `Review, then POST /guard/${def.id}/activate with { "confirm": true }. Nothing is live until you confirm.`,
    });
  });

  app.post("/guard/:id/activate", async (c) => {
    if (sellerOnly(c)) return c.json({ error: "forbidden" }, 403);
    const def = db.getProxy(c.req.param("id"));
    if (!def) return c.json({ error: "not_found" }, 404);
    const body = z.object({ confirm: z.literal(true) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request", detail: "Send { confirm: true }." }, 400);
    if (!def.compiled.promises.length) return c.json({ error: "nothing_to_enforce", detail: "No promise in this draft can be verified." }, 409);
    if (def.active) return c.json({ error: "already_active", endpoint: `POST /g/${def.slug}` }, 409);

    def.active = true;
    db.saveProxy(def);
    // The compiled promise becomes the contract's first published version (1.1.0), pinned per case like any other.
    db.publishPromises(def.id, { version: "1.1.0", text: def.promise, compiled: def.compiled, publishedAt: Date.now(), draftId: def.id });
    const g = proxyGuaranteeOf(def);
    return c.json({ active: true, endpoint: `POST /g/${def.slug}`, price: g.price, contract: contractRef(g), contractUrl: `/${def.id}/contract` });
  });

  app.get("/guards", (c) =>
    c.json(db.activeProxies().map((d) => ({ id: d.id, title: d.title, endpoint: `POST /g/${d.slug}`, upstream: new URL(d.url).host, promise: d.promise }))),
  );

  app.post("/g/:slug", guard((c) => lookup(`g-${c.req.param("slug")}`)), servePaid);

  // ---------- Appeals ----------

  app.post("/appeal", async (c) => {
    const body = AppealRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues }, 400);

    const { caseId, receipt, complaint } = body.data;
    const record = db.getCase(caseId);
    const g = record && lookup(record.service);
    if (!record || !g || !receiptValid(caseId, receipt)) return c.json({ error: "case_not_found" }, 404);
    if (record.verdict.decision !== "delivered") {
      return c.json({ error: "not_charged", detail: "Rejected cases were never charged." }, 409);
    }
    if (record.appeal) return c.json({ error: "already_appealed", appeal: record.appeal }, 409);
    if (Date.now() > record.createdAt + config.appealWindowMs) return c.json({ error: "appeal_window_closed" }, 409);

    const ruling = await judge(effective(g, record.promises ?? []), { input: record.input, output: record.output, complaint });
    let credit: { voucher: string; usage: string } | null = null;
    let voucherId: string | null = null;
    if (ruling.status === "breach") {
      const issued = vouchers.issue(caseId, g.id, record.payer);
      voucherId = issued.voucher.id;
      credit = {
        voucher: issued.token,
        usage: `Send it as the ${VOUCHER_HEADER} header on your next POST /${g.id}. Valid 7 days, one use.`,
      };
    }

    record.appeal = { filedAt: Date.now(), complaint, ruling, voucherId };
    db.saveCase(record);
    return c.json({ caseId, ruling, credit });
  });

  // ---------- Public record ----------

  app.get("/verdicts", (c) => {
    const service = c.req.query("service");
    const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);
    const cases = db
      .allCases()
      .filter((x) => !service || x.service === service)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    return c.json(cases.map(publicCase));
  });

  app.get("/verdicts/:id", async (c) => {
    const record = db.getCase(c.req.param("id"));
    if (!record) return c.json({ error: "not_found" }, 404);
    await maybeReconcile(record);
    return c.json(publicCase(record));
  });

  // ---------- Reconciliation: ask the chain, never assume ----------
  // A timeout or facilitator error doesn't mean "not charged" (x402 issue #1062). For any
  // delivered case still pending or failed, read the token's authorizationState on-chain.

  const RECONCILE_AFTER_MS = 60_000;

  const reconcile = async (record: Case): Promise<{ changed: boolean; note: string }> => {
    const status = settlementStatus(record);
    if (status === "settled" || status === "not_attempted") return { changed: false, note: `Nothing to reconcile: ${status}.` };
    const p = record.payment;
    if (!p?.network || !p.asset || !p.payer || !p.nonce) return { changed: false, note: "Missing payment details; cannot reconcile." };

    const used = await chain.authorizationUsed({ network: p.network, asset: p.asset, payer: p.payer, nonce: p.nonce });
    const events = (record.events ??= []);
    if (used) {
      record.settlement = { transaction: "unknown (found via authorizationState)", network: p.network, at: Date.now() };
      events.push({ state: "reconciled_settled", at: Date.now(), note: "On-chain: the authorization nonce was used. The payment did settle." });
    } else if (p.validBefore && Date.now() / 1000 > p.validBefore) {
      events.push({ state: "expired_unsettled", at: Date.now(), note: "On-chain: nonce unused and the authorization has expired. It can never be charged." });
    } else {
      return { changed: false, note: "On-chain: not settled yet; the authorization is still valid. Check again later." };
    }
    db.saveCase(record);
    return { changed: true, note: events.at(-1)!.note };
  };

  app.post("/cases/:id/reconcile", async (c) => {
    const record = db.getCase(c.req.param("id"));
    if (!record) return c.json({ error: "not_found" }, 404);
    try {
      const result = await reconcile(record);
      return c.json({ ...result, payment: { status: settlementStatus(record), timeline: record.events ?? [] } });
    } catch (error) {
      return c.json({ error: "reconcile_failed", detail: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  /** Reconciles stale cases opportunistically when someone looks at them. */
  const maybeReconcile = async (record: Case) => {
    const status = settlementStatus(record);
    if ((status === "pending" || status === "failed") && Date.now() - record.createdAt > RECONCILE_AFTER_MS) {
      await reconcile(record).catch(() => undefined);
    }
  };

  // ---------- Proof-Carrying Payments certificates ----------

  app.get("/certificates/key", (c) =>
    c.json({ algorithm: "Ed25519", encoding: "signature = base64(Ed25519(canonical JSON of certificate))", publicKey: signer.publicKeyPem }),
  );

  app.get("/certificates/:id", (c) => {
    const record = db.getCase(c.req.param("id"));
    if (!record) return c.json({ error: "not_found" }, 404);
    return c.json({ certificate: record.certificate, signature: record.signature, payment: { status: settlementStatus(record), settlement: record.settlement } });
  });

  // Anyone can check a certificate offline with the public key; this endpoint does the same for convenience.
  app.post("/certificates/verify", async (c) => {
    const body = CertificateRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const valid = verifyCertificate(body.data.certificate as Certificate, body.data.signature, signer.publicKeyPem);
    return c.json({ valid });
  });

  // The buyer proves that what they received is exactly what was judged, without publishing it.
  app.post("/certificates/:id/check-output", async (c) => {
    const record = db.getCase(c.req.param("id"));
    if (!record) return c.json({ error: "not_found" }, 404);
    const body = OutputCheckRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const hash = sha256(body.data.output ?? null);
    return c.json({ matches: hash === record.certificate.evaluated_output_hash, hash, evaluated: record.certificate.evaluated_output_hash });
  });

  app.get("/trust", (c) => {
    const cases = db.allCases();
    return c.json({
      method: TRUST_METHOD,
      overall: trustReport(cases),
      services: Object.fromEntries(
        allGuarantees().map((g) => [g.id, { title: g.title, price: g.price, ...trustReport(cases.filter((x) => x.service === g.id)) }]),
      ),
      network: config.network,
    });
  });

  app.get("/credits/:address", (c) => {
    const now = Date.now();
    const open = db
      .vouchersFor(c.req.param("address"))
      .filter((v) => !v.redeemedBy && now <= v.expiresAt)
      .map((v) => ({ id: v.id, service: v.service, fromCase: v.caseId, expiresAt: new Date(v.expiresAt).toISOString() }));
    return c.json({ address: c.req.param("address"), credits: open });
  });

  return app;
}
