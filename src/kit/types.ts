import type { z } from "zod";
import type { CrashCase } from "./crashtest.ts";

export type Violation = { rule: string; detail: string };

export type JudgeRuling =
  | { status: "upheld" | "breach"; reasoning: string; findings: string[] }
  | { status: "abstained"; reasoning: string };

/**
 * A guaranteed service: what it costs, what it promises, how the promise is checked,
 * and the work itself. The kit turns one of these into a paid x402 endpoint that only
 * settles when the output keeps every promise.
 */
export type Guarantee<I, O> = {
  /** URL segment: the service is served at POST /<id> and documented at GET /<id>/contract. */
  id: string;
  /** Contract version. Bump it whenever the promise changes; each case records the version it was judged under. */
  version?: string;
  title: string;
  description: string;
  /** x402 price, e.g. "$0.01". */
  price: string;
  input: z.ZodType<I>;
  /** Output schema. Checked by the kit before any rule runs. */
  output: z.ZodType<O>;
  /** Human-readable promises, published in the contract. */
  guarantees: string[];
  /** Objective checks, run only after the output matched the schema. Return [] when all pass. */
  rules: (input: I, output: O) => Violation[];
  /** Optional AI judge for what rules can't express. Evidence is treated as data, never instructions. */
  judge?: {
    instructions: string;
    evidence: (input: I, output: unknown) => string;
  };
  /** The work. May return anything: the contract decides whether it counts as delivered. */
  run: (input: I, opts: { fault?: string }) => Promise<unknown>;
  /** A known-good request and response, used to prefill the public challenge form. */
  sample?: { input: I; output: O };
  /** Crash Test suite: attacks with their expected outcome, fixed before they run. */
  crashSuite?: CrashCase[];
  /** Fault names accepted on the x-demo-fault header when DEMO_FAULTS=1. */
  faults?: readonly string[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGuarantee = Guarantee<any, any>;

/** Identity helper so input/output types are inferred from the schemas. */
export function defineGuarantee<I, O>(g: Guarantee<I, O>): Guarantee<I, O> {
  return g;
}

export type JudgeFn = (
  g: AnyGuarantee,
  args: { input: unknown; output: unknown; complaint?: string },
) => Promise<JudgeRuling>;
