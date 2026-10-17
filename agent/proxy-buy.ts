/**
 * Buys once from an API a seller guaranteed through Tribunal ("Guarantee any API"), via PayBox.
 *   node proxy-buy.ts usd-exchange-rates
 */
import { PayboxClient } from "@paybox-sh/sdk";

const T = (process.env.TRIBUNAL_URL ?? "https://paybox-tribunal.onrender.com").replace(/\/+$/, "");
const slug = process.argv[2] ?? "usd-exchange-rates";

const guards = (await (await fetch(`${T}/guards`, { headers: { accept: "application/json" } })).json()) as { id: string; title: string; upstream: string; promise: string }[];
const g = guards.find((x) => x.id === `g-${slug}`);
if (!g) throw new Error(`No active guaranteed API "${slug}"`);
console.log(`${g.title} (${g.upstream})\nPromise: ${g.promise}\n`);

const paybox = PayboxClient.fromConfig();
const { credentials } = await paybox.listCredentials();
const wallet = credentials.find((c) => JSON.stringify(c.credential.metadata).includes("solana"));
if (!wallet) throw new Error("No Solana wallet granted");
const r = await paybox.useService({ credentialId: wallet.credential.id, url: `${T}/g/${slug}`, method: "POST", body: {} }, { autoSign: true, waitForApproval: true });
let res = r.response;
if (!["success", "error", "denied"].includes(res.status)) res = await paybox.waitForRequest(res.request_id, { timeoutMs: 120_000 });
const value = (res.output?.value ?? {}) as { resource?: { status?: number; body?: unknown } };
let body = value.resource?.body as any;
if (typeof body === "string") body = JSON.parse(body);
console.log(`HTTP ${value.resource?.status} · ${body?.decision}`);
if (body?.data) console.log(`Rates: ${JSON.stringify(body.data.rates)} (${body.data.date})`);
await new Promise((s) => setTimeout(s, 2000));
const v = await (await fetch(`${T}/verdicts/${body.caseId}`)).json();
console.log(`Payment: ${v.payment.status}${v.payment.settlement ? ` · https://solscan.io/tx/${v.payment.settlement.transaction}` : ""}`);
console.log(`Case: ${T}/cases/${body.caseId}`);
