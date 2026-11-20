
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import type { inngest } from "../../../workers/client";
import { buildRunRequestedEventForRunId } from "./run-lane";
import {
  conductorOwnerOf,
  conductorOwnerOnlyEnabled,
  dropForeignRuns,
  isOtherWorkersOwner,
} from "./conductor-owner";
import { emitTeamNoteRunEnd } from "@/services/team-notes/emit-run-end";
import { LOOK_PARK_EXPIRY_MS, lookAwaitingSiteId } from "@/services/sites/look-wait";

type Svc = ReturnType<typeof serviceClient>;
type InngestClient = typeof inngest;

export const STALE_RUN_REAP_HOURS_DEFAULT = 2;

export function staleRunReapHours(): number {
  const raw = process.env.STALE_RUN_REAP_HOURS;
  const v = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : STALE_RUN_REAP_HOURS_DEFAULT;
}

export const CONDUCTOR_PROVISION_STUCK_MIN_DEFAULT = 15;
export const CONDUCTOR_ACTIVE_STUCK_MIN_DEFAULT = 45;

export function conductorProvisionStuckMinutes(): number {
  const raw = process.env.CONDUCTOR_PROVISION_STUCK_MIN;
  const v = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : CONDUCTOR_PROVISION_STUCK_MIN_DEFAULT;
}

export function conductorActiveStuckMinutes(): number {
  const raw = process.env.CONDUCTOR_ACTIVE_STUCK_MIN;
  const v = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : CONDUCTOR_ACTIVE_STUCK_MIN_DEFAULT;
}

const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "blocked",
]);

const STALE_REAP_ERROR_PREFIX = "stale_reap";

interface StaleRunRow {
  id: string;
  tenant_id: string;
  agent_slug: string;
  blocked_by_run_id?: string | null;
  payload: unknown;
  trigger?: string | null;
  worker_id?: string | null;
}

function threadIdOfPayload(payload: unknown): string | null {
  return payload && typeof payload === "object"
    ? (((payload as { thread_id?: unknown }).thread_id as
        | string
        | undefined) ?? null)
    : null;
}

export interface StaleReapResult {
  blocked_reaped: number;
  queued_reaped: number;
  promoted: number;
  conductor_provisioning_reaped: number;
  conductor_active_reaped: number;
}

export async function reapStaleRuns(
  svc: Svc = serviceClient(),
  inngestClient?: InngestClient,
  nowMs: number = Date.now(),
): Promise<StaleReapResult> {
  const hours = staleRunReapHours();
  const cutoffIso = new Date(nowMs - hours * 3600_000).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  let blockedReaped = 0;
  let queuedReaped = 0;
  let promoted = 0;
  let conductorProvisioningReaped = 0;
  let conductorActiveReaped = 0;

  const { data: blockedRows, error: bErr } = await svc
    .from("agent_runs")
    .select("id, tenant_id, agent_slug, blocked_by_run_id, payload, trigger, worker_id")
    .eq("status", "blocked")
    .is("batch_id", null)
    .lt("enqueued_at", cutoffIso);
  if (bErr) {
    await logEvent({
      level: "error",
      source: "stale-run-reaper",
      code: "stale_reap_select_failed",
      error: new Error(bErr.message),
      meta: { sweep: "blocked" },
    });
  } else {
    const rows = await dropForeignRuns(svc, (blockedRows ?? []) as StaleRunRow[]);
    const blockerIds = [
      ...new Set(
        rows
          .map((r) => r.blocked_by_run_id)
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      ),
    ];
    const blockerStatus = new Map<string, string>();
    let blockerLookupOk = true;
    if (blockerIds.length > 0) {
      const { data: blockers, error: blkErr } = await svc
        .from("agent_runs")
        .select("id, status")
        .in("id", blockerIds);
      if (blkErr) {
        blockerLookupOk = false;
        await logEvent({
          level: "error",
          source: "stale-run-reaper",
          code: "stale_reap_blocker_lookup_failed",
          error: new Error(blkErr.message),
        });
      } else {
        for (const b of (blockers ?? []) as Array<{ id: string; status: string }>) {
          blockerStatus.set(b.id, b.status);
        }
      }
    }

    if (blockerLookupOk) {
      for (const r of rows) {
        const bs = r.blocked_by_run_id
          ? blockerStatus.get(r.blocked_by_run_id)
          : undefined;
        const blockerLive = bs !== undefined && LIVE_STATUSES.has(bs);
        if (blockerLive) continue;

        const { data: cas, error: upErr } = await svc
          .from("agent_runs")
          .update({
            status: "failed",
            error: `stale_reap: blocked >${hours}h, blocker terminal`,
            finished_at: nowIso,
            needs_run_end_emit: true,
          })
          .eq("id", r.id)
          .eq("status", "blocked")
          .select("id");
        if (upErr || !cas || cas.length === 0) continue;
        blockedReaped += 1;

        await emitTeamNoteRunEnd({
          runId: r.id,
          tenantId: r.tenant_id,
          agentSlug: r.agent_slug,
          trigger: r.trigger ?? null,
          paused: false,
          status: "failed",
          error: STALE_REAP_ERROR_PREFIX,
          willRetry: false,
          toolCalls: undefined,
          groundingFlags: undefined,
          operatorShapes: undefined,
        });

        await logEvent({
          level: "warn",
          source: "stale-run-reaper",
          code: "stale_reap_blocked",
          tenant_id: r.tenant_id,
          run_id: r.id,
          message: `stale_reap: blocked >${hours}h, blocker terminal`,
          meta: { agent_slug: r.agent_slug, blocker_status: bs ?? "missing" },
        });

        promoted += await promoteThreadSuccessor(svc, inngestClient, r);
      }
    }
  }

  const { data: queuedRows, error: qErr } = await svc
    .from("agent_runs")
    .select("id, tenant_id, agent_slug, payload, trigger, worker_id")
    .eq("status", "queued")
    .is("batch_id", null)
    .is("started_at", null)
    .lt("enqueued_at", cutoffIso);
  if (qErr) {
    await logEvent({
      level: "error",
      source: "stale-run-reaper",
      code: "stale_reap_select_failed",
      error: new Error(qErr.message),
      meta: { sweep: "queued" },
    });
  } else {
    for (const r of await dropForeignRuns(svc, (queuedRows ?? []) as StaleRunRow[])) {
      const { data: cas, error: upErr } = await svc
        .from("agent_runs")
        .update({
          status: "failed",
          error: `stale_reap: queued >${hours}h, never claimed`,
          finished_at: nowIso,
          needs_run_end_emit: true,
        })
        .eq("id", r.id)
        .eq("status", "queued")
        .select("id");
      if (upErr || !cas || cas.length === 0) continue;
      queuedReaped += 1;

      await emitTeamNoteRunEnd({
        runId: r.id,
        tenantId: r.tenant_id,
        agentSlug: r.agent_slug,
        trigger: r.trigger ?? null,
        paused: false,
        status: "failed",
        error: STALE_REAP_ERROR_PREFIX,
        willRetry: false,
        toolCalls: undefined,
        groundingFlags: undefined,
        operatorShapes: undefined,
      });

      await logEvent({
        level: "warn",
        source: "stale-run-reaper",
        code: "stale_reap_queued",
        tenant_id: r.tenant_id,
        run_id: r.id,
        message: `stale_reap: queued >${hours}h, never claimed`,
        meta: { agent_slug: r.agent_slug },
      });

      promoted += await promoteThreadSuccessor(svc, inngestClient, r);
    }
  }

  const provStuckMin = conductorProvisionStuckMinutes();
  const activeStuckMin = conductorActiveStuckMinutes();
  const provCutoffIso = new Date(nowMs - provStuckMin * 60_000).toISOString();
  const activeCutoffIso = new Date(nowMs - activeStuckMin * 60_000).toISOString();

  const { data: provRows, error: provErr } = await svc
    .from("conductor_runs")
    .select("id, tenant_id")
    .eq("status", "provisioning")
    .lt("updated_at", provCutoffIso);
  if (provErr) {
    await logEvent({
      level: "error",
      source: "stale-run-reaper",
      code: "conductor_reap_select_failed",
      error: new Error(provErr.message),
      meta: { sweep: "conductor_provisioning" },
    });
  } else {
    for (const r of (provRows ?? []) as Array<{ id: string; tenant_id: string }>) {
      if (
        await reapConductorSlot(svc, r.tenant_id, r.id, provCutoffIso, "provisioning")
      ) {
        conductorProvisioningReaped += 1;
      }
    }
  }

  const { data: activeRows, error: activeErr } = await svc
    .from("conductor_runs")
    .select("id, tenant_id, goal_graph")
    .eq("status", "active")
    .lt("updated_at", activeCutoffIso);
  if (activeErr) {
    await logEvent({
      level: "error",
      source: "stale-run-reaper",
      code: "conductor_reap_select_failed",
      error: new Error(activeErr.message),
      meta: { sweep: "conductor_active" },
    });
  } else {
    for (const r of (activeRows ?? []) as Array<{
      id: string;
      tenant_id: string;
      goal_graph?: unknown;
    }>) {
      if (
        isOtherWorkersOwner(conductorOwnerOf(r.goal_graph)) &&
        (await conductorOwnerOnlyEnabled())
      ) {
        continue;
      }
      if (lookAwaitingSiteId(r.goal_graph)) continue;
      if (await conductorHasLiveChild(svc, r.tenant_id, r.id, r.goal_graph)) continue;
      if (
        await reapConductorSlot(svc, r.tenant_id, r.id, activeCutoffIso, "active")
      ) {
        conductorActiveReaped += 1;
      }
    }
  }

  const { data: parkedExpired, error: parkedErr } = await svc.rpc("expire_parked_look_runs", {
    p_expiry_seconds: Math.round(LOOK_PARK_EXPIRY_MS / 1000),
    p_limit: 200,
  });
  if (parkedErr) {
    await logEvent({
      level: "error",
      source: "stale-run-reaper",
      code: "conductor_reap_rpc_failed",
      error: new Error(parkedErr.message),
      meta: { sweep: "look_park" },
    });
  } else if (typeof parkedExpired === "number") {
    conductorActiveReaped += parkedExpired;
  }

  if (
    blockedReaped > 0 ||
    queuedReaped > 0 ||
    conductorProvisioningReaped > 0 ||
    conductorActiveReaped > 0
  ) {
    await logEvent({
      level: "warn",
      source: "stale-run-reaper",
      code: "stale_reap_swept",
      meta: {
        blocked_reaped: blockedReaped,
        queued_reaped: queuedReaped,
        promoted,
        conductor_provisioning_reaped: conductorProvisioningReaped,
        conductor_active_reaped: conductorActiveReaped,
      },
    });
  }

  return {
    blocked_reaped: blockedReaped,
    queued_reaped: queuedReaped,
    promoted,
    conductor_provisioning_reaped: conductorProvisioningReaped,
    conductor_active_reaped: conductorActiveReaped,
  };
}

async function conductorHasLiveChild(
  svc: Svc,
  tenantId: string,
  conductorRunId: string,
  goalGraph: unknown,
): Promise<boolean> {
  const childIdSet = new Set<string>();

  if (Array.isArray(goalGraph)) {
    for (const node of goalGraph as Array<{ child_run_id?: unknown }>) {
      const cid = node?.child_run_id;
      if (typeof cid === "string" && cid.length > 0) childIdSet.add(cid);
    }
  }

  const { data: dh, error: dhErr } = await svc
    .from("dispatch_history")
    .select("target_run_id")
    .eq("tenant_id", tenantId)
    .eq("source_run_id", conductorRunId);
  if (dhErr) return true;
  for (const d of (dh ?? []) as Array<{ target_run_id: string | null }>) {
    if (typeof d.target_run_id === "string" && d.target_run_id.length > 0) {
      childIdSet.add(d.target_run_id);
    }
  }

  if (childIdSet.size === 0) return false;
  const { data: live, error: liveErr } = await svc
    .from("agent_runs")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("id", [...childIdSet])
    .in("status", ["queued", "running"])
    .limit(1);
  if (liveErr) return true;
  return (live ?? []).length > 0;
}

async function reapConductorSlot(
  svc: Svc,
  tenantId: string,
  conductorRunId: string,
  cutoffIso: string,
  priorStatus: "provisioning" | "active",
): Promise<boolean> {
  try {
    const { data, error } = await svc.rpc("cancel_conductor_run", {
      p_tenant_id: tenantId,
      p_conductor_run_id: conductorRunId,
      p_reason: "stale_slot_reap",
      p_require_updated_before: cutoffIso,
    });
    if (error) {
      await logEvent({
        level: "error",
        source: "stale-run-reaper",
        code: "conductor_reap_rpc_failed",
        tenant_id: tenantId,
        run_id: conductorRunId,
        error: new Error(error.message),
        meta: { prior_status: priorStatus },
      });
      return false;
    }
    const cancelled =
      data != null && typeof data === "object" && (data as { cancelled?: unknown }).cancelled === true;
    if (cancelled) {
      const stoppedChildren = Number(
        (data as { stopped_children?: unknown }).stopped_children ?? 0,
      );
      await logEvent({
        level: "warn",
        source: "stale-run-reaper",
        code: "conductor_slot_reaped",
        tenant_id: tenantId,
        run_id: conductorRunId,
        message: `stale_slot_reap: ${priorStatus} build wedged, slot freed`,
        meta: { prior_status: priorStatus, stopped_children: stoppedChildren },
      });
    }
    return cancelled;
  } catch (e) {
    await logEvent({
      level: "warn",
      source: "stale-run-reaper",
      code: "conductor_reap_threw",
      tenant_id: tenantId,
      run_id: conductorRunId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return false;
  }
}

async function promoteThreadSuccessor(
  svc: Svc,
  inngestClient: InngestClient | undefined,
  reaped: StaleRunRow,
): Promise<number> {
  const threadId = threadIdOfPayload(reaped.payload);
  if (!threadId) return 0;
  try {
    const { data: inflight, error: inflightErr } = await svc
      .from("agent_runs")
      .select("id")
      .eq("tenant_id", reaped.tenant_id)
      .filter("payload->>thread_id", "eq", threadId)
      .in("status", ["queued", "running"])
      .limit(1);
    if (inflightErr || (inflight && inflight.length > 0)) return 0;

    const { data: promotedId, error: promoteErr } = await svc.rpc(
      "promote_next_blocked_run",
      { p_tenant_id: reaped.tenant_id, p_thread_id: threadId },
    );
    if (promoteErr || !promotedId) return 0;

    if (inngestClient) {
      await inngestClient.send(
        await buildRunRequestedEventForRunId(svc, promotedId as string, {
          tenant_id: reaped.tenant_id,
        }),
      );
    }
    return 1;
  } catch (e) {
    await logEvent({
      level: "warn",
      source: "stale-run-reaper",
      code: "stale_reap_promote_failed",
      tenant_id: reaped.tenant_id,
      run_id: reaped.id,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return 0;
  }
}
