import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceRules, extractDeterministic, Invoice } from "../src/services/invoice.ts";
import { summaryRules, summarizeDeterministic } from "../src/services/summary.ts";
import { wilsonLowerBound } from "../src/kit/trust.ts";
import { amountAppearsIn, appearsIn } from "../src/kit/text.ts";
import { extractJson } from "../src/llm.ts";
import { ARTICLE, GOOD_INVOICE, VALID_OUTPUT } from "./fixtures.ts";

const inv = (patch: object = {}) => invoiceRules({ document: GOOD_INVOICE }, Invoice.parse({ ...VALID_OUTPUT, ...patch }));
const rulesOf = (v: { rule: string }[]) => v.map((x) => x.rule);

test("valid invoice passes every rule", () => assert.deepEqual(inv(), []));

test("deterministic extractor reads the fixture correctly", () => {
  assert.deepEqual(extractDeterministic(GOOD_INVOICE), VALID_OUTPUT);
});

test("wrong total is caught", () => assert.deepEqual(rulesOf(inv({ total: 99999 })), ["total", "grounding"]));

test("line math and subtotal are caught", () => {
  const bad = structuredClone(VALID_OUTPUT);
  bad.line_items[0].amount = 6000;
  assert.deepEqual(rulesOf(invoiceRules({ document: GOOD_INVOICE }, bad)), ["line_math", "subtotal"]);
});

test("impossible calendar date is caught", () => assert.deepEqual(rulesOf(inv({ issue_date: "2026-02-30" })), ["date"]));

test("rounding within tolerance is accepted in the math", () => {
  const rounded = structuredClone(VALID_OUTPUT);
  rounded.line_items[0].unit_price = 2500.004; // 2 x 2500.004 = 5000.008 vs amount 5000
  assert.deepEqual(invoiceRules({ document: GOOD_INVOICE }, rounded), []);
});

test("a total that differs from the document is a misread, even within rounding", () => {
  assert.deepEqual(rulesOf(inv({ total: 50456.01 })), ["grounding"]);
});

test("invented vendor is caught by grounding, without AI", () => {
  assert.deepEqual(rulesOf(inv({ vendor_name: "Globex Corporation" })), ["grounding"]);
});

test("grounding ignores case and accents", () => {
  assert.deepEqual(inv({ vendor_name: "PANADERIA LA ESQUINA" }), []);
  assert.ok(appearsIn("Café tinto", "cafe TINTO"));
});

test("amounts match across money formats", () => {
  assert.ok(amountAppearsIn("Total: 50.456", 50456));
  assert.ok(amountAppearsIn("Total: $1,234.50", 1234.5));
  assert.ok(!amountAppearsIn("Total: 50.456", 50556));
});

test("swapped line descriptions pass every rule (only the judge can catch it)", () => {
  const swapped = structuredClone(VALID_OUTPUT);
  [swapped.line_items[0].description, swapped.line_items[1].description] = [swapped.line_items[1].description, swapped.line_items[0].description];
  assert.deepEqual(invoiceRules({ document: GOOD_INVOICE }, swapped), []);
});

test("deterministic summary respects its own contract", () => {
  const req = { text: ARTICLE, max_words: 40 };
  assert.deepEqual(summaryRules(req, summarizeDeterministic(req)), []);
});

test("summary over the word limit is caught", () => {
  const out = { summary: "word ".repeat(70), key_points: ["PayBox is a vault."] };
  assert.deepEqual(rulesOf(summaryRules({ text: ARTICLE, max_words: 60 }, out)), ["length"]);
});

test("invented number in a summary is caught", () => {
  const out = { summary: "PayBox grew 47% after launch in 2026.", key_points: ["Supports x402."] };
  const v = summaryRules({ text: ARTICLE, max_words: 60 }, out);
  assert.deepEqual(rulesOf(v), ["invented_numbers"]);
  assert.match(v[0].detail, /47/);
});

test("duplicate key points are caught", () => {
  const out = { summary: "PayBox is a vault.", key_points: ["Supports x402.", "supports x402."] };
  assert.deepEqual(rulesOf(summaryRules({ text: ARTICLE, max_words: 60 }, out)), ["duplicates"]);
});

test("extractJson tolerates fences and prose", () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"breach": false}\n```'), { breach: false });
  assert.equal(extractJson("no json here"), undefined);
});

test("wilson lower bound rewards volume", () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(wilsonLowerBound(3, 3) < wilsonLowerBound(300, 300));
  assert.ok(wilsonLowerBound(300, 300) > 0.98);
});

test("rule parser: decimals don't split clauses, and nested objects are fields", async () => {
  const { compileWithRules } = await import("../src/kit/compiler.ts");
  const output = {
    type: "object",
    properties: { base: { type: "string" }, rates: { type: "object", properties: { EUR: { type: "number" }, MXN: { type: "number" } } } },
  };
  const drafts = compileWithRules("EUR between 0.5 and 1.5, MXN between 10 and 30, always includes rates", { input: { type: "object", properties: {} }, output });
  const rules = drafts.map((d) => ("rule" in d ? d.rule : null));
  assert.deepEqual(rules[0], { type: "numeric_bounds", field: "rates.EUR", min: 0.5, max: 1.5 });
  assert.deepEqual(rules[2], { type: "required_fields", fields: ["rates"] });
  assert.equal(drafts.length, 3);
});
