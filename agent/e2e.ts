/**
 * End-to-end checks against a live Tribunal server: pages, promise compiler, crash tests, public
 * challenges, certificates, security, trust, and (with --paid) real payments through PayBox,
 * the on-chain audit and an appeal.
 *
 *   node e2e.ts           free checks only
 *   node e2e.ts --paid    also real payments (two of them settle, $0.01 each)
 */
import { writeFileSync } from "node:fs";
import { PayboxClient, type AgentResponse } from "@paybox-sh/sdk";

const T = (process.env.TRIBUNAL_URL ?? "https://paybox-tribunal.onrender.com").replace(/\/+$/, "");
const PAID = process.argv.includes("--paid");
type Result = { n: number; area: string; check: string; ok: boolean; detail: string };
const results: Result[] = [];

async function check(area: string, name: string, fn: () => Promise<string>) {
  const n = results.length + 1;
  try {
    const detail = await fn();
    results.push({ n, area, check: name, ok: true, detail });
    console.log(`✅ ${String(n).padStart(2)} ${area} · ${name}  ${detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ n, area, check: name, ok: false, detail });
    console.log(`❌ ${String(n).padStart(2)} ${area} · ${name}  ${detail}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const get = async (path: string, accept = "application/json") => {
  const res = await fetch(`${T}${path}`, { headers: { accept }, signal: AbortSignal.timeout(90_000) });
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
};
const getJson = async <X = any>(path: string): Promise<X> => JSON.parse((await get(path)).text);
const post = async <X = any>(path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${T}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json: X;
  try {
    json = JSON.parse(text);
  } catch {
    json = text as X;
  }
  return { status: res.status, json };
};

// ---------- 1. Pages a person opens ----------
async function pages() {
  for (const [path, marker] of [
    ["/", "PayBox Tribunal"],
    ["/contracts", "The contracts"],
    ["/invoice/contract", "contracts"],
    ["/certificates/key", "<html"],
  ] as const) {
    await check("Pages", `GET ${path} renders HTML for a browser`, async () => {
      const r = await get(path, "text/html");
      assert(r.status === 200 && r.type.includes("text/html") && r.text.includes(marker), `status ${r.status}, ${r.type}`);
      return `${r.status} · ${Math.round(r.text.length / 1024)} KB`;
    });
  }
  await check("Pages", "Same contract URL gives agents JSON", async () => {
    const c = await getJson(`/invoice/contract`);
    assert(c.service === "invoice" && c.settlement === "after-validation" && c.rails?.length === 2, "no machine-readable contract");
    return `settlement ${c.settlement}, rails ${c.rails.map((r: any) => r.network.split(":")[0]).join(" + ")}`;
  });
  await check("Pages", "AI backend answers", async () => {
    const s = await getJson(`/ai/status`);
    assert(s.ok === true, `ok=${s.ok} ${s.lastError?.message ?? ""}`);
    return `${s.backend} · ${s.model} · ${s.ms} ms`;
  });
}

// ---------- 2. Promise compiler ----------
async function compiler() {
  const cases: [string, string, (r: any) => string][] = [
    ["English, mixed certainty", "The summary must be at most 30 words, never invents numbers, and must be funny", (r) => {
      const kinds = r.promises.map((p: any) => p.certainty);
      assert(kinds.filter((k: string) => k === "deterministic").length >= 2, `kinds ${kinds}`);
      assert(r.notGuaranteed.some((u: any) => /funny/i.test(u.text)), "'funny' was not refused");
      return `${kinds.join(", ")} + refused "funny"`;
    }],
    ["Spanish wording", "El resumen debe tener máximo 20 palabras y no inventa cifras", (r) => {
      assert(r.promises.some((p: any) => p.rule?.type === "length_limit" && p.rule.max === 20), "no 20-word limit");
      return r.promises.map((p: any) => p.rule?.type).join(", ");
    }],
    ["Only subjective promises", "The summary must be elegant and inspiring", (r) => {
      assert(r.promises.length === 0 && r.notGuaranteed.length >= 1, `${r.promises.length} promises compiled`);
      return `0 rules, ${r.notGuaranteed.length} refused`;
    }],
    ["Promise about a field the service doesn't have", "The summary must include a price_usd field between 1 and 10", (r) => {
      const numeric = r.promises.filter((p: any) => p.rule?.type === "numeric_bounds");
      assert(numeric.length === 0, "invented a rule for a field that doesn't exist");
      return `no rule invented (${r.notGuaranteed.length} refused, ${r.promises.length} other)`;
    }],
  ];
  for (const [name, text, verify] of cases) {
    await check("Compiler", name, async () => {
      const r = await post(`/summary/promises/compile`, { text });
      assert(r.status === 200, `status ${r.status}`);
      return `${r.json.engine} · ${verify(r.json)}`;
    });
  }
}

// ---------- 3. Crash tests ----------
async function crashTests() {
  for (const service of ["invoice", "summary", "quote"]) {
    await check("Crash test", `${service}: every attack caught, honest output passes`, async () => {
      const r = await getJson(`/${service}/crash-test`);
      const m = r.metrics;
      assert(m.missed === 0 && m.wronglyRejected === 0, `missed ${m.missed}, wrongly rejected ${m.wronglyRejected}`);
      return `${m.caught}/${m.attacks} attacks caught, ${m.honestCases} honest passed`;
    });
  }
}

// ---------- 4. Public challenges ("Break a guarantee") ----------
// Only real attacks: an honest output is not a challenge (honest passes are covered by the crash tests).
async function challenges() {
  const fresh = () => new Date().toISOString();
  const plans: { service: string; name: string; expectCaught: boolean; mutate: (o: any) => void; note: string }[] = [
    { service: "invoice", name: "total inflated by 100", expectCaught: true, mutate: (o) => (o.total += 100), note: "e2e: inflated total" },
    { service: "invoice", name: "vendor invented", expectCaught: true, mutate: (o) => (o.vendor_name = "Globex Corporation"), note: "e2e: invented vendor" },
    { service: "summary", name: "invented figure", expectCaught: true, mutate: (o) => (o.summary += " It already has 2 million users."), note: "e2e: invented number" },
    { service: "summary", name: "over the word limit", expectCaught: true, mutate: (o) => (o.summary = Array(80).fill("payments").join(" ")), note: "e2e: too long" },
    { service: "quote", name: "price from 15 minutes ago", expectCaught: true, mutate: (o) => (o.as_of = new Date(Date.now() - 900_000).toISOString()), note: "e2e: stale" },
    { service: "quote", name: "zero price", expectCaught: true, mutate: (o) => { o.as_of = fresh(); o.price = 0; }, note: "e2e: zero price" },
  ];
  for (const p of plans) {
    await check("Challenge", `${p.service}: ${p.name} → ${p.expectCaught ? "caught" : "passes"}`, async () => {
      const sample = await getJson(`/${p.service}/sample`);
      const output = structuredClone(sample.output);
      p.mutate(output);
      const r = await post(`/${p.service}/challenge`, { input: sample.input, output, note: p.note });
      assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
      assert(r.json.caught === p.expectCaught, `caught=${r.json.caught}: ${r.json.verdict?.summary}`);
      const rules = r.json.verdict.rules.violations.map((v: any) => v.rule).join(", ");
      return r.json.caught ? `caught by ${rules || `AI judge (${r.json.verdict.judge.status})`}` : `passed (judge ${r.json.verdict.judge.status})`;
    });
  }
}

// ---------- 5. Certificates ----------
async function certificates() {
  const verdicts = await getJson<any[]>(`/verdicts?limit=100`);
  const delivered = verdicts.find((v) => v.decision === "delivered");
  await check("Certificate", "Signed certificate of a real paid case verifies", async () => {
    assert(delivered, "no delivered case");
    const { certificate, signature } = await getJson(`/certificates/${delivered.caseId}`);
    const r = await post(`/certificates/verify`, { certificate, signature });
    assert(r.json.valid === true, "signature invalid");
    return `case ${delivered.caseId.slice(0, 8)} · Ed25519 valid`;
  });
  await check("Certificate", "Tampered certificate is rejected", async () => {
    const { certificate, signature } = await getJson(`/certificates/${delivered.caseId}`);
    const forged = { ...certificate, verdict: { ...certificate.verdict, decision: "rejected" } };
    const r = await post(`/certificates/verify`, { certificate: forged, signature });
    assert(r.json.valid === false, "a forged verdict verified");
    return "forged verdict → valid: false";
  });
  await check("Certificate", "A different output doesn't match the judged hash", async () => {
    const r = await post(`/certificates/${delivered.caseId}/check-output`, { output: { forged: true } });
    assert(r.json.matches === false, "mismatch not detected");
    return "matches: false";
  });
}

// ---------- 6. Security ----------
async function security() {
  await check("Security", "Paid route without a payment answers 402, never the result", async () => {
    const r = await post(`/quote`, { asset: "BTC", max_age_seconds: 120 });
    assert(r.status === 402, `status ${r.status}`);
    return "402 Payment Required";
  });
  await check("Security", "A forged payment header is refused", async () => {
    const r = await post(`/quote`, { asset: "BTC", max_age_seconds: 120 }, { "payment-signature": Buffer.from('{"x402Version":2,"payload":{}}').toString("base64") });
    assert(r.status >= 400 && r.status !== 422 && r.status < 500 || r.status === 402, `status ${r.status}`);
    assert(r.status !== 200, "served without paying");
    return `${r.status}, nothing served`;
  });
  await check("Security", "Registering an API needs the seller token", async () => {
    const r = await post(`/guard`, { title: "x", url: "https://api.coinbase.com/v2/prices/BTC-USD/spot", method: "GET", promise: "price is positive" });
    assert(r.status === 403, `status ${r.status}`);
    return "403 without x-admin-token";
  });
  await check("Security", "Publishing a contract needs the seller token", async () => {
    const r = await post(`/summary/promises/publish`, { draftId: "00000000-0000-4000-8000-000000000000", confirm: true });
    assert(r.status === 403 || r.status === 401, `status ${r.status}`);
    return `${r.status} without x-admin-token`;
  });
  await check("Security", "Public record never exposes buyers' data", async () => {
    const ev = await getJson<any[]>(`/evidence/export`);
    const leaked = ev.filter((c) => c.input !== "[redacted]" || c.output !== "[redacted]");
    const v = await get(`/verdicts?limit=100`);
    assert(leaked.length === 0 && !v.text.includes("Panadería"), `${leaked.length} unredacted`);
    return `${ev.length} cases, all redacted`;
  });
}

// ---------- 7. Trust ----------
async function trust() {
  await check("Trust", "No buyer ever paid for a broken promise", async () => {
    const t = await getJson(`/trust`);
    assert(t.overall.chargedFailures === 0 && t.overall.settledDespiteRejection === 0, JSON.stringify(t.overall));
    return `${t.overall.attempts} judged · ${t.overall.rejectedBeforeCharge} refused before charge · 0 charged failures`;
  });
}

// ---------- 8. Real payments through PayBox ----------
function gatewayBody(response: AgentResponse) {
  const value = (response.output?.value ?? {}) as { resource?: { status?: number; body?: unknown }; response?: { status?: number; body?: unknown } };
  let body = value.resource?.body ?? value.response?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {}
  }
  return { status: value.resource?.status ?? value.response?.status, body: (body ?? {}) as any };
}

async function paid() {
  const paybox = PayboxClient.fromConfig();
  const { credentials } = await paybox.listCredentials();
  const wallet = credentials.find((g) => JSON.stringify(g.credential.metadata).includes("solana"));
  assert(wallet, "no Solana wallet granted");
  const buy = async (path: string, body: unknown) => {
    const r = await paybox.useService({ credentialId: wallet.credential.id, url: `${T}${path}`, method: "POST", body }, { autoSign: true, waitForApproval: true });
    let res = r.response;
    if (!["success", "error", "denied"].includes(res.status)) res = await paybox.waitForRequest(res.request_id, { timeoutMs: 120_000 });
    return gatewayBody(res);
  };

  let rejectedId = "";
  await check("Paid", "Quote that keeps its promise → 200, settled on Solana", async () => {
    const r = await buy(`/quote`, { asset: "SOL", max_age_seconds: 120 });
    assert(r.status === 200 && r.body.decision === "delivered", `HTTP ${r.status}`);
    await new Promise((s) => setTimeout(s, 2000));
    const v = await getJson(`/verdicts/${r.body.caseId}`);
    assert(v.payment.status === "settled", `payment ${v.payment.status}`);
    return `SOL $${r.body.data.price} · tx ${v.payment.settlement.transaction.slice(0, 10)}…`;
  });
  await check("Paid", "Stale quote → 422, never settled", async () => {
    const r = await buy(`/quote?fault=stale`, { asset: "SOL", max_age_seconds: 120 });
    assert(r.status === 422 && r.body.charged === false, `HTTP ${r.status}`);
    rejectedId = r.body.caseId;
    return `case ${rejectedId.slice(0, 8)} · charged: false`;
  });
  await check("Paid", "Invoice with a required field missing → 422", async () => {
    const sample = await getJson(`/invoice/sample`);
    const r = await buy(`/invoice?fault=missing_field`, sample.input);
    assert(r.status === 422, `HTTP ${r.status}`);
    return r.body.verdict.rules.violations.map((v: any) => v.rule).join(", ");
  });
  await check("Paid", "Summary with an unsupported claim → rejected", async () => {
    const sample = await getJson(`/summary/sample`);
    const r = await buy(`/summary?fault=unsupported_claim`, sample.input);
    assert(r.status === 422, `HTTP ${r.status} · judge ${r.body.verdict?.judge?.status}`);
    const rules = r.body.verdict.rules.violations.map((v: any) => v.rule).join(", ");
    return rules ? `rules: ${rules}` : `AI judge: ${r.body.verdict.judge.status}`;
  });
  await check("Paid", "Appeal with a baseless complaint is not rewarded", async () => {
    const sample = await getJson(`/summary/sample`);
    const r = await buy(`/summary`, sample.input);
    assert(r.status === 200 && r.body.receipt, `HTTP ${r.status}`);
    const a = await post(`/appeal`, { caseId: r.body.caseId, receipt: r.body.receipt, complaint: "I just want my money back, the summary is fine but I changed my mind." });
    assert(a.status === 200, `appeal status ${a.status} ${JSON.stringify(a.json).slice(0, 120)}`);
    assert(a.json.credit === null, "a baseless appeal earned a credit");
    return `ruling: ${a.json.ruling.status}, no credit`;
  });
  await check("Paid", "On-chain audit proves the rejected Solana payment never moved", async () => {
    assert(rejectedId, "no rejected case");
    // The signed transaction expires with its blockhash; the audit after the window is final.
    for (let i = 0; i < 12; i++) {
      await new Promise((s) => setTimeout(s, 30_000));
      await post(`/audit`, {});
      const v = await getJson(`/verdicts/${rejectedId}`);
      const e = v.payment.timeline.find((x: any) => x.state === "expired_unsettled" || x.state === "settled_despite_rejection");
      if (e) {
        assert(e.state === "expired_unsettled", "flagged as fraud");
        return e.note;
      }
    }
    throw new Error("audit did not conclude within 6 minutes");
  });
}

const t0 = Date.now();
console.log(`Tribunal e2e against ${T}${PAID ? " (with real payments)" : ""}\n`);
await pages();
await compiler();
await crashTests();
await challenges();
await certificates();
await security();
await trust();
if (PAID) await paid();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed in ${Math.round((Date.now() - t0) / 1000)}s`);
writeFileSync(new URL("./e2e-results.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), server: T, passed, total: results.length, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
