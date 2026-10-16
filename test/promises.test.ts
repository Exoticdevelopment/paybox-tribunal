import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { MiddlewareHandler } from "hono";
import { ARTICLE } from "./fixtures.ts";

process.env.DEMO_FAULTS = "1";
process.env.LLM_BACKEND = "off";
process.env.ANTHROPIC_API_KEY = "";
process.env.DATA_FILE = ":memory:";
process.env.VOUCHER_SECRET = "test-secret";

const { createApp } = await import("../src/app.ts");
const { Db } = await import("../src/store/db.ts");
const { valuesAt, detectLanguage, evaluatePromise } = await import("../src/kit/promises.ts");
const { compileWithRules } = await import("../src/kit/compiler.ts");
type AnyGuarantee = import("../src/kit/types.ts").AnyGuarantee;

const pass: MiddlewareHandler = async (_c, next) => next();
let judged: AnyGuarantee | null;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  judged = null;
  app = createApp({
    db: new Db(":memory:"),
    paywall: pass,
    judge: async (g) => {
      judged = g;
      return { status: "abstained", reasoning: "test" };
    },
  });
});

const post = (path: string, body: unknown) => app.request(path, { method: "POST", body: JSON.stringify(body) });
const compile = async (text: string, service = "summary") => (await post(`/${service}/promises/compile`, { text })).json();
const publish = async (draftId: string, service = "summary") => post(`/${service}/promises/publish`, { draftId, confirm: true });
const summarize = (max_words = 40) => post("/summary", { text: ARTICLE, max_words });

// ---------- Building blocks ----------

test("valuesAt walks objects and arrays", () => {
  const doc = { a: { b: 1 }, items: [{ x: 1 }, { x: 2 }], tags: ["p", "q"] };
  assert.deepEqual(valuesAt(doc, "a.b"), [1]);
  assert.deepEqual(valuesAt(doc, "items[].x"), [1, 2]);
  assert.deepEqual(valuesAt(doc, "tags[]"), ["p", "q"]);
  assert.deepEqual(valuesAt(doc, "missing"), [undefined]);
});

test("language heuristic tells Spanish from English and abstains on tiny text", () => {
  assert.equal(detectLanguage("El resumen de la factura es claro y se entrega para el cliente."), "es");
  assert.equal(detectLanguage("The summary of the invoice is clear and it is delivered to the client."), "en");
  assert.equal(detectLanguage("Hola"), null);
});

test("numeric grounding promise flags invented figures", () => {
  const p = { text: "no inventa cifras", interpretation: "", certainty: "deterministic" as const, rule: { type: "numeric_grounding" as const, fields: ["summary"], sourceField: "text" } };
  assert.equal(evaluatePromise(p, { text: "Sold 12 units" }, { summary: "Sold 12 units" }).length, 0);
  assert.match(evaluatePromise(p, { text: "Sold 12 units" }, { summary: "Sold 99 units" })[0].detail, /99/);
});

// ---------- Compiler ----------

test("offline compiler maps common Spanish promises to typed rules", () => {
  const schemas = {
    input: { type: "object", properties: { text: { type: "string" }, max_words: { type: "number" } } },
    output: { type: "object", properties: { summary: { type: "string" }, key_points: { type: "array", items: { type: "string" } } } },
  };
  const drafts = compileWithRules("El resumen debe estar en español, máximo 50 palabras, no inventa cifras. Siempre con tono profesional", schemas);
  const types = drafts.map((d) => ("rule" in d ? (d.rule as { type: string }).type : "unverifiable"));
  assert.deepEqual(types, ["language", "length_limit", "numeric_grounding", "unverifiable"]);
});

test("compile shows what is deterministic, probabilistic and not guaranteed", async () => {
  const draft = await compile("Máximo 30 palabras, no inventa cifras, nunca contradice el texto original, con excelente calidad");
  assert.equal(draft.engine, "rules");
  assert.deepEqual(draft.summary, { deterministic: 2, heuristic: 0, probabilistic: 1, notGuaranteed: 1 });
  assert.ok(draft.promises.every((p: { certaintyNote: string }) => p.certaintyNote));
  assert.match(draft.notGuaranteed[0].reason, /Subjective/);
});

test("promises about fields the service doesn't have are refused, not invented", async () => {
  const draft = await compile("Siempre incluye el autor y la fecha de publicación");
  assert.equal(draft.promises.length, 0);
  assert.match(draft.notGuaranteed[0].reason, /No matching output field/);
});

// ---------- Publishing and enforcement ----------

test("nothing is enforced until the seller confirms", async () => {
  const draft = await compile("Máximo 5 palabras");
  assert.equal((await summarize()).status, 200);
  assert.equal((await post("/summary/promises/publish", { draftId: draft.draftId })).status, 400);
  assert.equal((await summarize()).status, 200);
});

test("a published promise becomes a new contract version and is enforced", async () => {
  const before = await (await app.request("/summary/contract")).json();
  const draft = await compile("Máximo 10 palabras");
  const res = await (await publish(draft.draftId)).json();

  assert.equal(res.contract.version, "1.1.0");
  assert.notEqual(res.contract.hash, before.contractHash);

  const rejected = await (await summarize()).json();
  assert.equal(rejected.decision, "rejected");
  assert.equal(rejected.verdict.rules.violations[0].rule, "promise:length_limit");
});

test("language promise rejects a summary in the wrong language", async () => {
  await publish((await compile("El resumen debe estar en español")).draftId);
  const body = await (await summarize()).json();
  assert.equal(body.verdict.rules.violations[0].rule, "promise:language");
});

test("earlier cases keep the contract version they were judged under", async () => {
  const old = await (await summarize()).json();
  await publish((await compile("Máximo 10 palabras")).draftId);
  const cert = await (await app.request(`/certificates/${old.caseId}`)).json();
  assert.equal(cert.certificate.contract.version, "1.0.0");
  const history = await (await app.request("/summary/promises")).json();
  assert.equal(history.current.version, "1.1.0");
  assert.equal(history.history.length, 1);
});

test("semantic promises are handed to the AI judge", async () => {
  await publish((await compile("Nunca contradice el texto original")).draftId);
  await summarize();
  assert.match(judged!.judge!.instructions, /Nunca contradice el texto original/);
});

// ---------- Freshness and the price-quote service ----------

const { freshnessProblem } = await import("../src/kit/promises.ts");

test("freshness accepts recent timestamps and rejects stale or future ones", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.equal(freshnessProblem("2026-10-15T11:59:30Z", 60, now), null);
  assert.match(freshnessProblem("2026-10-15T11:50:00Z", 60, now)!, /600s old/);
  assert.match(freshnessProblem("2026-10-15T12:10:00Z", 60, now)!, /future/);
  assert.equal(freshnessProblem(now / 1000 - 10, 60, now), null);
  assert.equal(freshnessProblem("whenever", 60, now), "is not a timestamp");
});

test("offline compiler understands freshness promises", async () => {
  const draft = await compile("Los datos nunca tienen más de 30 segundos de antigüedad", "quote");
  assert.equal(draft.promises[0].rule.type, "freshness");
  assert.equal(draft.promises[0].rule.field, "as_of");
  assert.equal(draft.promises[0].rule.maxAgeSeconds, 30);
});

test("freshness promised on a service without timestamps is refused", async () => {
  const draft = await compile("Datos de máximo 30 segundos de antigüedad", "summary");
  assert.equal(draft.promises.length, 0);
  assert.match(draft.notGuaranteed[0].reason, /no timestamp/);
});

// ---------- Crash Test ----------

test("crash test: every deterministic attack is caught, honest outputs pass", async () => {
  for (const service of ["invoice", "summary", "quote"]) {
    const r = await (await app.request(`/${service}/crash-test`)).json();
    assert.equal(r.metrics.deterministic.caught, r.metrics.deterministic.attacks, service);
    assert.equal(r.metrics.wronglyRejected, 0, service);
    assert.match(r.label, /Simulation/);
  }
});

test("crash test reports semantic attacks as missed when the judge abstains", async () => {
  const r = await (await app.request("/invoice/crash-test")).json();
  assert.equal(r.metrics.semantic.attacks, 1);
  assert.equal(r.metrics.semantic.caught, 0);
});

test("crash test attacks the seller's published promises too", async () => {
  await publish((await compile("Máximo 30 palabras, no inventa cifras, nunca contradice el texto")).draftId);
  const r = await (await app.request("/summary/crash-test")).json();
  const fromPromises = r.results.filter((x: { source: string }) => x.source === "promise");
  assert.equal(fromPromises.length, 2);
  assert.ok(fromPromises.every((x: { correct: boolean }) => x.correct));
  assert.deepEqual(r.untestedPromises, ["nunca contradice el texto"]);
  assert.equal(r.contract.version, "1.1.0");
});
