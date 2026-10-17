import { test } from "node:test";
import assert from "node:assert/strict";
import { getBase58Decoder, getBase64Decoder, getBase64Encoder, getTransactionDecoder, getTransactionEncoder, type SignatureBytes } from "@solana/kit";
import { solanaSigner } from "../src/payment.ts";
import { solanaSignatureUsed } from "../src/kit/chain.ts";

// An x402 exact-SVM payment PayBox built for Tribunal (fee payer = facilitator, second signer = buyer), unsigned.
const UNSIGNED =
  "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAIBBAiuSvoTsUMM2VLUoVj7WuikMgoNKJBPRUSP0pJxzfOCwvieiWGZh4q2GvWynlXDtahL9mmjMSZwzQUmkAzECpX6/R/V2yBd2UJvc4WFa1YDVyHPVGX+kkR2fJ1Z+JsdOCeK2L5JSjJOGF5efiyzicSdcZ634+ewcAWvqn6unRiDDgMGRm/lIRcy/+ytunLDm+e8jOW7xfcSayxDmzpAAAAABt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKnG+nrzvtutOj1l82qryXQxsbvkwtL24OR8pgIDRS9dYQVKU1qZKSEGTSTocWDaOHx8NbXdvJK7geQfqEBBBUSNfAnkxXfdwxkNtmy15PyU5ns98MUiddnxBsd62o4pc9kEBAAFAiBOAAAEAAkDAQAAAAAAAAAFBAIGAwEKDBAnAAAAAAAABgcAIDhlYzdkY2M0M2FkYWVlYWFkYzQ5YjMxZDk2Y2E0MGE5AA==";
const BUYER = "HjWKYL4iDtdPgJyiKkCZnrsBY56JUX45qLnoQMWpyrSV";

function signedByBuyer(): { b64: string; signature: string } {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(UNSIGNED));
  const sig = new Uint8Array(64).fill(7) as SignatureBytes;
  const signed = { ...tx, signatures: { ...tx.signatures, [BUYER]: sig } };
  return { b64: getBase64Decoder().decode(getTransactionEncoder().encode(signed)), signature: getBase58Decoder().decode(sig) };
}

test("the Solana buyer and their payment signature are read from the partially signed transaction", () => {
  const { b64, signature } = signedByBuyer();
  assert.deepEqual(solanaSigner(b64), { payer: BUYER, signature });
  assert.equal(solanaSigner(UNSIGNED), null, "nobody signed yet");
  assert.equal(solanaSigner("not a transaction"), null);
});

test("a settled Solana payment is found by the buyer's signature; an unused one is not", async () => {
  const since = Date.parse("2026-10-17T12:00:00Z");
  const t = since / 1000;
  const chainTxs: Record<string, string[]> = { feePayerSig1: ["feePayerSig1", "BUYER_SIG"], other: ["other", "x"] };
  const call = async (method: string, params: unknown[]) => {
    if (method === "getSignaturesForAddress") {
      return [
        { signature: "other", blockTime: t + 30, err: null },
        { signature: "feePayerSig1", blockTime: t + 10, err: null },
      ];
    }
    if (method === "getTransaction") return { transaction: { signatures: chainTxs[params[0] as string] } };
    throw new Error(method);
  };
  assert.equal(await solanaSignatureUsed(call, "buyer", "BUYER_SIG", since), true);
  assert.equal(await solanaSignatureUsed(call, "buyer", "NEVER_USED", since), false);
});

test("failed transactions and ones older than the case are ignored", async () => {
  const since = Date.parse("2026-10-17T12:00:00Z");
  const t = since / 1000;
  let fetched = 0;
  const call = async (method: string) => {
    if (method === "getSignaturesForAddress") {
      return [
        { signature: "failed", blockTime: t + 5, err: { InstructionError: [0, "x"] } },
        { signature: "ancient", blockTime: t - 3600, err: null },
      ];
    }
    fetched++;
    return { transaction: { signatures: ["ancient", "BUYER_SIG"] } };
  };
  assert.equal(await solanaSignatureUsed(call, "buyer", "BUYER_SIG", since), false);
  assert.equal(fetched, 0, "neither the failed nor the pre-case transaction is fetched");
});
