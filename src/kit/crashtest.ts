import type { Promise_ } from "./promises.ts";
import type { AnyGuarantee, JudgeFn } from "./types.ts";
import { decide } from "./verdict.ts";

/**
 * Crash Test: before buyers rely on a guarantee, Tribunal tries to break it.
 *
 * Each case has its expected outcome fixed BEFORE it runs, so the validator can't grade
 * its own homework. Results are reported per kind and always labelled as a simulation:
 * mutation tests show what the contract can catch, not production accuracy.
 */
export type CrashKind = "deterministic" | "semantic" | "edge";

export type CrashCase = {
  name: string;
  kind: CrashKind;
  /** What a correct validator must do with this output. */
  expect: "pass" | "fail";
  /** Mutates a copy of the honest sample output. Omit to test the honest output itself. */
  mutate?: (output: Record<string, unknown>) => unknown;
  /** Replace the sample input (e.g. to test edge inputs). */
  input?: unknown;
};

export type CrashResult = {
  name: string;
  kind: CrashKind;
  source: "suite" | "promise";
  expect: "pass" | "fail";
  outcome: "delivered" | "rejected";
  correct: boolean;
  rulesHit: string[];
  judge: string;
  ms: number;
};

/** Attacks derived from the seller's published promises: one targeted mutation per checkable rule. */
export function casesFromPromises(promises: Promise_[]): CrashCase[] {
  return promises.flatMap((p): CrashCase[] => {
    const r = p.rule;
    const set = (o: Record<string, unknown>, path: string, fn: (v: unknown) => unknown) => {
      const keys = path.replace(/\[\]/g, "").split(".");
      // Only top-level and first-array-item paths are mutated; enough to probe each rule.
      let target: Record<string, unknown> = o;
      for (const k of keys.slice(0, -1)) {
        const next = target[k];
        target = (Array.isArray(next) ? next[0] : next) as Record<string, unknown>;
        if (!target) return o;
      }
      const last = keys.at(-1)!;
      const cur = target[last];
      target[last] = Array.isArray(cur) && path.endsWith("[]") ? [fn(cur[0]), ...cur.slice(1)] : fn(cur);
      return o;
    };
    const name = (what: string) => `Promise "${p.text}": ${what}`;
    switch (r.type) {
      case "length_limit":
        return [{
          name: name(`exceed ${r.max} ${r.unit}`),
          kind: "deterministic",
          expect: "fail",
          mutate: (o) => set(o, r.field, (v) => (r.unit === "items" ? Array.from({ length: r.max + 1 }, (_, i) => `item ${i}`) : `${String(v ?? "")} ${"word ".repeat(r.max + 5)}`.trim())),
        }];
      case "required_fields":
        return [{ name: name(`blank ${r.fields[0]}`), kind: "deterministic", expect: "fail", mutate: (o) => set(o, r.fields[0], () => "") }];
      case "numeric_bounds":
        return [{ name: name(`push ${r.field} out of range`), kind: "deterministic", expect: "fail", mutate: (o) => set(o, r.field, () => (r.max ?? 0) + 1_000_000) }];
      case "language":
        return [{ name: name("answer in the wrong language"), kind: "deterministic", expect: "fail", mutate: (o) => set(o, r.field, () => r.language === "en" ? "Este texto está escrito completamente en español y no en el idioma prometido por el vendedor." : "This text is written entirely in English and not in the language that the seller promised.") }];
      case "numeric_grounding":
        return [{ name: name("slip in an invented figure"), kind: "deterministic", expect: "fail", mutate: (o) => set(o, r.fields[0], (v) => `${String(v ?? "")} It grew 987% overnight.`) }];
      case "source_grounding":
        return [{ name: name(`invent ${r.fields[0]}`), kind: "deterministic", expect: "fail", mutate: (o) => set(o, r.fields[0], (v) => (typeof v === "number" ? 987654.32 : "Invented Value Inc")) }];
      case "freshness":
        return [{ name: name("deliver stale data"), kind: "deterministic", expect: "fail", mutate: (o) => set(o, r.field, () => new Date(Date.now() - (r.maxAgeSeconds + 600) * 1000).toISOString()) }];
      case "schema_type":
        return [{ name: name(`wrong type for ${r.field}`), kind: "deterministic", expect: "fail", mutate: (o) => set(o, r.field, () => (r.valueType === "string" ? 42 : "not the right type")) }];
      case "semantic_claim":
        return []; // No reliable automatic attack: reported as untested instead of faked.
    }
  });
}

export async function runCrashTest(g: AnyGuarantee, promises: Promise_[], judge: JudgeFn, suite: CrashCase[]) {
  if (!g.sample) throw new Error(`Service ${g.id} has no sample to test from.`);
  const cases = [
    ...suite.map((c) => ({ ...c, source: "suite" as const })),
    ...casesFromPromises(promises).map((c) => ({ ...c, source: "promise" as const })),
  ];

  const results: CrashResult[] = [];
  for (const c of cases) {
    const { input, output } = g.sample; // read per case: samples may be time-dependent
    const copy = structuredClone(output) as Record<string, unknown>;
    const mutated = c.mutate ? c.mutate(copy) : copy;
    const started = performance.now();
    const verdict = await decide(g, c.input ?? input, mutated === undefined ? copy : mutated, judge, promises);
    const outcome = verdict.decision;
    results.push({
      name: c.name,
      kind: c.kind,
      source: c.source,
      expect: c.expect,
      outcome,
      correct: (c.expect === "fail") === (outcome === "rejected"),
      rulesHit: [...new Set(verdict.rules.violations.map((v) => v.rule))],
      judge: verdict.judge.status,
      ms: Math.round(performance.now() - started),
    });
  }

  const shouldFail = results.filter((r) => r.expect === "fail");
  const shouldPass = results.filter((r) => r.expect === "pass");
  const byKind = (k: CrashKind) => {
    const xs = shouldFail.filter((r) => r.kind === k);
    return { attacks: xs.length, caught: xs.filter((r) => r.correct).length };
  };
  const untested = promises.filter((p) => p.rule.type === "semantic_claim").map((p) => p.text);

  return {
    service: g.id,
    label: "Simulation: mutation tests against this contract version. Shows what the contract catches, not production accuracy.",
    ranAt: new Date().toISOString(),
    metrics: {
      cases: results.length,
      attacks: shouldFail.length,
      caught: shouldFail.filter((r) => r.correct).length,
      missed: shouldFail.filter((r) => !r.correct).length,
      honestCases: shouldPass.length,
      wronglyRejected: shouldPass.filter((r) => !r.correct).length,
      deterministic: byKind("deterministic"),
      semantic: byKind("semantic"),
      edge: byKind("edge"),
      judgeRulings: results.filter((r) => r.judge === "upheld" || r.judge === "breach").length,
      avgMs: Math.round(results.reduce((n, r) => n + r.ms, 0) / Math.max(results.length, 1)),
    },
    untestedPromises: untested,
    results,
  };
}

export type CrashReport = Awaited<ReturnType<typeof runCrashTest>>;
