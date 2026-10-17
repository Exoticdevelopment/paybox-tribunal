/**
 * A buyer agent built on the official PayBox SDK.
 *
 * It needs a fresh BTC price. Before spending, it reads the seller's published contract and trust
 * score; then it pays through PayBox (non-custodial, signed with this machine's paired key) and
 * reports what Tribunal decided: promise kept → charged, promise broken → 422, never charged.
 *
 *   node buyer.ts            both scenarios (honest, then a broken promise)
 *   node buyer.ts honest     only the honest call
 *   node buyer.ts broken     only the broken promise (demo fault: stale quote)
 *
 * Setup once: npx paybox login, then npx paybox connect (pairs a signing key with an emoji code).
 */
import { PayboxClient, type AgentResponse } from "@paybox-sh/sdk";

const TRIBUNAL = (process.env.TRIBUNAL_URL ?? "https://paybox-tribunal.onrender.com").replace(/\/+$/, "");
const PAY_ON = (process.env.PAY_ON ?? "solana") as "solana" | "evm";
const MIN_TRUST = Number(process.env.MIN_TRUST ?? 0);
const TASK = { asset: "BTC", max_age_seconds: 120 };

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

type Contract = { title: string; price: string; settlement: string; guarantees: string[]; rails?: { network: string }[] };
type Trust = { services: Record<string, { score: number; attempts: number; rejectedBeforeCharge: number; chargedFailures: number }> };
type PublicCase = {
  caseId: string;
  decision: string;
  charged: boolean;
  verdict: { summary: string; rules?: { violations: { rule: string; detail: string }[] } };
  payment: { status: string; settlement: { transaction: string; network: string } | null; timeline: { state: string; note: string }[] };
};

/** Reads what PayBox's x402 gateway returned: the paid HTTP response and whether money moved. */
function readGateway(response: AgentResponse) {
  const value = (response.output?.value ?? {}) as {
    payment?: { status?: string; ok?: boolean };
    resource?: { status?: number; ok?: boolean; body?: unknown };
    response?: { status?: number; body?: unknown };
  };
  const httpStatus = value.resource?.status ?? value.response?.status;
  let body = value.resource?.body ?? value.response?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {}
  }
  return { httpStatus, body: (body ?? {}) as Record<string, unknown>, payment: value.payment?.status ?? (value.payment?.ok ? "paid" : "unknown") };
}

async function run(paybox: PayboxClient, credentialId: string, scenario: "honest" | "broken") {
  const url = scenario === "broken" ? `${TRIBUNAL}/quote?fault=stale` : `${TRIBUNAL}/quote`;
  console.log(`\n${c.bold(scenario === "honest" ? "━━ Scenario 1: an honest seller" : "━━ Scenario 2: the seller breaks its promise")}`);
  if (scenario === "broken") console.log(c.dim("   (demo fault: the server deliberately returns a stale quote)"));

  await step("Paying through PayBox", `$0.01 USDC on ${PAY_ON === "solana" ? "Solana" : "Base"}, signed by this machine's paired key…`);
  const result = await paybox.useService({ credentialId, url, method: "POST", body: TASK }, { autoSign: true, waitForApproval: true });
  let response = result.response;
  if (response.status !== "success" && response.status !== "error" && response.status !== "denied") {
    response = await paybox.waitForRequest(response.request_id, { timeoutMs: 120_000 });
  }
  if (response.status === "denied") {
    console.log(c.red(`   PayBox denied the payment: ${response.error ?? "no reason given"}`));
    return;
  }

  const { httpStatus, body } = readGateway(response);
  const caseId = typeof body.caseId === "string" ? body.caseId : null;
  await step("Tribunal answered", `HTTP ${httpStatus ?? "?"}`);

  if (!caseId) {
    console.log(c.yellow(`   No case id in the response. PayBox status: ${response.status}${response.error ? `, ${response.error}` : ""}`));
    return;
  }
  // The public record is the source of truth for whether money moved.
  await pause(1500);
  const record = await getJson<PublicCase>(`/verdicts/${caseId}`);
  for (const e of record.payment.timeline) console.log(`   ${c.dim(e.state.padEnd(14))} ${c.dim(e.note)}`);

  if (record.decision === "delivered") {
    const data = body.data as { price?: number; as_of?: string } | undefined;
    console.log(c.green(`\n   ✅ Promise kept. BTC = $${data?.price?.toLocaleString("en-US") ?? "?"} (as of ${data?.as_of ?? "?"})`));
    console.log(c.green(`   💸 Charged $0.01.`) + (record.payment.settlement ? c.dim(` tx ${record.payment.settlement.transaction}`) : ""));
    if (record.payment.settlement?.network.startsWith("solana")) {
      console.log(c.dim(`   https://solscan.io/tx/${record.payment.settlement.transaction}`));
    }
  } else {
    const why = record.verdict.rules?.violations.map((v) => `${v.rule}: ${v.detail}`).join("; ") || record.verdict.summary;
    console.log(c.red(`\n   ❌ Promise broken: ${why}`));
    console.log(c.bold(`   🛡  Charged $0. The signed payment was never settled.`));
  }
  console.log(c.dim(`   Case: ${TRIBUNAL}/cases/${caseId}`));
}

async function main() {
  const which = process.argv[2] as "honest" | "broken" | undefined;
  console.log(c.bold("\nPayBox buyer agent") + c.dim("  ·  built on @paybox-sh/sdk"));
  console.log(`Task: ${c.bold(`get a ${TASK.asset} price no older than ${TASK.max_age_seconds}s`)}\n`);

  await step("Reading the seller's contract before spending", `${TRIBUNAL}/quote/contract`);
  const contract = await getJson<Contract>("/quote/contract");
  console.log(`   ${contract.title} · ${contract.price} · settlement: ${c.bold(contract.settlement)}`);
  for (const g of contract.guarantees) console.log(c.dim(`   • ${g}`));

  await step("Checking the seller's trust score", "computed from real transactions");
  const trust = (await getJson<Trust>("/trust")).services.quote;
  console.log(`   score ${trust.score.toFixed(2)} · ${trust.attempts} judged · ${trust.rejectedBeforeCharge} rejected before charge · ${trust.chargedFailures} charged failures`);
  if (trust.score < MIN_TRUST) {
    console.log(c.red(`   Below my minimum (${MIN_TRUST}). Not buying.`));
    return;
  }

  const paybox = PayboxClient.fromConfig();
  const { credentials } = await paybox.listCredentials();
  const wallet = credentials.find(
    (g) => g.credential.credential_type === "wallet" && JSON.stringify(g.credential.metadata).toLowerCase().includes(PAY_ON),
  );
  if (!wallet) throw new Error(`No ${PAY_ON} wallet granted to this agent. Run: npx paybox account-change`);
  await step("Using PayBox wallet", `${wallet.credential.name} (keys stay in PayBox; this agent never sees them)`);
  if (!paybox.canSign) console.log(c.yellow("   No signing key paired yet: run `npx paybox connect` once."));

  if (!which || which === "honest") await run(paybox, wallet.credential.id, "honest");
  if (!which || which === "broken") await run(paybox, wallet.credential.id, "broken");
  console.log(c.bold("\nPayBox controls who can spend. Tribunal controls what must be delivered before the seller gets paid.\n"));
}

main().catch((error) => {
  console.error(c.red(`\n${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
});
