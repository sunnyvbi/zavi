
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { runChannelRecipe } from "@/services/channels/engine";
import { channelsDue, type ChannelState } from "@/services/channels/due";
import { readChannelStates } from "@/services/channels/state";
import { readLockedChannelSlugs } from "@/services/channels/lock";
import { runWatchProbes, type MetricSnapshotRow } from "@/services/channels/watch";
import { loadChannelRecipe, recipeExists } from "@/services/channels/recipe";
import { enqueueAgentRun } from "@/services/agents/runner";
import { loadTierGateConfig, resolveTenantTier } from "@/services/agents/entitlement";
import { tierAllows as tierAllowsSlug } from "@/services/billing/tiers";
import { marketingUrlOf } from "@/services/brand/resolve-brand-kit";
import { defaultChannelContext } from "@/services/channels/context";
import { buildAutorunView, readAutopilotState, readEffectiveAutorun, type AutopilotState } from "@/services/growth/channel-autorun";
import { tenantIsIdle } from "@/services/growth/tenant-idle";

function hasMarketingSite(product_url: unknown): boolean {
  return marketingUrlOf(product_url) !== null;
}

const PER_TENANT_LIMIT = 3;

export const channelSweepFn = inngest.createFunction(
  { id: "channel-sweep" },
  { cron: "0 7 * * *" },
  async ({ step, logger }) => {
    if (isWorkerCronStopped("channel-sweep")) {
      logger.info("channel-sweep: skipped — not on the scheduled-work allowlist");
      return { cron_stopped: true as const };
    }
    const summary = await step.run("sweep", async () => {
      const svc = serviceClient();
      const { data: tenants, error } = await svc
        .from("tenants")
        .select("id, slug, product_url");
      if (error) throw new Error(`tenant scan failed: ${error.message}`);

      const locked = await readLockedChannelSlugs();

      let considered = 0;
      let probed = 0;
      let probeChanged = 0;
      let probeErrors = 0;
      let skippedAutopilotOff = 0;
      let skippedIdle = 0;
      let skippedNoneDue = 0;
      let stateUnreadable = 0;
      let enqueued = 0;
      let refused = 0;
      const refusals: Record<string, number> = {};

      for (const tenant of tenants ?? []) {
        try {
          const channelState = await readChannelStates(svc, tenant.id);
          if (channelState.error) {
            stateUnreadable += 1;
            logger.warn(
              `channel-sweep: channel state unreadable for tenant ${tenant.id}, skipping: ${channelState.error}`,
            );
            continue;
          }

          try {
            const probe = await runWatchProbes(
              {
                channelStates: async () =>
                  channelState.states.map((s) => ({
                    channel_slug: s.channel.slug,
                    last_run_at: s.last_run_at,
                  })),
                snapshots: async (keys) => {
                  const { data } = await svc
                    .from("tenant_metric_snapshots")
                    .select("metric_key, value, status, window_end")
                    .eq("tenant_id", tenant.id)
                    .in("metric_key", keys as string[]);
                  return (data ?? []) as MetricSnapshotRow[];
                },
                write: async (channel_slug, at, delta) => {
                  const { error } = await svc.from("tenant_channels").upsert(
                    {
                      tenant_id: tenant.id,
                      channel_slug,
                      last_probe_at: at,
                      last_probe_delta: delta,
                    },
                    { onConflict: "tenant_id,channel_slug" },
                  );
                  if (error) {
                    logger.warn(
                      `channel-sweep: probe write failed for ${tenant.id}/${channel_slug}: ${error.message}`,
                    );
                  }
                },
                watchFor: (slug) => {
                  try {
                    return recipeExists(slug)
                      ? (loadChannelRecipe(slug).meta.watch ?? null)
                      : null;
                  } catch {
                    return null;
                  }
                },
              },
              new Date(),
            );
            probed += probe.probed;
            probeChanged += probe.changed;
          } catch (err) {
            probeErrors += 1;
            logger.warn(
              `channel-sweep: probe failed for tenant ${tenant.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }

          let autopilot: AutopilotState;
          try {
            autopilot = await readAutopilotState(tenant.id);
          } catch (err) {
            logger.warn(
              `channel-sweep: autopilot unreadable for tenant ${tenant.id}, skipping: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            continue;
          }
          if (!autopilot.enabled) {
            skippedAutopilotOff += 1;
            continue;
          }
          if (await tenantIsIdle(tenant.id)) {
            skippedIdle += 1;
            continue;
          }
          const autorun = buildAutorunView(
            autopilot,
            channelState.states.filter((s) => s.seeded).map((s) => ({
              channel_slug: s.channel.slug,
              autorun: s.autorun,
              autorun_set_by: s.autorun_set_by,
              autorun_set_at: s.autorun_set_at,
              chatgpt_autopilot_consent_at: s.chatgpt_autopilot_consent_at,
            })),
          );

          considered += 1;

          const { data: conn } = await svc
            .from("connector_metadata")
            .select("slug")
            .eq("tenant_id", tenant.id);

          const linked = new Set<string>(
            ((conn ?? []) as Array<{ slug: string }>).map((c) => c.slug),
          );
          const { data: livePlan, error: planErr } = await svc
            .from("growth_plan")
            .select("id")
            .eq("tenant_id", tenant.id)
            .eq("status", "live")
            .limit(1);
          if (planErr) {
            logger.warn(
              `channel-sweep: growth plan unreadable for tenant ${tenant.id}, skipping: ${planErr.message}`,
            );
            continue;
          }
          const hasLivePlan = (livePlan ?? []).length > 0;

          let tierAllows: (executorSlug: string) => boolean;
          try {
            const tierCfg = await loadTierGateConfig();
            if (tierCfg.deferred) throw new Error("tier config unreadable");
            const tier = await resolveTenantTier(tenant.id, tierCfg);
            tierAllows = (slug) => tierAllowsSlug(tier, slug, tierCfg.agentMin, tierCfg.alwaysPro);
          } catch (err) {
            logger.warn(
              `channel-sweep: tier unreadable for tenant ${tenant.id}, skipping: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            continue;
          }

          const due = channelsDue(
            channelState.states.map((s) => ({
              channel_slug: s.channel.slug,
              last_run_at: s.last_run_at,
              priority: s.priority,
              plan_selected: s.plan_selected,
              plan_sort_order: s.plan_sort_order,
              founder_stopped: s.plan_selected_set_by === "founder_stopped",
              autorun: autorun.resolve(s.channel.slug).effective,
              last_probe_delta: s.last_probe_delta,
            })) as ChannelState[],
            linked,
            Date.now(),
            PER_TENANT_LIMIT,
            hasMarketingSite(
              (tenant as { product_url?: unknown }).product_url,
            ),
            hasLivePlan,
            locked,
            tierAllows,
          );
          if (due.length === 0) {
            skippedNoneDue += 1;
            continue;
          }

          for (const slug of due) {
            try {
              const stillMay = await readEffectiveAutorun(tenant.id, slug, "channel-sweep").catch(() => false);
              if (!stillMay) {
                refused += 1;
                refusals["autorun_off_at_start"] = (refusals["autorun_off_at_start"] ?? 0) + 1;
                continue;
              }
              const result = await runChannelRecipe(tenant.id, slug, {
                channelContext: defaultChannelContext,
                enqueue: async (input) =>
                  enqueueAgentRun({
                    agent_slug: input.slug,
                    tenant_id: input.tenant_id,
                    trigger: "channel_recipe",
                    payload: input.payload,
                    cron_dedupe_key: `channel:${input.tenant_id}:${slug}:${new Date()
                      .toISOString()
                      .slice(0, 10)}`,
                  }),
              });
              if (result.ok) {
                enqueued += 1;
              } else {
                refused += 1;
                refusals[result.reason] = (refusals[result.reason] ?? 0) + 1;
                if (result.reason === "cap_reached") break;
              }
            } catch (e) {
              refused += 1;
              refusals["threw"] = (refusals["threw"] ?? 0) + 1;
              logger.error(
                `channel-sweep ${tenant.slug}/${slug} threw: ${(e as Error).message}`,
              );
            }
          }
        } catch (e) {
          logger.error(
            `channel-sweep tenant ${tenant.slug} failed: ${(e as Error).message}`,
          );
        }
      }

      return {
        tenants_total: (tenants ?? []).length,
        considered,
        probed,
        probe_changed: probeChanged,
        probe_errors: probeErrors,
        skipped_autopilot_off: skippedAutopilotOff,
        skipped_idle: skippedIdle,
        skipped_none_due: skippedNoneDue,
        state_unreadable: stateUnreadable,
        enqueued,
        refused,
        refusals,
      };
    });

    logger.info(`channel-sweep: ${JSON.stringify(summary)}`);
    return summary;
  },
);
