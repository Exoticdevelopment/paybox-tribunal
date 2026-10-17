import { createHash } from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { getBase58Decoder, getBase64Encoder, getTransactionDecoder } from "@solana/kit";

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
    const accepted = decoded.accepted as { asset?: string; network?: string; maxTimeoutSeconds?: number } | undefined;
    const solana = typeof (decoded.payload as { transaction?: unknown }).transaction === "string" ? solanaSigner((decoded.payload as { transaction: string }).transaction) : null;
    if (solana) {
      // Solana (exact SVM): the buyer signs a transaction the facilitator completes and pays fees for.
      // The buyer's signature identifies it on-chain; it can't land after its blockhash expires.
      return {
        payer: solana.payer,
        key: paymentKey(decoded.payload),
        nonce: solana.signature,
        asset: accepted?.asset ?? null,
        network: accepted?.network ?? null,
        validBefore: Math.floor(Date.now() / 1000) + (accepted?.maxTimeoutSeconds ?? 300),
      };
    }
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

/** The buyer of a partially signed Solana payment: the one signer whose signature is already present. */
export function solanaSigner(base64Transaction: string): { payer: string; signature: string } | null {
  try {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64Transaction));
    for (const [address, sig] of Object.entries(tx.signatures)) {
      if (sig && sig.some((b) => b !== 0)) return { payer: address, signature: getBase58Decoder().decode(sig) };
    }
  } catch {}
  return null;
}
