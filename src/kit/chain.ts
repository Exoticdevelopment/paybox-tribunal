import { createPublicClient, http, parseAbi } from "viem";
import { base, baseSepolia } from "viem/chains";

/**
 * On-chain truth for reconciliation and the fraud detector: did this buyer's signed payment
 * actually move money? This is how Tribunal avoids assuming a timeout means "not charged"
 * (x402 issue #1062), and how it catches a seller settling a rejected payment.
 *
 * - Base (EIP-3009): `nonce` is the authorization nonce; USDC's authorizationState says if it was used.
 * - Solana (exact SVM): `nonce` is the buyer's signature on the payment transaction. A settled
 *   transaction carries that exact signature, so we look for it among the buyer's recent transactions.
 */
export type ChainReader = {
  authorizationUsed(args: { network: string; asset: string; payer: string; nonce: string; since?: number }): Promise<boolean>;
};

const CHAINS: Record<string, typeof base | typeof baseSepolia> = { "eip155:8453": base, "eip155:84532": baseSepolia };
const abi = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);

const SOLANA_RPC: Record<string, string> = {
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": process.env.SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com",
};

type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Public RPCs rate-limit bursts: space calls out and back off on 429s. A call that still fails
 * throws, and the audit leaves the case pending for the next run: it never clears a case on an error.
 */
const rpc = (url: string): RpcCall => {
  let last = 0;
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + 300 - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))) as { result?: unknown; error?: { message: string } };
      const limited = res.status === 429 || /too many requests/i.test(body.error?.message ?? "");
      if (limited && attempt < 4) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (body.error) throw new Error(`Solana RPC ${method}: ${body.error.message}`);
      return body.result;
    }
  };
};

/**
 * True if any transaction involving the buyer since `since` carries the buyer's payment signature.
 * Solana transactions expire with their blockhash (about a minute), so a check after that is final.
 */
export async function solanaSignatureUsed(call: RpcCall, payer: string, signature: string, since?: number): Promise<boolean> {
  const recent = (await call("getSignaturesForAddress", [payer, { limit: 50 }])) as { signature: string; blockTime: number | null; err: unknown }[];
  const window = since ? Math.floor(since / 1000) - 120 : 0;
  for (const entry of recent) {
    if (entry.blockTime !== null && entry.blockTime < window) break; // newest first: older ones can't be it
    if (entry.err) continue;
    if (entry.signature === signature) return true;
    const tx = (await call("getTransaction", [entry.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }])) as {
      transaction?: { signatures?: string[] };
    } | null;
    if (tx?.transaction?.signatures?.includes(signature)) return true;
  }
  return false;
}

// One rate-limited client per endpoint, shared by every audit.
const clients = new Map<string, RpcCall>();
const rpcFor = (url: string) => clients.get(url) ?? clients.set(url, rpc(url)).get(url)!;

export const viemChainReader: ChainReader = {
  async authorizationUsed({ network, asset, payer, nonce, since }) {
    if (network.startsWith("solana:")) {
      const url = SOLANA_RPC[network];
      if (!url) throw new Error(`No RPC configured for ${network}`);
      return solanaSignatureUsed(rpcFor(url), payer, nonce, since);
    }
    const chain = CHAINS[network];
    if (!chain) throw new Error(`No RPC configured for ${network}`);
    const client = createPublicClient({ chain, transport: http() });
    return client.readContract({
      address: asset as `0x${string}`,
      abi,
      functionName: "authorizationState",
      args: [payer as `0x${string}`, nonce as `0x${string}`],
    });
  },
};
