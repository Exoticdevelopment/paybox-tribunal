import { serve } from "@hono/node-server";
import type { MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { config } from "./config.ts";
import { createApp } from "./app.ts";
import { paywallRoutes } from "./kit/tribunal.ts";
import { services } from "./services/index.ts";
import { Db } from "./store/db.ts";
import { paymentKey } from "./payment.ts";

const db = new Db(config.dataFile);

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitatorUrl }))
  .register(config.network, new ExactEvmScheme())
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
          accepts: [{ scheme: "exact" as const, price: process.env.PRICE_PROXY ?? process.env.PRICE ?? "$0.01", network: config.network, payTo: config.payTo }],
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

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`PayBox Tribunal on http://localhost:${info.port}`);
  console.log(`  network ${config.network} → ${config.payTo}`);
  console.log(`  services: ${services.map((s) => `${s.id} (${s.price})`).join(", ")}`);
  console.log(`  AI: ${config.llmBackend}${config.llmBackend === "api" ? ` (${config.llmModel})` : ""}`);
});
