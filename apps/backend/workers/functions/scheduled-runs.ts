
import { isEngineerBackendRun } from "@/services/billing/tiers";
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { enqueueWorkItem } from "@/services/agents/work-queue";
import { enqueueAgentRun } from "@/services/agents/runner";
import { createTierGate } from "@/services/agents/entitlement";
import { channelForAgent } from "@/services/agents/channel-agents";
import { runChannelRecipe } from "@/services/channels/engine";
import { filterOutShellTenants } from "./_shell-tenant-filter";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import { isCronStopped, isStandingOrderRow } from "@/services/agents/cron-stopped";
import { loadAgentDefinition } from "@/services/agents/registry";
import { cronDueInBucket } from "./cron-match";
import {
  runCustomAgentSchedules,
  defaultCustomScheduleDeps,
  type CustomScheduleDeps,
  type CustomScheduleResult,
} from "./custom-agent-schedules";
import {
  runCustomAgentWatches,
  defaultCustomWatchDeps,
  type CustomWatchDeps,
  type CustomWatchResult,
} from "./custom-agent-watches";
import { buildGrowthFanInPayload } from "@/services/growth/fan-in";
import { logEvent } from "@/services/logging/logEvent";
import { isResearchWatchPrecheckEnabled } from "@/agents/research/research-watch-flag";
import {
  deriveTopicKey,
  extractAskText,
  loadResearchWatchBaseline,
} from "@/agents/research/persist-evidence";
import { shouldShortCircuitResearchWatch } from "@/agents/research/research-watch-precheck";
import { guardedRefetch } from "@/services/agents/url-watch";
import { defaultChannelContext } from "@/services/channels/context";

type ScheduleRow = {
  tenant_id: string;
  agent_slug: string;
  cron_expression: string;
  enabled: boolean;
  last_fired_at: string | null;
  payload_template: Record<string, unknown> | null;
  timezone: string | null;
};

function isResearchWatchTick(row: ScheduleRow): boolean {
  if (row.agent_slug !== "research") return false;
  const tpl = row.payload_template;
  if (!tpl || typeof tpl !== "object") return false;
  const so = (tpl as Record<string, unknown>).standing_order;
  return !!so && typeof so === "object";
}

export type ResearchWatchPrecheckDeps = {
  isEnabled: (tenant_id: string) => Promise<boolean>;
  shortCircuit: typeof shouldShortCircuitResearchWatch;
  loadBaseline: typeof loadResearchWatchBaseline;
  refetch: (url: string) => Promise<{ content: string; ok: boolean }>;
};

const defaultPrecheckDeps: ResearchWatchPrecheckDeps = {
  isEnabled: (tenant_id) => isResearchWatchPrecheckEnabled(tenant_id),
  shortCircuit: shouldShortCircuitResearchWatch,
  loadBaseline: loadResearchWatchBaseline,
  refetch: guardedRefetch,
};

async function tryShortCircuitResearchWatch(
  row: ScheduleRow,
  logger: ScheduledRunsLogger,
  deps: ResearchWatchPrecheckDeps,
): Promise<boolean> {
  try {
    if (!isResearchWatchTick(row)) return false;
    if (!(await deps.isEnabled(row.tenant_id))) return false;

    const topic_key = deriveTopicKey(extractAskText(row.payload_template));
    const { shortCircuit, totalUrls, changedUrls } = await deps.shortCircuit({
      tenant_id: row.tenant_id,
      topic_key,
      loadBaseline: deps.loadBaseline,
      refetch: deps.refetch,
    });

    if (!shortCircuit) return false;

    await logEvent({
      level: "info",
      source: "research.watch.precheck",
      code: "no_delta",
      tenant_id: row.tenant_id,
      meta: { total: totalUrls, count: changedUrls.length },
    });
    logger.info(
      `scheduled-runs: research watch pre-check suppressed ${row.tenant_id}/research (no_delta, total=${totalUrls})`,
    );
    return true;
  } catch (e) {
    logger.warn(
      `scheduled-runs: research watch pre-check errored for ${row.tenant_id}/research (fail-open → enqueue): ${(e as Error).message}`,
    );
    return false;
  }
}

export type ScheduledRunsLogger = {
  warn: (s: string) => void;
  info: (s: string) => void;
  error: (s: string) => void;
};
export async function runScheduledRunsHandler(
  logger: ScheduledRunsLogger,
  precheckDeps: ResearchWatchPrecheckDeps = defaultPrecheckDeps,
  customDeps?: CustomScheduleDeps,
  watchDeps?: CustomWatchDeps,
): Promise<{
  scanned: number;
  fired: number;
  skippedNotDue: number;
  skippedUnwired: number;
  skippedStopped: number;
  skippedPlan?: number;
  suppressedNoDelta?: number;
  bucket: string;
  halted?: boolean;
  custom?: CustomScheduleResult;
  customWatch?: CustomWatchResult;
}> {
  if (await isFleetHalted()) {
    const bucket = bucket5min();
    logger.info(`scheduled-runs: fleet halt active — scan skipped (bucket=${bucket})`);
    return {
      scanned: 0,
      fired: 0,
      skippedNotDue: 0,
      skippedUnwired: 0,
      skippedStopped: 0,
      bucket,
      halted: true,
    };
  }

  const { data, error } = await serviceClient()
    .from("tenant_agent_schedules")
    .select(
      "tenant_id, agent_slug, cron_expression, enabled, last_fired_at, payload_template, timezone",
    )
    .eq("enabled", true);
  if (error) {
    throw new Error(`scheduled_runs scan failed: ${error.message}`);
  }
  const allRows = (data ?? []) as ScheduleRow[];
  const { data: shellRows } = await serviceClient()
    .from("tenants")
    .select("id")
    .eq("kind", "launch_video_shell");
  const shellTenantIds = new Set((shellRows ?? []).map((r: { id: string }) => r.id));
  const { kept: rows, excluded: shellExcluded } = filterOutShellTenants(allRows, shellTenantIds);
  if (shellExcluded > 0) {
    logger.warn(
      `scheduled-runs: excluded ${shellExcluded} schedule row(s) for launch_video_shell tenant(s) (inert until claimed)`,
    );
  }
  const bucket = bucket5min();
  const bypass = cronGateBypassed();
  let fired = 0;
  let skippedUnwired = 0;
  let skippedStopped = 0;
  let skippedNotDue = 0;
  let suppressedNoDelta = 0;
  const stampRows: { tenant_id: string; agent_slug: string }[] = [];
  const tierGate = createTierGate();
  let skippedPlan = 0;

  for (const row of rows) {
    if (!cronDueInBucket(row.cron_expression, bucket, row.timezone)) {
      skippedNotDue += 1;
      continue;
    }
    if (!isStandingOrderRow(row.payload_template) && isCronStopped(row.agent_slug)) {
      skippedStopped += 1;
      logger.info(
        `scheduled-runs: skipped ${row.agent_slug} (scheduled runs stopped fleet-wide; set PRAXIS_DISABLE_CRON_STOP=1 to restore)`,
      );
      continue;
    }
    const agent = await loadAgentDefinition(row.agent_slug, row.tenant_id);
    if (!agent) {
      logger.warn(
        `scheduled-runs: tenant_agent_schedules references missing agent ${row.agent_slug}`,
      );
      continue;
    }
    if (!bypass && CRON_GATED_UNWIRED.has(row.agent_slug)) {
      skippedUnwired += 1;
      logger.info(
        `scheduled-runs: skipped ${row.agent_slug} (dispatch not wired; set PRAXIS_DISABLE_CRON_GATE=1 to bypass)`,
      );
      continue;
    }

    try {
      const tierDecision = await tierGate.decide(row.tenant_id, row.agent_slug, {
        engineerBackendRun: isEngineerBackendRun(row.agent_slug, {
          trigger: "cron",
          enqueuedByUser: false,
          payload: row.payload_template ?? {},
        }),
      });
      if (!tierDecision.allowed) {
        skippedPlan += 1;
        continue;
      }
    } catch (e) {
      skippedPlan += 1;
      logger.warn(
        `scheduled-runs: tier unreadable for ${row.tenant_id}/${row.agent_slug}, skipping: ${(e as Error).message}`,
      );
      continue;
    }

    if (await tryShortCircuitResearchWatch(row, logger, precheckDeps)) {
      suppressedNoDelta += 1;
      stampRows.push({ tenant_id: row.tenant_id, agent_slug: row.agent_slug });
      continue;
    }

    const dedupeKey = `${row.tenant_id}:${row.agent_slug}:${bucket}`;
    let templatePayload =
      row.payload_template &&
      typeof row.payload_template === "object" &&
      Object.keys(row.payload_template).length > 0
        ? (row.payload_template as Record<string, unknown>)
        : null;

    if (row.agent_slug === "growth-lead") {
      try {
        const fanIn = await buildGrowthFanInPayload(row.tenant_id);
        templatePayload = { ...(templatePayload ?? {}), ...fanIn };
      } catch (e) {
        logger.warn(
          `scheduled-runs: growth fan-in build failed for ${row.tenant_id} (running tool-first): ${(e as Error).message}`,
        );
      }
    }

    const channel = channelForAgent(row.agent_slug);
    if (channel) {
      try {
        const result = await runChannelRecipe(
          row.tenant_id,
          channel.channel_slug,
          {
            channelContext: defaultChannelContext,
            enqueue: async (input) =>
              enqueueAgentRun({
                agent_slug: input.slug,
                tenant_id: input.tenant_id,
                trigger: "channel_recipe",
                payload: input.payload,
                cron_dedupe_key: dedupeKey,
              }),
          },
          undefined,
          templatePayload ?? undefined,
        );
        if (result.ok) {
          fired += 1;
        } else {
          logger.info(
            `scheduled-runs: channel run refused for ${row.tenant_id}/${row.agent_slug} (${result.reason})`,
          );
        }
        stampRows.push({ tenant_id: row.tenant_id, agent_slug: row.agent_slug });
      } catch (e) {
        logger.error(
          `scheduled-runs: channel run failed for ${row.tenant_id}/${row.agent_slug}: ${(e as Error).message}`,
        );
      }
      continue;
    }

    try {
      await enqueueWorkItem({
        tenant_id: row.tenant_id,
        agent_slug: row.agent_slug,
        source: "cron",
        payload: templatePayload,
        dedupe_key: dedupeKey,
      });
      fired += 1;
      stampRows.push({ tenant_id: row.tenant_id, agent_slug: row.agent_slug });
    } catch (e) {
      logger.error(
        `scheduled-runs: enqueue failed for ${row.tenant_id}/${row.agent_slug}: ${(e as Error).message}`,
      );
    }
  }

  for (const fr of stampRows) {
    const { error: stampErr } = await serviceClient()
      .from("tenant_agent_schedules")
      .update({ last_fired_at: bucket })
      .eq("tenant_id", fr.tenant_id)
      .eq("agent_slug", fr.agent_slug);
    if (stampErr) {
      logger.warn(
        `scheduled-runs: last_fired_at stamp failed for ${fr.tenant_id}/${fr.agent_slug}: ${stampErr.message}`,
      );
    }
  }

  let custom: CustomScheduleResult | undefined;
  try {
    custom = await runCustomAgentSchedules(
      bucket,
      { shellTenantIds, logger },
      customDeps ?? defaultCustomScheduleDeps((tid, slug) => tierGate.decide(tid, slug)),
    );
    if (custom.scanned > 0) {
      logger.info(
        `scheduled-runs: custom agents scanned ${custom.scanned}, fired ${custom.fired}, not_due ${custom.notDue}, skipped_plan ${custom.skippedPlan}, invalid ${custom.invalid}, lost_claim ${custom.lostClaim}`,
      );
    }
  } catch (e) {
    logger.warn(`scheduled-runs: custom agent scan failed: ${(e as Error).message}`);
  }

  let customWatch: CustomWatchResult | undefined;
  try {
    customWatch = await runCustomAgentWatches(
      bucket,
      { shellTenantIds, logger },
      watchDeps ?? defaultCustomWatchDeps((tid, slug) => tierGate.decide(tid, slug)),
    );
    if (customWatch.scanned > 0) {
      logger.info(
        `scheduled-runs: custom watches scanned ${customWatch.scanned}, checked ${customWatch.checked}, fired ${customWatch.fired}, no_delta ${customWatch.noDelta}, not_due ${customWatch.notDue}, skipped_plan ${customWatch.skippedPlan}, invalid ${customWatch.invalid}, lost_claim ${customWatch.lostClaim}`,
      );
    }
  } catch (e) {
    logger.warn(`scheduled-runs: custom watch scan failed: ${(e as Error).message}`);
  }

  logger.info(
    `scheduled-runs: scanned ${rows.length}, fired ${fired}, not_due ${skippedNotDue}, skipped_unwired ${skippedUnwired}, skipped_stopped ${skippedStopped}, skipped_plan ${skippedPlan}, suppressed_no_delta ${suppressedNoDelta} in bucket=${bucket}`,
  );
  return {
    scanned: rows.length,
    fired,
    skippedNotDue,
    skippedUnwired,
    skippedStopped,
    skippedPlan,
    suppressedNoDelta,
    bucket,
    ...(custom ? { custom } : {}),
    ...(customWatch ? { customWatch } : {}),
  };
}

const CRON_GATED_UNWIRED = new Set<string>([]);

function cronGateBypassed(): boolean {
  return process.env.PRAXIS_DISABLE_CRON_GATE === "1";
}

function bucket5min(d: Date = new Date()): string {
  const ms = d.getTime();
  const fiveMin = 5 * 60 * 1000;
  return new Date(Math.floor(ms / fiveMin) * fiveMin).toISOString();
}

export const scheduledRunsFn = inngest.createFunction(
  { id: "scheduled-runs", concurrency: 1 },
  { cron: "*/5 * * * *" },
  async ({ logger }) => runScheduledRunsHandler(logger),
);
