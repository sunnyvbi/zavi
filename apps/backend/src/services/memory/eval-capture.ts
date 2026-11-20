
import { serviceClient } from "@/services/supabase";
import { scrubQueryForCapture } from "./eval-capture-scrub";
import type { SearchHit } from "./index";

const FLAG_CACHE_TTL_MS = 60_000;
const flagCache = new Map<string, { value: boolean; expiresAt: number }>();

export function _resetCaptureFlagCache(tenant_id?: string): void {
  if (tenant_id) flagCache.delete(tenant_id);
  else flagCache.clear();
}

async function isCaptureEnabledForTenant(tenant_id: string): Promise<boolean> {
  const cached = flagCache.get(tenant_id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let resolved = false;
  try {
    const sb = serviceClient();
    const [{ data: tRow }, { data: gRow }] = await Promise.all([
      sb
        .from("tenants")
        .select("brain_eval_capture")
        .eq("id", tenant_id)
        .maybeSingle(),
      sb.from("system_config").select("blob").eq("id", 1).maybeSingle(),
    ]);

    const tenantFlag =
      tRow &&
      typeof (tRow as { brain_eval_capture: boolean | null })
        .brain_eval_capture === "boolean"
        ? ((tRow as { brain_eval_capture: boolean })
            .brain_eval_capture as boolean)
        : null;

    const globalFlag =
      gRow &&
      (gRow as { blob: Record<string, unknown> | null }).blob &&
      typeof (gRow as { blob: Record<string, unknown> }).blob
        .brain_eval_capture_default === "boolean"
        ? ((gRow as { blob: Record<string, unknown> }).blob
            .brain_eval_capture_default as boolean)
        : null;

    resolved = tenantFlag ?? globalFlag ?? false;
  } catch (e) {
    resolved = false;
  }

  flagCache.set(tenant_id, {
    value: resolved,
    expiresAt: Date.now() + FLAG_CACHE_TTL_MS,
  });
  return resolved;
}

async function resolveSameTenantRunId(
  tenant_id: string,
  candidate_run_id: string | null | undefined,
): Promise<string | null> {
  if (!candidate_run_id) return null;
  try {
    const { data } = await serviceClient()
      .from("agent_runs")
      .select("tenant_id")
      .eq("id", candidate_run_id)
      .maybeSingle();
    if (!data) return null;
    if ((data as { tenant_id: string }).tenant_id !== tenant_id) return null;
    return candidate_run_id;
  } catch {
    return null;
  }
}

type FailureReason =
  | "db_down"
  | "rls_reject"
  | "check_violation"
  | "scrubber_exception"
  | "other";

async function logCaptureFailure(
  tenant_id: string | null,
  reason: FailureReason,
  detail: string,
): Promise<void> {
  try {
    await serviceClient()
      .from("eval_capture_failures")
      .insert({ tenant_id, reason, detail: detail.slice(0, 500) });
  } catch (e) {
    console.warn(
      `[eval-capture] failure-log insert also failed (${reason}): ${
        (e as Error)?.message ?? e
      }`,
    );
  }
}

export type RecordEvalCaptureInput = {
  tenant_id: string;
  query: string;
  hits: SearchHit[];
  k: number;
  latency_ms: number;
  run_id: string | null;
  agent_slug: string | null;
  tool_name?: "search" | "query";
};

export async function recordEvalCapture(
  input: RecordEvalCaptureInput,
): Promise<void> {
  const tool_name = input.tool_name ?? "search";

  const enabled = await isCaptureEnabledForTenant(input.tenant_id);
  if (!enabled) return;

  let scrubbed: string;
  try {
    scrubbed = scrubQueryForCapture(input.query);
  } catch (e) {
    await logCaptureFailure(
      input.tenant_id,
      "scrubber_exception",
      `scrubber threw: ${(e as Error)?.message ?? e}`,
    );
    return;
  }

  const safeRunId = await resolveSameTenantRunId(input.tenant_id, input.run_id);

  const slug =
    input.agent_slug && input.agent_slug.length > 200
      ? input.agent_slug.slice(0, 200)
      : input.agent_slug ?? null;

  const latency_ms = Math.max(
    0,
    Math.min(599_999, Math.floor(input.latency_ms)),
  );

  const k = Math.max(1, Math.min(50, input.k));

  const retrieved_chunk_ids = input.hits
    .map((h) => h.chunk_id)
    .filter((id): id is string => typeof id === "string");
  const retrieved_note_ids = input.hits
    .map((h) => h.note_id)
    .filter((id): id is string => typeof id === "string");

  try {
    const { error } = await serviceClient().from("eval_candidates").insert({
      tenant_id: input.tenant_id,
      tool_name,
      query: scrubbed,
      retrieved_chunk_ids,
      retrieved_note_ids,
      latency_ms,
      k,
      run_id: safeRunId,
      agent_slug: slug,
    });
    if (error) {
      const reason: FailureReason = error.message?.toLowerCase().includes("check")
        ? "check_violation"
        : error.message?.toLowerCase().includes("rls") ||
          error.message?.toLowerCase().includes("policy")
        ? "rls_reject"
        : "other";
      await logCaptureFailure(input.tenant_id, reason, error.message ?? "");
    }
  } catch (e) {
    await logCaptureFailure(
      input.tenant_id,
      "db_down",
      `insert threw: ${(e as Error)?.message ?? e}`,
    );
  }
}

const inFlight = new Set<Promise<unknown>>();

export function _trackForDrain<T>(p: Promise<T>): Promise<T> {
  if (process.env.GBRAIN_EVAL_CAPTURE_TRACK !== "1") return p;
  inFlight.add(p as Promise<unknown>);
  void p.finally(() => inFlight.delete(p as Promise<unknown>));
  return p;
}

export async function _drainPendingCaptures(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  if (inFlight.size === 0) return;
  await Promise.allSettled([...inFlight]);
}
