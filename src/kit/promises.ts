import { z } from "zod";
import { amountAppearsIn, appearsIn, normalize, numberTokens, wordCount } from "./text.ts";
import type { Violation } from "./types.ts";

/**
 * The closed catalog of promise types. A natural-language promise can only compile into
 * one of these: the AI picks a type and fills parameters, it never writes code that runs.
 * Field paths use dots and [] for arrays: "summary", "key_points[]", "line_items[].amount".
 */
export const RuleSpec = z.discriminatedUnion("type", [
  z.object({ type: z.literal("required_fields"), fields: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("schema_type"), field: z.string(), valueType: z.enum(["string", "number", "boolean", "array"]) }),
  z.object({ type: z.literal("numeric_bounds"), field: z.string(), min: z.number().nullable(), max: z.number().nullable() }),
  z.object({ type: z.literal("length_limit"), field: z.string(), unit: z.enum(["words", "chars", "items"]), max: z.number().int().positive() }),
  z.object({ type: z.literal("language"), field: z.string(), language: z.enum(["es", "en", "pt", "fr"]) }),
  z.object({ type: z.literal("source_grounding"), fields: z.array(z.string()).min(1), sourceField: z.string() }),
  z.object({ type: z.literal("numeric_grounding"), fields: z.array(z.string()).min(1), sourceField: z.string() }),
  z.object({ type: z.literal("freshness"), field: z.string(), maxAgeSeconds: z.number().int().positive() }),
  z.object({ type: z.literal("semantic_claim"), statement: z.string().min(5) }),
]);
export type RuleSpec = z.infer<typeof RuleSpec>;

export type Certainty = "deterministic" | "heuristic" | "probabilistic";

/** How sure we can be when a rule of this type passes or fails. Published with every promise. */
export const CERTAINTY: Record<RuleSpec["type"], Certainty> = {
  required_fields: "deterministic",
  schema_type: "deterministic",
  numeric_bounds: "deterministic",
  length_limit: "deterministic",
  language: "heuristic",
  source_grounding: "deterministic",
  numeric_grounding: "deterministic",
  freshness: "deterministic",
  semantic_claim: "probabilistic",
};

export const CERTAINTY_NOTE: Record<Certainty, string> = {
  deterministic: "Checked exactly by code. Same input, same result, every time.",
  heuristic: "Checked by a word-frequency heuristic. Reliable on normal text, can miss very short or mixed-language text.",
  probabilistic: "Checked by the AI judge. Can be wrong; abstains when unsure, and only rejects with a concrete finding.",
};

export type Promise_ = {
  /** The seller's words for this promise. */
  text: string;
  /** What Tribunal understood, in plain words. */
  interpretation: string;
  rule: RuleSpec;
  certainty: Certainty;
};

export type Unverifiable = { text: string; reason: string };

// ---------- Paths ----------

/** All values at a path. "line_items[].amount" → every line's amount. Missing values come back as undefined. */
export function valuesAt(obj: unknown, path: string): unknown[] {
  let current: unknown[] = [obj];
  for (const raw of path.split(".")) {
    const isArray = raw.endsWith("[]");
    const key = isArray ? raw.slice(0, -2) : raw;
    current = current.flatMap((v) => {
      const next = key ? (v as Record<string, unknown> | undefined)?.[key] : v;
      if (!isArray) return [next];
      return Array.isArray(next) ? next : [undefined];
    });
  }
  return current;
}

/** True when the path exists in a JSON Schema (as produced by z.toJSONSchema). */
export function pathInSchema(schema: unknown, path: string): boolean {
  let node = schema as Record<string, unknown> | undefined;
  for (const raw of path.split(".")) {
    const isArray = raw.endsWith("[]");
    const key = isArray ? raw.slice(0, -2) : raw;
    if (key) node = (node?.properties as Record<string, Record<string, unknown>> | undefined)?.[key];
    if (!node) return false;
    if (isArray) {
      if (node.type !== "array") return false;
      node = node.items as Record<string, unknown> | undefined;
    }
  }
  return Boolean(node);
}

function fieldsOf(rule: RuleSpec): string[] {
  if ("fields" in rule) return rule.fields;
  if ("field" in rule) return [rule.field];
  return [];
}

/** Checks a compiled rule refers to fields the service actually has. Returns problems, [] when fine. */
export function checkAgainstSchemas(rule: RuleSpec, inputSchema: unknown, outputSchema: unknown): string[] {
  const problems = fieldsOf(rule)
    .filter((f) => !pathInSchema(outputSchema, f))
    .map((f) => `output field "${f}" does not exist`);
  if ("sourceField" in rule && !pathInSchema(inputSchema, rule.sourceField)) {
    problems.push(`input field "${rule.sourceField}" does not exist`);
  }
  return problems;
}

// ---------- Evaluation ----------

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

const STOPWORDS: Record<"es" | "en" | "pt" | "fr", string[]> = {
  es: ["el", "la", "los", "las", "de", "que", "y", "en", "un", "una", "es", "por", "con", "para", "del", "se", "su", "al", "como", "más"],
  en: ["the", "and", "of", "to", "in", "is", "it", "that", "for", "with", "on", "as", "was", "are", "by", "this", "be", "an", "at", "from"],
  pt: ["o", "a", "os", "as", "de", "que", "e", "em", "um", "uma", "é", "por", "com", "para", "do", "da", "não", "se", "no", "na"],
  fr: ["le", "la", "les", "de", "des", "et", "en", "un", "une", "est", "que", "pour", "dans", "du", "qui", "sur", "pas", "au", "avec", "ce"],
};

/** Best-guess language by stopword frequency, or null when the text is too short to tell. */
export function detectLanguage(text: string): keyof typeof STOPWORDS | null {
  const words = normalize(text).split(/[^a-z]+/).filter(Boolean);
  if (words.length < 6) return null;
  const scores = Object.entries(STOPWORDS).map(([lang, list]) => {
    const set = new Set(list.map(normalize));
    return [lang, words.filter((w) => set.has(w)).length] as const;
  });
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] === 0 ? null : (scores[0][0] as keyof typeof STOPWORDS);
}

/** Evaluates one published promise. Semantic claims return [] here: the AI judge handles them. */
export function evaluatePromise(p: Promise_, input: unknown, output: unknown): Violation[] {
  const rule = p.rule;
  const fail = (detail: string): Violation => ({ rule: `promise:${rule.type}`, detail: `${detail} (promise: "${p.text}")` });
  const source = "sourceField" in rule ? valuesAt(input, rule.sourceField).filter((v) => typeof v === "string").join("\n") : "";

  switch (rule.type) {
    case "required_fields":
      return rule.fields.flatMap((f) => (valuesAt(output, f).some(isEmpty) ? [fail(`"${f}" is empty or missing`)] : []));

    case "schema_type":
      return valuesAt(output, rule.field).flatMap((v) => {
        const actual = Array.isArray(v) ? "array" : typeof v;
        return actual === rule.valueType ? [] : [fail(`"${rule.field}" is ${actual}, expected ${rule.valueType}`)];
      });

    case "numeric_bounds":
      return valuesAt(output, rule.field).flatMap((v) => {
        if (typeof v !== "number") return [fail(`"${rule.field}" is not a number`)];
        if (rule.min !== null && v < rule.min) return [fail(`"${rule.field}" is ${v}, below ${rule.min}`)];
        if (rule.max !== null && v > rule.max) return [fail(`"${rule.field}" is ${v}, above ${rule.max}`)];
        return [];
      });

    case "length_limit":
      return valuesAt(output, rule.field).flatMap((v) => {
        const n = rule.unit === "items" ? (Array.isArray(v) ? v.length : 0) : rule.unit === "words" ? wordCount(String(v ?? "")) : String(v ?? "").length;
        return n > rule.max ? [fail(`"${rule.field}" has ${n} ${rule.unit}; limit is ${rule.max}`)] : [];
      });

    case "language":
      return valuesAt(output, rule.field).flatMap((v) => {
        const lang = typeof v === "string" ? detectLanguage(v) : null;
        return lang && lang !== rule.language ? [fail(`"${rule.field}" looks like ${lang}, promised ${rule.language}`)] : [];
      });

    case "source_grounding":
      return rule.fields.flatMap((f) =>
        valuesAt(output, f).flatMap((v) => {
          if (typeof v === "string" && v && !appearsIn(source, v)) return [fail(`"${f}" value "${v}" is not in ${rule.sourceField}`)];
          if (typeof v === "number" && !amountAppearsIn(source, v)) return [fail(`"${f}" value ${v} is not in ${rule.sourceField}`)];
          return [];
        }),
      );

    case "numeric_grounding": {
      const allowed = numberTokens(source);
      const text = rule.fields.flatMap((f) => valuesAt(output, f)).filter((v) => typeof v === "string").join(" ");
      const invented = [...numberTokens(text)].filter((n) => !allowed.has(n));
      return invented.length ? [fail(`numbers not in ${rule.sourceField}: ${invented.join(", ")}`)] : [];
    }

    case "freshness":
      return valuesAt(output, rule.field).flatMap((v) => {
        const problem = freshnessProblem(v, rule.maxAgeSeconds);
        return problem ? [fail(`"${rule.field}" ${problem}`)] : [];
      });

    case "semantic_claim":
      return [];
  }
}

/** Allowed clock skew between servers when checking timestamps. */
const CLOCK_SKEW_SECONDS = 30;

/**
 * Null when the timestamp (ISO string or unix seconds/ms) is at most maxAgeSeconds old,
 * otherwise a short description of the problem. Used by the freshness rule and by services.
 */
export function freshnessProblem(value: unknown, maxAgeSeconds: number, now = Date.now()): string | null {
  const ms =
    typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) return "is not a timestamp";
  const age = Math.round((now - ms) / 1000);
  if (age < -CLOCK_SKEW_SECONDS) return `is ${-age}s in the future`;
  if (age > maxAgeSeconds) return `is ${age}s old; limit is ${maxAgeSeconds}s`;
  return null;
}
