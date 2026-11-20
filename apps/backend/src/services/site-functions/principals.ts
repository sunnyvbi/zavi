
import type { KvStore } from "@/services/sites/host-record";
import { adminFunctions, type FunctionsSpec } from "./manifest";

export const fnPrincipalKey = (siteId: string) => `fnprincipal:${siteId}`;

export type FnKv = KvStore & { delete(key: string): Promise<void> };

export interface PrincipalPlan {
  adminFns: string[];
}

export function planPrincipals(spec: FunctionsSpec | null): PrincipalPlan {
  return { adminFns: spec ? adminFunctions(spec) : [] };
}

export async function putPrincipalRecord(kv: FnKv, shardRef: string, siteId: string, plan: PrincipalPlan): Promise<void> {
  await kv.put(fnPrincipalKey(siteId), JSON.stringify({ v: 1, shard_id: shardRef, admin_fns: [...plan.adminFns].sort() }));
}

export async function dropPrincipalRecord(kv: FnKv, siteId: string): Promise<void> {
  await kv.delete(fnPrincipalKey(siteId));
}
