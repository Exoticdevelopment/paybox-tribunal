import type { MiddlewareHandler } from "hono";
import { claudeJudge } from "./kit/judge.ts";
import { createTribunal } from "./kit/tribunal.ts";
import type { JudgeFn } from "./kit/types.ts";
import type { ChainReader } from "./kit/chain.ts";
import { services } from "./services/index.ts";
import type { Db } from "./store/db.ts";

export type AppDeps = {
  db: Db;
  /** x402 payment middleware. Injected so tests can run without a facilitator. */
  paywall: MiddlewareHandler;
  /** AI judge. Defaults to Claude through the configured LLM backend. */
  judge?: JudgeFn;
  /** On-chain reads for reconciliation. Defaults to public RPCs. */
  chain?: ChainReader;
};

export function createApp({ db, paywall, judge = claudeJudge, chain }: AppDeps) {
  return createTribunal({ db, guarantees: services, paywall, judge, chain });
}
