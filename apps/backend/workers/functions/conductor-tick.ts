
import { maybeSendBuildLiveEmail } from "@/services/build/build-live-email";
import { postBuildReadyMessage } from "@/services/build/build-ready-message";
import { defaultBuildFirstPlanDeps, startFirstPlanAfterBuild } from "@/services/setup/build-first-plan";
import { runPreviewCheck } from "@/services/sites/preview-check";
import { runThumbnailEvent } from "@/services/sites/site-thumbnail-capture";
import { noteRunPreviewChanged } from "@/services/sites/site-preview-snapshot-capture";
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { conductorTick } from "@/services/agents/conductor";
import type { ConductorTickDeps } from "@/services/agents/conductor";
import {
  realConductorTickDeps,
  staticPublishPlan,
  isConductorEnabled,
  resolveConductorRepairEnabled,
} from "@/services/agents/conductor-driver";
import { appendConductorAction, isLoggableTick } from "@/services/agents/conductor-ledger";
import {
  targetedRunId,
  CONDUCTOR_TICK_REQUESTED,
  followUpTickEvent,
  lookAutoStartTickEvent,
  needsFollowUpTick,
} from "@/services/agents/conductor-kick";
import { requestBuildScreenCheck } from "./build-screen-check";
import { requestBuildStaticPublish } from "./build-static-publish";
import { rollbackStaticHosting } from "@/services/hosting/static-publish";
import { expireStalePausedBuilds, resumeStrandedSiteRepublishes } from "@/services/agents/continue-build";
import { logBuildTick } from "@/services/agents/conductor-observability";
import type { ConductorNode } from "@/services/agents/conductor";
import { getBoolSetting } from "@/services/settings";
import { AWAITING_LOOK_GRAPH_MARKER, touchLookPickedRun } from "@/services/sites/look-wait";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { shouldDrainSharedQueue } from "@/services/agents/boot-role";
import {
  conductorOwnerOf,
  conductorOwnerOnlyEnabled,
  isOtherWorkersOwner,
} from "@/services/agents/conductor-owner";

const MAX_CONDUCTORS_PER_SWEEP = 25;
export const MAX_AWAITING_LOOK_PER_SWEEP = 25;
const AWAITING_LOOK_FILTER = JSON.stringify(AWAITING_LOOK_GRAPH_MARKER);
export const MAX_PARALLEL_CONDUCTOR_TICKS = 10;

type TickLogger = {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
};

type TickCtx = { event?: unknown; logger: TickLogger };

export function withScreenCheckRequest(deps: ConductorTickDeps): ConductorTickDeps {
  if (!deps.screenCheck) return deps;
  return {
    ...deps,
    requestScreenCheck: async ({ conductor_run_id, node_id }) => {
      try {
        await requestBuildScreenCheck({ conductor_run_id, node_id });
      } catch (e) {
        console.warn(
          `[conductor-tick] screen check request failed for ${conductor_run_id}: ${(e as Error).message}`,
        );
      }
    },
  };
}

export function withStaticPublishRequest(deps: ConductorTickDeps): ConductorTickDeps {
  return {
    ...deps,
    staticPublish: {
      plan: (input) => staticPublishPlan(input),
      request: (input) => requestBuildStaticPublish(input),
      rollback: ({ tenant_id }) => rollbackStaticHosting(tenant_id),
    },
  };
}

const tickHandler = (mode: "cron" | "event") =>
  async ({ event, logger }: TickCtx) => {
    if (!(await isConductorEnabled())) {
      return { skipped: true, reason: "flag_off" };
    }
    const svc = serviceClient();

    const repairEnabled = await resolveConductorRepairEnabled();
    const baseRepair = realConductorTickDeps.repairConfig;
    const tickDeps: ConductorTickDeps =
      baseRepair && baseRepair.enabled !== repairEnabled
        ? {
            ...realConductorTickDeps,
            repairConfig: { ...baseRepair, enabled: repairEnabled },
          }
        : realConductorTickDeps;

    const { data: halted, error: killErr } = await svc.rpc("is_fleet_halted");
    if (killErr) {
      logger.error(`conductor-tick: is_fleet_halted failed (fail-closed, skipping): ${killErr.message}`);
      return { skipped: true, reason: "fleet_kill_check_failed" };
    }
    if (halted === true) {
      return { skipped: true, reason: "fleet_halted" };
    }

    const requested = mode === "event" ? targetedRunId(event) : null;
    if (mode === "event" && !requested) {
      return { skipped: true, reason: "no_target" };
    }
    if (!requested && !shouldDrainSharedQueue()) {
      return { skipped: true, reason: "not_canonical" };
    }
    if (!requested) {
      try {
        const expired = await expireStalePausedBuilds();
        if (expired > 0) logger.info(`conductor-tick: closed ${expired} paused build(s) past the continue window`);
      } catch (e) {
        logger.warn(`conductor-tick: paused-build expiry failed: ${(e as Error).message}`);
      }
      try {
        const resumed = await resumeStrandedSiteRepublishes();
        if (resumed > 0) logger.warn(`conductor-tick: resumed ${resumed} stranded site republish(es)`);
      } catch (e) {
        logger.warn(`conductor-tick: stranded republish resume failed: ${(e as Error).message}`);
      }
    }
    const { data, error } = requested
      ? await svc
          .from("conductor_runs")
          .select("id, tenant_id, kind, goal_graph")
          .eq("status", "active")
          .eq("id", requested)
          .limit(1)
      : await svc
          .from("conductor_runs")
          .select("id, tenant_id, kind, goal_graph")
          .eq("status", "active")
          .not("goal_graph", "cs", AWAITING_LOOK_FILTER)
          .order("updated_at", { ascending: true })
          .limit(MAX_CONDUCTORS_PER_SWEEP);
    if (error) {
      logger.error(`conductor-tick: select active conductors failed: ${error.message}`);
      return { ticked: 0, error: error.message };
    }

    let candidates = data ?? [];
    if (!requested) {
      const parked = await svc
        .from("conductor_runs")
        .select("id, tenant_id, kind, goal_graph")
        .eq("status", "active")
        .contains("goal_graph", AWAITING_LOOK_FILTER)
        .order("updated_at", { ascending: true })
        .limit(MAX_AWAITING_LOOK_PER_SWEEP);
      if (parked.error) logger.warn(`conductor-tick: select look-awaiting builds failed: ${parked.error.message}`);
      else candidates = [...candidates, ...(parked.data ?? [])];
    }
    if (candidates.length > 0 && (await conductorOwnerOnlyEnabled())) {
      candidates = candidates.filter(
        (row) => !isOtherWorkersOwner(conductorOwnerOf((row as { goal_graph?: unknown }).goal_graph)),
      );
      if (candidates.length === 0 && requested) {
        return { skipped: true, reason: "other_worker", requested };
      }
    }

    if (mode === "cron") {
      await sweepHeldChanges(svc, logger);
      const ids = candidates.map((row) => row.id as string);
      if (ids.length === 0) return { fanned_out: 0 };
      try {
        await inngest.send(
          ids.map((conductor_run_id) => ({
            name: CONDUCTOR_TICK_REQUESTED,
            data: { conductor_run_id },
          })),
        );
      } catch (e) {
        logger.error(`conductor-tick: fan-out send failed: ${(e as Error).message}`);
        return { fanned_out: 0, error: (e as Error).message };
      }
      return { fanned_out: ids.length };
    }

    const results: Array<{ id: string; action: string; awaiting?: string }> = [];
    let skippedNotEnabled = 0;
    for (const row of candidates) {
      const id = row.id as string;
      const tenant_id = row.tenant_id as string;
      const kind = row.kind as string | null;
      if (kind !== "build_app" && isWorkerCronStopped("conductor-tick-autonomy")) {
        skippedNotEnabled++;
        continue;
      }
      try {
        const r = await conductorTick(id, withStaticPublishRequest(withScreenCheckRequest(tickDeps)));
        results.push({ id, action: r.action, ...(r.action === "waiting" && r.awaiting ? { awaiting: r.awaiting } : {}) });
        if (r.action === "waiting" && r.awaiting === "look") {
          await touchLookPickedRun(tenant_id, id).catch((e: unknown) => {
            logger.warn(`conductor-tick: parked heartbeat failed for ${id}: ${(e as Error).message}`);
          });
          const autoTick = lookAutoStartTickEvent(id, r.auto_start_at);
          if (autoTick) {
            await inngest.send(autoTick).catch((e: unknown) => {
              logger.warn(`conductor-tick: look auto start tick failed for ${id}: ${(e as Error).message}`);
            });
          }
        }
        if (kind === "build_app" && r.action === "completed" && r.final === "done") {
          await maybeSendBuildLiveEmail({ tenant_id, conductor_run_id: id });
          await postBuildReadyMessage({ tenant_id, conductor_run_id: id });
          void defaultBuildFirstPlanDeps(svc)
            .then((deps) => startFirstPlanAfterBuild(tenant_id, id, deps))
            .then((out) => {
              if (out.started) logger.info(`conductor-tick: first plan after build ${id} ${JSON.stringify(out.result)}`);
            })
            .catch((e: unknown) => {
              logger.warn(`conductor-tick: first plan after build failed for ${id}: ${(e as Error).message}`);
            });
          void runPreviewCheck({ tenantId: tenant_id, runId: id }).catch(() => undefined);
          await inngest.send(runThumbnailEvent(tenant_id, id)).catch((e: unknown) => {
            logger.warn(`conductor-tick: thumbnail request failed for ${id}: ${(e as Error).message}`);
          });
          await noteRunPreviewChanged(tenant_id, id);
        }
        if (kind === "build_app" && r.action === "completed") {
          void settleHeldChange(tenant_id, id, r.final).catch((e: unknown) => {
            logger.warn(`conductor-tick: queued change drain failed for ${tenant_id}: ${(e as Error).message}`);
          });
        }
        await appendConductorAction(svc, tenant_id, id, r);
        if (kind === "build_app" && isLoggableTick(r)) {
          const { data: latest } = await svc
            .from("conductor_runs")
            .select("goal_graph")
            .eq("id", id)
            .eq("tenant_id", tenant_id)
            .maybeSingle();
          await logBuildTick({
            tenant_id,
            conductor_run_id: id,
            result: r,
            graph: ((latest?.goal_graph as ConductorNode[] | null) ?? []),
          });
        }
      } catch (e) {
        logger.error(`conductor-tick: tick failed for ${id}: ${(e as Error).message}`);
        results.push({ id, action: "error" });
        await appendConductorAction(svc, tenant_id, id, {
          action: "dispatch_failed",
          node_id: "",
          reason: (e as Error).message,
        }).catch(() => {});
      }
    }
    const followUps = results
      .filter((r) => needsFollowUpTick(r))
      .map((r) => followUpTickEvent(r.id, Date.now()));
    let followed_up = 0;
    if (followUps.length > 0) {
      try {
        await inngest.send(followUps);
        followed_up = followUps.length;
      } catch (e) {
        logger.warn(`conductor-tick: follow-up tick send failed: ${(e as Error).message}`);
      }
    }
    return {
      ticked: results.length,
      skipped_not_enabled: skippedNotEnabled,
      requested,
      results,
      followed_up,
    };
  };

export async function drainAfterBuild(tenant_id: string): Promise<unknown> {
  const { drainQueuedSiteChange } = await import("@/services/sites/queued-change");
  const { realDrainDeps } = await import("@/routes/workspace/website-chat");
  return drainQueuedSiteChange(tenant_id, await realDrainDeps());
}

async function settleHeldChange(tenant_id: string, conductor_run_id: string, final: unknown): Promise<unknown> {
  if (final === "failed") {
    const { dropHeldChanges } = await import("@/services/sites/queued-change");
    await dropHeldChanges(tenant_id, conductor_run_id);
  }
  return drainAfterBuild(tenant_id);
}

const HELD_CHANGE_SWEEP_LIMIT = 20;

async function sweepHeldChanges(svc: ReturnType<typeof serviceClient>, logger: { warn: (m: string) => void }): Promise<void> {
  try {
    const { data } = await svc
      .from("site_queued_change")
      .select("tenant_id")
      .eq("status", "queued")
      .order("queued_at")
      .limit(HELD_CHANGE_SWEEP_LIMIT);
    const tenants = [...new Set(((data ?? []) as Array<{ tenant_id: string }>).map((row) => row.tenant_id))];
    await Promise.allSettled(tenants.map((tenant_id) => drainAfterBuild(tenant_id)));
  } catch (e) {
    logger.warn(`conductor-tick: held change sweep failed: ${(e as Error).message}`);
  }
}

export const conductorTickFn = inngest.createFunction(
  { id: "conductor-tick", concurrency: 1 },
  [{ cron: "*/2 * * * *" }],
  tickHandler("cron"),
);

export const conductorTickRequestedFn = inngest.createFunction(
  {
    id: "conductor-tick-requested",
    concurrency: [
      { limit: 1, key: "event.data.conductor_run_id" },
      { limit: MAX_PARALLEL_CONDUCTOR_TICKS },
    ],
  },
  [{ event: CONDUCTOR_TICK_REQUESTED }],
  tickHandler("event"),
);
