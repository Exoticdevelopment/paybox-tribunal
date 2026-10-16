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
export async function structured<T>(req: StructuredRequest<T>): Promise<T | null> {
  try {
    if (config.llmBackend === "api") return await viaApi(req);
    if (config.llmBackend === "gemini") return await viaGemini(req);
    if (config.llmBackend === "cli") return await viaCli(req);
    return null;
  } catch (error) {
    console.error(`llm (${config.llmBackend}) failed:`, error instanceof Error ? error.message : error);
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
async function viaGemini<T>(req: StructuredRequest<T>): Promise<T | null> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`, {
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
  if (!res.ok) throw new Error(`Gemini answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
