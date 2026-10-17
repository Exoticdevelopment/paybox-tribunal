import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { Compiled } from "./compiler.ts";
import { defineGuarantee, type AnyGuarantee } from "./types.ts";

/**
 * Instant guarantees for any existing API: the seller gives a URL and a promise in plain
 * language; Tribunal compiles the promise, crash-tests it against a live sample, and then
 * sits in front of the API as a paid x402 endpoint that only settles when the upstream
 * response keeps the promise. No code on the seller's side.
 */
export type ProxyDef = {
  id: string; // "g-<slug>", served at POST /g/<slug>
  slug: string;
  title: string;
  url: string;
  method: "GET" | "POST";
  promise: string;
  compiled: Compiled;
  sampleInput: ProxyInput;
  sampleOutput: unknown;
  outputSchema: JsonSchema;
  createdAt: number;
  active: boolean;
};

export const ProxyInput = z.object({
  /** JSON body forwarded to the upstream API (POST only). */
  body: z.record(z.string(), z.unknown()).optional(),
  /** Query string parameters forwarded to the upstream API. */
  query: z.record(z.string(), z.string()).optional(),
});
export type ProxyInput = z.infer<typeof ProxyInput>;

export type JsonSchema = { type: string; properties?: Record<string, JsonSchema>; items?: JsonSchema };

/** A JSON Schema shaped like a sample value, so promises can refer to its fields by name. */
export function inferSchema(value: unknown, depth = 0): JsonSchema {
  if (Array.isArray(value)) return { type: "array", items: value.length && depth < 6 ? inferSchema(value[0], depth + 1) : { type: "string" } };
  if (value === null) return { type: "null" };
  if (typeof value === "object") {
    if (depth >= 6) return { type: "object" };
    return {
      type: "object",
      properties: Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([k, v]) => [k, inferSchema(v, depth + 1)])),
    };
  }
  return { type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string" };
}

/** The input schema promises can reference: "body.<field>" and "query.<field>". */
export function proxyInputSchema(sample: ProxyInput): JsonSchema {
  return {
    type: "object",
    properties: {
      body: inferSchema(sample.body ?? {}),
      query: inferSchema(sample.query ?? {}),
    },
  };
}

// ---------- Safe upstream calls (no SSRF) ----------

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Throws unless the URL is a public HTTPS endpoint. allowLocal is for local testing only. */
export async function assertPublicUrl(raw: string, allowLocal: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Not a valid URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (allowLocal && local && (url.protocol === "http:" || url.protocol === "https:")) return url;
  if (url.protocol !== "https:") throw new Error("Only https:// URLs can be guaranteed.");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed.");
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => privateAddress(a.address))) throw new Error("The URL must resolve to a public address.");
  return url;
}

/** Calls the upstream API once. Returns parsed JSON, or null for any failure (which the tribunal then rejects). */
/**
 * Calls the seller's API once. Returns null on any failure (the tribunal then rejects and nobody pays),
 * or, with explain=true (when registering an API), throws a readable reason instead.
 */
export async function callUpstream(def: Pick<ProxyDef, "url" | "method">, input: ProxyInput, allowLocal: boolean, explain = false): Promise<unknown> {
  const fail = (reason: string) => {
    if (explain) throw new Error(reason);
    return null;
  };
  const url = await assertPublicUrl(def.url, allowLocal);
  for (const [k, v] of Object.entries(input.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: def.method,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json", ...(def.method === "POST" ? { "content-type": "application/json" } : {}) },
    body: def.method === "POST" ? JSON.stringify(input.body ?? {}) : undefined,
  });
  if (res.status >= 300 && res.status < 400) return fail(`The API answered with a redirect (${res.status}); use the final URL.`);
  if (!res.ok) return fail(`The API answered HTTP ${res.status}${res.status === 429 ? " (rate limited: it may block shared cloud servers)" : ""}.`);
  const text = await res.text();
  if (text.length > MAX_BYTES) return fail("The API answered more than 256 KB.");
  try {
    return JSON.parse(text);
  } catch {
    return fail("The API did not answer with JSON.");
  }
}

/** Turns a stored definition into a guarantee the tribunal can serve, judge and crash-test. */
export function proxyGuarantee(def: ProxyDef, price: string, allowLocal: boolean): AnyGuarantee {
  return defineGuarantee<ProxyInput, unknown>({
    id: def.id,
    title: def.title,
    description: `Guaranteed proxy for ${new URL(def.url).host}. Settles only if the upstream response keeps the seller's promise.`,
    price,
    input: ProxyInput,
    output: z.unknown(),
    guarantees: [
      `Upstream: ${def.method} ${def.url}`,
      "The upstream must answer with JSON, within 8 seconds and 256 KB.",
      "Every promise below is checked before your payment settles. If any fails, the response is 422 and you are never charged.",
    ],
    rules: () => [],
    run: (input) => callUpstream(def, input, allowLocal),
    sample: { input: def.sampleInput, output: def.sampleOutput },
    crashSuite: [{ name: "Honest upstream response", kind: "deterministic", expect: "pass" }],
  });
}

export function slugify(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "api";
}
