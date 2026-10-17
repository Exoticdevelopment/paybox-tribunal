/**
 * A buyer agent built on the official PayBox SDK.
 *
 * Before spending, it reads the seller's published contract and trust score; then it pays through
 * PayBox (non-custodial, signed with this machine's paired key) and reports what Tribunal decided:
 * promise kept → charged, promise broken → 422, never charged.
 *
 *   node buyer.ts            demo: an honest BTC quote, then a stale one
 *   node buyer.ts honest     only the honest quote
 *   node buyer.ts broken     only the broken promise (demo fault: stale quote)
 *   node buyer.ts suite      12 calls: four per service (quote, invoice, summary), two honest and two broken
 *
 * Setup once: npx paybox login, then npx paybox connect (pairs a signing key with an emoji code).
 */
import { PayboxClient, type AgentResponse } from "@paybox-sh/sdk";

const TRIBUNAL = (process.env.TRIBUNAL_URL ?? "https://paybox-tribunal.onrender.com").replace(/\/+$/, "");
const PAY_ON = (process.env.PAY_ON ?? "solana") as "solana" | "evm";
const MIN_TRUST = Number(process.env.MIN_TRUST ?? 0);

type Service = "quote" | "invoice" | "summary";
type Scenario = { service: Service; title: string; body: Record<string, unknown>; fault?: string; note?: string };

const INVOICE_A = [
  "Vendor: Panadería La Esquina",
  "Invoice: FE-2026-0412",
  "Date: 2026-10-14",
  "Currency: COP",
  "",
  "2 x Pan de bono @ 2500 = 5000",
  "3 x Café tinto @ 1800 = 5400",
  "1 x Torta de chocolate @ 32000 = 32000",
  "",
  "Subtotal: 42400",
  "Tax: 8056",
  "Total: 50456",
].join("\n");
const INVOICE_B = [
  "Vendor: Ferretería El Tornillo",
  "Invoice: FT-88213",
  "Date: 2026-10-16",
  "Currency: USD",
  "",
  "4 x Drill bit set @ 12.50 = 50.00",
  "1 x Cordless drill @ 89.99 = 89.99",
  "10 x Wall anchor pack @ 1.20 = 12.00",
  "",
  "Subtotal: 151.99",
  "Tax: 12.16",
  "Total: 164.15",
].join("\n");
const TEXT_A =
  "PayBox is a non-custodial payment vault launched by MoonPay in July 2026. It lets people store wallets, cards and secrets once and then authorise AI agents to pay within limits they set. Sensitive actions require passkey approval. Agents never receive raw credentials; they get scoped outputs such as single-use virtual cards. PayBox supports x402, so agents can pay for web services per request.";
const TEXT_B =
  "The x402 protocol revives the HTTP 402 Payment Required status code so that software can pay for a resource in the same request that fetches it. A server answers 402 with the price, the accepted asset and the network; the client signs a payment and retries. Payments settle in stablecoins such as USDC, often in under two seconds, and fees are low enough to charge one cent per call. This makes per-request pricing practical for APIs used by AI agents.";

const DEMO: Scenario[] = [
  { service: "quote", title: "an honest seller", body: { asset: "BTC", max_age_seconds: 120 } },
  { service: "quote", title: "the seller breaks its promise", body: { asset: "BTC", max_age_seconds: 120 }, fault: "stale", note: "the server deliberately returns a stale quote" },
];

/** Four calls per service: two honest, two deliberately broken promises (12 in total). */
const SUITE: Scenario[] = [
  { service: "quote", title: "BTC price, honest", body: { asset: "BTC", max_age_seconds: 120 } },
  { service: "quote", title: "ETH price, honest", body: { asset: "ETH", max_age_seconds: 120 } },
  { service: "quote", title: "SOL price served 15 minutes stale", body: { asset: "SOL", max_age_seconds: 120 }, fault: "stale" },
  { service: "quote", title: "asked for BTC, got another pair", body: { asset: "BTC", max_age_seconds: 120 }, fault: "wrong_pair" },
  { service: "invoice", title: "bakery invoice, honest", body: { document: INVOICE_A } },
  { service: "invoice", title: "hardware store invoice, honest", body: { document: INVOICE_B } },
  { service: "invoice", title: "total inflated by the seller", body: { document: INVOICE_A }, fault: "wrong_total" },
  { service: "invoice", title: "vendor name invented", body: { document: INVOICE_B }, fault: "hallucinated" },
  { service: "summary", title: "summary of the PayBox launch, honest", body: { text: TEXT_A, max_words: 40 } },
  { service: "summary", title: "summary of x402, honest", body: { text: TEXT_B, max_words: 40 } },
  { service: "summary", title: "summary with an invented number", body: { text: TEXT_A, max_words: 40 }, fault: "invented_number" },
  { service: "summary", title: "summary over the word limit", body: { text: TEXT_B, max_words: 40 }, fault: "too_long" },
];

// ---------- terminal output ----------
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = async (label: string, detail = "") => {
  console.log(`${c.cyan("▸")} ${label}${detail ? ` ${c.dim(detail)}` : ""}`);
  await pause(400);
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${TRIBUNAL}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}

type Contract = { title: string; price: string; settlement: string; guarantees: string[] };
type Trust = { services: Record<string, { score: number; attempts: number; rejectedBeforeCharge: number; chargedFailures: number }> };
type PublicCase = {
  caseId: string;
  decision: string;
  verdict: { summary: string; rules?: { violations: { rule: string; detail: string }[] } };
  payment: { status: string; settlement: { transaction: string; network: string } | null; timeline: { state: string; note: string }[] };
};

/** Reads what PayBox's x402 gateway returned: the paid HTTP response. */
function readGateway(response: AgentResponse) {
  const value = (response.output?.value ?? {}) as {
    resource?: { status?: number; body?: unknown };
    response?: { status?: number; body?: unknown };
  };
  const httpStatus = value.resource?.status ?? value.response?.status;
  let body = value.resource?.body ?? value.response?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {}
  }
  return { httpStatus, body: (body ?? {}) as Record<string, unknown> };
}

/** What the buyer actually got, in one line. */
function describe(service: Service, data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  if (service === "quote") return `${data.pair} = $${Number(data.price).toLocaleString("en-US")} (as of ${data.as_of})`;
  if (service === "invoice") return `${data.vendor_name} · ${data.invoice_number} · total ${data.total} ${data.currency ?? ""}`;
  return `"${String(data.summary ?? "").slice(0, 90)}…"`;
}

/** Read the contract and trust score before spending anything on a service. */
async function checkSeller(service: Service) {
  await step(`Reading the ${service} contract before spending`, `${TRIBUNAL}/${service}/contract`);
  const contract = await getJson<Contract>(`/${service}/contract`);
  console.log(`   ${contract.title} · ${contract.price} · settlement: ${c.bold(contract.settlement)}`);
  for (const g of contract.guarantees) console.log(c.dim(`   • ${g}`));
  await step("Checking the seller's trust score", "computed from real transactions");
  const trust = (await getJson<Trust>("/trust")).services[service];
  console.log(`   score ${trust.score.toFixed(2)} · ${trust.attempts} judged · ${trust.rejectedBeforeCharge} rejected before charge · ${trust.chargedFailures} charged failures`);
  return trust.score >= MIN_TRUST;
}

async function run(paybox: PayboxClient, credentialId: string, s: Scenario, index: number) {
  const url = `${TRIBUNAL}/${s.service}${s.fault ? `?fault=${s.fault}` : ""}`;
  console.log(`\n${c.bold(`━━ ${index}. ${s.service}: ${s.title}`)}`);
  if (s.fault) console.log(c.dim(`   (demo fault "${s.fault}": ${s.note ?? "the server deliberately breaks this promise"})`));

  await step("Paying through PayBox", `$0.01 USDC on ${PAY_ON === "solana" ? "Solana" : "Base"}, signed by this machine's paired key…`);
  const result = await paybox.useService({ credentialId, url, method: "POST", body: s.body }, { autoSign: true, waitForApproval: true });
  let response = result.response;
  if (response.status !== "success" && response.status !== "error" && response.status !== "denied") {
    response = await paybox.waitForRequest(response.request_id, { timeoutMs: 120_000 });
  }
  if (response.status === "denied") {
    console.log(c.red(`   PayBox denied the payment: ${response.error ?? "no reason given"}`));
    return null;
  }

  const { httpStatus, body } = readGateway(response);
  const caseId = typeof body.caseId === "string" ? body.caseId : null;
  await step("Tribunal answered", `HTTP ${httpStatus ?? "?"}`);
  if (!caseId) {
    console.log(c.yellow(`   No case id in the response. PayBox status: ${response.status}${response.error ? `, ${response.error}` : ""}`));
    return null;
  }
  // The public record is the source of truth for whether money moved.
  await pause(1500);
  const record = await getJson<PublicCase>(`/verdicts/${caseId}`);
  for (const e of record.payment.timeline) console.log(`   ${c.dim(e.state.padEnd(14))} ${c.dim(e.note)}`);

  if (record.decision === "delivered") {
    console.log(c.green(`\n   ✅ Promise kept. ${describe(s.service, body.data as Record<string, unknown> | undefined)}`));
    console.log(c.green(`   💸 Charged $0.01.`) + (record.payment.settlement ? c.dim(` tx ${record.payment.settlement.transaction}`) : ""));
    if (record.payment.settlement?.network.startsWith("solana")) console.log(c.dim(`   https://solscan.io/tx/${record.payment.settlement.transaction}`));
  } else {
    const why = record.verdict.rules?.violations.map((v) => `${v.rule}: ${v.detail}`).join("; ") || record.verdict.summary;
    console.log(c.red(`\n   ❌ Promise broken: ${why}`));
    console.log(c.bold(`   🛡  Charged $0. The signed payment was never settled.`));
  }
  console.log(c.dim(`   Case: ${TRIBUNAL}/cases/${caseId}`));
  return record;
}

async function main() {
  const which = process.argv[2] as "honest" | "broken" | "suite" | undefined;
  const plan = which === "suite" ? SUITE : which === "honest" ? [DEMO[0]] : which === "broken" ? [DEMO[1]] : DEMO;
  console.log(c.bold("\nPayBox buyer agent") + c.dim("  ·  built on @paybox-sh/sdk"));
  console.log(`Task: ${c.bold(which === "suite" ? "buy from three guaranteed APIs, 12 calls" : "get a BTC price no older than 120s")}\n`);

  const paybox = PayboxClient.fromConfig();
  const { credentials } = await paybox.listCredentials();
  const wallet = credentials.find(
    (g) => g.credential.credential_type === "wallet" && JSON.stringify(g.credential.metadata).toLowerCase().includes(PAY_ON),
  );
  if (!wallet) throw new Error(`No ${PAY_ON} wallet granted to this agent. Run: npx paybox account-change`);

  let charged = 0;
  let refused = 0;
  const checked = new Set<Service>();
  for (const [i, s] of plan.entries()) {
    if (!checked.has(s.service)) {
      console.log("");
      if (!(await checkSeller(s.service))) {
        console.log(c.red(`   Below my minimum trust (${MIN_TRUST}). Not buying from ${s.service}.`));
        continue;
      }
      await step("Using PayBox wallet", `${wallet.credential.name} (keys stay in PayBox; this agent never sees them)`);
      if (!paybox.canSign) console.log(c.yellow("   No signing key paired yet: run `npx paybox connect` once."));
      checked.add(s.service);
    }
    const record = await run(paybox, wallet.credential.id, s, i + 1);
    if (record?.decision === "delivered") charged++;
    else if (record) refused++;
  }
  if (plan.length > 2) console.log(c.bold(`\n${plan.length} calls · ${charged} kept their promise and were paid · ${refused} broke it and cost $0`));
  console.log(c.bold("\nPayBox controls who can spend. Tribunal controls what must be delivered before the seller gets paid.\n"));
}

main().catch((error) => {
  console.error(c.red(`\n${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
});
