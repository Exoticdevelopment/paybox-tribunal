import { evaluatePromise, type Promise_ } from "./promises.ts";
import type { AnyGuarantee, JudgeFn, JudgeRuling, Violation } from "./types.ts";

export type Verdict = {
  decision: "delivered" | "rejected";
  /** One line for humans and agents: why this decision. */
  summary: string;
  rules: { passed: boolean; violations: Violation[] };
  judge: JudgeRuling | { status: "skipped"; reasoning: string };
  decidedAt: number;
};

/**
 * Schema first, then the service's rules, then the AI judge. A rule violation is final
 * and skips the (slower, paid) judge. The judge only rejects on a positive breach
 * finding; when it abstains, the objective checks decide.
 */
export async function decide(
  g: AnyGuarantee,
  input: unknown,
  output: unknown,
  judge: JudgeFn,
  promises: Promise_[] = [],
): Promise<Verdict> {
  const violations = objectiveChecks(g, input, output, promises);
  const rules = { passed: violations.length === 0, violations };

  if (!rules.passed) {
    return {
      decision: "rejected",
      summary: `Failed ${violations.length} contract check(s): ${[...new Set(violations.map((v) => v.rule))].join(", ")}.`,
      rules,
      judge: { status: "skipped", reasoning: "Rule violations are final; judge not consulted." },
      decidedAt: Date.now(),
    };
  }

  const ruling = await judge(g, { input, output });
  const breached = ruling.status === "breach";
  return {
    decision: breached ? "rejected" : "delivered",
    summary: breached
      ? `AI judge found a breach: ${ruling.findings.join("; ") || ruling.reasoning}`
      : ruling.status === "upheld"
        ? "Passed every contract check and the AI judge confirmed the output."
        : "Passed every contract check.",
    rules,
    judge: ruling,
    decidedAt: Date.now(),
  };
}

export function objectiveChecks(g: AnyGuarantee, input: unknown, output: unknown, promises: Promise_[] = []): Violation[] {
  if (output === null || output === undefined) {
    return [{ rule: "non_empty", detail: "Service returned no output." }];
  }
  const parsed = g.output.safeParse(output);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      rule: "schema",
      detail: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    }));
  }
  // Built-in rules, then the seller's published promises (compiled from natural language).
  return [...g.rules(input, parsed.data), ...promises.flatMap((p) => evaluatePromise(p, input, parsed.data))];
}
