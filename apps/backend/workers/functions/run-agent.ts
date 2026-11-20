
import { RETIRED_CHANNEL_SLUGS } from "@zavi/shared";
import { MODELS } from "@/services/llm/models";
import { modelUsedFor, routingForPersist } from "./staff-model-model-used";
import { connectGateSlugFor } from "@/services/agents/connect-gate";
import { NonRetriableError } from "inngest";
import { checkStaffModelAtExecution } from "./staff-model-run-gate";
import { readStaffModelOverride } from "@/services/agents/engine/staff-model-override";
import { inngest } from "../client";
import {
  resolveRunAgentGlobalConcurrency,
  resolveBackgroundReserve,
} from "./run-agent-concurrency";
import { serviceClient } from "@/services/supabase";
import { isRunStopRequested } from "@/services/agents/run-stop";
import { isMoneyPathSlug } from "@/services/agents/infra-retry";
import { conductorRunIdOf, stoppedConductorReason } from "@/services/agents/conductor-child-guard";
import {
  AgentNotFoundError,
  buildContext,
  type ClaimedAgentRun,
  claimAgentRun,
  enqueueAgentRun,
  persistTerminal,
  runDispatch,
} from "@/services/agents/runner";
import { makeEmitProgress } from "@/services/agents/progress";
import { loadAgentDefinition } from "@/services/agents/registry";
import { resolveSandboxMode } from "@/services/sandbox/sandbox-enablement-flag";
import { finalizeRun } from "./finalize-run";
import { resolveModelForRun } from "@/services/agents/model-router";
import { MODEL_REFUSAL_CODE } from "@/services/agents/sdk-refusal";
import { hasRunFailureCode } from "@/services/agents/run-failure-code";
import { flushRunTiming, markRunTiming, planBuildFields, recordRunQueueMs } from "@/services/agents/run-timing";
import { estimateRunEta } from "@/services/agents/eta-estimate";
import type { DispatcherResult } from "@/services/agents/types";
import { capDispatchResultForInngest } from "@/services/agents/cap-dispatch-result";
import { ensureAgentRunnable } from "@/services/agents/ensure-runnable";
import { runOriginForTrigger } from "@/services/agents/run-origin";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import {
  shouldDelegateConversationalEngineerToLocal,
  delegateConversationalRunToLocal,
} from "@/services/agents/work-queue";
import { maybeSendUsageLimitAlert } from "@/services/agents/usage-limit-alert";
import {
  bootstrapRepoIfNeeded,
  injectSandboxSecrets,
  sandboxScrubFailureReason,
  pauseAndMarkPaused,
  quarantineSandbox,
  resolveSandboxForRun,
  resolveStoredDefaultBranch,
  sandboxTemplateForRun,
  type SandboxHandle,
} from "@/services/sandbox/lifecycle";
import { payloadSiteId, resolvePayloadSiteBackend, resolveSiteBackendForRepo } from "@/services/sites/site-backend";
import { onSiteSandboxReady } from "@/services/sites/sandbox-ready";
import { CLEAR_FIRST_DRAFT_CMD, isFirstSiteBuildPayload } from "@/services/sites/first-draft";
import {
  createRunWorktree,
  reapOrphanWorktrees,
  removeRunWorktree,
  resolveCheckoutBase,
} from "@/services/sandbox/run-worktree";
import { ensureRunWorktreeDeps } from "@/services/sandbox/shared-install";
import { takeLazyProvisionedSandbox } from "@/services/sandbox/lazy-provision";
import { callMcpTool } from "@/services/mcp/execute";
import {
  execCommand as execSandboxCommand,
  extendSandboxTimeout,
  revokeSandboxGithubToken,
  withSandboxSession,
  ENGINEER_NODE_OPTIONS,
} from "@/services/sandbox/e2b-client";
import { getTenantSandboxKeepalive } from "@/services/sandbox/keepalive-flag";
import { closeAnchorRun } from "@/services/sandbox/browser-mcp/anchor-backend";
import { _clearRunBrowserState } from "@/services/sandbox/browser-mcp/backend";
import { clearCaptureLedger } from "@/services/agents/engine/capture-ledger";
import { clearGroundingReceipts } from "@/services/agents/engine/grounding-receipt-ledger";
import { clearInvestorDbLedger } from "@/services/agents/engine/investor-db-ledger";
import { releaseRunFigures } from "@/services/agents/engine/figure-ledger";
import { cronFailureSummaryText, writeCronRunSummary } from "@/services/agents/cron-summary";
import { pickRepoForTask } from "@/services/sandbox/repo-picker";
import { logEvent } from "@/services/logging/logEvent";
import { runMemoryGate } from "@/services/agents/memory-gate";
import { fillPlaceholderDocs, placeholderDocSlugsFor } from "@/services/memory/fill-placeholder-docs";
import { maybeSendPreviewReadyEmail } from "@/services/growth/preview-ready-email";
import { PREVIEW_RUN_KEY_PREFIX, isCustomAgentSlug } from "@/services/billing/tiers";
import { isDoneForYouClaim } from "@/services/growth/done-for-you";
import { makeDoneForYouCtx } from "@/services/growth/done-for-you-ctx";
import {
  asPreviewRunMode,
  isPreviewClaim,
  previewRunMode,
  makePreviewDryCtx,
  stripDryPreviewResult,
  PREVIEW_RUN_FAILED,
} from "@/services/growth/preview-dry-run";
import {
  maybeSendUpgradeActionsReadyEmail,
  recordPreviewActionTypes,
} from "@/services/growth/preview-upgrade";
import {
  resolveRepoCredsForRun,
  type RepoCredsResolved,
  type RepoCredsNeedsPick,
  type RepoCredsResult,
} from "@/services/sandbox/repo-creds";
import {
  ensureProvisionedBuildDeps,
  hideStaleFirstBuildPreview,
  isFirstBuildScaffold,
  isProvisionedBuildPayload,
  prepareFirstBuildPreview,
} from "@/services/build/first-build-preview";
import {
  checkoutDraftOrThrow,
  isLiveEditPayload,
  kickLiveEditPreview,
} from "@/services/build/live-edit";
export {
  resolveRepoCredsForRun,
  type RepoCredsResolved,
  type RepoCredsNeedsPick,
  type RepoCredsResult,
};

export const REACTIVE_AGENT_SLUGS = new Set([
  "support-lead",
  "trust-safety",
  "dispute-response",
  "qa",
  "listing-quality",
]);

export const SANDBOX_AGENT_SLUGS = new Set(["engineer"]);

const UNIVERSAL_RUN_WORKTREES_DEFAULT = "1";

const WORKTREE_DEPS_AGENTS: ReadonlySet<string> = new Set(["engineer"]);
export function universalRunWorktreesEnabled(
  tenant_id: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.UNIVERSAL_RUN_WORKTREES ?? UNIVERSAL_RUN_WORKTREES_DEFAULT).trim();
  if (raw === "0" || raw.toLowerCase() === "false" || raw.length === 0) return false;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(tenant_id);
}

export function downgradeFollowupToNewPr(
  payload: Record<string, unknown> | null,
): Record<string, unknown> {
  const p = { ...((payload ?? {}) as Record<string, unknown>) };
  const supersededNumber = p.target_pr_number;
  const supersededRepo = p.target_pr_repo;
  delete p.kind;
  delete p.checkout_ref;
  delete p.head_branch;
  delete p.target_pr_number;
  delete p.target_pr_repo;
  delete p.target_pr_url;
  if (typeof supersededNumber === "number") p.superseded_pr_number = supersededNumber;
  if (typeof supersededRepo === "string" && supersededRepo.length > 0) {
    p.superseded_pr_repo = supersededRepo;
    p.repo_hint = supersededRepo;
  }
  return p;
}

export async function engineerFollowupTargetIsLive(
  tenant_id: string,
  run_id: string,
  payload: Record<string, unknown> | null,
  deps: { callMcpTool: typeof callMcpTool } = { callMcpTool },
): Promise<boolean> {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (p.kind !== "engineer_pr_followup") return true;
  const repo = typeof p.target_pr_repo === "string" ? p.target_pr_repo : "";
  const num = typeof p.target_pr_number === "number" ? p.target_pr_number : null;
  const ref = typeof p.checkout_ref === "string" ? p.checkout_ref : "";
  if (!repo.includes("/") || num == null || !ref) return true;
  const [owner, repoName] = repo.split("/");
  let res;
  try {
    res = await deps.callMcpTool(
      { tenant_id, run_id },
      "github",
      "get_pr",
      { owner, repo: repoName, pull_number: num },
    );
  } catch {
    return true;
  }
  if (res.is_error) {
    return !/not_found/i.test(res.content);
  }
  try {
    const pr = JSON.parse(res.content) as {
      state?: string;
      head_branch?: string;
    };
    return pr.state === "open" && pr.head_branch === ref;
  } catch {
    return true;
  }
}

export async function isLocalDelegatedRun(
  sb: ReturnType<typeof serviceClient>,
  run_id: string,
): Promise<boolean> {
  const { data: localItem } = await sb
    .from("agent_work_items")
    .select("id")
    .eq("agent_run_id", run_id)
    .eq("lane", "local")
    .maybeSingle();
  return Boolean(localItem);
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

export function unwrapSettled<T>(r: Settled<T>): T {
  if (!r.ok) throw r.error;
  return r.value;
}

export type RunPrelude = {
  localDelegated: Promise<Settled<boolean>>;
  conductorStopped: Promise<Settled<string | null>>;
  agentDef: Promise<Settled<Awaited<ReturnType<typeof loadAgentDefinition>>>>;
  execGate: Promise<Settled<Awaited<ReturnType<typeof ensureAgentRunnable>>>>;
  sandboxMode: Promise<Settled<Awaited<ReturnType<typeof resolveSandboxMode>> | null>>;
};

export function loadRunPrelude(claim: ClaimedAgentRun, run_id: string): RunPrelude {
  const sb = serviceClient();
  const def = loadAgentDefinition(claim.agent_slug, claim.tenant_id);
  return {
    localDelegated: settle(isLocalDelegatedRun(sb, run_id)),
    conductorStopped: settle(
      conductorRunIdOf(claim.payload) ? stoppedConductorReason(sb, claim) : Promise.resolve(null),
    ),
    agentDef: settle(def),
    execGate: settle(
      ensureAgentRunnable(claim.tenant_id, claim.agent_slug, {
        origin: runOriginForTrigger(claim.trigger),
        run: {
          runId: claim.id,
          trigger: claim.trigger,
          enqueuedByUser: claim.enqueued_by !== null,
          payload: claim.payload,
          cronDedupeKey: claim.cron_dedupe_key ?? null,
        },
        agent: def,
      }),
    ),
    sandboxMode: settle(def.then((d) => (d ? resolveSandboxMode(d, claim.tenant_id) : null))),
  };
}

export async function resolveSiteRunInputs(
  tenant_id: string,
  trigger: string,
  payload: unknown,
  agent: Parameters<typeof connectGateSlugFor>[0]["agent"],
): Promise<{
  siteBackend: Awaited<ReturnType<typeof resolvePayloadSiteBackend>>;
  connectGate: string | null;
  repoCreds: RepoCredsResult | null;
}> {
  const creds = settle(resolveRepoCredsForRun(tenant_id, payload));
  const [siteBackend, connectGate] = await Promise.all([
    resolvePayloadSiteBackend(tenant_id, payload),
    connectGateSlugFor({ tenant_id, agent, trigger, payload }),
  ]);
  if (connectGate !== null) return { siteBackend, connectGate, repoCreds: null };
  return { siteBackend, connectGate, repoCreds: unwrapSettled(await creds) };
}

export function isBatchChildPayload(payload: unknown): boolean {
  const batchId = (payload as { batch_id?: unknown } | null)?.batch_id;
  return typeof batchId === "string" && batchId.length > 0;
}

const RUN_AGENT_PER_TENANT_CONCURRENCY = 5;
const RUN_AGENT_GLOBAL_CONCURRENCY = resolveRunAgentGlobalConcurrency();

export const RUN_AGENT_TENANT_KEY_C8reverified = true;

const RUN_AGENT_BACKGROUND_RESERVE = resolveBackgroundReserve(
  process.env.RUN_AGENT_BACKGROUND_RESERVE,
  RUN_AGENT_GLOBAL_CONCURRENCY,
);

function makeRunAgentFn(opts: { id: string; laneIf: string; globalLimit: number }) {
  return inngest.createFunction(
  {
    id: opts.id,
    retries: 2,
    concurrency: [
      {
        scope: "fn",
        key: "event.data.tenant_id",
        limit: RUN_AGENT_PER_TENANT_CONCURRENCY,
      },
      {
        scope: "account",
        key: '"run-agent-global"',
        limit: opts.globalLimit,
      },
    ],
    onFailure: async ({ event, error }) => {
      const orig = event.data.event as { data?: { run_id?: string } } | undefined;
      const run_id = orig?.data?.run_id;
      if (!run_id) return;
      const message =
        `dispatch failed — Inngest exhausted retries (likely step exceeded the ` +
        `gateway window): ${(error?.message ?? "unknown").slice(0, 300)}`;
      const { data, error: updErr } = await serviceClient()
        .from("agent_runs")
        .update({
          status: "failed",
          error: message,
          finished_at: new Date().toISOString(),
          needs_run_end_emit: true,
        })
        .eq("id", run_id)
        .eq("status", "running")
        .select(
          "id, tenant_id, agent_slug, trigger, payload, infra_retry_count, last_progress_at, custom_agent_id, custom_trigger_id",
        );
      if (updErr) {
        await logEvent({
          level: "error",
          source: "worker.run-agent.onFailure",
          code: "onfailure_cas_error",
          run_id,
          error: new Error(updErr.message),
        });
        return;
      }
      if (!data || data.length === 0) return;
      await logEvent({
        level: "error",
        source: "worker.run-agent.onFailure",
        code: "run_terminal_onfailure",
        tenant_id: data[0].tenant_id,
        run_id,
        error,
        meta: { agent_slug: data[0].agent_slug },
      });
      try {
        const { settleCustomAgentAltTerminal } = await import("@/services/agents/custom-agent-runs");
        await settleCustomAgentAltTerminal({ ...data[0], status: "failed", error: message });
      } catch (e) {
        console.warn(`[run-agent] custom agent settle failed for ${run_id}: ${(e as Error).message}`);
      }
    },
  },
  { event: "agent.run.requested", if: opts.laneIf },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id;

    const memoryGate = await runMemoryGate(step, run_id);
    if (memoryGate.held) {
      logger.info(
        `run-agent: run_id=${run_id} held for onboarding memory (${memoryGate.iterations} checks, ended: ${memoryGate.reason})`,
      );
    }

    const claim = await step.run("claim", () => claimAgentRun(run_id));
    if (!claim) {
      logger.info(`run-agent: claim returned null for run_id=${run_id}; skipping`);
      return { skipped: true, reason: "not-queued" };
    }
    await step.run("emit-claimed", () => makeEmitProgress(run_id, claim.tenant_id)("claimed"));
    const emitWorker = makeEmitProgress(run_id, claim.tenant_id);
    markRunTiming(run_id, "claimed");
    recordRunQueueMs(run_id, claim.queue_ms);
    const prelude = loadRunPrelude(claim, run_id);

    const localDelegated = unwrapSettled(await prelude.localDelegated);
    if (localDelegated) {
      logger.info(
        `run-agent: run_id=${run_id} is local-lane delegated; skipping cloud dispatch (laptop owns it)`,
      );
      return { skipped: true, reason: "local-delegated" };
    }

    const conductorStopped = unwrapSettled(await prelude.conductorStopped);
    if (conductorStopped) {
      await step.run("finalize-conductor-stopped", async () => {
        const { error } = await serviceClient()
          .from("agent_runs")
          .update({
            status: "failed",
            error: conductorStopped,
            finished_at: new Date().toISOString(),
            needs_run_end_emit: true,
          })
          .eq("id", run_id)
          .eq("status", "running");
        if (error) throw new Error(`finalize conductor-stopped run failed: ${error.message}`);
      });
      logger.info(`run-agent: run_id=${run_id} not started: ${conductorStopped}`);
      return { skipped: true, reason: "conductor-stopped" };
    }

    const execGate = unwrapSettled(await prelude.execGate);
    const staffGate = execGate.runnable
      ? await checkStaffModelAtExecution(serviceClient(), claim.tenant_id, claim.payload)
      : ({ ok: true } as const);
    const claimedChannel = (claim.payload as { channel_slug?: unknown } | null)?.channel_slug;
    const retiredChannel =
      typeof claimedChannel === "string" && RETIRED_CHANNEL_SLUGS.has(claimedChannel)
        ? claimedChannel
        : RETIRED_CHANNEL_SLUGS.has(claim.agent_slug)
          ? claim.agent_slug
          : null;
    if (!execGate.runnable || !staffGate.ok || retiredChannel) {
      const gateReason = retiredChannel
        ? "channel_retired"
        : !execGate.runnable
          ? execGate.reason
          : "staff_model_refused";
      const gateError = retiredChannel
        ? `blocked at execution: channel_retired — ${retiredChannel}`
        : !execGate.runnable
          ? `blocked at execution: ${execGate.reason} — ${execGate.detail}`
          : `blocked at execution: staff_model_refused — ${staffGate.ok ? "" : staffGate.reason}`;
      const { data: gateRows } = await serviceClient()
        .from("agent_runs")
        .update({
          status: "failed",
          error: gateError,
          finished_at: new Date().toISOString(),
          needs_run_end_emit: true,
        })
        .eq("id", run_id)
        .eq("status", "running")
        .select(
          "id, tenant_id, agent_slug, trigger, payload, infra_retry_count, last_progress_at, custom_agent_id, custom_trigger_id",
        );
      if (Array.isArray(gateRows) && gateRows.length === 1) {
        try {
          const { settleCustomAgentAltTerminal } = await import("@/services/agents/custom-agent-runs");
          await settleCustomAgentAltTerminal({ ...gateRows[0], status: "failed", error: gateError });
        } catch (e) {
          console.warn(`[run-agent] custom agent settle failed for ${run_id}: ${(e as Error).message}`);
        }
      }
      if (claim.trigger === "channel_recipe") {
        try {
          await tenantRpc(asTenantId(claim.tenant_id), "record_channel_run", {
            p_run_id: run_id,
          });
        } catch (e) {
          console.warn(
            `[run-agent] record_channel_run failed for gated run ${run_id}: ${(e as Error).message}`,
          );
        }
      }
      logger.info(
        `run-agent: run_id=${run_id} blocked at execution (${gateReason}); finalized failed`,
      );
      return { skipped: true, reason: `gate:${gateReason}` };
    }

    try {
      if (
        !payloadSiteId(claim.payload) &&
        !readStaffModelOverride(claim.payload) &&
        await shouldDelegateConversationalEngineerToLocal(
          claim.tenant_id,
          claim.agent_slug,
          claim.trigger,
          run_id,
        )
      ) {
        await delegateConversationalRunToLocal({
          run_id,
          tenant_id: claim.tenant_id,
          agent_slug: claim.agent_slug,
          trigger: claim.trigger,
          payload: claim.payload,
        });
        logger.info(
          `run-agent: run_id=${run_id} handed to laptop local lane (engineer_runs_local); skipping cloud dispatch`,
        );
        return { skipped: true, reason: "handed-to-local" };
      }
    } catch (e) {
      logger.warn(
        `run-agent: local delegation failed for run_id=${run_id}; executing on cloud instead: ${(e as Error).message}`,
      );
    }

    let sandbox: SandboxHandle | null = null;
    let tokenRevokeFailed = false;
    let sitePrepared = false;
    const revokeToken = async (): Promise<void> => {
      try {
        await revokeSandboxGithubToken(sandbox!.e2b_sandbox_id, {
          NODE_OPTIONS: ENGINEER_NODE_OPTIONS,
        });
      } catch (e) {
        tokenRevokeFailed = true;
        await quarantineSandbox(sandbox!, {
          source: "run-agent-pre-model",
          tenant_id: claim.tenant_id,
          reason: (e as Error)?.message ?? String(e),
        });
        throw e;
      }
    };
    const provisionedBuildDeps = async () => {
      const deps = await ensureProvisionedBuildDeps(sandbox!.e2b_sandbox_id);
      if (!deps.ok) {
        console.warn(`[run-agent ${run_id}] provisioned build deps ${deps.reason} (continuing)`);
      }
      return deps;
    };
    let worktreeCreated = false;
    let lazySandboxEligible = false;
    let sandboxRepoFullName: string | null = null;
    let provisionedRepoFullName: string | null = null;

    let dispatchResult: DispatcherResult | undefined;
    let previewDry = false;

    try {
      const agentDef = unwrapSettled(await prelude.agentDef);
      const preludeMode = unwrapSettled(await prelude.sandboxMode);
      const siteRun =
        payloadSiteId(claim.payload) && agentDef && preludeMode?.requires_sandbox && !preludeMode.lazyEligible
          ? await step.run("resolve-site-run", () =>
              resolveSiteRunInputs(claim.tenant_id, claim.trigger, claim.payload, agentDef),
            )
          : null;
      if (siteRun) {
        claim.payload = {
          ...((claim.payload ?? {}) as Record<string, unknown>),
          site_backend: siteRun.siteBackend,
        };
      }
      if (payloadSiteId(claim.payload) && !siteRun) {
        const siteBackend = await step.run("resolve-site-backend", () =>
          resolvePayloadSiteBackend(claim.tenant_id, claim.payload),
        );
        claim.payload = {
          ...((claim.payload ?? {}) as Record<string, unknown>),
          site_backend: siteBackend,
        };
      }
      if (agentDef) {
        const sandboxMode = preludeMode ?? (await resolveSandboxMode(agentDef, claim.tenant_id));
        agentDef.metadata_praxis.requires_sandbox = sandboxMode.requires_sandbox;
        lazySandboxEligible = sandboxMode.lazyEligible;
      }
      const deferToConnectGate = siteRun
        ? siteRun.connectGate !== null
        : !!agentDef?.metadata_praxis.requires_sandbox &&
        !lazySandboxEligible &&
        (await step.run("connect-gate-check", () =>
          connectGateSlugFor({
            tenant_id: claim.tenant_id,
            agent: agentDef,
            trigger: claim.trigger,
            payload: claim.payload,
          }),
        )) !== null;
      if (agentDef?.metadata_praxis.requires_sandbox && !lazySandboxEligible && !deferToConnectGate) {
        let repoCreds =
          (siteRun?.repoCreds as RepoCredsResult | null | undefined) ??
          (await step.run("resolve-repo-creds", () =>
            resolveRepoCredsForRun(claim.tenant_id, claim.payload),
          ));

        if (repoCreds.kind === "needs_pick") {
          const taskDescription =
            claim.payload && typeof claim.payload === "object"
              ? String(
                  (claim.payload as { task_description?: unknown })
                    .task_description ?? "",
                )
              : "";
          const decision = await step.run("repo-picker", () =>
            pickRepoForTask({
              task_description: taskDescription,
              repos: repoCreds.kind === "needs_pick" ? repoCreds.repos : [],
              tenant_id: claim.tenant_id,
            }),
          );

          if (decision.decision === "ask") {
            await step.run("persist-repo-ask", async () => {
              const sb = serviceClient();
              const threadId =
                claim.payload &&
                typeof claim.payload === "object" &&
                typeof (claim.payload as { thread_id?: unknown }).thread_id ===
                  "string"
                  ? ((claim.payload as { thread_id?: string }).thread_id as string)
                  : null;
              if (threadId) {
                const { error: rpcErr } = await sb.rpc(
                  "record_agent_chat_reply",
                  {
                    p_thread_id: threadId,
                    p_tenant_id: claim.tenant_id,
                    p_expected_agent_slug: claim.agent_slug,
                    p_run_id: run_id,
                    p_body: decision.message,
                    p_meta: {
                      awaiting_repo_pick: true,
                      repos:
                        repoCreds.kind === "needs_pick" ? repoCreds.repos : [],
                      pending_task_description: taskDescription,
                    },
                  },
                );
                if (rpcErr) {
                  console.warn(
                    `[run-agent ${run_id}] record_agent_chat_reply (repo-ask) failed: ${rpcErr.message}`,
                  );
                }
              }
              await sb
                .from("agent_runs")
                .update({
                  status: "success",
                  parse_ok: true,
                  output_text: decision.message,
                  finished_at: new Date().toISOString(),
                  error: null,
                  cost_tokens: 0,
                  cost_usd: 0,
                })
                .eq("id", run_id);
            });
            await emitWorker("persisted");
            await emitWorker("completed", { code: "awaiting_repo_pick" });
            try {
              await step.sendEvent("emit-terminal-repo-pick", {
                name: "agent.run.terminal",
                data: { run_id },
              });
            } catch (e) {
              logger.warn(
                `run-agent: agent.run.terminal emit failed for ${run_id} (repo-pick path, trace skipped): ${(e as Error).message}`,
              );
            }
            return { run_id, status: "needs_repo_pick" as const };
          }

          const merged = {
            ...((claim.payload ?? {}) as Record<string, unknown>),
            repo_hint: decision.repo,
          };
          claim.payload = merged;

          {
            const threadIdForStick =
              claim.payload &&
              typeof claim.payload === "object" &&
              typeof (claim.payload as { thread_id?: unknown }).thread_id === "string"
                ? ((claim.payload as { thread_id?: string }).thread_id as string)
                : null;
            if (threadIdForStick) {
              await step.run("persist-haiku-pick-per-thread", async () => {
                const { error: stickErr } = await serviceClient()
                  .from("agent_threads")
                  .update({ repo_full_name: decision.repo })
                  .eq("id", threadIdForStick)
                  .eq("tenant_id", claim.tenant_id);
                if (stickErr) {
                  logger.warn(
                    `[run-agent ${run_id}] persist-per-thread-repo failed for thread ${threadIdForStick}: ${stickErr.message}`,
                  );
                }
              });
            }
          }

          repoCreds = await step.run("resolve-repo-creds-retry", () =>
            resolveRepoCredsForRun(claim.tenant_id, merged),
          );
          if (repoCreds.kind !== "resolved") {
            throw new Error(
              `repo-picker returned non-connected repo "${decision.repo}"; please pass an explicit repo_hint.`,
            );
          }
        }

        if (repoCreds.kind !== "resolved") {
          throw new Error("internal: repoCreds not resolved after pick branch");
        }
        const resolvedCreds = repoCreds;
        sandboxRepoFullName = resolvedCreds.repo_full_name;

        claim.payload = {
          ...((claim.payload ?? {}) as Record<string, unknown>),
          repo_hint: resolvedCreds.repo_full_name,
        };

        if (!payloadSiteId(claim.payload)) {
          const siteRef = await step.run("resolve-site-for-repo", () =>
            resolveSiteBackendForRepo(claim.tenant_id, resolvedCreds.repo_full_name),
          );
          if (siteRef) {
            claim.payload = {
              ...((claim.payload ?? {}) as Record<string, unknown>),
              site_id: siteRef.site_id,
              site_backend: siteRef.site_backend,
            };
          }
        }

        const inSiteSession = <T,>(fn: () => Promise<T>): Promise<T> =>
          payloadSiteId(claim.payload) ? withSandboxSession(claim.tenant_id, fn) : fn();
        sandbox = await step.run("resolve-sandbox", () =>
          inSiteSession(() => resolveSandboxForRun({
            tenant_id: claim.tenant_id,
            repo_full_name: resolvedCreds.repo_full_name,
            installation_token: resolvedCreds.installation_token,
            template: sandboxTemplateForRun(claim.agent_slug, claim.payload),
            run_id,
            provisioned: resolvedCreds.provisioned === true,
          })),
        );

        const injectSecrets = () =>
          injectSandboxSecrets(sandbox!.e2b_sandbox_id, {
            GITHUB_TOKEN: resolvedCreds.installation_token,
            ...(claim.agent_slug === "engineer"
              ? { NODE_OPTIONS: ENGINEER_NODE_OPTIONS }
              : {}),
          });

        const bootstrapRepo = () =>
          bootstrapRepoIfNeeded(
            sandbox!.e2b_sandbox_id,
            resolvedCreds.repo_full_name,
            claim.tenant_id,
          );

        const siteIdForRun = (claim.payload as { site_id?: unknown } | null)?.site_id;
        const siteReadyId =
          resolvedCreds.provisioned === true && typeof siteIdForRun === "string" && siteIdForRun.trim()
            ? siteIdForRun.trim()
            : null;
        const siteSandboxReady = (site_id: string) =>
          onSiteSandboxReady(
            {
              tenant_id: claim.tenant_id,
              run_id,
              site_id,
              repo_full_name: resolvedCreds.repo_full_name,
              e2b_sandbox_id: sandbox!.e2b_sandbox_id,
            },
            undefined,
            { payload: claim.payload },
          );
        sitePrepared =
          siteReadyId !== null &&
          claim.agent_slug === "engineer" &&
          !isFirstBuildScaffold(claim.payload) &&
          !isLiveEditPayload(claim.payload) &&
          !isBatchChildPayload(claim.payload);
        if (siteReadyId !== null && sitePrepared) {
          await step.run("prepare-site-sandbox", () =>
            withSandboxSession(claim.tenant_id, async () => {
              try {
                await injectSecrets();
                await bootstrapRepo();
              } catch (e) {
                await revokeToken().catch(() => undefined);
                throw e;
              }
              await revokeToken();
              const preview = await siteSandboxReady(siteReadyId);
              const deps =
                isProvisionedBuildPayload(claim.payload) && preview !== "preview_starting" ? await provisionedBuildDeps() : null;
              return { preview, deps };
            }),
          );
        } else {
          await step.run("inject-secrets", injectSecrets);
          await step.run("bootstrap-repo", bootstrapRepo);
          if (siteReadyId !== null) {
            await step.run("site-sandbox-ready", () => siteSandboxReady(siteReadyId));
          }
        }

        if (resolvedCreds.provisioned === true && isFirstBuildScaffold(claim.payload)) {
          await step.run("hide-stale-first-build-preview", () =>
            hideStaleFirstBuildPreview(
              claim.tenant_id,
              resolvedCreds.repo_full_name,
              serviceClient() as unknown as Parameters<typeof hideStaleFirstBuildPreview>[2],
              sandbox!.e2b_sandbox_id,
            ).catch(() => "none" as const),
          );
        }

        if (resolvedCreds.provisioned === true && isLiveEditPayload(claim.payload)) {
          const defaultBranch = await step.run("resolve-live-edit-base", () =>
            resolveStoredDefaultBranch(claim.tenant_id, resolvedCreds.repo_full_name),
          );
          await step.run("checkout-live-edit-draft", () =>
            checkoutDraftOrThrow(sandbox!.e2b_sandbox_id, defaultBranch || "main"),
          );
        }

        if (resolvedCreds.provisioned === true) provisionedRepoFullName = resolvedCreds.repo_full_name;

        const isBatchChild = isBatchChildPayload(claim.payload);
        const wantsWorktree =
          isBatchChild ||
          (!resolvedCreds.provisioned &&
            universalRunWorktreesEnabled(claim.tenant_id));
        if (wantsWorktree && sandbox) {
          const defaultBase = await step.run("resolve-default-branch", () =>
            resolveStoredDefaultBranch(
              claim.tenant_id,
              resolvedCreds.repo_full_name,
            ),
          );
          if (
            (claim.payload as { kind?: unknown } | null)?.kind ===
            "engineer_pr_followup"
          ) {
            const live = await step.run("revalidate-pr-followup", () =>
              engineerFollowupTargetIsLive(
                claim.tenant_id,
                run_id,
                claim.payload as Record<string, unknown> | null,
              ),
            );
            if (!live) {
              const downgraded = downgradeFollowupToNewPr(
                claim.payload as Record<string, unknown> | null,
              );
              await step.run("persist-followup-downgrade", async () => {
                const { error: dErr } = await serviceClient()
                  .from("agent_runs")
                  .update({ payload: downgraded })
                  .eq("id", run_id)
                  .eq("tenant_id", claim.tenant_id);
                if (dErr) {
                  throw new Error(
                    `followup downgrade persist failed for ${run_id}: ${dErr.message}`,
                  );
                }
                return { ok: true };
              });
              claim.payload = downgraded;
            }
          }

          const base = resolveCheckoutBase({
            payload: claim.payload as Record<string, unknown> | null,
            defaultBase,
          });

          await step.run("opportunistic-reap-worktrees", async () => {
            try {
              const sbReap = serviceClient();
              const { data: liveRuns } = await sbReap
                .from("agent_runs")
                .select("id, payload")
                .eq("tenant_id", claim.tenant_id)
                .in("status", ["queued", "running", "blocked"]);
              const keep = (liveRuns ?? [])
                .filter((r) => {
                  const rh = (r.payload as { repo_hint?: unknown } | null)?.repo_hint;
                  return typeof rh !== "string" || rh.length === 0
                    || rh === resolvedCreds.repo_full_name;
                })
                .map((r) => r.id as string);
              if (!keep.includes(run_id)) keep.push(run_id);
              await reapOrphanWorktrees({
                sandbox_id: sandbox!.e2b_sandbox_id,
                keepRunIds: keep,
              });
            } catch (e) {
              console.warn(
                `[run-agent ${run_id}] opportunistic reap failed (continuing): ${(e as Error).message}`,
              );
            }
            return { ok: true };
          });

          const wt = await step.run("create-run-worktree", () =>
            createRunWorktree({
              sandbox_id: sandbox!.e2b_sandbox_id,
              run_id,
              base,
              fetchBase: base !== defaultBase,
              defaultBase,
              tenant_id: claim.tenant_id,
              agent_slug: claim.agent_slug,
            }),
          );
          if (wt.ok) {
            worktreeCreated = true;
            if (wt.treeKb != null) {
              const measuredKb = wt.treeKb;
              await step.run("persist-measured-tree-kb", async () => {
                try {
                  const { error: pErr } = await serviceClient().rpc(
                    "set_sandbox_measured_tree_kb",
                    {
                      p_tenant_id: claim.tenant_id,
                      p_repo_full_name: resolvedCreds.repo_full_name,
                      p_kb: measuredKb,
                    },
                  );
                  if (pErr) {
                    console.error(
                      `persist measured_tree_kb failed for ${run_id}: ${pErr.message}`,
                    );
                  }
                } catch (e) {
                  console.error(
                    `persist measured_tree_kb failed for ${run_id}:`,
                    e,
                  );
                }
                return { ok: true };
              });
            }
            if (WORKTREE_DEPS_AGENTS.has(claim.agent_slug)) {
              const wtPath = wt.path;
              await step.run("worktree-deps", async () => {
                const deps = await ensureRunWorktreeDeps({
                  sandbox_id: sandbox!.e2b_sandbox_id,
                  worktree_path: wtPath,
                });
                if (deps.outcome !== "ok") {
                  console.warn(
                    `[run-agent ${run_id}] worktree deps ${deps.outcome}${deps.code ? ` (${deps.code})` : ""} (continuing)`,
                  );
                }
                return { outcome: deps.outcome, ms: deps.ms ?? null };
              });
            }
            if (wt.fellBack) {
              const downgraded = downgradeFollowupToNewPr(
                claim.payload as Record<string, unknown> | null,
              );
              await step.run("persist-followup-downgrade-fellback", async () => {
                const { error: dErr } = await serviceClient()
                  .from("agent_runs")
                  .update({ payload: downgraded })
                  .eq("id", run_id)
                  .eq("tenant_id", claim.tenant_id);
                if (dErr) {
                  throw new Error(
                    `followup downgrade (fellBack) persist failed for ${run_id}: ${dErr.message}`,
                  );
                }
                return { ok: true };
              });
              claim.payload = { ...downgraded, _mt_repo_root: wt.path };
            } else {
              claim.payload = {
                ...((claim.payload ?? {}) as Record<string, unknown>),
                _mt_repo_root: wt.path,
              };
            }
          } else {
            const wtMsg = `per-run worktree create failed for run=${run_id}: ${wt.error}`;
            if (wt.code === "worktree_timeout") {
              throw new NonRetriableError(`worktree_timeout: ${wtMsg}`);
            }
            if (wt.code === "worktree_insufficient_disk") {
              await step.run("record-insufficient-disk-intent", async () => {
                try {
                  if (wt.treeKb != null) {
                    const { error: pErr } = await serviceClient().rpc(
                      "set_sandbox_measured_tree_kb",
                      {
                        p_tenant_id: claim.tenant_id,
                        p_repo_full_name: resolvedCreds.repo_full_name,
                        p_kb: wt.treeKb,
                      },
                    );
                    if (pErr) {
                      console.error(
                        `persist measured_tree_kb (insufficient) failed for ${run_id}: ${pErr.message}`,
                      );
                    }
                  }
                  const { error: iErr } = await serviceClient().rpc(
                    "mark_sandbox_needs_recreate",
                    {
                      p_tenant_id: claim.tenant_id,
                      p_repo_full_name: resolvedCreds.repo_full_name,
                      p_reason: "insufficient_disk",
                    },
                  );
                  if (iErr) {
                    console.error(
                      `mark_sandbox_needs_recreate failed for ${run_id}: ${iErr.message}`,
                    );
                  }
                } catch (e) {
                  console.error(
                    `record insufficient_disk intent failed for ${run_id}:`,
                    e,
                  );
                }
                return { ok: true };
              });
              throw new NonRetriableError(`worktree_insufficient_disk: ${wtMsg}`);
            }
            throw new Error(wtMsg);
          }
        }
      }

      if (sandbox && claim.agent_slug === "engineer" && !sitePrepared) {
        await step.run("revoke-sandbox-github-token", revokeToken);

        const provisionedRepo = provisionedRepoFullName;
        if (provisionedRepo !== null && isFirstBuildScaffold(claim.payload)) {
          await step.run("first-build-preview-install", () =>
            prepareFirstBuildPreview(sandbox!.e2b_sandbox_id),
          );
        }

        if (
          provisionedRepo !== null &&
          !isFirstBuildScaffold(claim.payload) &&
          (isProvisionedBuildPayload(claim.payload) || isLiveEditPayload(claim.payload))
        ) {
          await step.run("provisioned-build-deps", provisionedBuildDeps);
        }

        if (provisionedRepo !== null && isLiveEditPayload(claim.payload)) {
          await step.run("kick-live-edit-preview", () => {
            kickLiveEditPreview({
              tenant_id: claim.tenant_id,
              repo_full_name: provisionedRepo,
              sandbox_id: sandbox!.e2b_sandbox_id,
              run_id,
            });
            return true;
          });
        }
      }

      if (!agentDef) throw new AgentNotFoundError(claim.agent_slug);
      const ctx = { model: modelUsedFor(claim.payload, agentDef.metadata_praxis.model) };

      const previewMode = isPreviewClaim(claim)
        ? asPreviewRunMode(
            await step.run("preview-dry", async () => {
              const mode = await previewRunMode(claim);
              if (mode.dry && !mode.keepCards) await recordPreviewActionTypes(claim.tenant_id, run_id, []);
              return mode;
            }),
          )
        : { dry: false, keepCards: false };
      previewDry = previewMode.dry;
      const previewKeepCards = previewMode.keepCards;

      if (placeholderDocSlugsFor(claim.agent_slug).length > 0) {
        await step.run("fill-placeholder-docs", () =>
          fillPlaceholderDocs(claim.tenant_id, claim.agent_slug),
        );
      }

      const result = (dispatchResult = await step.run("dispatch", async () => {
        markRunTiming(run_id, "loaded_context");
        await emitWorker("loaded_context");
        try {
          let fullCtx;
          try {
            markRunTiming(run_id, "ctx_build_start");
            void estimateRunEta(claim.tenant_id, claim.agent_slug);
            fullCtx = await buildContext(claim, run_id);
            if (previewDry) fullCtx = makePreviewDryCtx(fullCtx, { keepCards: previewKeepCards });
            else if (isDoneForYouClaim(claim)) fullCtx = makeDoneForYouCtx(fullCtx);
            markRunTiming(run_id, "ctx_build_end");
          } catch (ctxErr) {
            if (ctxErr && typeof ctxErr === "object") {
              (ctxErr as { praxis_context_build_failure?: boolean })
                .praxis_context_build_failure = true;
            }
            throw ctxErr;
          }
          if (sandbox && sandboxRepoFullName) {
            fullCtx.worker_sandbox = {
              repo_full_name: sandboxRepoFullName,
              e2b_sandbox_id: sandbox.e2b_sandbox_id,
            };
          }
          if (isDoneForYouClaim(claim)) {
            const { data: first, error: claimErr } = await tenantRpc(asTenantId(claim.tenant_id), "claim_done_for_you_dispatch", {
              p_run_id: run_id,
            });
            if (claimErr) {
              const e = new Error(`done-for-you dispatch claim unreadable: ${claimErr.message}`);
              (e as { praxis_context_build_failure?: boolean }).praxis_context_build_failure = true;
              throw e;
            }
            if (first !== true) throw new NonRetriableError("done-for-you run not replayed after an interrupted dispatch");
          }
          const routing = readStaffModelOverride(claim.payload)
            ? null
            : await resolveModelForRun(fullCtx, claim.payload);
          if (routing?.effective) {
            fullCtx.agent.metadata_praxis.model = routing.model;
          }
          markRunTiming(run_id, "dispatch_start");
          const rawDispatchResult = await runDispatch(fullCtx, claim.payload);
          markRunTiming(run_id, "dispatch_end");
          const persistedRouting = routingForPersist(claim.payload, routing);
          if (persistedRouting) {
            (rawDispatchResult as DispatcherResult).routing = persistedRouting;
          }
          const dispatchResult = previewDry
            ? stripDryPreviewResult(rawDispatchResult as DispatcherResult)
            : rawDispatchResult;
          return capDispatchResultForInngest(dispatchResult as DispatcherResult);
        } catch (e) {
          let msg = (e as Error).message ?? "unknown dispatch error";
          if (
            msg !== "run_cancelled" &&
            /aborted by user/i.test(msg) &&
            (await isRunStopRequested(run_id))
          ) {
            throw new NonRetriableError("run_cancelled");
          }
          if (msg === "run_cancelled") throw e;
          if (previewDry) {
            e = new Error(PREVIEW_RUN_FAILED);
            msg = PREVIEW_RUN_FAILED;
          }
          const stack = previewDry ? "" : ((e as Error).stack ?? "");
          try {
            await serviceClient()
              .from("agent_runs")
              .update({ error: `dispatch_inner: ${msg}\n${stack.slice(0, 800)}` })
              .eq("id", run_id);
          } catch (updateErr) {
            console.error(
              `[run-agent] inner update failed for ${run_id}:`,
              (updateErr as Error).message,
            );
          }
          await emitWorker("tool_use_errored", {
            code: `dispatch:${msg.slice(0, 80).replace(/\s+/g, " ")}`,
          });
          await logEvent({
            level: "error",
            source: "worker.run-agent",
            code: "dispatch_inner_throw",
            tenant_id: claim.tenant_id,
            run_id,
            error: e,
            meta: { agent_slug: claim.agent_slug, error_class: (e as Error).name },
          });
          const isContextBuildFailure =
            !!e &&
            typeof e === "object" &&
            (e as { praxis_context_build_failure?: boolean })
              .praxis_context_build_failure === true;
          if (hasRunFailureCode(e)) {
            throw new NonRetriableError(msg);
          }
          if (msg.startsWith(`${MODEL_REFUSAL_CODE}:`)) {
            throw new NonRetriableError(msg);
          }
          if (isDoneForYouClaim(claim) && !isContextBuildFailure) {
            throw new NonRetriableError(`done-for-you run not auto-retried: ${msg}`);
          }
          if (
            (isMoneyPathSlug(claim.agent_slug) || isCustomAgentSlug(claim.agent_slug)) &&
            !isContextBuildFailure
          ) {
            throw new NonRetriableError(
              `money-path run not auto-retried (${claim.agent_slug}): ${msg}`,
            );
          }
          throw e;
        }
      }));

      const finalized = await finalizeRun(
        {
          run_id,
          tenant_id: claim.tenant_id,
          agent_slug: claim.agent_slug,
          trigger: claim.trigger,
          model: ctx.model,
          result,
          payload: claim.payload,
          preview: previewDry,
        },
        {
          step: {
            run: step.run.bind(step),
            sendEvent: (id, payload) =>
              step.sendEvent(
                id,
                payload as Parameters<typeof step.sendEvent>[1],
              ),
          },
          emitWorker,
          rebuildContext: () => buildContext(claim, run_id),
        },
      );
      if (previewDry && !previewKeepCards) {
        try {
          await step.run("preview-action-types", () =>
            recordPreviewActionTypes(claim.tenant_id, run_id, result.preview_action_types ?? []),
          );
        } catch (e) {
          try {
            await step.run("log-preview-action-types-failed", () =>
              logEvent({
                level: "warn",
                source: "worker.run-agent",
                code: "preview_action_types_failed",
                tenant_id: claim.tenant_id,
                run_id,
                error: e,
              }),
            );
          } catch {
            console.warn(`run-agent: preview action-types warning failed for ${run_id}`);
          }
        }
        try {
          await step.sendEvent("preview-upgrade-after-dry-run", {
            name: "growth.preview_upgrade.requested",
            data: { run_id, tenant_id: claim.tenant_id },
          });
        } catch (e) {
          await logEvent({
            level: "warn",
            source: "worker.run-agent",
            code: "preview_rerun_request_failed",
            tenant_id: claim.tenant_id,
            run_id,
            error: e,
          });
        }
      }
      if (claim.cron_dedupe_key?.startsWith(PREVIEW_RUN_KEY_PREFIX)) {
        await step.run("preview-ready-email", async () => {
          try {
            return previewDry
              ? await maybeSendPreviewReadyEmail(claim.tenant_id)
              : await maybeSendUpgradeActionsReadyEmail(claim.tenant_id);
          } catch (e) {
            return { sent: false, reason: `error: ${(e as Error).message}` };
          }
        });
      }
      return finalized;
    } catch (e) {
      const rawMessage = (e as Error).message ?? "unknown error";
      const failedStepId = (e as { stepId?: unknown })?.stepId;
      const message =
        previewDry && rawMessage !== "run_cancelled" ? PREVIEW_RUN_FAILED : rawMessage;
      if (message !== rawMessage) e = new Error(message);
      const isCancelled = message === "run_cancelled";
      if (!isCancelled) {
        const err = e;
        await step.run("log-terminal-error", () =>
          logEvent({
            level: "error",
            source: "worker.run-agent",
            code: "run_terminal_error",
            tenant_id: claim.tenant_id,
            run_id,
            error: err,
            meta: {
              agent_slug: claim.agent_slug,
              error_class: (err as Error).name,
              ...(typeof failedStepId === "string" ? { stage: failedStepId } : {}),
            },
          }),
        );
      }
      await flushRunTiming(
        run_id,
        { agent_slug: claim.agent_slug, trigger: claim.trigger, outcome: isCancelled ? "cancelled" : "failed", ...planBuildFields(claim.payload) },
        claim.tenant_id,
      );
      await step.run("persist-failure", () =>
        persistTerminal(
          run_id,
          claim.agent_slug,
          dispatchResult ?? null,
          message,
          modelUsedFor(claim.payload, MODELS.anthropic.sonnet),
          claim.payload,
          claim.trigger,
        ),
      );
      if (!isCancelled) {
        await step.run("emit-failed-progress", () =>
          emitWorker("failed", { code: "dispatch_error" }),
        );
        await step.sendEvent("emit-failed", {
          name: "agent.run.failed",
          data: {
            run_id,
            tenant_id: claim.tenant_id,
            agent_slug: claim.agent_slug,
            error: message,
          },
        });
      }

      try {
        await step.sendEvent("emit-terminal", {
          name: "agent.run.terminal",
          data: { run_id },
        });
      } catch (e2) {
        logger.warn(
          `run-agent: agent.run.terminal emit failed for ${run_id} on failure path (trace skipped): ${(e2 as Error).message}`,
        );
      }

      if (claim.cron_dedupe_key?.startsWith(PREVIEW_RUN_KEY_PREFIX)) {
        try {
          await step.sendEvent("preview-upgrade-after-failure", {
            name: "growth.preview_upgrade.requested",
            data: { run_id, tenant_id: claim.tenant_id },
          });
        } catch (e3) {
          await logEvent({
            level: "warn",
            source: "worker.run-agent",
            code: "preview_rerun_request_failed",
            tenant_id: claim.tenant_id,
            run_id,
            error: e3,
          });
        }
        await step.run("preview-ready-email-after-failure", async () => {
          try {
            return {
              free: await maybeSendPreviewReadyEmail(claim.tenant_id),
              upgrade: await maybeSendUpgradeActionsReadyEmail(claim.tenant_id),
            };
          } catch (err) {
            return { sent: false, reason: `error: ${(err as Error).message}` };
          }
        });
      }

      if (claim.trigger === "cron" && !isCancelled) {
        try {
          await step.run("cron-summary-failure", () =>
            writeCronRunSummary({
              tenant_id: claim.tenant_id,
              agent_slug: claim.agent_slug,
              run_id,
              status: "dispatch_error",
              cost_usd: null,
              summary_text: cronFailureSummaryText(message, claim.agent_slug),
            }),
          );
        } catch (e) {
          logger.warn(
            `run-agent: cron summary on-failure write also failed for ${run_id}: ${(e as Error).message}`,
          );
        }
      }
      if (isCancelled) {
        return { run_id, status: "cancelled" as const, error: null };
      }
      try {
        await maybeSendUsageLimitAlert({
          message,
          run_id,
          tenant_id: claim.tenant_id,
          agent_slug: claim.agent_slug,
        });
      } catch (e) {
        logger.warn(
          `run-agent: usage-limit alert hook failed for ${run_id}: ${(e as Error).message}`,
        );
      }
      return { run_id, status: "dispatch_error" as const, error: message };
    } finally {
      try {
        await closeAnchorRun(run_id, "run_end");
      } catch (e) {
        console.warn(
          `[run-agent ${run_id}] closeAnchorRun failed: ${(e as Error).message}`,
        );
      }

      try {
        _clearRunBrowserState(run_id);
      } catch (e) {
        console.warn(
          `[run-agent ${run_id}] _clearRunBrowserState failed: ${(e as Error).message}`,
        );
      }

      try {
        clearCaptureLedger(run_id);
      } catch (e) {
        console.warn(
          `[run-agent ${run_id}] clearCaptureLedger failed: ${(e as Error).message}`,
        );
      }

      try {
        clearGroundingReceipts(run_id);
      } catch (e) {
        console.warn(
          `[run-agent ${run_id}] clearGroundingReceipts failed: ${(e as Error).message}`,
        );
      }

      try {
        const { data: st } = await serviceClient().from("agent_runs").select("status").eq("tenant_id", claim.tenant_id).eq("id", run_id).maybeSingle<{ status: string }>();
        releaseRunFigures(run_id, st?.status ?? null);
      } catch (e) {
        releaseRunFigures(run_id, null);
        console.warn(`[run-agent ${run_id}] figure ledger status read failed: ${(e as Error).message}`);
      }

      try {
        clearInvestorDbLedger(run_id);
      } catch (e) {
        console.warn(
          `[run-agent ${run_id}] clearInvestorDbLedger failed: ${(e as Error).message}`,
        );
      }

      if (!sandbox) {
        try {
          const adopted = takeLazyProvisionedSandbox(run_id);
          if (adopted) {
            sandbox = adopted.handle;
            sandboxRepoFullName = adopted.repo_full_name;
          }
        } catch (e) {
          console.warn(
            `[run-agent ${run_id}] lazy sandbox adoption failed: ${(e as Error).message}`,
          );
        }
      }
      if (sandbox) {
        if (provisionedRepoFullName !== null && isFirstSiteBuildPayload(claim.payload)) {
          try {
            await execSandboxCommand(sandbox.e2b_sandbox_id, CLEAR_FIRST_DRAFT_CMD, 15_000);
          } catch (e) {
            console.warn(`[run-agent ${run_id}] first draft not cleared: ${(e as Error).message}`);
          }
        }
        if (worktreeCreated) {
          try {
            await removeRunWorktree({
              sandbox_id: sandbox.e2b_sandbox_id,
              run_id,
            });
          } catch (e) {
            console.warn(
              `[run-agent ${run_id}] removeRunWorktree failed: ${(e as Error).message}`,
            );
          }
        }

        let liveSharerOnSandbox = false;
        let sharerKind = "";
        try {
          const sbGuard = serviceClient();
          const { data: selfRow } = await sbGuard
            .from("agent_runs")
            .select("batch_id")
            .eq("id", run_id)
            .maybeSingle();
          const batchId = (selfRow?.batch_id as string | null) ?? null;
          if (batchId) {
            const { count, error: cntErr } = await sbGuard
              .from("agent_runs")
              .select("id", { count: "exact", head: true })
              .eq("batch_id", batchId)
              .eq("status", "running")
              .neq("id", run_id);
            if (!cntErr && (count ?? 0) > 0) {
              liveSharerOnSandbox = true;
              sharerKind = "batch sibling";
            }
          }
          if (!liveSharerOnSandbox) {
            const { data: sharers, error: shErr } = await sbGuard
              .from("agent_runs")
              .select("id, payload")
              .eq("tenant_id", claim.tenant_id)
              .eq("status", "running")
              .neq("id", run_id)
              .in("agent_slug", Array.from(SANDBOX_AGENT_SLUGS));
            if (!shErr) {
              const repo = sandboxRepoFullName;
              liveSharerOnSandbox = (sharers ?? []).some((r) => {
                const rh = (r.payload as { repo_hint?: unknown } | null)?.repo_hint;
                return (
                  typeof rh !== "string" || rh.length === 0 || rh === repo
                );
              });
              if (liveSharerOnSandbox) sharerKind = "concurrent sandbox run";
            }
          }
        } catch (e) {
          console.warn(
            `[run-agent ${run_id}] live-sharer guard query failed — proceeding with teardown: ${(e as Error).message}`,
          );
        }

        let scrubFailure = await sandboxScrubFailureReason(sandbox, tokenRevokeFailed);

        if (scrubFailure) {
        } else if (liveSharerOnSandbox) {
          console.log(
            `[run-agent ${run_id}] running ${sharerKind} on shared sandbox — skipping secret-wipe + pause; last run out will tear down`,
          );
        } else {
          try {
            await revokeSandboxGithubToken(sandbox.e2b_sandbox_id);
          } catch (e) {
            scrubFailure = { reason: (e as Error)?.message ?? String(e), retiredElsewhere: false };
          }
        }

        if (scrubFailure) {
          await quarantineSandbox(sandbox, {
            source: "run-agent-teardown",
            tenant_id: claim.tenant_id,
            reason: scrubFailure.reason,
            alreadyRetired: scrubFailure.retiredElsewhere,
          });
        } else if (!liveSharerOnSandbox) {
          const keepalive = await getTenantSandboxKeepalive(claim.tenant_id);
          if (keepalive) {
            try {
              await extendSandboxTimeout(sandbox.e2b_sandbox_id);
              console.log(
                `[run-agent ${run_id}] sandbox keepalive ON for tenant=${claim.tenant_id} — extended timeout; e2b will auto-pause after ${Math.round(50)}min idle`,
              );
            } catch (e) {
              console.warn(
                `[run-agent ${run_id}] extendSandboxTimeout failed — falling back to pause: ${(e as Error).message}`,
              );
              await pauseAndMarkPaused(sandbox);
            }
          } else {
            await pauseAndMarkPaused(sandbox);
          }
        }
      }
    }
  },
  );
}

export const runAgentFn = makeRunAgentFn({
  id: "run-agent",
  laneIf: "event.data.lane != 'interactive'",
  globalLimit: Math.max(
    1,
    RUN_AGENT_GLOBAL_CONCURRENCY - RUN_AGENT_BACKGROUND_RESERVE,
  ),
});

export const runAgentInteractiveFn = makeRunAgentFn({
  id: "run-agent-interactive",
  laneIf: "event.data.lane == 'interactive'",
  globalLimit: RUN_AGENT_GLOBAL_CONCURRENCY,
});

{
  const bgLimit = RUN_AGENT_GLOBAL_CONCURRENCY - RUN_AGENT_BACKGROUND_RESERVE;
  if (bgLimit < 1 || bgLimit > RUN_AGENT_GLOBAL_CONCURRENCY) {
    throw new Error(
      `[run-agent split] invalid concurrency: G=${RUN_AGENT_GLOBAL_CONCURRENCY} ` +
        `reserve=${RUN_AGENT_BACKGROUND_RESERVE} -> bgLimit=${bgLimit} (need 1 <= bgLimit <= G)`,
    );
  }
}
