import { serve } from "@hono/node-server";
import type { MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { config } from "./config.ts";
import { createApp } from "./app.ts";
import { acceptsFor, paywallRoutes } from "./kit/tribunal.ts";
import { services } from "./services/index.ts";
import { Db } from "./store/db.ts";
import { paymentKey } from "./payment.ts";
import { evidenceCases, gitHubEvidence } from "./kit/evidence.ts";
import { createHash } from "node:crypto";

const db = new Db(config.dataFile, config.evidenceFile);

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitatorUrl }))
  .register(config.network, new ExactEvmScheme())
  .register(config.solanaNetwork, new ExactSvmScheme())
  // Funds only move here, after the handler returned < 400. Record it on the case.
  .onAfterSettle(async ({ paymentPayload, result }) => {
    if (!result.success) return;
    const record = db.findCaseByPaymentKey(paymentKey(paymentPayload.payload));
    if (!record) return;
    record.settlement = { transaction: result.transaction, network: result.network, at: Date.now() };
    record.payer ??= result.payer ?? null;
    (record.events ??= []).push({ state: "settled", at: Date.now(), note: `Settled on-chain: ${result.transaction}` });
    db.saveCase(record);
  })
  // A delivered result whose payment failed to settle: recorded as such, never confused with a rejection.
  .onSettleFailure(async ({ paymentPayload, error }) => {
    const record = db.findCaseByPaymentKey(paymentKey(paymentPayload.payload));
    if (!record) return;
    record.settlementFailure = { reason: error.message, at: Date.now() };
    (record.events ??= []).push({ state: "settle_failed", at: Date.now(), note: `Facilitator error: ${error.message}. Will reconcile on-chain before assuming anything.` });
    db.saveCase(record);
  });

// PAYWALL=off lets you exercise every path locally without paying (e.g. to try the judge). Refused when deployed.
const paywallOff = process.env.PAYWALL === "off";
if (paywallOff && config.isHosted) throw new Error("PAYWALL=off is for local testing only.");
const paywall: MiddlewareHandler = paywallOff
  ? async (_c, next) => next()
  : paymentMiddleware(
      {
        ...paywallRoutes(services),
        // Every API a seller guarantees through /guard is served (and paid) here.
        "POST /g/:slug": {
          accepts: acceptsFor(process.env.PRICE_PROXY ?? process.env.PRICE ?? "$0.01"),
          description: "Guaranteed API proxy. Pay-on-validation: settles only if the upstream response keeps the seller's published promise.",
          mimeType: "application/json",
        },
      },
      resourceServer,
    );
const app = createApp({ db, paywall });

if (paywallOff) console.warn("PAYWALL=off: services are FREE. Local testing only.");
if (config.demoFaults) console.warn("DEMO_FAULTS=1: x-demo-fault header is honoured. Never enable in production.");
if (config.payTo === "0x0000000000000000000000000000000000000000") console.warn("PAY_TO is not set: payments would go nowhere.");

/**
 * Behind a TLS-terminating proxy (Render) requests arrive as http://. Restore the public
 * https:// URL so the x402 challenge advertises the same resource the buyer requested.
 */
const fetchBehindProxy = (req: Request) => {
  if (req.headers.get("x-forwarded-proto") === "https" && req.url.startsWith("http://")) {
    return app.fetch(new Request(req.url.replace(/^http:/, "https:"), req));
  }
  return app.fetch(req);
};

serve({ fetch: fetchBehindProxy, port: config.port }, (info) => {
  console.log(`PayBox Tribunal on http://localhost:${info.port}`);
  console.log(`  network ${config.network} → ${config.payTo}`);
  if (config.payToSolana) console.log(`  also ${config.solanaNetwork} → ${config.payToSolana}`);
  console.log(`  services: ${services.map((s) => `${s.id} (${s.price})`).join(", ")}`);
  console.log(`  AI: ${config.llmBackend}${config.llmBackend === "api" ? ` (${config.llmModel})` : ""}`);
  if (config.llmBackend !== "off") void warmUp(info.port);
  if (config.evidenceGitHub) void startEvidenceBackup();
});

/**
 * Real cases survive restarts: restore them from GitHub on boot, then back up any change once a minute.
 * Inputs and outputs are redacted; certificates still verify.
 */
async function startEvidenceBackup() {
  const store = gitHubEvidence(config.evidenceGitHub!);
  try {
    const restored = db.addEvidence(await store.load());
    console.log(`  evidence: restored ${restored} case(s) from GitHub`);
  } catch (error) {
    console.error("evidence restore failed:", error instanceof Error ? error.message : error);
  }
  let lastHash = "";
  const backup = async () => {
    const cases = evidenceCases(db);
    const hash = createHash("sha256").update(JSON.stringify(cases)).digest("hex");
    if (!cases.length || hash === lastHash) return;
    try {
      const total = await store.save(cases);
      lastHash = hash;
      console.log(`  evidence: backed up ${total} case(s)`);
    } catch (error) {
      console.error("evidence backup failed:", error instanceof Error ? error.message : error);
    }
  };
  setInterval(backup, 60_000).unref();
}

/** Pre-computes the AI answers for the demos on the public page, so judges get them instantly. */
async function warmUp(port: number) {
  const demos: [string, unknown][] = [
    ["/summary/promises/compile", { text: "The summary must be in English, at most 25 words, never invents figures, never contradicts the text, with a professional tone" }],
    ["/invoice/crash-test", undefined],
    ["/summary/crash-test", undefined],
  ];
  for (const [path, body] of demos) {
    try {
      await fetch(`http://localhost:${port}${path}`, body
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : undefined);
    } catch {}
  }
  console.log("  AI demos warmed up");
}
