import { createHash } from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";

/** Same key from the request header and from the settlement hook's paymentPayload. */
export function paymentKey(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** What we can learn from a signed x402 payment, enough to reconcile it on-chain later. */
export type PaymentInfo = {
  payer: string | null;
  key: string | null;
  nonce: string | null;
  /** Token contract and CAIP-2 network the authorization is for. */
  asset: string | null;
  network: string | null;
  /** Unix seconds after which the authorization can never settle. */
  validBefore: number | null;
};

export const NO_PAYMENT: PaymentInfo = { payer: null, key: null, nonce: null, asset: null, network: null, validBefore: null };

/**
 * Reads the payer, nonce and limits from the signed payment header. The middleware has
 * already verified the signature by the time the handler runs; this only extracts fields.
 */
export function readPayment(header: string | undefined): PaymentInfo {
  if (!header) return NO_PAYMENT;
  try {
    const decoded = decodePaymentSignatureHeader(header);
    type Auth = { from?: string; nonce?: string; validBefore?: string | number };
    const inner = decoded.payload as { authorization?: Auth; permit2Authorization?: Auth };
    const auth = inner.authorization ?? inner.permit2Authorization;
    const accepted = decoded.accepted as { asset?: string; network?: string } | undefined;
    return {
      payer: auth?.from ?? null,
      key: paymentKey(decoded.payload),
      nonce: auth?.nonce ?? null,
      asset: accepted?.asset ?? null,
      network: accepted?.network ?? null,
      validBefore: auth?.validBefore !== undefined ? Number(auth.validBefore) : null,
    };
  } catch {
    return NO_PAYMENT;
  }
}
