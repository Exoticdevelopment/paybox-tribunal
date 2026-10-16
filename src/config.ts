function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env var ${name} (see .env.example)`);
  return value;
}

export type LlmBackend = "api" | "gemini" | "cli" | "off";

const anthropicKey = process.env.ANTHROPIC_API_KEY || undefined;
const geminiKey = process.env.GEMINI_API_KEY || undefined;
// Picks the AI automatically from whichever key is set: Anthropic first, then Gemini (free tier), else none.
const llmBackend = (process.env.LLM_BACKEND || (anthropicKey ? "api" : geminiKey ? "gemini" : "off")) as LlmBackend;
const isHosted = process.env.NODE_ENV === "production" || process.env.RENDER === "true";

if (!["api", "gemini", "cli", "off"].includes(llmBackend)) {
  throw new Error(`LLM_BACKEND must be api, gemini, cli or off (got "${llmBackend}")`);
}
if (llmBackend === "cli" && isHosted) {
  // The CLI runs on a personal Claude subscription: fine for local testing, not for a public service.
  throw new Error("LLM_BACKEND=cli is for local testing only. Use api (with ANTHROPIC_API_KEY) or off when deployed.");
}
if (llmBackend === "gemini" && !geminiKey) {
  throw new Error("LLM_BACKEND=gemini needs GEMINI_API_KEY (free at aistudio.google.com).");
}
if (llmBackend === "api" && !anthropicKey) {
  throw new Error("LLM_BACKEND=api needs ANTHROPIC_API_KEY.");
}

export const config = {
  port: Number(process.env.PORT ?? 4021),
  payTo: required("PAY_TO", "0x0000000000000000000000000000000000000000") as `0x${string}`,
  network: required("NETWORK", "eip155:84532") as `${string}:${string}`,
  facilitatorUrl: required("FACILITATOR_URL", "https://x402.org/facilitator"),
  voucherSecret: required("VOUCHER_SECRET", "dev-only-secret"),
  anthropicKey,
  geminiKey,
  /** Gemini model for the gemini backend. */
  geminiModel: process.env.GEMINI_MODEL || "gemini-flash-latest",
  llmBackend,
  /** Model for the API backend. Override with a cheaper one (e.g. claude-haiku-5-5) to keep judge cost below the price. */
  llmModel: process.env.LLM_MODEL || "claude-opus-5-5",
  demoFaults: process.env.DEMO_FAULTS === "1",
  /** Required to publish seller promises when deployed. Locally, publishing is open if unset. */
  adminToken: process.env.ADMIN_TOKEN || undefined,
  dataFile: process.env.DATA_FILE ?? "data/db.json",
  /** How long after delivery a paid result can be appealed. */
  appealWindowMs: 24 * 60 * 60 * 1000,
  isHosted,
} as const;
