/**
 * Real end-to-end test on Base Sepolia (testnet USDC, no real money).
 *
 *   node scripts/testnet-e2e.ts setup   → creates a buyer and a seller TEST wallet, prints the buyer address to fund
 *   node scripts/testnet-e2e.ts run     → starts the real server, pays twice, checks balances, writes a report
 *
 * Case A: honest invoice  → expect 200, payment settled on-chain, buyer -0.01, seller +0.01.
 * Case B: faulty invoice  → expect 422, payment NEVER settled, balances unchanged.
 *
 * Keys live in .testnet/wallets.json (gitignored). They are throwaway testnet keys:
 * never send real funds to these addresses.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const DIR = ".testnet";
const WALLETS = join(DIR, "wallets.json");
const PORT = 4040;
const BASE = `http://localhost:${PORT}`;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const; // Circle USDC on Base Sepolia
const EXPLORER = "https://sepolia.basescan.org";

const INVOICE = `Vendor: Panadería La Esquina
Invoice: FE-2026-0412
Date: 2026-10-14
Currency: COP

2 x Pan de bono @ 2500 = 5000
3 x Café tinto @ 1800 = 5400
1 x Torta de chocolate @ 32000 = 32000

Subtotal: 42400
Tax: 8056
Total: 50456`;

type Wallets = { buyer: `0x${string}`; seller: `0x${string}` };

const chain = createPublicClient({ chain: baseSepolia, transport: http() });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const balance = (address: `0x${string}`) => chain.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [address] });
const usdc = (v: bigint) => `${formatUnits(v, 6)} USDC`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadWallets(): Wallets {
  if (!existsSync(WALLETS)) throw new Error("No test wallets yet. Run: node scripts/testnet-e2e.ts setup");
  return JSON.parse(readFileSync(WALLETS, "utf8")) as Wallets;
}

async function setup() {
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(WALLETS)) {
    writeFileSync(WALLETS, JSON.stringify({ buyer: generatePrivateKey(), seller: generatePrivateKey() }, null, 2));
  }
  const w = loadWallets();
  const buyer = privateKeyToAccount(w.buyer).address;
  const seller = privateKeyToAccount(w.seller).address;
  console.log(`\nTest wallets (Base Sepolia only, keys in ${WALLETS}, never commit or fund with real money)\n`);
  console.log(`  BUYER  (fund this one): ${buyer}`);
  console.log(`  SELLER (receives):      ${seller}\n`);
  console.log(`Buyer balance now: ${usdc(await balance(buyer))}`);
  console.log(`\nNext: get testnet USDC for the BUYER address at https://faucet.circle.com (network: Base Sepolia), then run:`);
  console.log(`  node scripts/testnet-e2e.ts run\n`);
}

/** One paid call, exactly like an agent would do it: probe → 402 → sign → retry once. */
async function paidCall(http402: x402HTTPClient, path: string, body: unknown, headers: Record<string, string> = {}) {
  const init = { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
  const probe = await fetch(BASE + path, init);
  if (probe.status !== 402) throw new Error(`Expected 402 on probe, got ${probe.status}`);
  const required = http402.getPaymentRequiredResponse((h) => probe.headers.get(h), await probe.json().catch(() => undefined));
  const payload = await http402.createPaymentPayload(required);
  const paymentHeaders = http402.encodePaymentSignatureHeader(payload);
  const res = await fetch(BASE + path, { ...init, headers: { ...init.headers, ...paymentHeaders } });
  const json = (await res.json()) as Record<string, unknown>;
  let settlement: { transaction?: string } | null = null;
  try {
    settlement = http402.getPaymentSettleResponse((h) => res.headers.get(h));
  } catch {
    settlement = null;
  }
  return { status: res.status, json, settlement, amount: BigInt(required.accepts[0].amount), paymentHeaders };
}

async function waitForBalance(address: `0x${string}`, expected: bigint) {
  for (let i = 0; i < 20; i++) {
    const b = await balance(address);
    if (b === expected) return b;
    await sleep(3000);
  }
  return balance(address);
}

async function run() {
  const w = loadWallets();
  const buyerAccount = privateKeyToAccount(w.buyer);
  const buyer = buyerAccount.address;
  const seller = privateKeyToAccount(w.seller).address;

  const startBuyer = await balance(buyer);
  const startSeller = await balance(seller);
  console.log(`Buyer  ${buyer}: ${usdc(startBuyer)}`);
  console.log(`Seller ${seller}: ${usdc(startSeller)}`);
  if (startBuyer < 20_000n) throw new Error("Buyer needs at least 0.02 USDC on Base Sepolia. Use https://faucet.circle.com first.");

  console.log("\nStarting the real server (x402 testnet facilitator, DEMO_FAULTS=1)...");
  const server = spawn(process.execPath, ["src/server.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PAY_TO: seller,
      NETWORK: "eip155:84532",
      FACILITATOR_URL: process.env.TESTNET_FACILITATOR ?? "https://x402.org/facilitator",
      PRICE: "$0.01",
      DEMO_FAULTS: "1",
      PAYWALL: "on",
      LLM_BACKEND: "off",
      DATA_FILE: join(DIR, "db.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));

  try {
    for (let i = 0; i < 30 && !(await fetch(`${BASE}/trust`).then((r) => r.ok).catch(() => false)); i++) await sleep(500);

    const client = new x402Client();
    registerExactEvmScheme(client, { signer: buyerAccount });
    const http402 = new x402HTTPClient(client);

    console.log("\nCase A: honest invoice (should be delivered and charged)");
    const a = await paidCall(http402, "/invoice", { document: INVOICE });
    console.log(`  HTTP ${a.status} · decision ${a.json.decision} · settlement tx ${a.settlement?.transaction ?? "none"}`);
    const afterA = await waitForBalance(buyer, startBuyer - a.amount);

    console.log("\nCase C: replay the exact signed payment from case A (should be refused, no second charge)");
    const replay = await fetch(`${BASE}/invoice`, {
      method: "POST",
      headers: { "content-type": "application/json", ...a.paymentHeaders },
      body: JSON.stringify({ document: INVOICE }),
    });
    const replayJson = (await replay.json()) as Record<string, unknown>;
    console.log(`  HTTP ${replay.status} · ${String(replayJson.error ?? replayJson.decision)}`);

    console.log("\nCase B: faulty invoice, total inflated (should be rejected and NOT charged)");
    const b = await paidCall(http402, "/invoice", { document: INVOICE }, { "x-demo-fault": "wrong_total" });
    console.log(`  HTTP ${b.status} · decision ${b.json.decision} · charged ${String(b.json.charged)}`);
    console.log("  Waiting 30s to make sure nothing settles later...");
    await sleep(30_000);

    const endBuyer = await balance(buyer);
    const endSeller = await balance(seller);
    const cert = (await fetch(`${BASE}/certificates/${String(b.json.caseId)}`).then((r) => r.json())) as { certificate: { payment: { nonce: string | null } } };

    const checks = [
      ["Case A returned 200 and was delivered", a.status === 200 && a.json.decision === "delivered"],
      ["Case A settled on-chain (tx hash returned)", Boolean(a.settlement?.transaction)],
      ["Buyer paid exactly once (0.01 USDC)", startBuyer - endBuyer === a.amount && afterA === startBuyer - a.amount],
      ["Seller received exactly once (0.01 USDC)", endSeller - startSeller === a.amount],
      ["Case C replayed payment refused with 409, no second charge", replay.status === 409 && replayJson.error === "payment_already_used"],
      ["Case B returned 422 and was rejected", b.status === 422 && b.json.decision === "rejected"],
      ["Case B was never settled (no tx)", !b.settlement?.transaction],
      ["Case B certificate is bound to its signed (unused) payment nonce", Boolean(cert.certificate.payment.nonce)],
    ] as const;

    console.log("\nResults");
    for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    const passed = checks.every(([, ok]) => ok);

    const report = `# Testnet end-to-end report

Run at ${new Date().toISOString()} on Base Sepolia with the public x402 testnet facilitator. Testnet USDC, no real money.

| | Address | Before | After |
|---|---|---|---|
| Buyer | [${buyer}](${EXPLORER}/address/${buyer}) | ${usdc(startBuyer)} | ${usdc(endBuyer)} |
| Seller | [${seller}](${EXPLORER}/address/${seller}) | ${usdc(startSeller)} | ${usdc(endSeller)} |

**Case A, honest invoice:** HTTP ${a.status}, ${String(a.json.decision)}. Settlement: ${a.settlement?.transaction ? `[${a.settlement.transaction}](${EXPLORER}/tx/${a.settlement.transaction})` : "none"}.

**Case C, replay of case A's signed payment:** HTTP ${replay.status}, ${String(replayJson.error ?? "")}. Refused before reaching the paywall: no second charge.

**Case B, total inflated by 100:** HTTP ${b.status}, ${String(b.json.decision)}. Reason: ${String((b.json.verdict as { summary?: string })?.summary ?? "")} Settlement: none. The buyer signed a payment authorization (nonce \`${cert.certificate.payment.nonce}\`) that was never submitted and expires unused.

## Checks

${checks.map(([name, ok]) => `- ${ok ? "✅" : "❌"} ${name}`).join("\n")}

**Overall: ${passed ? "PASS" : "FAIL"}**
`;
    writeFileSync(join(DIR, "report.md"), report);
    console.log(`\n${passed ? "PASS" : "FAIL"} · report written to ${join(DIR, "report.md")}`);
    if (!passed) {
      console.log("\nServer log (last lines):\n" + serverLog.split("\n").slice(-25).join("\n"));
      process.exitCode = 1;
    }
  } finally {
    server.kill();
  }
}

const command = process.argv[2];
if (command === "setup") await setup();
else if (command === "run") await run();
else console.log("Usage: node scripts/testnet-e2e.ts setup | run");
