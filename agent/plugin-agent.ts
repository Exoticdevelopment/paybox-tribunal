/**
 * A buyer agent that goes through the PayBox Tribunal PLUGIN, the way any agent in PayBox would:
 *   discover_plugins → check_guarantee → a paid tool proposes an x402 payment → PayBox prepares it →
 *   this machine's paired key signs it → PayBox pays and fetches → get_case verifies the signed verdict.
 *
 *   node plugin-agent.ts            honest quote, then a broken promise, then the verdict
 *   node plugin-agent.ts invoice    also an invoice extraction through the plugin
 *
 * The SDK's runPlugin doesn't sign plugin x402 proposals yet, so the proposal's signing plan is read
 * through PayBox's own reopen_signing_window and signed by the SDK's x402 signer (completeX402).
 */
import { PayboxClient, type AgentResponse } from "@paybox-sh/sdk";

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
  await pause(350);
};

type Internal = PayboxClient & {
  mcp: { callTool(name: string, args: Record<string, unknown>): Promise<{ content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }> };
  completeX402(result: { response: AgentResponse; plan: unknown }, opts: { autoSign?: boolean; waitForApproval?: boolean }): Promise<{ response: AgentResponse }>;
};
const paybox = PayboxClient.fromConfig() as Internal;
const textOf = (r: { content?: { type: string; text?: string }[] }) => r.content?.find((x) => x.type === "text")?.text ?? "";
const json = (r: { content?: { type: string; text?: string }[]; structuredContent?: unknown }) => {
  try {
    return JSON.parse(textOf(r));
  } catch {
    return r.structuredContent as any;
  }
};

let pluginId = "";

/** Calls a plugin tool. Paid tools return an x402 proposal that PayBox turns into a request to sign. */
async function useTool(tool: string, input: Record<string, unknown>) {
  const raw = await paybox.usePlugin({ pluginId, toolId: tool, input });
  return raw;
}

async function payThroughPlugin(tool: string, input: Record<string, unknown>) {
  await step(`Plugin tool ${c.bold(tool)}`, JSON.stringify(input));
  const raw = await useTool(tool, input);
  const proposed = json(raw);
  const requestId = proposed?.request_id;
  if (!requestId) throw new Error(`No PayBox request from ${tool}: ${textOf(raw).slice(0, 200)}`);
  await step("The plugin proposed an x402 payment; PayBox opened a request", requestId);
  const reopened = json(await paybox.mcp.callTool("reopen_signing_window", { request_id: requestId }));
  const x = reopened.plan?.x402;
  await step("PayBox checked the live 402 challenge", `${x?.amount_usd} USDC on ${x?.rail ?? "solana"} → ${String(x?.accepted?.payTo).slice(0, 8)}…`);
  await step("Signing with this machine's paired key", "non-custodial: the wallet key never leaves PayBox");
  const done = await paybox.completeX402({ response: { request_id: requestId, status: "pending_signature" } as AgentResponse, plan: reopened.plan }, { autoSign: true, waitForApproval: true });
  let res = done.response;
  if (!["success", "error", "denied"].includes(res.status)) res = await paybox.waitForRequest(res.request_id, { timeoutMs: 120_000 });
  const value = (res.output?.value ?? {}) as { resource?: { status?: number; body?: unknown; body_preview?: string }; response?: { status?: number; body?: unknown }; payment?: { status?: string } };
  // A paid 200 comes back as resource.body; a 422 (nothing settled) as response.body.
  let body = (value.resource?.body ?? value.response?.body ?? value.resource?.body_preview) as any;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {}
  }
  await step("Tribunal answered", `HTTP ${value.resource?.status ?? value.response?.status}`);
  return { status: value.resource?.status, body: body ?? {} };
}

async function main() {
  console.log(c.bold("\nAgent → PayBox → PayBox Tribunal plugin") + c.dim("  ·  @paybox-sh/sdk · Solana mainnet\n"));

  await step("discover_plugins", `query "guaranteed price"`);
  const page = await paybox.discoverPlugins({ query: "tribunal" });
  const plugin = page.plugins.find((p) => /tribunal/i.test(p.name ?? ""));
  if (!plugin) throw new Error("PayBox Tribunal plugin not found (is it enabled?)");
  pluginId = plugin.id;
  console.log(`   ${c.bold(plugin.name ?? "")} · ${plugin.type} · ${plugin.enabled ? c.green("enabled") : c.red("disabled")} · ${plugin.tools?.length} tools`);

  await step(`Plugin tool ${c.bold("check_guarantee")}`, `{"service":"quote"} (free, read-only)`);
  const guarantee = json(await useTool("check_guarantee", { service: "quote" }));
  console.log(c.dim(`   ${guarantee.price} · settles ${guarantee.settlement} · trust ${guarantee.trustScore} · ${guarantee.chargedFailures} charged failures · crash test ${guarantee.crashTest?.caught}/${guarantee.crashTest?.attacks}`));

  console.log(`\n${c.bold("━━ 1. Honest seller")}`);
  const ok = await payThroughPlugin("get_price_quote", { asset: "BTC", max_age_seconds: 120, pay_on: "solana" });
  if (ok.body.decision === "delivered") {
    console.log(c.green(`   ✅ Promise kept. ${ok.body.data.pair} = $${Number(ok.body.data.price).toLocaleString("en-US")} · charged $0.01`));
  } else console.log(c.red(`   ❌ ${ok.body.verdict?.summary ?? JSON.stringify(ok.body).slice(0, 160)}`));

  console.log(`\n${c.bold("━━ 2. The seller breaks its promise")} ${c.dim('(demo_fault: "stale")')}`);
  const bad = await payThroughPlugin("get_price_quote", { asset: "BTC", max_age_seconds: 120, pay_on: "solana", demo_fault: "stale" });
  if (bad.body.decision === "rejected") {
    const why = bad.body.verdict.rules.violations.map((v: any) => `${v.rule}: ${v.detail}`).join("; ");
    console.log(c.red(`   ❌ Promise broken: ${why}`));
    console.log(c.bold("   🛡  Charged $0. The signed payment was never settled."));
  } else console.log(c.yellow(`   ${JSON.stringify(bad.body).slice(0, 160)}`));

  if (process.argv[2] === "invoice") {
    console.log(`\n${c.bold("━━ 3. Invoice extraction through the plugin")}`);
    const doc = "Vendor: Panadería La Esquina\nInvoice: FE-2026-0412\nDate: 2026-10-14\nCurrency: COP\n\n2 x Pan de bono @ 2500 = 5000\n3 x Café tinto @ 1800 = 5400\n1 x Torta de chocolate @ 32000 = 32000\n\nSubtotal: 42400\nTax: 8056\nTotal: 50456";
    const inv = await payThroughPlugin("extract_invoice", { document: doc, pay_on: "solana" });
    console.log(inv.body.decision === "delivered" ? c.green(`   ✅ ${inv.body.data.vendor_name} · total ${inv.body.data.total} ${inv.body.data.currency} · charged $0.01`) : c.red(`   ❌ ${inv.body.verdict?.summary}`));
  }

  for (const [label, r] of [["paid", ok], ["refused", bad]] as const) {
    if (!r.body.caseId) continue;
    await step(`Plugin tool ${c.bold("get_case")}`, `${label} case ${r.body.caseId.slice(0, 8)}… (verifies the Ed25519 certificate inside the plugin)`);
    const v = json(await useTool("get_case", { case_id: r.body.caseId }));
    const ok2 = v?.certificateValid ?? v?.signatureValid ?? v?.verified;
    console.log(`   ${v?.decision ?? "?"} · payment ${v?.payment?.status ?? v?.paymentStatus ?? "?"} · certificate ${ok2 === true ? c.green("valid ✓") : String(ok2)}`);
  }
  console.log(c.bold("\nPayBox controls who can spend. Tribunal controls what must be delivered before the seller gets paid.\n"));
}

main().catch((e) => {
  console.error(c.red(`\n${e instanceof Error ? e.message : String(e)}`));
  process.exit(1);
});
