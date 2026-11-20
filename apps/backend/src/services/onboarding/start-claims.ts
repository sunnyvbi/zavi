
import type { SupabaseClient } from "@supabase/supabase-js";

const START_CLAIM_STALE_MS = 10 * 60 * 1000;

export type StartClaim =
  | { kind: "owned"; token: string }
  | { kind: "replay"; tenant_id: string; conductor_run_id: string | null }
  | { kind: "busy"; stale: boolean; tenant_id: string | null }
  | { kind: "unavailable" };

type ClaimRow = { tenant_id: string | null; conductor_run_id: string | null; created_at: string | null };

async function tenantCreatedSince(sb: SupabaseClient, user_id: string, since: string): Promise<string | null> {
  const { data: links, error } = await sb.from("tenant_users").select("tenant_id").eq("user_id", user_id);
  if (error) throw new Error(error.message);
  const ids = ((links ?? []) as Array<{ tenant_id?: unknown }>).map((l) => l.tenant_id).filter((v): v is string => typeof v === "string");
  if (!ids.length) return null;
  const { data: rows, error: tErr } = await sb
    .from("tenants")
    .select("id")
    .in("id", ids)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  if (tErr) throw new Error(tErr.message);
  const id = ((rows ?? []) as Array<{ id?: unknown }>)[0]?.id;
  return typeof id === "string" && id ? id : null;
}

export async function claimStart(
  sb: SupabaseClient,
  user_id: string,
  key: string,
  { runRequired = true }: { runRequired?: boolean } = {},
): Promise<StartClaim> {
  try {
    const claimedAt = new Date().toISOString();
    const { error: insErr } = await sb.from("build_start_claims").insert({ user_id, idem_key: key, created_at: claimedAt });
    if (!insErr) return { kind: "owned", token: claimedAt };
    if ((insErr as { code?: string }).code !== "23505") throw new Error(insErr.message);
    const { data, error } = await sb
      .from("build_start_claims")
      .select("tenant_id, conductor_run_id, created_at")
      .eq("user_id", user_id)
      .eq("idem_key", key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as ClaimRow | null;
    if (!row) return { kind: "busy", stale: false, tenant_id: null };
    if (row.tenant_id && (row.conductor_run_id || !runRequired)) {
      return { kind: "replay", tenant_id: row.tenant_id, conductor_run_id: row.conductor_run_id };
    }
    const at = row.created_at ? Date.parse(row.created_at) : NaN;
    const stale = Number.isFinite(at) && Date.now() - at > START_CLAIM_STALE_MS;
    if (!row.tenant_id && !stale) return { kind: "busy", stale: false, tenant_id: null };
    const tenant_id = row.tenant_id ?? (row.created_at ? await tenantCreatedSince(sb, user_id, row.created_at) : null);
    if (tenant_id && !runRequired) {
      if (row.created_at) await recordStartClaim(sb, user_id, key, row.created_at, { tenant_id });
      return { kind: "replay", tenant_id, conductor_run_id: null };
    }
    if (tenant_id) {
      const { data: run, error: runErr } = await sb
        .from("conductor_runs")
        .select("id")
        .eq("tenant_id", tenant_id)
        .eq("request_key", key)
        .maybeSingle();
      if (runErr) throw new Error(runErr.message);
      const run_id = (run as { id?: unknown } | null)?.id;
      if (row.created_at) {
        await recordStartClaim(sb, user_id, key, row.created_at, {
          tenant_id,
          ...(typeof run_id === "string" && run_id ? { conductor_run_id: run_id } : {}),
        });
      }
      if (typeof run_id === "string" && run_id) return { kind: "replay", tenant_id, conductor_run_id: run_id };
      return { kind: "busy", stale, tenant_id };
    }
    const { data: taken, error: takeErr } = await sb
      .from("build_start_claims")
      .update({ created_at: claimedAt })
      .eq("user_id", user_id)
      .eq("idem_key", key)
      .is("tenant_id", null)
      .eq("created_at", row.created_at)
      .select("idem_key");
    if (takeErr) throw new Error(takeErr.message);
    return Array.isArray(taken) && taken.length === 1
      ? { kind: "owned", token: claimedAt }
      : { kind: "busy", stale: false, tenant_id: null };
  } catch (e) {
    console.warn(`[start-claims] claim failed: ${(e as Error)?.message ?? e}`);
    return { kind: "unavailable" };
  }
}

export async function recordStartClaim(
  sb: SupabaseClient,
  user_id: string,
  key: string,
  token: string,
  patch: { tenant_id: string; conductor_run_id?: string },
): Promise<boolean> {
  try {
    const { data, error } = await sb
      .from("build_start_claims")
      .update(patch)
      .eq("user_id", user_id)
      .eq("idem_key", key)
      .eq("created_at", token)
      .select("idem_key");
    if (error) {
      console.warn(`[start-claims] claim record failed: ${error.message}`);
      return false;
    }
    return Array.isArray(data) && data.length === 1;
  } catch (e) {
    console.warn(`[start-claims] claim record failed: ${(e as Error)?.message ?? e}`);
    return false;
  }
}

export async function releaseStartClaim(sb: SupabaseClient, user_id: string, key: string, token: string): Promise<void> {
  try {
    await sb
      .from("build_start_claims")
      .delete()
      .eq("user_id", user_id)
      .eq("idem_key", key)
      .eq("created_at", token)
      .is("tenant_id", null);
  } catch {
  }
}

export async function waitForClaimedTenant(
  sb: SupabaseClient,
  user_id: string,
  key: string,
  { timeoutMs = 10_000, stepMs = 500 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, stepMs));
    const { data, error } = await sb
      .from("build_start_claims")
      .select("tenant_id")
      .eq("user_id", user_id)
      .eq("idem_key", key)
      .maybeSingle();
    if (error || !data) return null;
    const tenant_id = (data as { tenant_id?: unknown }).tenant_id;
    if (typeof tenant_id === "string" && tenant_id) return tenant_id;
  }
  return null;
}
