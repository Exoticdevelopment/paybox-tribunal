import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Verdict } from "../kit/verdict.ts";
import type { JudgeRuling } from "../kit/types.ts";
import type { Certificate } from "../kit/certificate.ts";
import type { Compiled } from "../kit/compiler.ts";
import type { Promise_ } from "../kit/promises.ts";
import type { PaymentInfo } from "../payment.ts";
import type { ProxyDef } from "../kit/proxy.ts";

/** One step in a payment's life. Settlement and quality are tracked separately, never conflated. */
export type PaymentEvent = {
  state: "authorized" | "voucher" | "judged" | "not_charged" | "settling" | "settled" | "settle_failed" | "reconciled_settled" | "expired_unsettled" | "settled_despite_rejection";
  at: number;
  note: string;
};

export type Case = {
  id: string;
  /** Guarantee id the case belongs to (e.g. "invoice"). */
  service: string;
  createdAt: number;
  /** Paying wallet, when known (x402 payer or the voucher's original payer). */
  payer: string | null;
  via: "x402" | "voucher";
  /** Stable hash of the signed payment, used to match the settlement hook to this case. */
  paymentKey: string | null;
  /** Fields of the signed payment needed to reconcile it on-chain (absent on vouchers and old cases). */
  payment?: PaymentInfo;
  /** Client-chosen key: a retry with the same key gets this case's response back instead of paying again. */
  idempotencyKey?: string | null;
  response?: { status: number; body: unknown };
  /** Payment timeline: authorized → judged → not_charged | settling → settled | settle_failed → reconciled. */
  events?: PaymentEvent[];
  input: unknown;
  output: unknown;
  verdict: Verdict;
  /** Seller promises in force when this case was judged (appeals use these, never newer ones). */
  promises?: Promise_[];
  /** Signed Proof-Carrying Payments certificate, issued at decision time. */
  certificate: Certificate;
  signature: string;
  /** Filled in by the settlement hook once funds actually move. */
  settlement: { transaction: string; network: string; at: number } | null;
  /** The output passed but settlement failed: kept apart from quality rejections. */
  settlementFailure: { reason: string; at: number } | null;
  /** Set when the chain shows a REJECTED case's authorization was used anyway: the seller settled outside Tribunal. */
  fraud?: { detectedAt: number; note: string } | null;
  appeal: Appeal | null;
};

export type Appeal = {
  filedAt: number;
  complaint: string;
  ruling: JudgeRuling;
  voucherId: string | null;
};

export type Voucher = {
  id: string;
  caseId: string;
  service: string;
  payer: string | null;
  issuedAt: number;
  expiresAt: number;
  /** Case currently using this voucher; cleared if that attempt is rejected. */
  reservedBy: string | null;
  redeemedBy: string | null;
};

/** A compiled set of seller promises awaiting confirmation. */
export type PromiseDraft = { id: string; service: string; text: string; compiled: Compiled; createdAt: number };

/** A published, immutable set of seller promises. Each publish is a new contract version. */
export type PromiseSet = { version: string; text: string; compiled: Compiled; publishedAt: number; draftId: string };

/** A public attempt to break a service's guarantee. Stores the verdict, never the submitted payload. */
export type Challenge = {
  id: string;
  service: string;
  at: number;
  contractVersion: string;
  note: string;
  caught: boolean;
  rulesHit: string[];
  judge: string;
  summary: string;
};

type Data = {
  proxies: Record<string, ProxyDef>;
  cases: Record<string, Case>;
  challenges: Record<string, Challenge[]>;
  vouchers: Record<string, Voucher>;
  drafts: Record<string, PromiseDraft>;
  promiseSets: Record<string, PromiseSet[]>;
};

/**
 * Single-file JSON store. Plenty for a hackathon demo and keeps the audit trail
 * human-readable; swap for SQLite/Postgres before real traffic.
 */
export class Db {
  private data: Data;
  private readonly file: string;

  /**
   * @param evidenceFile Real cases committed to the repo (inputs and outputs redacted). They are restored on
   * every boot, so the public record survives redeploys on hosts with an ephemeral disk.
   */
  constructor(file: string, evidenceFile?: string) {
    this.file = file;
    const loaded: Partial<Data> = file !== ":memory:" && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    this.data = { cases: {}, vouchers: {}, drafts: {}, promiseSets: {}, challenges: {}, proxies: {}, ...loaded };
    if (evidenceFile && existsSync(evidenceFile)) {
      for (const c of JSON.parse(readFileSync(evidenceFile, "utf8")) as Case[]) this.data.cases[c.id] ??= c;
    }
  }

  private flush() {
    if (this.file === ":memory:") return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  saveCase(c: Case) {
    this.data.cases[c.id] = c;
    this.flush();
  }

  getCase(id: string): Case | undefined {
    return this.data.cases[id];
  }

  findCaseByIdempotencyKey(service: string, key: string): Case | undefined {
    return Object.values(this.data.cases).find((c) => c.service === service && c.idempotencyKey === key);
  }

  findCaseByPaymentKey(key: string): Case | undefined {
    return Object.values(this.data.cases).find((c) => c.paymentKey === key);
  }

  allCases(): Case[] {
    return Object.values(this.data.cases);
  }

  saveVoucher(v: Voucher) {
    this.data.vouchers[v.id] = v;
    this.flush();
  }

  getVoucher(id: string): Voucher | undefined {
    return this.data.vouchers[id];
  }

  saveDraft(d: PromiseDraft) {
    this.data.drafts[d.id] = d;
    this.flush();
  }

  getDraft(id: string): PromiseDraft | undefined {
    return this.data.drafts[id];
  }

  publishPromises(service: string, set: PromiseSet) {
    (this.data.promiseSets[service] ??= []).push(set);
    this.flush();
  }

  promiseHistory(service: string): PromiseSet[] {
    return this.data.promiseSets[service] ?? [];
  }

  saveChallenge(c: Challenge) {
    (this.data.challenges[c.service] ??= []).push(c);
    this.flush();
  }

  challengesFor(service: string): Challenge[] {
    return this.data.challenges[service] ?? [];
  }

  saveProxy(p: ProxyDef) {
    this.data.proxies[p.id] = p;
    this.flush();
  }

  getProxy(id: string): ProxyDef | undefined {
    return this.data.proxies[id];
  }

  activeProxies(): ProxyDef[] {
    return Object.values(this.data.proxies).filter((p) => p.active);
  }

  vouchersFor(payer: string): Voucher[] {
    const p = payer.toLowerCase();
    return Object.values(this.data.vouchers).filter((v) => v.payer?.toLowerCase() === p);
  }
}
