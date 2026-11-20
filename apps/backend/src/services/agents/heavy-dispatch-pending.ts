
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { tenantClient, asTenantId } from "@/services/tenant-client";

type Sb = Pick<SupabaseClient, "from">;

export const PENDING_TTL_MS = 30 * 60 * 1000;

export type HeavyConfirmPending = {
  nonce: string;
  target: string;
  intent: string;
  context: Record<string, unknown> | null;
  armed_run_id: string | null;
  user_id: string | null;
  est_credits: number;
  armed_at: string;
};

function client(tenant_id: string, sb?: Sb): Sb {
  return sb ?? (tenantClient(asTenantId(tenant_id)) as unknown as Sb);
}

export function parsePending(raw: unknown): HeavyConfirmPending | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.nonce !== "string" || !r.nonce) return null;
  if (typeof r.target !== "string" || !r.target) return null;
  if (typeof r.intent !== "string" || !r.intent) return null;
  if (typeof r.armed_at !== "string") return null;
  return {
    nonce: r.nonce,
    target: r.target,
    intent: r.intent,
    context:
      r.context && typeof r.context === "object" ? (r.context as Record<string, unknown>) : null,
    armed_run_id: typeof r.armed_run_id === "string" ? r.armed_run_id : null,
    user_id: typeof r.user_id === "string" ? r.user_id : null,
    est_credits: typeof r.est_credits === "number" ? r.est_credits : 0,
    armed_at: r.armed_at,
  };
}

export function isFreshPending(p: HeavyConfirmPending, nowMs: number = Date.now()): boolean {
  const t = new Date(p.armed_at).getTime();
  return Number.isFinite(t) && nowMs - t <= PENDING_TTL_MS;
}

export function pendingExpiresAt(p: HeavyConfirmPending): string {
  return new Date(new Date(p.armed_at).getTime() + PENDING_TTL_MS).toISOString();
}

export async function readHeavyDispatchPending(
  params: { tenant_id: string; thread_id: string },
  sb?: Sb,
): Promise<HeavyConfirmPending | null> {
  try {
    const { data, error } = await client(params.tenant_id, sb)
      .from("agent_threads")
      .select("heavy_confirm_pending")
      .eq("id", params.thread_id)
      .eq("tenant_id", params.tenant_id)
      .maybeSingle();
    if (error || !data) return null;
    return parsePending((data as { heavy_confirm_pending?: unknown }).heavy_confirm_pending);
  } catch {
    return null;
  }
}

export async function findBuildConfirmCardRow(
  tenant_id: string,
  thread_id: string,
  nonce: string,
  sb?: Sb,
): Promise<{ id: string; meta: Record<string, unknown> } | null> {
  const { data } = await client(tenant_id, sb)
    .from("agent_thread_messages")
    .select("id, meta")
    .eq("tenant_id", tenant_id)
    .eq("thread_id", thread_id)
    .eq("sender_role", "assistant")
    .eq("meta->build_confirm->>nonce", nonce)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = (data ?? [])[0] as { id: string; meta: Record<string, unknown> | null } | undefined;
  return row ? { id: row.id, meta: row.meta ?? {} } : null;
}

export async function markBuildConfirmCard(
  tenant_id: string,
  thread_id: string,
  nonce: string,
  patch: { status: "started"; run_id: string | null } | { status: "replaced" },
  sb?: Sb,
): Promise<void> {
  try {
    const row = await findBuildConfirmCardRow(tenant_id, thread_id, nonce, sb);
    if (!row) return;
    const card = (row.meta.build_confirm ?? {}) as Record<string, unknown>;
    await client(tenant_id, sb)
      .from("agent_thread_messages")
      .update({ meta: { ...row.meta, build_confirm: { ...card, ...patch } } })
      .eq("id", row.id)
      .eq("tenant_id", tenant_id);
  } catch {
  }
}

export async function armHeavyDispatchPending(
  params: {
    tenant_id: string;
    thread_id: string;
    armed_run_id: string | null;
    user_id: string | null;
    target: string;
    intent: string;
    context: Record<string, unknown> | null;
    est_credits: number;
  },
  sb?: Sb,
): Promise<HeavyConfirmPending | null> {
  const pending: HeavyConfirmPending = {
    nonce: randomUUID(),
    target: params.target,
    intent: params.intent,
    context: params.context,
    armed_run_id: params.armed_run_id,
    user_id: params.user_id,
    est_credits: params.est_credits,
    armed_at: new Date().toISOString(),
  };
  try {
    const previous = await readHeavyDispatchPending(params, sb);
    const { data, error } = await client(params.tenant_id, sb)
      .from("agent_threads")
      .update({ heavy_confirm_pending: pending })
      .eq("id", params.thread_id)
      .eq("tenant_id", params.tenant_id)
      .select("id");
    if (error || (data?.length ?? 0) !== 1) return null;
    if (previous && previous.nonce !== pending.nonce) {
      await markBuildConfirmCard(
        params.tenant_id,
        params.thread_id,
        previous.nonce,
        { status: "replaced" },
        sb,
      );
    }
    return pending;
  } catch {
    return null;
  }
}

export async function claimHeavyDispatchPending(
  params: { tenant_id: string; thread_id: string; nonce: string },
  sb?: Sb,
): Promise<HeavyConfirmPending | null> {
  try {
    const current = await readHeavyDispatchPending(params, sb);
    if (!current || current.nonce !== params.nonce || !isFreshPending(current)) return null;
    const { data, error } = await client(params.tenant_id, sb)
      .from("agent_threads")
      .update({ heavy_confirm_pending: null })
      .eq("id", params.thread_id)
      .eq("tenant_id", params.tenant_id)
      .eq("heavy_confirm_pending->>nonce", params.nonce)
      .select("id");
    if (error) return null;
    return (data?.length ?? 0) > 0 ? current : null;
  } catch {
    return null;
  }
}

export async function restoreHeavyDispatchPending(
  params: { tenant_id: string; thread_id: string; pending: HeavyConfirmPending },
  sb?: Sb,
): Promise<boolean> {
  try {
    const { data, error } = await client(params.tenant_id, sb)
      .from("agent_threads")
      .update({ heavy_confirm_pending: params.pending })
      .eq("id", params.thread_id)
      .eq("tenant_id", params.tenant_id)
      .is("heavy_confirm_pending", null)
      .select("id");
    return !error && (data?.length ?? 0) === 1;
  } catch {
    return false;
  }
}

export async function clearHeavyDispatchPending(
  params: { tenant_id: string; thread_id: string; nonce: string },
  sb?: Sb,
): Promise<boolean> {
  try {
    const { data, error } = await client(params.tenant_id, sb)
      .from("agent_threads")
      .update({ heavy_confirm_pending: null })
      .eq("id", params.thread_id)
      .eq("tenant_id", params.tenant_id)
      .eq("heavy_confirm_pending->>nonce", params.nonce)
      .select("id");
    return !error && (data?.length ?? 0) === 1;
  } catch {
    return false;
  }
}
