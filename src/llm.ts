import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.ts";

export type StructuredRequest<T> = {
  schema: z.ZodType<T>;
  system: string;
  user: string;
  effort: "low" | "medium";
};

let client: Anthropic | null = null;

export function llmAvailable(): boolean {
  return config.llmBackend !== "off";
}

/**
 * One structured call to Claude, through whichever backend is configured:
 * - api: Anthropic API (needs ANTHROPIC_API_KEY). Use this when deployed.
 * - gemini: Google Gemini (needs GEMINI_API_KEY; free tier). Also fine when deployed.
 * - cli: local `claude -p` (Claude Code on your own subscription). Local testing only.
 * - off: returns null; callers fall back to deterministic behaviour.
 * Returns null on refusal, timeout or unparseable output, never throws.
 */
/** Last AI failure, kept for the /ai/status health check (message only, never credentials). */
let lastError: { at: string; message: string } | null = null;

export function llmStatus() {
  const model = config.llmBackend === "gemini" ? config.geminiModel : config.llmBackend === "api" ? config.llmModel : null;
  return { backend: config.llmBackend, model, lastError };
}

/** Sends a tiny structured request and reports whether the configured AI answers correctly. */
export async function llmHealthCheck() {
  if (!llmAvailable()) return { ...llmStatus(), ok: false, detail: "No AI backend configured." };
  const started = Date.now();
  const answer = await structured({
    schema: z.object({ ok: z.boolean() }),
    system: "You are a health check. Answer exactly as instructed.",
    user: 'Reply with {"ok": true}.',
    effort: "low",
  });
  return { ...llmStatus(), ok: answer?.ok === true, ms: Date.now() - started };
}

// Identical questions get the identical answer instantly (temperature 0), so a busy model
// never breaks a demo that was already run once. Only successful answers are cached.
const answers = new Map<string, unknown>();
const MAX_CACHED = 500;

export async function structured<T>(req: StructuredRequest<T>): Promise<T | null> {
  const key = JSON.stringify([config.llmBackend, req.system, req.user, z.toJSONSchema(req.schema)]);
  if (answers.has(key)) return answers.get(key) as T;
  const answer = await structuredUncached(req);
  if (answer !== null && req.user !== 'Reply with {"ok": true}.') {
    if (answers.size >= MAX_CACHED) answers.delete(answers.keys().next().value!);
    answers.set(key, answer);
  }
  return answer;
}

async function structuredUncached<T>(req: StructuredRequest<T>): Promise<T | null> {
  try {
    if (config.llmBackend === "api") return await viaApi(req);
    if (config.llmBackend === "gemini") return await viaGemini(req);
    if (config.llmBackend === "cli") return await viaCli(req);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastError = { at: new Date().toISOString(), message: message.slice(0, 500) };
    console.error(`llm (${config.llmBackend}) failed:`, message);
    return null;
  }
}

async function viaApi<T>(req: StructuredRequest<T>): Promise<T | null> {
  client ??= new Anthropic({ apiKey: config.anthropicKey });
  const response = await client.beta.messages.parse({
    model: config.llmModel,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: req.system,
    output_config: { effort: req.effort, format: betaZodOutputFormat(req.schema) },
    messages: [{ role: "user", content: req.user }],
  });
  if (response.stop_reason === "refusal") return null;
  return (response.parsed_output as T | null) ?? null;
}

/**
 * Google Gemini (free tier available). JSON mode plus the schema in the prompt; the reply is
 * validated against the same zod schema as every other backend, so a malformed answer is
 * treated exactly like no answer.
 */
// Free-tier models get overloaded (503) or rate-limited (429); try the next one instead of giving up.
const GEMINI_FALLBACKS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-2.0-flash", "gemini-2.0-flash-lite"];

async function viaGemini<T>(req: StructuredRequest<T>): Promise<T | null> {
  const models = [...new Set([config.geminiModel, ...GEMINI_FALLBACKS])];
  let lastFailure: unknown;
  // Two rounds over the free models, with a short pause, before giving up.
  for (const model of [...models, ...models]) {
    if (lastFailure) await new Promise((r) => setTimeout(r, 1500));
    try {
      return await geminiCall(model, req);
    } catch (error) {
      lastFailure = error;
      if (!/answered (429|500|503|404)/.test(String(error))) throw error;
    }
  }
  throw lastFailure;
}

async function geminiCall<T>(model: string, req: StructuredRequest<T>): Promise<T | null> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": config.geminiKey ?? "" },
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${req.user}\n\nRespond with ONLY a JSON object that matches this JSON Schema:\n${JSON.stringify(z.toJSONSchema(req.schema))}`,
            },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini (${model}) answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] };
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const json = extractJson(text);
  if (json === undefined) return null;
  const parsed = req.schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

const CLI_TIMEOUT_MS = 180_000;

async function viaCli<T>(req: StructuredRequest<T>): Promise<T | null> {
  const prompt = [
    req.system,
    "",
    req.user,
    "",
    "Respond with ONLY a JSON object (no prose, no code fences) that matches this JSON Schema:",
    JSON.stringify(z.toJSONSchema(req.schema)),
  ].join("\n");

  const stdout = await runClaudeCli(prompt);
  const envelope = JSON.parse(stdout) as { result?: string; is_error?: boolean };
  if (envelope.is_error || typeof envelope.result !== "string") return null;

  const json = extractJson(envelope.result);
  if (json === undefined) return null;
  const parsed = req.schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function runClaudeCli(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Prompt goes through stdin so nothing needs shell quoting. On Windows the CLI is
    // often a .cmd shim, which only resolves through a shell.
    const child = spawn("claude", ["-p", "--output-format", "json"], {
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude CLI timed out after ${CLI_TIMEOUT_MS / 1000}s`));
    }, CLI_TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not start claude CLI (is Claude Code installed and logged in?): ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude CLI exited with ${code}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}

/** Pulls the first JSON object out of model text, tolerating code fences or stray prose. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
