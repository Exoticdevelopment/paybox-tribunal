import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db, Voucher } from "../store/db.ts";

const VOUCHER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Credits are bearer tokens (`<id>.<hmac>`), not balances keyed by address: anyone can
 * see a wallet address, so an address alone must never unlock a free call.
 * Each credit is valid only on the service whose result was faulty.
 */
export class Vouchers {
  private readonly db: Db;
  private readonly secret: string;

  constructor(db: Db, secret: string) {
    this.db = db;
    this.secret = secret;
  }

  private sign(id: string) {
    return createHmac("sha256", this.secret).update(id).digest("base64url");
  }

  issue(caseId: string, service: string, payer: string | null): { voucher: Voucher; token: string } {
    const now = Date.now();
    const voucher: Voucher = {
      id: randomUUID(),
      caseId,
      service,
      payer,
      issuedAt: now,
      expiresAt: now + VOUCHER_TTL_MS,
      reservedBy: null,
      redeemedBy: null,
    };
    this.db.saveVoucher(voucher);
    return { voucher, token: `${voucher.id}.${this.sign(voucher.id)}` };
  }

  /** Validates a token and locks the voucher to one in-flight attempt. */
  reserve(
    token: string,
    service: string,
    attemptCaseId: string,
  ): { ok: true; voucher: Voucher } | { ok: false; reason: string } {
    const [id, sig] = token.split(".");
    if (!id || !sig) return { ok: false, reason: "malformed voucher" };

    const expected = Buffer.from(this.sign(id));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return { ok: false, reason: "invalid voucher signature" };
    }

    const voucher = this.db.getVoucher(id);
    if (!voucher) return { ok: false, reason: "unknown voucher" };
    if (voucher.service !== service) return { ok: false, reason: `voucher is for the ${voucher.service} service` };
    if (voucher.redeemedBy) return { ok: false, reason: "voucher already redeemed" };
    if (voucher.reservedBy) return { ok: false, reason: "voucher in use by another request" };
    if (Date.now() > voucher.expiresAt) return { ok: false, reason: "voucher expired" };

    voucher.reservedBy = attemptCaseId;
    this.db.saveVoucher(voucher);
    return { ok: true, voucher };
  }

  /** The free attempt delivered: the credit is spent. */
  commit(voucher: Voucher, caseId: string) {
    voucher.reservedBy = null;
    voucher.redeemedBy = caseId;
    this.db.saveVoucher(voucher);
  }

  /** The free attempt was rejected too: give the credit back. */
  release(voucher: Voucher) {
    voucher.reservedBy = null;
    this.db.saveVoucher(voucher);
  }
}
