import { createHash } from "node:crypto";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { objectSchema, type RedditObject } from "./adapter";
import { notePlatformWrite } from "@/services/channels/write-fence";

export type Operation = { step: string; state: "running" | "complete" | "failed" | "unknown"; result: unknown; request_hash: string; request: Record<string, unknown>; created_at?: string | null };
export interface OperationStore {
  read(step: string): Promise<Operation | null>;
  list(): Promise<Operation[]>;
  claim(step: string, request: Record<string, unknown>): Promise<boolean>;
  save(step: string, state: Operation["state"], result: unknown): Promise<void>;
}
export const CORRECTABLE_CODES = ["reddit_ads_invalid_request", "reddit_ads_retained_object_archived"];
export const CORRECT_PLAN_STEP = "Do not retry this unchanged. Correct the plan and propose it again with a new operation key. Objects already created stay paused in Reddit; archive them in Reddit Ads Manager if they are not needed.";
export function requestHash(request: Record<string, unknown>): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(request))).digest("hex");
}
export function operationStore(tenantId: string, key: string, actionId: string): OperationStore {
  const db = tenantClient(asTenantId(tenantId));
  return {
    async read(step) {
      const { data, error } = await db.from("reddit_ad_operations").select("step,state,result,request_hash,request,created_at").eq("operation_key", key).eq("step", step).maybeSingle();
      if (error) throw new Error(`Reddit operation read failed: ${error.message}`);
      return data as Operation | null;
    },
    async list() {
      const { data, error } = await db.from("reddit_ad_operations").select("step,state,result,request_hash,request").eq("operation_key", key).order("created_at");
      if (error) throw new Error(`Reddit operation read failed: ${error.message}`);
      return (data ?? []) as Operation[];
    },
    async claim(step, request) {
      const { error } = await db.from("reddit_ad_operations").insert({ operation_key: key, step, action_id: actionId, state: "running", request_hash: requestHash(request), request });
      if (!error) return true;
      if (error.code !== "23505") throw new Error(`Reddit operation claim failed: ${error.message}`);
      const retry = await db.from("reddit_ad_operations").update({ state: "running", result: null, updated_at: new Date().toISOString() }).eq("operation_key", key).eq("step", step).eq("state", "failed").eq("request_hash", requestHash(request)).select("step");
      if (retry.error) throw new Error(`Reddit operation retry claim failed: ${retry.error.message}`);
      return !!retry.data?.length;
    },
    async save(step, state, result) {
      const { error } = await db.from("reddit_ad_operations").update({ state, result, updated_at: new Date().toISOString() }).eq("operation_key", key).eq("step", step);
      if (error) throw new ExpectedToolError("reddit_ads_outcome_unknown", "The external result could not be persisted. Reconcile before retrying.");
    },
  };
}
export async function durableStep(store: OperationStore, step: string, request: Record<string, unknown>, create: () => Promise<RedditObject>, reconcile: () => Promise<RedditObject | null>): Promise<RedditObject> {
  const claimed = await store.claim(step, request);
  if (!claimed) {
    notePlatformWrite();
    const prior = await store.read(step);
    if (!prior || prior.request_hash !== requestHash(request)) throw new ExpectedToolError("reddit_ads_operation_conflict", "The operation key already belongs to a different request. Use its original plan or start a new operation after review.");
    if (prior.state === "complete") return objectSchema.parse(prior.result);
    const found = await reconcile();
    if (found) { await store.save(step, "complete", found); return found; }
    throw new ExpectedToolError("reddit_ads_outcome_unknown", "A previous step may have reached Reddit. No duplicate was created. Review the account and reconcile this operation before continuing.", { step });
  }
  try {
    const result = await create();
    await store.save(step, "complete", result);
    return result;
  } catch (e) {
    const unknown = !(e instanceof ExpectedToolError) || e.code === "reddit_ads_outcome_unknown";
    await store.save(step, unknown ? "unknown" : "failed", { error: e instanceof Error ? e.message : "Write failed", ...(e instanceof ExpectedToolError ? { code: e.code } : {}) });
    throw e;
  }
}
