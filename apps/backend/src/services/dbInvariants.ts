
import { serviceClient } from "./supabase";

const OK_TTL_MS = 60_000;
const FAIL_TTL_MS = 10_000;
const HEALTH_RPC_TIMEOUT_MS = 3_000;
const READY_TTL_MS = 5_000;

let cache: { ok: boolean; reason: string; at: number } | null = null;

export interface InvariantResult {
  ok: boolean;
  reason: string;
}

export async function checkSchemaInvariants(): Promise<InvariantResult> {
  if (cache && Date.now() - cache.at < (cache.ok ? OK_TTL_MS : FAIL_TTL_MS)) {
    return { ok: cache.ok, reason: cache.reason };
  }

  let ok = false;
  let reason = "ok";
  try {
    const { data, error } = await serviceClient()
      .rpc("schema_invariants_ok")
      .abortSignal(AbortSignal.timeout(HEALTH_RPC_TIMEOUT_MS));
    if (error) {
      ok = false;
      reason = `rpc_error: ${error.message}`;
    } else if (data === true) {
      ok = true;
      reason = "ok";
    } else {
      ok = false;
      reason =
        "schema_invariant_absent: a recorded migration's DDL did not persist " +
        "(memory_note_note_type_check / growth decision_classes). Repair the " +
        "migration before this build serves traffic.";
    }
  } catch (e) {
    ok = false;
    reason = `exception: ${e instanceof Error ? e.message : String(e)}`;
  }

  cache = { ok, reason, at: Date.now() };
  return { ok, reason };
}

export function _resetSchemaInvariantCache(): void {
  cache = null;
  ready = null;
}

export type DbReachability = { db: "up" } | { db: "down"; reason: string };
let ready: { at: number; value: DbReachability } | null = null;

export async function checkDbReachable(): Promise<DbReachability> {
  if (ready && Date.now() - ready.at < READY_TTL_MS) return ready.value;
  let value: DbReachability;
  try {
    const { error } = await serviceClient()
      .from("tenants")
      .select("id")
      .limit(1)
      .abortSignal(AbortSignal.timeout(2_000));
    value = error ? { db: "down", reason: error.message } : { db: "up" };
  } catch (e) {
    value = { db: "down", reason: e instanceof Error ? e.message : String(e) };
  }
  ready = { at: Date.now(), value };
  return value;
}
