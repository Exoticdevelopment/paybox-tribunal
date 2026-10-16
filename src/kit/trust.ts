import type { Case } from "../store/db.ts";

/**
 * Lower bound of the Wilson score interval: a pass rate that stays honest with few
 * samples (3/3 scores lower than 300/300).
 */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total === 0) return 0;
  const p = successes / total;
  const z2 = z * z;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return (centre - margin) / (1 + z2 / total);
}

export function trustReport(cases: Case[]) {
  const total = cases.length;
  const delivered = cases.filter((c) => c.verdict.decision === "delivered");
  const appeals = cases.filter((c) => c.appeal);
  const overturned = appeals.filter((c) => c.appeal?.ruling.status === "breach").length;
  // A delivery only counts as good if it was not later overturned on appeal.
  const good = delivered.length - overturned;
  // A seller caught settling a rejected payment loses all trust: that is the one thing Tribunal exists to prevent.
  const fraud = cases.filter((c) => c.fraud).length;

  return {
    score: fraud ? 0 : Math.round(wilsonLowerBound(good, total) * 100),
    attempts: total,
    delivered: delivered.length,
    rejectedBeforeCharge: total - delivered.length,
    settled: cases.filter((c) => c.settlement).length,
    appeals: appeals.length,
    appealsUpheldForBuyer: overturned,
    /** Paid results later found faulty. The number buyers care about most. */
    chargedFailures: overturned + fraud,
    /** Rejected results the seller settled anyway, proven on-chain. */
    settledDespiteRejection: fraud,
    lastVerdictAt: cases.reduce((max, c) => Math.max(max, c.verdict.decidedAt), 0) || null,
  };
}

export const TRUST_METHOD =
  "Wilson lower bound (95%) of deliveries not overturned on appeal, over every judged attempt. Computed from real transactions, not probes.";
