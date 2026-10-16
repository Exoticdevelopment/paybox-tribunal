import { verify } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { proposeX402, x402OutputSchema } from "./paybox.js";

/**
 * PayBox Tribunal: pay-on-validation for x402.
 * Every paid tool proposes an x402 request to a Tribunal endpoint. Tribunal verifies the
 * signed payment, runs the service, checks the result against a published contract, and
 * only settles the payment if the promise was kept (HTTP 200). If not, it answers 422 and
 * the payment is never settled. Read tools let the agent inspect the contract and trust
 * score before paying, and verify each signed verdict afterwards.
 */
const PROTOCOL_VERSION = "2026-07-28";
const BASE_URL = (process.env.TRIBUNAL_URL ?? "https://paybox-tribunal.onrender.com").replace(/\/+$/, "");
const CHAIN = "eip155:8453" as const; // Base mainnet USDC
/** Atomic USDC (6 decimals): 10000 = 0.01 USDC, the price of every Tribunal service. */
const MAX_AMOUNT = process.env.TRIBUNAL_MAX_AMOUNT ?? "10000";
const TIMEOUT_MS = 4000;

const SERVICES = ["invoice", "summary", "quote"] as const;

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Tribunal answered ${res.status} for ${path}`);
  return res.json();
}

const text = (s: string) => [{ type: "text" as const, text: s }];

/** Adds ?fault=… only when the caller explicitly asks for a demo failure (honoured only by demo servers). */
function endpoint(path: string, demoFault?: string) {
  const url = new URL(`${BASE_URL}${path}`);
  if (demoFault) url.searchParams.set("fault", demoFault);
  return url.toString();
}

const paidAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const demoFault = z
  .string()
  .regex(/^[a-z_]{1,40}$/)
  .optional()
  .describe("Demo only: ask a demo server to deliberately break its promise (e.g. wrong_total, stale) to show that a broken promise is never charged.");

function createServer() {
  const server = new McpServer({ name: "paybox-tribunal", version: "1.0.0" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  // ---------- Before paying ----------

  server.registerTool(
    "check_guarantee",
    {
      title: "Check a service's guarantee before paying",
      description:
        "Shows what a Tribunal service promises, its price, its trust score from real transactions, and how its contract performed in the Crash Test. Call this before proposing a payment and tell the user: if the result breaks the promise, they are never charged.",
      inputSchema: z.object({ service: z.enum(SERVICES).describe("invoice, summary or quote") }).strict(),
      outputSchema: z
        .object({
          service: z.string(),
          price: z.string(),
          network: z.string(),
          contractVersion: z.string(),
          settlement: z.string(),
          guarantees: z.array(z.string()),
          trustScore: z.number().nullable(),
          attempts: z.number(),
          rejectedBeforeCharge: z.number(),
          chargedFailures: z.number(),
          crashTest: z.object({ caught: z.number(), attacks: z.number(), wronglyRejected: z.number() }).nullable(),
        })
        .strict(),
      annotations: readAnnotations,
    },
    async ({ service }) => {
      const [contract, trust, crash] = await Promise.all([
        getJson(`/${service}/contract`) as Promise<{ price: string; network: string; version: string; settlement: string; guarantees: string[] }>,
        getJson("/trust") as Promise<{ services: Record<string, { score: number; attempts: number; rejectedBeforeCharge: number; chargedFailures: number }> }>,
        (getJson(`/${service}/crash-test`) as Promise<{ metrics: { caught: number; attacks: number; wronglyRejected: number } }>).catch(() => null),
      ]);
      const t = trust.services[service];
      const result = {
        service,
        price: contract.price,
        network: contract.network,
        contractVersion: contract.version,
        settlement: contract.settlement,
        guarantees: contract.guarantees,
        trustScore: t && t.attempts ? t.score : null,
        attempts: t?.attempts ?? 0,
        rejectedBeforeCharge: t?.rejectedBeforeCharge ?? 0,
        chargedFailures: t?.chargedFailures ?? 0,
        crashTest: crash ? { caught: crash.metrics.caught, attacks: crash.metrics.attacks, wronglyRejected: crash.metrics.wronglyRejected } : null,
      };
      const summary = [
        `${service}: ${result.price} per call, settled only after validation (contract v${result.contractVersion}).`,
        ...result.guarantees.map((g) => `- ${g}`),
        `Trust: ${result.trustScore ?? "new"} (${result.attempts} attempts, ${result.rejectedBeforeCharge} rejected without charge, ${result.chargedFailures} charged failures).`,
        result.crashTest ? `Crash Test: ${result.crashTest.caught}/${result.crashTest.attacks} attacks caught, ${result.crashTest.wronglyRejected} honest results wrongly rejected.` : "",
      ].filter(Boolean);
      return { content: text(summary.join("\n")), structuredContent: result };
    },
  );

  // ---------- Paid, guaranteed services (x402 proposals) ----------

  server.registerTool(
    "extract_invoice",
    {
      title: "Extract an invoice (guaranteed)",
      description:
        "Proposes a 0.01 USDC x402 payment to extract structured data from invoice or receipt text. Tribunal checks math, totals and that every value appears in the document before settling. If the result fails, the response is 422 and the payment is never settled. Poll the returned request; do not call this tool again to finish payment.",
      inputSchema: z.object({ document: z.string().min(20).max(50000).describe("Raw invoice or receipt text"), demo_fault: demoFault }).strict(),
      outputSchema: x402OutputSchema,
      annotations: paidAnnotations,
    },
    async ({ document, demo_fault }) =>
      proposeX402({ chain: CHAIN, url: endpoint("/invoice", demo_fault), maxAmount: MAX_AMOUNT, method: "POST", body: { document } }),
  );

  server.registerTool(
    "summarize_text",
    {
      title: "Summarize a text (guaranteed)",
      description:
        "Proposes a 0.01 USDC x402 payment to summarize a text within a word limit. Tribunal checks the limit and that no number is invented before settling; broken promises are never charged.",
      inputSchema: z
        .object({ text: z.string().min(200).max(50000), max_words: z.number().int().min(20).max(200).default(60), demo_fault: demoFault })
        .strict(),
      outputSchema: x402OutputSchema,
      annotations: paidAnnotations,
    },
    async ({ text: body, max_words, demo_fault }) =>
      proposeX402({ chain: CHAIN, url: endpoint("/summary", demo_fault), maxAmount: MAX_AMOUNT, method: "POST", body: { text: body, max_words } }),
  );

  server.registerTool(
    "get_price_quote",
    {
      title: "Get a fresh price quote (guaranteed)",
      description:
        "Proposes a 0.01 USDC x402 payment for a BTC, ETH or SOL price in USD, guaranteed no older than max_age_seconds. A stale or wrong quote is rejected and never charged.",
      inputSchema: z
        .object({ asset: z.enum(["BTC", "ETH", "SOL"]), max_age_seconds: z.number().int().min(10).max(3600).default(120), demo_fault: demoFault })
        .strict(),
      outputSchema: x402OutputSchema,
      annotations: paidAnnotations,
    },
    async ({ asset, max_age_seconds, demo_fault }) =>
      proposeX402({ chain: CHAIN, url: endpoint("/quote", demo_fault), maxAmount: MAX_AMOUNT, method: "POST", body: { asset, max_age_seconds } }),
  );

  // ---------- Any API a seller guaranteed with Tribunal ----------

  server.registerTool(
    "list_guaranteed_apis",
    {
      title: "List APIs guaranteed by Tribunal",
      description: "Lists third-party APIs whose sellers published a guarantee through Tribunal, with their promise in plain language.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ apis: z.array(z.object({ slug: z.string(), title: z.string(), upstream: z.string(), promise: z.string() }).strict()) }).strict(),
      annotations: readAnnotations,
    },
    async () => {
      const list = (await getJson("/guards")) as { id: string; title: string; upstream: string; promise: string }[];
      const apis = list.map((a) => ({ slug: a.id.replace(/^g-/, ""), title: a.title, upstream: a.upstream, promise: a.promise }));
      return {
        content: text(apis.length ? apis.map((a) => `${a.slug}: ${a.title} (${a.upstream}). Promise: ${a.promise}`).join("\n") : "No guaranteed APIs yet."),
        structuredContent: { apis },
      };
    },
  );

  server.registerTool(
    "call_guaranteed_api",
    {
      title: "Call a guaranteed API",
      description:
        "Proposes a 0.01 USDC x402 payment to a seller's API through Tribunal. The upstream response is checked against the seller's published promise before the payment settles.",
      inputSchema: z
        .object({
          slug: z.string().regex(/^[a-z0-9-]{1,60}$/),
          query: z.record(z.string(), z.string()).optional(),
          body: z.record(z.string(), z.json()).optional(),
        })
        .strict(),
      outputSchema: x402OutputSchema,
      annotations: paidAnnotations,
    },
    async ({ slug, query, body }) =>
      proposeX402({ chain: CHAIN, url: endpoint(`/g/${slug}`), maxAmount: MAX_AMOUNT, method: "POST", body: { ...(query ? { query } : {}), ...(body ? { body } : {}) } }),
  );

  // ---------- After paying ----------

  server.registerTool(
    "get_case",
    {
      title: "Get a verdict and verify its certificate",
      description:
        "Shows the promise, the evidence and the payment outcome of a Tribunal case, and independently verifies its Ed25519-signed certificate inside this plugin.",
      inputSchema: z.object({ case_id: z.uuid() }).strict(),
      outputSchema: z
        .object({
          caseId: z.string(),
          service: z.string(),
          decision: z.string(),
          charged: z.boolean(),
          paymentStatus: z.string(),
          reason: z.string(),
          violations: z.array(z.string()),
          contractVersion: z.string(),
          signatureValid: z.boolean(),
          caseUrl: z.string(),
        })
        .strict(),
      annotations: readAnnotations,
    },
    async ({ case_id }) => {
      const [v, key] = await Promise.all([
        getJson(`/verdicts/${case_id}`) as Promise<{
          caseId: string;
          service: string;
          decision: string;
          charged: boolean;
          payment: { status: string };
          verdict: { summary: string; rules: { violations: { rule: string; detail: string }[] } };
          certificate: { contract: { version: string } } & Record<string, unknown>;
          signature: string;
        }>,
        getJson("/certificates/key") as Promise<{ publicKey: string }>,
      ]);
      let signatureValid = false;
      try {
        signatureValid = verify(null, Buffer.from(canonicalJson(v.certificate)), key.publicKey, Buffer.from(v.signature, "base64"));
      } catch {
        signatureValid = false;
      }
      const result = {
        caseId: v.caseId,
        service: v.service,
        decision: v.decision,
        charged: v.charged,
        paymentStatus: v.payment.status,
        reason: v.verdict.summary,
        violations: v.verdict.rules.violations.map((x) => `${x.rule}: ${x.detail}`),
        contractVersion: v.certificate.contract.version,
        signatureValid,
        caseUrl: `${BASE_URL}/cases/${v.caseId}`,
      };
      return {
        content: text(
          `${result.decision === "delivered" ? "Promise kept" : "Promise broken"} · ${result.charged ? "charged" : "not charged"} · signature ${signatureValid ? "valid" : "INVALID"}\n${result.reason}\n${result.caseUrl}`,
        ),
        structuredContent: result,
      };
    },
  );

  return server;
}

/** Same canonical JSON the Tribunal server signs: keys sorted at every level, undefined dropped. */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

serveStdio(createServer, { legacy: "reject" });
