import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Verdict } from "./verdict.ts";

/**
 * Proof-Carrying Payments certificate: binds the promise (contract hash + version),
 * the evidence (input/output hashes, rule results, judge outcome) and the decision,
 * signed with the server's Ed25519 key so anyone can verify it with the public key.
 *
 * What it proves: this server evaluated exactly this output against exactly this
 * contract version and reached this decision. What it doesn't prove: that the
 * output is true, or that a seller couldn't settle a payment outside Tribunal.
 */
export const CERTIFICATE_SCHEMA = "tribunal.certificate/v1";

export const VALIDATOR_VERSION: string = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export type SettlementStatus = "not_attempted" | "pending" | "settled" | "failed";

export type Certificate = {
  schema: typeof CERTIFICATE_SCHEMA;
  case_id: string;
  service: string;
  contract: { version: string; hash: string };
  validator_version: string;
  input_hash: string;
  evaluated_output_hash: string;
  rules: { passed: boolean; violations: { rule: string; detail: string }[] };
  judge: { used: boolean; status: string };
  decision: Verdict["decision"];
  reason: string;
  /**
   * Binds the certificate to one payment: ref is the hash of the signed x402 authorization
   * (which includes the EIP-3009 nonce), so a certificate can't be replayed for another payment.
   */
  payment: { via: "x402" | "voucher"; payer: string | null; ref: string | null; nonce: string | null };
  issued_at: string;
};

/** Deterministic JSON: object keys sorted at every level, so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

// ---------- Signing ----------

/** Ed25519 key derived from the server secret, so it survives restarts without extra config. */
export class Signer {
  private readonly privateKey: KeyObject;
  readonly publicKeyPem: string;

  constructor(secret: string) {
    const seed = createHash("sha256").update(`tribunal-signing:${secret}`).digest();
    // PKCS#8 wrapper for a raw 32-byte Ed25519 seed.
    const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
    this.privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    this.publicKeyPem = createPublicKey(this.privateKey).export({ type: "spki", format: "pem" }).toString();
  }

  sign(certificate: Certificate): string {
    return sign(null, Buffer.from(canonicalJson(certificate)), this.privateKey).toString("base64");
  }
}

/** Anyone can run this with the published public key. */
export function verifyCertificate(certificate: Certificate, signature: string, publicKeyPem: string): boolean {
  try {
    return verify(null, Buffer.from(canonicalJson(certificate)), publicKeyPem, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function buildCertificate(args: {
  caseId: string;
  service: string;
  contract: { version: string; hash: string };
  input: unknown;
  output: unknown;
  verdict: Verdict;
  via: "x402" | "voucher";
  payer: string | null;
  paymentRef?: string | null;
  paymentNonce?: string | null;
}): Certificate {
  const { verdict } = args;
  return {
    schema: CERTIFICATE_SCHEMA,
    case_id: args.caseId,
    service: args.service,
    contract: args.contract,
    validator_version: VALIDATOR_VERSION,
    input_hash: sha256(args.input),
    evaluated_output_hash: sha256(args.output ?? null),
    rules: verdict.rules,
    judge: { used: verdict.judge.status !== "skipped" && verdict.judge.status !== "abstained", status: verdict.judge.status },
    decision: verdict.decision,
    reason: verdict.summary,
    payment: { via: args.via, payer: args.payer, ref: args.paymentRef ? `sha256:${args.paymentRef}` : null, nonce: args.paymentNonce ?? null },
    issued_at: new Date(verdict.decidedAt).toISOString(),
  };
}
