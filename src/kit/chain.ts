import { createPublicClient, http, parseAbi } from "viem";
import { base, baseSepolia } from "viem/chains";

/**
 * On-chain truth for reconciliation. EIP-3009 tokens (USDC) expose authorizationState:
 * true once an authorization nonce has been used, i.e. the payment really settled.
 * This is how Tribunal avoids assuming a timeout means "not charged" (x402 issue #1062).
 */
export type ChainReader = {
  authorizationUsed(args: { network: string; asset: string; payer: string; nonce: string }): Promise<boolean>;
};

const CHAINS: Record<string, typeof base | typeof baseSepolia> = { "eip155:8453": base, "eip155:84532": baseSepolia };
const abi = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);

export const viemChainReader: ChainReader = {
  async authorizationUsed({ network, asset, payer, nonce }) {
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
