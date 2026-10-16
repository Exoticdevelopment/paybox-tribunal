import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { MiddlewareHandler } from "hono";

process.env.LLM_BACKEND = "off";
process.env.ANTHROPIC_API_KEY = "";
process.env.DATA_FILE = ":memory:";
process.env.VOUCHER_SECRET = "test-secret";

const { createApp } = await import("../src/app.ts");
const { Db } = await import("../src/store/db.ts");
const { assertPublicUrl, inferSchema } = await import("../src/kit/proxy.ts");

// A seller's existing API. The test can make it misbehave.
let upstreamMode: "ok" | "stale" | "hot" | "broken" = "ok";
let upstream: Server;
let upstreamUrl = "";

before(async () => {
  upstream = createServer((_req, res) => {
    if (upstreamMode === "broken") {
      res.writeHead(500).end("oops");
      return;
    }
    const updated = upstreamMode === "stale" ? new Date(Date.now() - 3600_000) : new Date();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ city: "Bogota", temp_c: upstreamMode === "hot" ? 999 : 17, updated_at: updated.toISOString() }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/weather`;
});
after(() => upstream.close());

const pass: MiddlewareHandler = async (_c, next) => next();
const newApp = () => createApp({ db: new Db(":memory:"), paywall: pass, judge: async () => ({ status: "abstained", reasoning: "test" }) });
const post = (app: ReturnType<typeof newApp>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const PROMISE = "Los datos tienen menos de 120 segundos de antigüedad, temp_c entre -50 y 60";

test("a seller guarantees an existing API from a URL and a promise", async () => {
  upstreamMode = "ok";
  const app = newApp();
  const preview = await (await post(app, "/guard", { title: "Weather Bogota", url: upstreamUrl, promise: PROMISE })).json();

  assert.equal(preview.endpoint, "POST /g/weather-bogota");
  assert.deepEqual(preview.promises.map((p: { rule: { type: string } }) => p.rule.type), ["freshness", "numeric_bounds"]);
  assert.equal(preview.crashTest.metrics.missed, 0);
  assert.equal(preview.crashTest.metrics.wronglyRejected, 0);
  assert.equal((await post(app, "/g/weather-bogota", {})).status, 404, "nothing is live before confirmation");

  const active = await (await post(app, `/guard/${preview.draftId}/activate`, { confirm: true })).json();
  assert.equal(active.contract.version, "1.1.0");

  const ok = await post(app, "/g/weather-bogota", {});
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.city, "Bogota");
});

test("the guaranteed API is rejected without charge when the upstream breaks its promise", async () => {
  upstreamMode = "ok";
  const app = newApp();
  const preview = await (await post(app, "/guard", { title: "Weather", url: upstreamUrl, promise: PROMISE })).json();
  await post(app, `/guard/${preview.draftId}/activate`, { confirm: true });

  upstreamMode = "stale";
  const stale = await (await post(app, "/g/weather", {})).json();
  assert.equal(stale.decision, "rejected");
  assert.equal(stale.verdict.rules.violations[0].rule, "promise:freshness");

  upstreamMode = "hot";
  assert.equal((await (await post(app, "/g/weather", {})).json()).verdict.rules.violations[0].rule, "promise:numeric_bounds");

  upstreamMode = "broken";
  const broken = await post(app, "/g/weather", {});
  assert.equal(broken.status, 422);
  assert.equal((await broken.json()).verdict.rules.violations[0].rule, "non_empty");
  upstreamMode = "ok";

  const trust = await (await app.request("/trust")).json();
  assert.equal(trust.services["g-weather"].rejectedBeforeCharge, 3);
});

test("registering refuses unreachable or non-JSON upstreams", async () => {
  upstreamMode = "broken";
  const res = await post(newApp(), "/guard", { title: "Broken", url: upstreamUrl, promise: PROMISE });
  assert.equal(res.status, 422);
  upstreamMode = "ok";
});

test("SSRF guard: only public HTTPS when deployed", async () => {
  await assert.rejects(assertPublicUrl("http://example.com/x", false), /https/);
  await assert.rejects(assertPublicUrl("https://127.0.0.1/x", false), /public address/);
  await assert.rejects(assertPublicUrl("https://10.1.2.3/x", false), /public address/);
  await assert.rejects(assertPublicUrl("https://169.254.169.254/latest/meta-data", false), /public address/);
  await assert.rejects(assertPublicUrl("https://user:pass@example.com/", false), /credentials/);
  await assert.rejects(assertPublicUrl("file:///etc/passwd", false), /https/);
  assert.ok(await assertPublicUrl("http://127.0.0.1:9/x", true), "localhost allowed only in local mode");
});

test("schema inference names nested fields for promises", () => {
  const s = inferSchema({ a: 1, b: { c: "x" }, d: [{ e: true }] });
  assert.equal(s.properties!.a.type, "number");
  assert.equal(s.properties!.b.properties!.c.type, "string");
  assert.equal(s.properties!.d.items!.properties!.e.type, "boolean");
});

test("compiler picks value fields over same-named labels and keeps every range promise", async () => {
  const { compileWithRules } = await import("../src/kit/compiler.ts");
  const output = inferSchema({ current_units: { temperature_2m: "°C" }, current: { temperature_2m: 12.3, wind_speed_10m: 4.1 } });
  const drafts = compileWithRules("temperature_2m entre -30 y 50, wind_speed_10m entre 0 y 200, siempre incluye temperature_2m", { input: { type: "object", properties: {} }, output });
  const rules = drafts.map((d) => ("rule" in d ? (d.rule as { type: string; field?: string; fields?: string[] }) : null));
  assert.equal(rules[0]?.field, "current.temperature_2m");
  assert.equal(rules[1]?.field, "current.wind_speed_10m");
  assert.deepEqual(rules[2]?.fields, ["current.temperature_2m"]);
});
