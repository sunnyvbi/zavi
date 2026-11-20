
import { runMayUseThread } from "./run-owner";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { emitThreadEvent } from "@/services/agents/thread-event";
import { chatFailureBubbleBody } from "@/services/agents/error-body";
import { deriveOutcome } from "@/services/agents/outcome-model";
import { emitTeamNoteRunEnd } from "@/services/team-notes/emit-run-end";
import { workerId } from "@/services/agents/boot-role";
import { ownerOnlyMayApply } from "@/services/agents/conductor-owner";
import {
  tryInfraRetryRun,
  tryBuildChildResume,
  tryIdempotentAgentResume,
  tryEngineerResume,
  tryOperatorSlackResume,
  buildInfraRetryEvent,
  willBeInfraRetried,
  isUsageLimitError,
  BOOT_REQUEUE_SETTLE_MS,
  INFRA_RETRY_CAP,
  isMoneyPathSlug,
  type InfraRetryRow,
} from "@/services/agents/infra-retry";

const BOOT_REAP_ERROR =
  "boot_reap: orphaned by container restart (worker died mid-run)";

function threadIdOfPayload(payload: unknown): string | null {
  return payload && typeof payload === "object"
    ? (((payload as { thread_id?: unknown }).thread_id as string | undefined) ??
        null)
    : null;
}

type InngestSender = Parameters<typeof tryInfraRetryRun>[1];

export async function reapOrphanedRunsOnBoot(
  bootTsIso: string,
  svc = serviceClient(),
  inngest?: InngestSender,
  opts?: { quarantine?: boolean; workerId?: string; ownRunsOnly?: boolean },
): Promise<{ reaped: number; requeued: number }> {
  const ownRunsOnly = opts?.ownRunsOnly ?? ownerOnlyMayApply();
  const me = opts?.workerId ?? workerId();
  const ownRuns = ownRunsOnly
    ? `worker_id.is.null,worker_id.eq.${me}`
    : me === "canonical"
      ? 'worker_id.is.null,worker_id.not.like."canonical:*"'
      : null;
  const scoped = <Q extends { or: (f: string) => Q }>(q: Q): Q => (ownRuns ? q.or(ownRuns) : q);
  if (opts?.quarantine) {
    await logEvent({
      level: "warn",
      source: "boot-reap",
      code: "boot_reap_quarantined",
    });
    return { reaped: 0, requeued: 0 };
  }

  const { data: orphans, error: selErr } = await scoped(svc
    .from("agent_runs")
    .select(
      "id, tenant_id, agent_slug, status, error, infra_retry_count, last_progress_at, trigger, dfy:payload->done_for_you",
    )
    .eq("status", "running")
    .neq("agent_definition_hash", "local")
    .lt("started_at", bootTsIso));

  if (selErr) {
    await logEvent({
      level: "error",
      source: "boot-reap",
      code: "boot_reap_failed",
      error: new Error(selErr.message),
    });
    return { reaped: 0, requeued: 0 };
  }

  const rows = ((orphans ?? []) as Array<InfraRetryRow & { dfy?: unknown }>).map(({ dfy, ...r }) =>
    dfy != null ? { ...r, payload: { done_for_you: dfy } } : r,
  );

  let requeued = 0;
  const terminalizeIds: string[] = [];
  for (const r of rows) {
    let didRequeue = false;
    if (inngest) {
      try {
        didRequeue = await tryInfraRetryRun(svc, inngest, r, "boot");
        if (!didRequeue) {
          didRequeue = await tryBuildChildResume(svc, inngest, r);
        }
        if (!didRequeue) {
          didRequeue = await tryIdempotentAgentResume(svc, inngest, r);
        }
        if (!didRequeue) {
          didRequeue = await tryEngineerResume(svc, inngest, r);
        }
        if (!didRequeue) {
          didRequeue = await tryOperatorSlackResume(svc, inngest, r);
        }
      } catch (e) {
        await logEvent({
          level: "error",
          source: "boot-reap",
          code: "boot_reap_requeue_failed",
          error: e instanceof Error ? e : new Error(String(e)),
          meta: { run_id: r.id },
        });
        didRequeue = false;
      }
    }
    if (didRequeue) requeued += 1;
    else terminalizeIds.push(r.id);
  }

  let reaped = 0;
  if (terminalizeIds.length > 0) {
    const { data, error } = await svc
      .from("agent_runs")
      .update({
        status: "failed",
        error: BOOT_REAP_ERROR,
        finished_at: bootTsIso,
        needs_run_end_emit: true,
        outcome: deriveOutcome({ status: "failed", error: BOOT_REAP_ERROR }),
      })
      .in("id", terminalizeIds)
      .eq("status", "running")
      .select("id, tenant_id, agent_slug, payload, trigger");
    if (error) {
      await logEvent({
        level: "error",
        source: "boot-reap",
        code: "boot_reap_failed",
        error: new Error(error.message),
      });
    } else {
      const reapedRows = (data ?? []) as Array<{
        id: string;
        tenant_id: string;
        agent_slug: string;
        payload: unknown;
        trigger: string | null;
      }>;
      reaped = reapedRows.length;

      for (const row of reapedRows) {
        if (row.trigger !== "cron" || !row.agent_slug.startsWith("c-")) continue;
        const orphan = rows.find((r) => r.id === row.id);
        try {
          const { settleCustomAgentAltTerminal } = await import("./custom-agent-runs");
          await settleCustomAgentAltTerminal({
            ...row,
            status: "failed",
            error: BOOT_REAP_ERROR,
            infra_retry_count: orphan?.infra_retry_count ?? 0,
            last_progress_at: orphan?.last_progress_at ?? null,
          });
        } catch (e) {
          console.warn(`[boot-reap] custom agent settle failed for ${row.id}: ${(e as Error).message}`);
        }
      }

      const orphanById = new Map(rows.map((r) => [r.id, r]));
      for (const row of reapedRows) {
        if (row.trigger !== "chat") continue;
        const thread_id = threadIdOfPayload(row.payload);
        if (!thread_id) continue;
        if (!(await runMayUseThread(svc, row.tenant_id, row.id, thread_id).catch(() => false))) continue;

        const orphan = orphanById.get(row.id);
        const retryRow: InfraRetryRow = {
          id: row.id,
          tenant_id: row.tenant_id,
          agent_slug: row.agent_slug,
          status: "failed",
          error: BOOT_REAP_ERROR,
          infra_retry_count: orphan?.infra_retry_count ?? 0,
          last_progress_at: orphan?.last_progress_at ?? null,
          trigger: "chat",
        };
        if (willBeInfraRetried(retryRow)) continue;

        await emitTeamNoteRunEnd({
          runId: row.id,
          tenantId: row.tenant_id,
          agentSlug: row.agent_slug,
          trigger: "chat",
          paused: false,
          status: "failed",
          error: BOOT_REAP_ERROR,
          willRetry: false,
          toolCalls: undefined,
          groundingFlags: undefined,
          operatorShapes: undefined,
        });

        try {
          const { data: existingReply, error: existErr } = await svc
            .from("agent_thread_messages")
            .select("id")
            .eq("thread_id", thread_id)
            .eq("agent_run_id", row.id)
            .eq("sender_role", "assistant")
            .limit(1)
            .maybeSingle();
          if (!existErr && !existingReply) {
            const { error: rpcErr } = await svc.rpc("record_agent_chat_reply", {
              p_thread_id: thread_id,
              p_tenant_id: row.tenant_id,
              p_expected_agent_slug: row.agent_slug,
              p_run_id: row.id,
              p_body: chatFailureBubbleBody(BOOT_REAP_ERROR, row.agent_slug).slice(
                0,
                8000,
              ),
              p_meta: {
                trigger: "chat",
                is_error: true,
                failure_class: isUsageLimitError(BOOT_REAP_ERROR)
                  ? "usage_limit"
                  : "error_backstop",
              },
            });
            if (rpcErr) {
              await logEvent({
                level: "warn",
                source: "boot-reap",
                code: "boot_reap_failure_bubble_failed",
                error: new Error(rpcErr.message),
                meta: { run_id: row.id },
              });
            }
          }
        } catch (e) {
          await logEvent({
            level: "warn",
            source: "boot-reap",
            code: "boot_reap_failure_bubble_failed",
            error: e instanceof Error ? e : new Error(String(e)),
            meta: { run_id: row.id },
          });
        }

        try {
          await emitThreadEvent({
            tenant_id: row.tenant_id,
            agent_run_id: row.id,
            agent_slug: row.agent_slug,
            thread_id,
            kind: "run_end",
            body: { status: "error", cost_usd: 0 },
          });
          const { error: clearErr } = await svc
            .from("agent_runs")
            .update({ needs_run_end_emit: false })
            .eq("id", row.id);
          if (clearErr) {
            await logEvent({
              level: "warn",
              source: "boot-reap",
              code: "boot_reap_run_end_flag_clear_failed",
              error: new Error(clearErr.message),
              meta: { run_id: row.id },
            });
          }
        } catch (e) {
          await logEvent({
            level: "warn",
            source: "boot-reap",
            code: "boot_reap_run_end_emit_failed",
            error: e instanceof Error ? e : new Error(String(e)),
            meta: { run_id: row.id },
          });
        }
      }
    }
  }

  if (inngest) {
    const resweepCutoff = new Date(
      new Date(bootTsIso).getTime() - 60 * 60 * 1000,
    ).toISOString();
    const { data: parkedRows, error: parkedErr } = await scoped(svc
      .from("agent_runs")
      .select("id, tenant_id, agent_slug, infra_retry_count, trigger, batch_id")
      .eq("status", "queued")
      .gte("infra_retry_count", 1)
      .lte("infra_retry_count", INFRA_RETRY_CAP)
      .gte("enqueued_at", resweepCutoff));
    if (parkedErr) {
      await logEvent({
        level: "error",
        source: "boot-reap",
        code: "boot_reap_resweep_failed",
        error: new Error(parkedErr.message),
      });
    } else {
      const parked = ((parkedRows ?? []) as Array<{
        id: string;
        tenant_id: string;
        agent_slug: string;
        infra_retry_count: number;
      }>).filter((p) => !isMoneyPathSlug(p.agent_slug));
      if (parked.length > 0) {
        setTimeout(() => {
          void (async () => {
            for (const p of parked) {
              try {
                await inngest.send(buildInfraRetryEvent(p, p.infra_retry_count));
              } catch (e) {
                await logEvent({
                  level: "error",
                  source: "boot-reap",
                  code: "boot_reap_settle_dispatch_failed",
                  error: e instanceof Error ? e : new Error(String(e)),
                  meta: { run_id: p.id },
                });
              }
            }
          })();
        }, BOOT_REQUEUE_SETTLE_MS).unref();
        await logEvent({
          level: "info",
          source: "boot-reap",
          code: "boot_reap_settle_dispatch_scheduled",
          meta: { parked: parked.length, settle_ms: BOOT_REQUEUE_SETTLE_MS },
        });
      }
    }
  }

  if (reaped > 0 || requeued > 0) {
    await logEvent({
      level: "warn",
      source: "boot-reap",
      code: "boot_reap_orphans_handled",
      meta: { reaped, requeued },
    });
  }
  return { reaped, requeued };
}
