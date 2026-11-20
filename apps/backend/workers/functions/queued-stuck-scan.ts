
import { runMayUseThread } from "@/services/agents/run-owner";
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { isCanonicalContainer } from "@/services/agents/boot-role";
import { dropForeignRuns } from "@/services/agents/conductor-owner";
import {
  INFRA_RETRY_CAP,
  tryInfraRetryRun,
  willBeInfraRetried,
  isUsageLimitError,
  buildQueuedResendEvent,
  buildChatEarlyResendEvent,
  CHAT_QUEUED_EARLY_RESEND_MIN,
  type InfraRetryRow,
} from "@/services/agents/infra-retry";
import { chatFailureBubbleBody } from "@/services/agents/error-body";
import { runOutageRetrySweep } from "@/services/agents/outage-retry";
import { slackReplyClaimEventId } from "./slack-triage-reply";
import { emitThreadEvent } from "@/services/agents/thread-event";
import { logEvent } from "@/services/logging/logEvent";
import { BUILD_CONDUCTOR_RUN_ID_KEY } from "@/services/billing/tiers";
import { recordChildTerminalAndCheckBatch } from "@/services/agents/batch-fanout-rollup";
import { deriveOutcome } from "@/services/agents/outcome-model";
import {
  fetchChatBucketStuckRows,
  fetchNonChatBucketStuckRows,
  type StuckRunRow,
} from "./stuck-run-query";
import { listAgents } from "@/services/agents/registry";
import { RUNNING_HARD_CAP_HOURS } from "@/services/agents/run-hard-cap";
import { buildRunRequestedEventForRunId, computeRunLane } from "../../src/services/agents/run-lane";

async function ownersThreadOf(
  svc: Parameters<typeof runMayUseThread>[0],
  row: { id: string; tenant_id: string; payload: unknown },
): Promise<string | null> {
  const tid = threadIdOfPayload(row.payload);
  if (!tid) return null;
  return (await runMayUseThread(svc, row.tenant_id, row.id, tid).catch(() => false)) ? tid : null;
}

const QUEUED_STUCK_MIN = 10;
const CHAT_STALE_MIN = 15;
const NONCHAT_STALE_MIN = 30;
const EXPENSIVE_CHAT_STALE_MIN = 15;
const EXPENSIVE_SLUGS: ReadonlySet<string> = new Set(
  listAgents()
    .filter((a) => a.metadata_praxis?.cost_class === "expensive")
    .map((a) => a.slug),
);

export {
  MONEY_PATH_SLUGS,
  isInfraRetryable,
  isUsageLimitError,
  isConfigError,
  willBeInfraRetried,
  buildQueuedResendEvent,
  buildChatEarlyResendEvent,
  CHAT_QUEUED_EARLY_RESEND_MIN,
  QUEUED_RESEND_BUCKET_MS,
} from "@/services/agents/infra-retry";
const INFRA_RETRY_MIN_AGE_MS = 30_000;

type RunRow = StuckRunRow;

function threadIdOfPayload(payload: unknown): string | null {
  return payload && typeof payload === "object"
    ? (((payload as { thread_id?: unknown }).thread_id as
        | string
        | undefined) ?? null)
    : null;
}

export const queuedStuckScanFn = inngest.createFunction(
  { id: "queued-stuck-scan", concurrency: 1 },
  { cron: "*/2 * * * *" },
  async ({ logger }) => {
    if (!isCanonicalContainer()) {
      logger.info("queued-stuck-scan: skipped (not the prod container)");
      return { skipped: "not_canonical" as const };
    }
    const now = Date.now();
    const svc = serviceClient();

    let emitsRetried = 0;
    let emitsFailed = 0;
    {
      const { data: pendingRows, error: pErr } = await svc
        .from("agent_runs")
        .select("id, tenant_id, agent_slug, payload, trigger, status")
        .eq("needs_run_end_emit", true);
      if (pErr) {
        logger.error(
          `queued-stuck-scan select pending run_end emits failed: ${pErr.message}`,
        );
      } else {
        const pending = (pendingRows ?? []) as Array<{
          id: string;
          tenant_id: string;
          agent_slug: string;
          payload: unknown;
          trigger: string | null;
          status: string | null;
        }>;
        for (const row of pending) {
          const isCancelled = row.status === "cancelled";
          try {
            await emitThreadEvent({
              tenant_id: row.tenant_id,
              agent_run_id: row.id,
              agent_slug: row.agent_slug,
              thread_id: await ownersThreadOf(svc, row),
              kind: "run_end",
              body: { status: isCancelled ? "cancelled" : "error", cost_usd: 0 },
            });
            const { error: clearErr } = await svc
              .from("agent_runs")
              .update({ needs_run_end_emit: false })
              .eq("id", row.id);
            if (clearErr) {
              logger.warn(
                `queued-stuck-scan: emit OK but flag-clear failed for ${row.id}: ${clearErr.message}`,
              );
            }
            emitsRetried += 1;
            try {
              await inngest.send({
                id: `${row.id}-terminal-trace`,
                name: "agent.run.terminal",
                data: { run_id: row.id },
              });
            } catch (e) {
              logger.warn(
                `queued-stuck-scan: agent.run.terminal emit failed for ${row.id} (trace skipped): ${(e as Error).message}`,
              );
            }
            if (
              !isCancelled &&
              (row.trigger === "slack" || row.trigger === "email")
            ) {
              try {
                await inngest.send({
                  id: `${row.id}-fallback-completed`,
                  name: "agent.run.completed",
                  data: {
                    run_id: row.id,
                    tenant_id: row.tenant_id,
                    agent_slug: row.agent_slug,
                    status: "dispatch_error",
                  },
                });
              } catch (e) {
                logger.warn(
                  `queued-stuck-scan: fallback agent.run.completed send failed for ${row.id}: ${(e as Error).message}`,
                );
              }
            }
          } catch (e) {
            emitsFailed += 1;
            logger.error(
              `queued-stuck-scan: run_end retry-emit failed for ${row.id}: ${(e as Error).message}`,
            );
          }
        }
      }
    }

    const { data: earlyChatRows, error: earlyErr } = await svc
      .from("agent_runs")
      .select(`id, tenant_id, agent_slug, trigger, batch_id, worker_id, conductor_run_id:payload->>${BUILD_CONDUCTOR_RUN_ID_KEY}`)
      .eq("status", "queued")
      .in("trigger", ["chat", "mcp"])
      .is("batch_id", null)
      .lt(
        "enqueued_at",
        new Date(now - CHAT_QUEUED_EARLY_RESEND_MIN * 60 * 1000).toISOString(),
      )
      .gte(
        "enqueued_at",
        new Date(now - QUEUED_STUCK_MIN * 60 * 1000).toISOString(),
      );
    if (earlyErr) {
      logger.error(
        `queued-stuck-scan: early chat select failed: ${earlyErr.message}`,
      );
    }
    const earlyChat = await dropForeignRuns(
      svc,
      (earlyChatRows ?? []) as Array<{
        id: string;
        tenant_id: string;
        agent_slug: string;
        trigger: string | null;
        batch_id: string | null;
        worker_id?: string | null;
        conductor_run_id?: string | null;
      }>,
      { requireActiveConductor: true },
    );
    for (const row of earlyChat) {
      try {
        await inngest.send(buildChatEarlyResendEvent(row));
      } catch (e) {
        logger.error(
          `queued-stuck-scan: early chat re-send failed for ${row.id}: ${(e as Error).message}`,
        );
      }
    }

    const queuedCutoff = new Date(
      now - QUEUED_STUCK_MIN * 60 * 1000,
    ).toISOString();
    const { data: queuedRows, error: qErr } = await svc
      .from("agent_runs")
      .select(`id, tenant_id, agent_slug, trigger, batch_id, worker_id, conductor_run_id:payload->>${BUILD_CONDUCTOR_RUN_ID_KEY}`)
      .eq("status", "queued")
      .lt("enqueued_at", queuedCutoff);
    if (qErr) {
      throw new Error(`queued-stuck-scan select queued failed: ${qErr.message}`);
    }
    const queued = await dropForeignRuns(
      svc,
      (queuedRows ?? []) as Array<{
        id: string;
        tenant_id: string;
        agent_slug: string;
        worker_id?: string | null;
        conductor_run_id?: string | null;
      }>,
      { requireActiveConductor: true },
    );
    for (const row of queued) {
      try {
        await inngest.send(buildQueuedResendEvent(row, now));
      } catch (e) {
        logger.error(
          `queued-stuck-scan: re-send failed for ${row.id}: ${(e as Error).message}`,
        );
      }
    }

    const hardCapCutoff = new Date(
      now - RUNNING_HARD_CAP_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const chatStaleCutoff = new Date(
      now - CHAT_STALE_MIN * 60 * 1000,
    ).toISOString();
    const nonchatStaleCutoff = new Date(
      now - NONCHAT_STALE_MIN * 60 * 1000,
    ).toISOString();

    const { rows: chatRows, error: chatErr } = await fetchChatBucketStuckRows(
      svc,
      chatStaleCutoff,
      hardCapCutoff,
    );
    if (chatErr) {
      logger.error(
        `queued-stuck-scan select running (chat bucket) failed: ${chatErr.message}`,
      );
    }
    const { rows: nonchatRows, error: nonchatErr } =
      await fetchNonChatBucketStuckRows(svc, nonchatStaleCutoff, hardCapCutoff);
    if (nonchatErr) {
      logger.error(
        `queued-stuck-scan select running (non-chat bucket) failed: ${nonchatErr.message}`,
      );
    }

    const zombies: Array<{ row: RunRow; reason: string }> = [];
    for (const r of await dropForeignRuns(svc, [...chatRows, ...nonchatRows])) {
      const lastActivity = r.last_progress_at ?? r.started_at;
      if (!lastActivity) continue;

      const trigger = r.trigger ?? "manual";
      const isChat = computeRunLane(trigger, r.batch_id) === "interactive";

      if ((r.started_at ?? lastActivity) < hardCapCutoff) {
        zombies.push({
          row: r,
          reason: `watchdog_reap: running >${RUNNING_HARD_CAP_HOURS}h (hard cap)`,
        });
        continue;
      }

      const isExpensiveChat = isChat && EXPENSIVE_SLUGS.has(r.agent_slug);
      if (isExpensiveChat) {
        const ageMin = (now - new Date(lastActivity).getTime()) / 60000;
        if (ageMin < EXPENSIVE_CHAT_STALE_MIN) continue;
      }

      const minutes = isExpensiveChat
        ? EXPENSIVE_CHAT_STALE_MIN
        : isChat
          ? CHAT_STALE_MIN
          : NONCHAT_STALE_MIN;
      zombies.push({
        row: r,
        reason: `watchdog_reap: no progress for >${minutes}min (trigger=${trigger}${isExpensiveChat ? ",cost_class=expensive" : ""})`,
      });
    }

    let reaped = 0;
    let reapEmitFailed = 0;
    for (const z of zombies) {
      const reaped_at = new Date().toISOString();
      const { data: casResult, error: updErr } = await svc
        .from("agent_runs")
        .update({
          status: "failed",
          error: z.reason,
          finished_at: reaped_at,
          needs_run_end_emit: true,
          stop_requested: true,
          outcome: deriveOutcome({ status: "failed", error: z.reason }),
        })
        .eq("id", z.row.id)
        .eq("status", "running")
        .select("id");
      if (updErr) {
        logger.error(
          `queued-stuck-scan reap UPDATE failed for ${z.row.id}: ${updErr.message}`,
        );
        continue;
      }
      if (!casResult || casResult.length === 0) {
        continue;
      }
      reaped += 1;

      try {
        const { settleCustomAgentAltTerminal } = await import("@/services/agents/custom-agent-runs");
        await settleCustomAgentAltTerminal({
          id: z.row.id,
          tenant_id: z.row.tenant_id,
          agent_slug: z.row.agent_slug,
          trigger: z.row.trigger,
          status: "failed",
          error: z.reason,
          infra_retry_count: z.row.infra_retry_count ?? 0,
          last_progress_at: z.row.last_progress_at,
          payload: z.row.payload,
        });
      } catch (e) {
        logger.warn(`queued-stuck-scan: custom agent settle failed for ${z.row.id}: ${(e as Error).message}`);
      }

      let shouldPromote = true;
      if (z.row.batch_id != null && z.row.child_index != null) {
        try {
          const rollup = await recordChildTerminalAndCheckBatch({
            run_id: z.row.id,
            tenant_id: z.row.tenant_id,
            batch_id: z.row.batch_id,
            child_index: z.row.child_index,
            status: "failed",
            reason: z.reason,
          });
          shouldPromote = rollup.batch_complete;
        } catch (e) {
          logger.warn(
            `queued-stuck-scan: batch rollup threw (batch=${z.row.batch_id}, child=${z.row.child_index}): ${(e as Error).message}`,
          );
          shouldPromote = true;
        }
      }

      if (shouldPromote) {
        const reapThreadId = await ownersThreadOf(svc, z.row);
        if (reapThreadId) {
          try {
            const { data: promotedId, error: promoteErr } = await svc.rpc(
              "promote_next_blocked_run",
              { p_tenant_id: z.row.tenant_id, p_thread_id: reapThreadId },
            );
            if (promoteErr) {
              logger.warn(
                `queued-stuck-scan: promote_next_blocked_run failed (thread=${reapThreadId}): ${promoteErr.message}`,
              );
            } else if (promotedId) {
              await inngest.send(
                await buildRunRequestedEventForRunId(svc, promotedId as string, {
                  tenant_id: z.row.tenant_id,
                }),
              );
            }
          } catch (e) {
            logger.warn(
              `queued-stuck-scan: blocked-run promotion threw for thread=${reapThreadId}: ${(e as Error).message}`,
            );
          }
        }
      }

      const startedMs = z.row.started_at ? Date.parse(z.row.started_at) : Date.now();
      await logEvent({
        level: "error",
        source: "runner.watchdog",
        code: "watchdog_reap",
        tenant_id: z.row.tenant_id,
        run_id: z.row.id,
        message: z.reason,
        meta: {
          agent_slug: z.row.agent_slug,
          watchdog_age_ms: Math.max(0, Date.now() - startedMs),
        },
      });

      try {
        await emitThreadEvent({
          tenant_id: z.row.tenant_id,
          agent_run_id: z.row.id,
          agent_slug: z.row.agent_slug,
          thread_id: await ownersThreadOf(svc, z.row),
          kind: "run_end",
          body: { status: "error", cost_usd: 0 },
        });
        const { error: clearErr } = await svc
          .from("agent_runs")
          .update({ needs_run_end_emit: false })
          .eq("id", z.row.id);
        if (clearErr) {
          logger.warn(
            `queued-stuck-scan: emit OK but flag-clear failed for ${z.row.id}: ${clearErr.message}`,
          );
        }
      } catch (e) {
        reapEmitFailed += 1;
        logger.error(
          `queued-stuck-scan: run_end emit failed for reaped ${z.row.id}: ${(e as Error).message}; flag retained for path-0 retry`,
        );
      }
    }

    let infraRetried = 0;
    const retrySettleCutoff = new Date(now - INFRA_RETRY_MIN_AGE_MS).toISOString();
    const { data: infraRows, error: infraErr } = await svc
      .from("agent_runs")
      .select(`id, tenant_id, agent_slug, status, error, infra_retry_count, trigger, batch_id, worker_id, conductor_run_id:payload->>${BUILD_CONDUCTOR_RUN_ID_KEY}, dfy:payload->done_for_you`)
      .in("status", ["dispatch_error", "failed"])
      .is("last_progress_at", null)
      .lt("infra_retry_count", INFRA_RETRY_CAP)
      .lt("finished_at", retrySettleCutoff)
      .limit(50);
    if (infraErr) {
      logger.error(
        `queued-stuck-scan: select infra-retry failed: ${infraErr.message}`,
      );
    }
    for (const r of await dropForeignRuns(
      svc,
      (infraRows ?? []) as Array<
        Omit<InfraRetryRow, "last_progress_at"> & { worker_id?: string | null }
      >,
    )) {
      try {
        const requeued = await tryInfraRetryRun(
          svc,
          inngest,
          { ...r, last_progress_at: null, ...((r as { dfy?: unknown }).dfy != null ? { payload: { done_for_you: (r as { dfy?: unknown }).dfy } } : {}) },
          "scan",
        );
        if (requeued) infraRetried += 1;
      } catch (e) {
        logger.error(
          `queued-stuck-scan: infra-retry failed for ${r.id}: ${(e as Error).message}`,
        );
      }
    }

    let outageRetried = 0;
    try {
      const summary = await runOutageRetrySweep({
        svc,
        send: (ev) => inngest.send(ev),
        slackClaimId: slackReplyClaimEventId,
        log: (e) =>
          logEvent({
            level: e.level,
            source: "outage-retry",
            code: e.code,
            tenant_id: e.tenant_id,
            run_id: e.run_id,
            message: e.message,
            meta: {
              agent_slug: e.agent_slug,
              stage: e.stage,
              failure_class: e.failure_class,
              retry_count: e.retry_count,
            },
          }),
      });
      outageRetried = summary.requeued;
    } catch (e) {
      logger.error(`queued-stuck-scan: outage retry sweep failed: ${(e as Error).message}`);
    }

    try {
      const [{ runFirstPlanWatch }, { firstPlanWatchDeps }] = await Promise.all([
        import("@/services/growth/first-plan-watch"),
        import("@/services/growth/first-plan-watch-deps"),
      ]);
      const summary = await runFirstPlanWatch(await firstPlanWatchDeps(svc));
      if ("started" in summary && summary.started + summary.retried + summary.alerted + summary.resolved + summary.errors + summary.skipped_leaving > 0) {
        logger.info(`queued-stuck-scan: first plan watch ${JSON.stringify(summary)}`);
      }
    } catch (e) {
      logger.error(`queued-stuck-scan: first plan watch failed: ${(e as Error).message}`);
    }

    try {
      const [{ runStalledSetupTakeover }, { stalledSetupDeps }] = await Promise.all([
        import("@/services/growth/stalled-setup"),
        import("@/services/growth/first-plan-watch-deps"),
      ]);
      const summary = await runStalledSetupTakeover(await stalledSetupDeps(svc));
      if ("taken" in summary && summary.taken + summary.errors > 0) {
        logger.info(`queued-stuck-scan: stalled setup takeover ${JSON.stringify(summary)}`);
      }
    } catch (e) {
      const message = (e as Error).message;
      logger.error(`queued-stuck-scan: stalled setup takeover failed: ${message}`);
      try {
        const { stalledTickFailureLogDue } = await import("@/services/growth/stalled-setup");
        if (stalledTickFailureLogDue()) {
          await logEvent({ level: "warn", source: "first-plan-watch", code: "first_plan_stalled_setup_tick_failed", message });
        }
      } catch {
      }
    }

    let bubblesBackfilled = 0;
    const bubbleSettleCutoff = new Date(now - INFRA_RETRY_MIN_AGE_MS).toISOString();
    const { data: chatTermRows, error: chatTermErr } = await svc
      .from("agent_runs")
      .select(
        "id, tenant_id, agent_slug, status, error, infra_retry_count, last_progress_at, payload",
      )
      .eq("trigger", "chat")
      .in("status", ["dispatch_error", "failed"])
      .or(`finished_at.lt.${bubbleSettleCutoff},finished_at.is.null`)
      .order("finished_at", { ascending: false, nullsFirst: false })
      .limit(50);
    if (chatTermErr) {
      logger.error(
        `queued-stuck-scan: select chat failure-bubble backstop failed: ${chatTermErr.message}`,
      );
    }
    for (const r of (chatTermRows ?? []) as Array<{
      id: string;
      tenant_id: string;
      agent_slug: string;
      status: string;
      error: string | null;
      infra_retry_count: number;
      last_progress_at: string | null;
      payload: unknown;
    }>) {
      try {
        if (willBeInfraRetried(r)) continue;
        const thread_id = threadIdOfPayload(r.payload);
        if (!thread_id) continue;
        if (!(await runMayUseThread(svc, r.tenant_id, r.id, thread_id).catch(() => false))) continue;
        const { data: existingReply, error: existErr } = await svc
          .from("agent_thread_messages")
          .select("id")
          .eq("thread_id", thread_id)
          .eq("agent_run_id", r.id)
          .eq("sender_role", "assistant")
          .limit(1)
          .maybeSingle();
        if (existErr) {
          logger.warn(
            `queued-stuck-scan: failure-bubble existing-reply read failed for ${r.id}: ${existErr.message}`,
          );
          continue;
        }
        if (existingReply) continue;
        const { error: rpcErr } = await svc.rpc("record_agent_chat_reply", {
          p_thread_id: thread_id,
          p_tenant_id: r.tenant_id,
          p_expected_agent_slug: r.agent_slug,
          p_run_id: r.id,
          p_body: chatFailureBubbleBody(r.error, r.agent_slug).slice(0, 8000),
          p_meta: {
            trigger: "chat",
            is_error: true,
            failure_class: isUsageLimitError(r.error) ? "usage_limit" : "error_backstop",
          },
        });
        if (rpcErr) {
          logger.warn(
            `queued-stuck-scan: failure-bubble backstop write failed for ${r.id}: ${rpcErr.message}`,
          );
        } else {
          bubblesBackfilled += 1;
        }
      } catch (e) {
        logger.warn(
          `queued-stuck-scan: failure-bubble backstop threw for ${r.id}: ${(e as Error).message}`,
        );
      }
    }

    let steersRerouted = 0;
    try {
      const { data: swept, error: sweepErr } = await svc.rpc(
        "sweep_undrained_steers",
        { p_max_runs: 20 },
      );
      if (sweepErr) {
        logger.warn(`queued-stuck-scan: steer sweep failed: ${sweepErr.message}`);
      } else {
        for (const row of (swept ?? []) as Array<{
          run_id: string;
          tenant_id: string;
          rerouted: number;
          reason: string | null;
        }>) {
          if ((row.rerouted ?? 0) <= 0) {
            if (row.reason) {
              await logEvent({
                level: "warn",
                source: "agent.barge_in",
                code: "steer_dead_lettered",
                run_id: row.run_id,
                tenant_id: row.tenant_id,
                meta: { dead_letter_reason: row.reason },
              });
            }
            continue;
          }
          const { data: fresh } = await svc
            .from("agent_runs")
            .select("id")
            .eq("tenant_id", row.tenant_id)
            .eq("status", "queued")
            .filter("payload->>rerouted_from_run_id", "eq", row.run_id)
            .limit(1);
          const freshId = (fresh?.[0] as { id: string } | undefined)?.id;
          if (!freshId) continue;
          await inngest.send(
            await buildRunRequestedEventForRunId(svc, freshId, {
              tenant_id: row.tenant_id,
            }),
          );
          steersRerouted += 1;
        }
      }
    } catch (e) {
      logger.warn(`queued-stuck-scan: steer sweep threw: ${(e as Error).message}`);
    }

    logger.info(
      `queued-stuck-scan: emits-retried=${emitsRetried} emits-failed=${emitsFailed} queued-resent=${queued.length} reaped=${reaped} reap-emit-failed=${reapEmitFailed} infra-retried=${infraRetried} outage-retried=${outageRetried} bubbles-backfilled=${bubblesBackfilled} steers-rerouted=${steersRerouted}`,
    );
    return {
      emits_retried: emitsRetried,
      emits_failed: emitsFailed,
      resent: queued.length,
      reaped,
      reap_emit_failed: reapEmitFailed,
      infra_retried: infraRetried,
      outage_retried: outageRetried,
      bubbles_backfilled: bubblesBackfilled,
      steers_rerouted: steersRerouted,
    };
  },
);
