
import { serviceClient } from "@/services/supabase";
import { clearWebsiteEditsForTenant } from "@/routes/workspace/website-edits";
import { clearAppliedSiteEdits, siteEditsAppId } from "@/services/sites/site-inline-edits";
import { asTenantId } from "@/services/tenant-client";
import { getAppSetting, getBoolSetting } from "@/services/settings";
import { a2aDispatch } from "@/services/agents/a2a-dispatch";
import { BUILD_CONDUCTOR_RUN_ID_KEY } from "@/services/billing/tiers";
import { isAutopilotClassRun } from "@/services/agents/autopilot-decision-class";
import { consumeClassBudget, decisionClassForStage } from "@/services/agents/class-cap";
import { execCommand, getSandboxHost } from "@/services/sandbox/e2b-client";
import { SITE_REPO_DIR, VITE_DEV_PORT } from "@/services/sites/contract";
import { PREVIEW_CONFIG_WRITE_TIMEOUT_MS, SITE_DEPS_STALE_CMD, STOP_DEV_SERVER_TIMEOUT_MS, STOP_TEMPLATE_DEV_SERVER_CMD, publishWhenReady } from "@/services/sites/sandbox-ready";
import { DEPS_LEFT_NO_MODULES, installSiteDeps } from "@/services/build/deps-install-script";
import { refreshSitePreviewConfigCmd, siteDevStartCmd, sitePreviewConfigRefreshOutcome, writeSitePreviewConfigCmd } from "@/services/sites/preview-picker";
import { CLEAR_FIRST_DRAFT_CMD } from "@/services/sites/first-draft";
import { decideDeployTruth, realDeployTruthPollDeps } from "@/services/pipeline/deploy-truth";
import {
  previewEnabled,
  startPreviewServer,
  PREVIEW_DEFAULT_PORT,
} from "@/services/sandbox/preview";
import { runPostDeployScreenCheck } from "@/services/qa/post-deploy-screen-check";
import { resolveRefineGate } from "@/services/agents/refine-gate";
import { writeNote } from "@/services/memory";
import {
  assembleAppArtifactSummary,
  type AppArtifactSummaryInput,
} from "@/services/agents/app-artifact-summary";
import { looksLikeSeedPlaceholder } from "@/services/provisioning/seed-markers";
import { ROLE_GRANT_ERROR_PREFIX } from "@/services/provisioning/role-grant-check";
import { PARSE_FAILED_USER_ERROR } from "@/services/agents/runner";
import { readProvisionedRepoHeadSha } from "@/services/provisioning/github-repo";
import { realDeployPollDeps, reconcileFailedRow } from "../../../workers/functions/provisioning-deploy-poll";
import { makeSiteDeployDeps } from "@/services/sites/site-deploy-deps";
import { autoPickRecommendedLook, buildAwaitsLook, checkParkedLookRun, SITE_BUILD_WAITS_FOR_LOOK_SETTING } from "@/services/sites/look-wait";
import { siteDesignStore } from "@/services/sites/site-design-store";
import { isStaticEligible, readStaticState, staticRoutingActive } from "@/services/hosting/static-publish";
import { declaredRefineOutcome, type DeclaredRefineOutcome } from "@/services/agents/refine-no-change";
import { isFastPassRouteMiss } from "@/services/sites/site-edit-route";
import {
  acceptanceProbe,
  resolveAcceptanceGateMode,
} from "@/services/provisioning/acceptance-gate-driver";
import type {
  ConductorTickDeps,
  ConductorNode,
  ChildTerminalStatus,
  RepairConfig,
  StaticPublishPlan,
} from "@/services/agents/conductor";
import {
  coerceFailureClass,
  boundFailureReason,
  PUSH_GATE_DEFAULT_MAX_WAIT_MS,
} from "@/services/agents/conductor";

export async function isConductorEnabled(): Promise<boolean> {
  const v = await getAppSetting("conductor_enabled");
  if (v !== undefined) return v === true;
  return process.env.PRAXIS_CONDUCTOR_ENABLED !== "0";
}

export const DEFAULT_REPAIR_MAX_ATTEMPTS = 3;

export const REPAIRABLE_STAGES = ["scaffold", "build", "qa"] as const;

export function isConductorRepairEnabled(): boolean {
  return process.env.PRAXIS_CONDUCTOR_REPAIR_ENABLED !== "0";
}

export async function resolveConductorRepairEnabled(): Promise<boolean> {
  const v = await getAppSetting("conductor_repair_enabled");
  if (v !== undefined) return v === true;
  return isConductorRepairEnabled();
}

export function resolveRepairMaxAttempts(): number {
  const raw = process.env.PRAXIS_CONDUCTOR_REPAIR_MAX_ATTEMPTS;
  const n = raw ? Number(raw) : DEFAULT_REPAIR_MAX_ATTEMPTS;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_REPAIR_MAX_ATTEMPTS;
  return Math.min(Math.floor(n), 10);
}

export function mapChildStatus(
  status: string | null | undefined,
  meta?: { needs_review?: boolean | null; payload?: unknown },
): ChildTerminalStatus {
  if (status === "success") {
    if (meta?.needs_review === true && isAutopilotClassRun(meta.payload)) {
      return "held";
    }
    return "success";
  }
  if (status === "parse_failed" || status === "dispatch_error" || status === "failed") {
    return "failed";
  }
  return "running";
}

const CLAIM_ABANDONED_MS = 5 * 60_000;

async function dispatchViaA2a(input: {
  tenant_id: string;
  conductor_run_id: string;
  target_agent_slug: string;
  payload: Record<string, unknown>;
  dedup_key: string;
}): Promise<{ ok: true; child_run_id: string; adopted?: boolean } | { ok: false; reason: string }> {
  const { dedup_key } = input;
  const claimKey = `${input.conductor_run_id}:${dedup_key}`;
  const sb = serviceClient();
  const { error: claimErr } = await sb
    .from("conductor_dispatch_claims")
    .insert({ conductor_run_id: input.conductor_run_id, dedup_key });
  if (claimErr) {
    if ((claimErr as { code?: string }).code !== "23505") return { ok: false, reason: "dispatch_in_flight" };
    const { data: prior, error: priorErr } = await sb
      .from("dispatch_history")
      .select("target_run_id")
      .eq("tenant_id", input.tenant_id)
      .eq("dedup_key", dedup_key)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (priorErr) return { ok: false, reason: "dispatch_in_flight" };
    const priorId = (prior as { target_run_id?: string | null } | null)?.target_run_id;
    if (priorId) return { ok: true, child_run_id: priorId, adopted: true };
    const { data: orphan, error: orphanErr } = await sb
      .from("agent_runs")
      .select("id")
      .eq("tenant_id", input.tenant_id)
      .eq("payload->>conductor_dispatch_key", claimKey)
      .limit(1)
      .maybeSingle();
    if (orphanErr) return { ok: false, reason: "dispatch_in_flight" };
    const orphanId = (orphan as { id?: string } | null)?.id;
    if (orphanId) return { ok: true, child_run_id: orphanId, adopted: true };
    await sb
      .from("conductor_dispatch_claims")
      .delete()
      .eq("conductor_run_id", input.conductor_run_id)
      .eq("dedup_key", dedup_key)
      .lt("claimed_at", new Date(Date.now() - CLAIM_ABANDONED_MS).toISOString());
    return { ok: false, reason: "dispatch_in_flight" };
  }
  const r = await a2aDispatch({
    tenant_id: input.tenant_id,
    source_agent_slug: "conductor",
    source_run_id: input.conductor_run_id,
    target_agent_slug: input.target_agent_slug,
    payload: {
      ...input.payload,
      [BUILD_CONDUCTOR_RUN_ID_KEY]: input.conductor_run_id,
      conductor_dispatch_key: claimKey,
    },
    dedup_key,
    lineage_key: null,
  });
  if (r.ok) return { ok: true, child_run_id: r.child_run_id };
  if (r.reason !== "deduped") {
    await sb
      .from("conductor_dispatch_claims")
      .delete()
      .eq("conductor_run_id", input.conductor_run_id)
      .eq("dedup_key", dedup_key);
  }
  if (r.reason === "deduped") {
    const { data: priors } = await serviceClient()
      .from("dispatch_history")
      .select("target_run_id")
      .eq("tenant_id", input.tenant_id)
      .eq("dedup_key", dedup_key)
      .order("created_at", { ascending: false })
      .limit(10);
    const candidateIds = (priors ?? [])
      .map((p: { target_run_id?: string }) => p.target_run_id)
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    if (candidateIds.length === 0) {
      console.warn(
        `[conductor-driver] dedupe-recovery lookup miss for ${dedup_key} — node will retry next tick`,
      );
      return { ok: false, reason: "deduped_no_prior_found" };
    }
    const { data: runs } = await serviceClient()
      .from("agent_runs")
      .select("id,status")
      .in("id", candidateIds);
    const rank = (s: string | null) =>
      s === "success" ? 0 : s === "running" ? 1 : s === "queued" ? 2 :
      s === "parse_failed" ? 3 : s === "failed" ? 4 : 5;
    const picked = (runs ?? [])
      .slice()
      .sort((a, b) => rank((a as { status?: string }).status ?? null) - rank((b as { status?: string }).status ?? null))[0];
    const recovered = (picked as { id?: string } | undefined)?.id ?? candidateIds[0];
    if (recovered) return { ok: true, child_run_id: recovered, adopted: true };
    console.warn(
      `[conductor-driver] dedupe-recovery lookup miss for ${dedup_key} — node will retry next tick`,
    );
    return { ok: false, reason: "deduped_no_prior_found" };
  }
  return { ok: false, reason: r.reason };
}

export function repoFullNameFromNode(node: ConductorNode): string | null {
  const target = (node.payload as { target?: { github_full_name?: unknown; repo_url?: unknown } } | null)
    ?.target;
  const full = target?.github_full_name;
  if (typeof full === "string" && /^[^/]+\/[^/]+$/.test(full)) return full;
  const url = target?.repo_url;
  if (typeof url === "string") {
    const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

export async function previewServerAnswers(
  sandbox_id: string,
  port: number,
  exec: typeof execCommand = execCommand,
): Promise<boolean> {
  const res = await exec(
    sandbox_id,
    `curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${port}/`,
    10_000,
  ).catch(() => null);
  const code = Number((res?.stdout ?? "").trim().slice(-3));
  return code >= 200 && code < 400;
}

export async function recordSiteSandboxPreview(input: {
  tenant_id: string;
  repo_full_name: string;
  url: string | null;
  port: number;
  status: "starting" | "live" | "dead";
}): Promise<boolean> {
  const sb = serviceClient();
  const { data: row, error } = await sb
    .from("tenant_sandbox")
    .select("id")
    .eq("tenant_id", input.tenant_id)
    .eq("repo_full_name", input.repo_full_name)
    .maybeSingle();
  if (error) throw new Error(`tenant_sandbox read failed: ${error.message}`);
  const rowId = (row as { id?: string } | null)?.id;
  if (!rowId) return false;
  const { error: rpcErr } = await sb.rpc("set_sandbox_preview", {
    p_id: rowId,
    p_url: input.url,
    p_port: input.port,
    p_status: input.status,
  });
  if (rpcErr) throw new Error(`set_sandbox_preview failed: ${rpcErr.message}`);
  return true;
}

export const PREVIEW_CONFIG_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
const previewConfigRefreshedAt = new Map<string, number>();

export function __resetPreviewConfigRefreshes(): void {
  previewConfigRefreshedAt.clear();
}

async function refreshRunningPreviewConfig(
  e2bId: string,
  opts: { beforeStop?: () => Promise<void>; mayRestart?: () => Promise<boolean> } = {},
  now: () => number = Date.now,
): Promise<boolean> {
  const beforeStop = opts.beforeStop ?? (async () => {});
  const mayRestart = opts.mayRestart;
  const last = previewConfigRefreshedAt.get(e2bId);
  if (last !== undefined && now() - last < PREVIEW_CONFIG_REFRESH_COOLDOWN_MS) return false;
  if (mayRestart && !(await mayRestart())) {
    console.info(`[preview-config] sandbox=${e2bId} refresh deferred: the installed packages are not the lockfile's and a build may be running`);
    return false;
  }
  previewConfigRefreshedAt.set(e2bId, now());
  const res = await execCommand(e2bId, refreshSitePreviewConfigCmd(), 20_000).catch(() => null);
  const outcome = sitePreviewConfigRefreshOutcome(res?.stdout ?? "");
  if (outcome === "unchanged") {
    previewConfigRefreshedAt.delete(e2bId);
    return false;
  }
  const reason = outcome === "rewritten" ? "version-or-sha-drift" : outcome === "newer" ? "running-config-newer" : "refresh-failed";
  console.info(`[preview-config] sandbox=${e2bId} outcome=${outcome ?? "unknown"} reason=${reason}`);
  if (outcome !== "rewritten") return false;
  try {
    await beforeStop();
  } catch (e) {
    previewConfigRefreshedAt.delete(e2bId);
    console.warn(`[preview-config] sandbox=${e2bId} restart skipped: the preview row could not be marked starting: ${(e as Error)?.message ?? e}`);
    return false;
  }
  const stop = await execCommand(e2bId, STOP_TEMPLATE_DEV_SERVER_CMD, STOP_DEV_SERVER_TIMEOUT_MS).catch(() => null);
  if (!stop || stop.exit_code !== 0) {
    console.warn(`[preview-config] sandbox=${e2bId} restart skipped: the running dev server did not stop`);
    return false;
  }
  console.info(`[preview-config] sandbox=${e2bId} restarting the dev server on the new config`);
  return true;
}

async function siteDepsStale(e2bId: string): Promise<boolean> {
  const res = await execCommand(e2bId, SITE_DEPS_STALE_CMD, 20_000).catch(() => null);
  return (res?.stdout ?? "").includes("__deps=stale");
}

async function restartForStaleSiteDeps(e2bId: string, beforeStop: () => Promise<void>): Promise<boolean> {
  if (!(await siteDepsStale(e2bId))) return false;
  try {
    await beforeStop();
  } catch (e) {
    console.warn(`[preview-deps] sandbox=${e2bId} restart skipped: the preview row could not be marked starting: ${(e as Error)?.message ?? e}`);
    return false;
  }
  const stop = await execCommand(e2bId, STOP_TEMPLATE_DEV_SERVER_CMD, STOP_DEV_SERVER_TIMEOUT_MS).catch(() => null);
  if (!stop || stop.exit_code !== 0) {
    console.warn(`[preview-deps] sandbox=${e2bId} restart skipped: the running dev server did not stop`);
    return false;
  }
  console.info(`[preview-deps] sandbox=${e2bId} installed packages do not match the lockfile; reinstalling before the dev server restarts`);
  return true;
}

async function syncSiteDepsBeforeBoot(e2bId: string): Promise<void> {
  const r = await installSiteDeps(e2bId, (id, cmd, t) => execCommand(id, cmd, t));
  if (r.ok) return;
  console.warn(`[preview-deps] sandbox=${e2bId} dependencies not installed: ${r.reason}`);
  if (DEPS_LEFT_NO_MODULES.has(r.reason)) throw new Error("the site's dependency install failed; keeping the preview offline");
}

export const kickPreviewReadiness: { probeReady?: (url: string) => Promise<boolean>; sleep?: (ms: number) => Promise<void> } = {};

export function kickSandboxPreview(input: { tenant_id: string; node: ConductorNode; site?: boolean; onlyIfAnswering?: boolean }): Promise<void> {
  if (!previewEnabled()) {
    console.info(`kickSandboxPreview: skipped for tenant=${input.tenant_id}: preview is switched off`);
    return Promise.resolve();
  }
  const repoFullName = repoFullNameFromNode(input.node);
  if (!repoFullName) {
    console.info(`kickSandboxPreview: skipped for tenant=${input.tenant_id}: the node has no target repo`);
    return Promise.resolve();
  }

  return (async () => {
    const sb = serviceClient();
    const { data: row } = await sb
      .from("tenant_sandbox")
      .select("id, e2b_sandbox_id, preview_status, preview_port")
      .eq("tenant_id", input.tenant_id)
      .eq("repo_full_name", repoFullName)
      .maybeSingle();
    const rowId = (row as { id?: string } | null)?.id;
    const e2bId = (row as { e2b_sandbox_id?: string | null } | null)?.e2b_sandbox_id;
    if (!rowId || !e2bId) {
      console.info(`kickSandboxPreview: skipped for ${repoFullName}: no ${rowId ? "running sandbox" : "sandbox row"} yet`);
      return;
    }
    const r = row as { preview_status?: string | null; preview_port?: number | null };
    const bootPort = input.site ? VITE_DEV_PORT : PREVIEW_DEFAULT_PORT;
    const runningPort = r.preview_port ?? bootPort;
    if (input.site && !input.onlyIfAnswering) await execCommand(e2bId, CLEAR_FIRST_DRAFT_CMD, 15_000).catch(() => null);
    let markedStarting = false;
    if (await previewServerAnswers(e2bId, runningPort)) {
      const markStarting = async () => {
        markedStarting = true;
        const { error } = await sb.rpc("set_sandbox_preview", { p_id: rowId, p_url: null, p_port: runningPort, p_status: "starting" });
        if (error) throw new Error(error.message);
      };
      const restartForConfig = input.site
        ? await refreshRunningPreviewConfig(e2bId, {
            beforeStop: markStarting,
            mayRestart: input.onlyIfAnswering ? async () => !(await siteDepsStale(e2bId)) : undefined,
          })
        : false;
      const restartForDeps =
        !restartForConfig && input.site && !input.onlyIfAnswering ? await restartForStaleSiteDeps(e2bId, markStarting) : false;
      if (!restartForConfig && !restartForDeps) {
        if (r.preview_status === "live" && !markedStarting) return;
        const live = { p_id: rowId, p_url: await getSandboxHost(e2bId, runningPort), p_port: runningPort, p_status: "live" };
        let { error } = await sb.rpc("set_sandbox_preview", live);
        if (error) ({ error } = await sb.rpc("set_sandbox_preview", live));
        if (error) console.warn(`kickSandboxPreview: ${repoFullName} answers but its row was not set live: ${error.message}`);
        return;
      }
    } else if (input.onlyIfAnswering) {
      return;
    }

    let startingWritten = markedStarting;
    if (!startingWritten) {
      try {
        const { error } = await sb.rpc("set_sandbox_preview", {
          p_id: rowId,
          p_url: null,
          p_port: bootPort,
          p_status: "starting",
        });
        startingWritten = !error;
      } catch {
        startingWritten = false;
      }
    }
    if (input.site && !startingWritten) {
      console.warn(`kickSandboxPreview: ${repoFullName} not booted: its preview row could not be marked starting`);
      return;
    }

    try {
      if (input.site && !input.onlyIfAnswering) await syncSiteDepsBeforeBoot(e2bId);
      if (input.site) {
        const w = await execCommand(e2bId, writeSitePreviewConfigCmd(), PREVIEW_CONFIG_WRITE_TIMEOUT_MS).catch(() => null);
        if (!w || w.exit_code !== 0 || w.timed_out) throw new Error("the preview config could not be written");
      }
      const { url, port } = await startPreviewServer(
        e2bId,
        bootPort,
        input.site
          ? { repo_dir: SITE_REPO_DIR, start_cmd: siteDevStartCmd(VITE_DEV_PORT), sanitize_secret_env: true }
          : { sanitize_secret_env: true },
      );
      if (input.site) {
        await sb.rpc("set_sandbox_preview", { p_id: rowId, p_url: url, p_port: port, p_status: "starting" });
        await publishWhenReady(
          { tenant_id: input.tenant_id, repo_full_name: repoFullName, url, port, site_id: repoFullName },
          {
            ...kickPreviewReadiness,
            recordPreview: async (r) => {
              const { error } = await sb.rpc("set_sandbox_preview", { p_id: rowId, p_url: r.url, p_port: r.port, p_status: r.status });
              if (error) console.warn(`kickSandboxPreview: preview row not updated for ${repoFullName}: ${error.message}`);
              return !error;
            },
          },
        );
        return;
      }
      await sb.rpc("set_sandbox_preview", {
        p_id: rowId,
        p_url: url,
        p_port: port,
        p_status: "live",
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `kickSandboxPreview: boot failed for ${repoFullName} (${e2bId}): ${(e as Error).message ?? e}`,
      );
      try {
        await sb.rpc("clear_sandbox_preview", { p_id: rowId, p_final_status: "dead" });
      } catch {
      }
    }
  })().catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`kickSandboxPreview: unexpected error: ${(e as Error).message ?? e}`);
  });
}

export function isAppArtifactIngestEnabled(): boolean {
  return process.env.BUILD_APP_ARTIFACT_INGEST_ENABLED !== "0";
}

function payloadString(node: ConductorNode | undefined, key: string): string | undefined {
  const v = (node?.payload as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function targetFromGraph(graph: ConductorNode[]): {
  repo_url?: string;
  github_full_name?: string;
  default_branch?: string;
} {
  for (const n of graph) {
    const target = (
      n.payload as {
        target?: { repo_url?: unknown; github_full_name?: unknown; default_branch?: unknown };
      } | null
    )?.target;
    if (!target) continue;
    const repo_url = typeof target.repo_url === "string" ? target.repo_url : undefined;
    const github_full_name =
      typeof target.github_full_name === "string" ? target.github_full_name : undefined;
    const default_branch =
      typeof target.default_branch === "string" ? target.default_branch : undefined;
    if (repo_url || github_full_name) return { repo_url, github_full_name, default_branch };
  }
  return {};
}

export function ingestAppArtifact(input: {
  tenant_id: string;
  graph: ConductorNode[];
  deploy_node: ConductorNode;
}): void {
  if (!isAppArtifactIngestEnabled()) return;
  const { tenant_id, graph } = input;
  if (graph.some((n) => (n.payload as { refine_mode?: unknown } | null)?.refine_mode === true)) {
    return;
  }

  void (async () => {
    const company_name =
      payloadString(graph.find((n) => payloadString(n, "company_name")), "company_name") ?? "";
    if (!company_name) return;
    const idea = payloadString(graph.find((n) => payloadString(n, "idea")), "idea");
    const { repo_url, github_full_name, default_branch } = targetFromGraph(graph);

    let live_url: string | undefined;
    try {
      const sb = serviceClient();
      const { data } = await sb
        .from("tenant_resources")
        .select("external_ref")
        .eq("tenant_id", tenant_id)
        .eq("resource_kind", "hosting")
        .eq("mode", "provisioned")
        .order("updated_at", { ascending: false })
        .limit(1);
      const ref = (data as Array<{ external_ref?: { url?: unknown } | null }> | null)?.[0]
        ?.external_ref;
      if (ref && typeof ref.url === "string" && ref.url.trim().length > 0) live_url = ref.url;
    } catch {
    }

    const summaryInput: AppArtifactSummaryInput = {
      company_name,
      ...(idea ? { idea } : {}),
      ...(repo_url ? { repo_url } : {}),
      ...(github_full_name ? { github_full_name } : {}),
      ...(default_branch ? { default_branch } : {}),
      ...(live_url ? { live_url } : {}),
    };
    const summary = assembleAppArtifactSummary(summaryInput);

    try {
      await writeNote(tenant_id, {
        title: summary.title,
        body_markdown: summary.body_markdown,
        note_type: "tenant_project",
        source: "agent_write",
        source_ref: github_full_name ?? repo_url ?? null,
        tags: summary.tags,
        metadata: summary.metadata,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `ingestAppArtifact: writeNote failed for tenant ${tenant_id} (${company_name}): ${
          (e as Error).message ?? e
        }`,
      );
    }
  })().catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`ingestAppArtifact: unexpected error: ${(e as Error).message ?? e}`);
  });
}

export function isBuildDeployStageEnabled(): boolean {
  return process.env.BUILD_DEPLOY_STAGE_ENABLED !== "0";
}

export function isBuildScreenCheckEnabled(): boolean {
  return process.env.BUILD_SCREEN_CHECK_ENABLED !== "0";
}

export function isAcceptanceGateEnabled(): boolean {
  return resolveAcceptanceGateMode() !== "off";
}

export function resolveAcceptanceRepairMaxAttempts(): number {
  const raw = process.env.BUILD_ACCEPTANCE_REPAIR_MAX_ATTEMPTS;
  const n = raw ? Number(raw) : 2;
  if (!Number.isFinite(n) || n < 1) return 2;
  return Math.min(Math.floor(n), 5);
}

export const REFINE_DEPLOY_GATE_MAX_WAIT_MS = 25 * 60 * 1000;

export function refineDeployGateMaxWaitMs(): number {
  const raw = process.env.REFINE_DEPLOY_GATE_MAX_WAIT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return REFINE_DEPLOY_GATE_MAX_WAIT_MS;
  const MIN = 5 * 60 * 1000;
  const MAX = 60 * 60 * 1000;
  return Math.min(Math.max(Math.floor(parsed), MIN), MAX);
}

function extractRefineGate(node?: ConductorNode): {
  pre_refine_sha: string;
  repo_full_name: string;
  default_branch: string;
  enqueued_at: number | null;
  engineer_run_id: string | null;
} | null {
  const p = (node?.payload ?? null) as Record<string, unknown> | null;
  const pre = p?.pre_refine_sha;
  if (typeof pre !== "string" || pre.trim().length === 0) return null;
  const target = (p?.target ?? {}) as Record<string, unknown>;
  const repo_full_name =
    typeof target.github_full_name === "string" ? target.github_full_name : "";
  const default_branch =
    typeof target.default_branch === "string" && target.default_branch.length > 0
      ? target.default_branch
      : "main";
  const rawAt = p?.refine_deploy_enqueued_at;
  const at =
    typeof rawAt === "number"
      ? rawAt
      : typeof rawAt === "string"
        ? Date.parse(rawAt)
        : NaN;
  return {
    pre_refine_sha: pre.trim(),
    repo_full_name,
    default_branch,
    enqueued_at: Number.isFinite(at) ? at : null,
    engineer_run_id:
      typeof p?.refine_engineer_run_id === "string" && p.refine_engineer_run_id.length > 0
        ? p.refine_engineer_run_id
        : null,
  };
}

export function refineCommitServedVerdict(
  served: "live" | "pending" | "failed" | "unknown",
  overBound: boolean,
): "ready" | "failed" | "provisioning" {
  if (served === "failed") return "failed";
  if (served === "pending" && !overBound) return "provisioning";
  return "ready";
}

async function renderServesCommit(
  tenant_id: string,
  sha: string,
): Promise<"live" | "pending" | "failed" | "unknown"> {
  const token = process.env.RENDER_API_KEY;
  if (!token) return "unknown";
  try {
    const { data, error } = await serviceClient()
      .from("tenant_resources")
      .select("external_ref")
      .eq("tenant_id", tenant_id)
      .eq("resource_kind", "hosting")
      .eq("mode", "provisioned")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) return "unknown";
    const ref = (data as Array<{ external_ref?: Record<string, unknown> | null }> | null)?.[0]?.external_ref;
    const serviceId = typeof ref?.render_service_id === "string" ? ref.render_service_id : "";
    if (!serviceId) return "unknown";
    const deploy = await realDeployTruthPollDeps(token).fetchLatestDeploy(serviceId);
    const decision = decideDeployTruth({ deploy, mergedSha: sha, healthOk: true });
    if (decision.kind === "healthy") return "live";
    return decision.kind === "failed" ? "failed" : "pending";
  } catch {
    return "unknown";
  }
}

async function readRunLandedCommit(agent_run_id: string): Promise<string | null> {
  try {
    const { data } = await serviceClient()
      .from("agent_runs")
      .select("commit_sha:parsed->>commit_sha")
      .eq("id", agent_run_id)
      .maybeSingle();
    const sha = (data as { commit_sha?: unknown } | null)?.commit_sha;
    return typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export async function readHostingStatus(
  tenant_id: string,
  node?: ConductorNode,
): Promise<"ready" | "failed" | "provisioning" | "none"> {
  const refine = extractRefineGate(node);
  const routedStatic = await readRoutedStaticVerdict(tenant_id, node, refine?.pre_refine_sha ?? null);
  if (routedStatic) return routedStatic;
  if (!refine) {
    return readBuildDeployStatus(tenant_id, node);
  }

  const base = await readBaseHostingStatus(tenant_id);

  if (base === "failed") return "failed";

  const overBound =
    refine.enqueued_at !== null &&
    Date.now() - refine.enqueued_at > refineDeployGateMaxWaitMs();

  if (base === "ready") {
    const head = await readProvisionedRepoHeadSha(
      refine.repo_full_name,
      refine.default_branch,
    );
    if (head && head !== refine.pre_refine_sha) {
      const own = refine.engineer_run_id ? await readRunLandedCommit(refine.engineer_run_id) : null;
      return refineCommitServedVerdict(await renderServesCommit(tenant_id, own ?? head), overBound);
    }
    return overBound ? "failed" : "provisioning";
  }

  return overBound ? "failed" : "provisioning";
}

async function readHostingRowRaw(
  tenant_id: string,
): Promise<{ error: boolean; status: string | null; url: string | null }> {
  const first = await readHostingRowOnce(tenant_id);
  if (first.status !== "failed") return first;
  const failedAt = first.updated_at ? Date.parse(first.updated_at) : NaN;
  if (!Number.isFinite(failedAt) || Date.now() - failedAt <= FAILED_HOSTING_REPROBE_AFTER_MS) return first;
  const serviceId = typeof first.ref?.render_service_id === "string" ? first.ref.render_service_id : "";
  const probeKey = `${tenant_id}:${serviceId}`;
  const now = Date.now();
  const lastProbe = failedHostingLastProbe.get(probeKey);
  if (lastProbe !== undefined && now - lastProbe < FAILED_HOSTING_REPROBE_INTERVAL_MS) return first;
  for (const [key, at] of failedHostingLastProbe) {
    if (now - at >= FAILED_HOSTING_REPROBE_INTERVAL_MS) failedHostingLastProbe.delete(key);
  }
  failedHostingLastProbe.set(probeKey, now);
  if (!(await recoverFailedHosting(tenant_id, serviceId, first.ref))) return first;
  failedHostingLastProbe.delete(probeKey);
  const again = await readHostingRowOnce(tenant_id);
  return again.error ? first : again;
}

const FAILED_HOSTING_REPROBE_AFTER_MS = 60 * 60 * 1000;
export const FAILED_HOSTING_REPROBE_INTERVAL_MS = 15 * 60 * 1000;
const failedHostingLastProbe = new Map<string, number>();

export function resetFailedHostingProbeBackoff(): void {
  failedHostingLastProbe.clear();
}

async function recoverFailedHosting(
  tenant_id: string,
  serviceId: string,
  ref: Record<string, unknown> | null,
): Promise<boolean> {
  const token = process.env.RENDER_API_KEY;
  if (!token || !serviceId) return false;
  try {
    const fetchFn = (globalThis as { fetch: Parameters<typeof realDeployPollDeps>[1] }).fetch;
    return await reconcileFailedRow(realDeployPollDeps(token, fetchFn), { tenant_id, external_ref: ref }, serviceId);
  } catch {
    return false;
  }
}

async function readHostingRowOnce(
  tenant_id: string,
): Promise<{
  error: boolean;
  status: string | null;
  url: string | null;
  ref: Record<string, unknown> | null;
  updated_at: string | null;
}> {
  const { data, error } = await serviceClient()
    .from("tenant_resources")
    .select("status, external_ref, updated_at")
    .eq("tenant_id", tenant_id)
    .eq("resource_kind", "hosting")
    .eq("mode", "provisioned")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) return { error: true, status: null, url: null, ref: null, updated_at: null };
  const row =
    (
      data as Array<{
        status?: string | null;
        external_ref?: Record<string, unknown> | null;
        updated_at?: string | null;
      }> | null
    )?.[0] ?? null;
  const status = row?.status ?? null;
  const url =
    typeof row?.external_ref?.url === "string" ? (row.external_ref.url as string) : null;
  return {
    error: false,
    status,
    url,
    ref: row?.external_ref ?? null,
    updated_at: typeof row?.updated_at === "string" ? row.updated_at : null,
  };
}

async function readBaseHostingStatus(
  tenant_id: string,
): Promise<"ready" | "failed" | "provisioning" | "none"> {
  const { error, status, url } = await readHostingRowRaw(tenant_id);
  if (error) return "provisioning";
  if (status === "failed") return "failed";
  if (!status) return "none";
  if (status !== "ready") return "provisioning";

  if (process.env.BUILD_DEPLOY_CONTENT_VERIFY === "0") return "ready";
  if (!url) return "ready";
  const servesSeed = await servesSeedPlaceholder(url);
  return servesSeed ? "failed" : "ready";
}

export const BUILD_DEPLOY_GATE_MAX_WAIT_MS = 15 * 60 * 1000;
export const UNPROVISIONED_BUILD_DEPLOY_GATE_MAX_WAIT_MS = 6 * 60 * 1000;

export function buildDeployGateMaxWaitMs(defaultMs: number = BUILD_DEPLOY_GATE_MAX_WAIT_MS): number {
  const raw = process.env.BUILD_DEPLOY_GATE_MAX_WAIT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
  const MIN = 2 * 60 * 1000;
  const MAX = 30 * 60 * 1000;
  return Math.min(Math.max(Math.floor(parsed), MIN), MAX);
}

function extractBuildDeployEnqueuedAt(node?: ConductorNode): number | null {
  const p = (node?.payload ?? null) as Record<string, unknown> | null;
  const raw = p?.deploy_enqueued_at;
  const at =
    typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(at) ? at : null;
}

type ProvisionedRepoTarget = { full_name: string; default_branch: string };

async function readProvisionedRepoTarget(
  tenant_id: string,
): Promise<ProvisionedRepoTarget | "none" | null> {
  try {
    const { data, error } = await serviceClient()
      .from("tenant_resources")
      .select("external_ref")
      .eq("tenant_id", tenant_id)
      .eq("resource_kind", "repo")
      .eq("mode", "provisioned")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) return null;
    const ref = (data as Array<{ external_ref?: Record<string, unknown> | null }> | null)?.[0]?.external_ref;
    const full_name = typeof ref?.github_full_name === "string" ? ref.github_full_name.trim() : "";
    if (!full_name) return "none";
    const default_branch =
      typeof ref?.default_branch === "string" && ref.default_branch.trim().length > 0
        ? ref.default_branch.trim()
        : "main";
    return { full_name, default_branch };
  } catch {
    return null;
  }
}

async function buildCommitServed(
  tenant_id: string,
  repo: ProvisionedRepoTarget | "none" | null,
): Promise<"live" | "pending" | "failed" | "unknown" | "no_target"> {
  if (repo === "none") return "no_target";
  if (!process.env.RENDER_API_KEY) return "unknown";
  if (!repo) return "unknown";
  const head = await readProvisionedRepoHeadSha(repo.full_name, repo.default_branch);
  if (!head) return "unknown";
  return renderServesCommit(tenant_id, head);
}

export async function staticPublishPlan(input: { tenant_id: string; refine: boolean }): Promise<StaticPublishPlan> {
  const state = await readStaticState(input.tenant_id);
  const routed = staticRoutingActive(state);
  if (input.refine && !routed) return { action: "none" };
  const hasDatabase = await tenantHasDatabase(input.tenant_id);
  if (hasDatabase === null) return { action: "none" };
  const verdict = await isStaticEligible({ tenant_id: input.tenant_id, hasDatabase });
  if (!verdict.eligible) return routed ? { action: "rollback" } : { action: "none" };
  const repo = await readProvisionedRepoTarget(input.tenant_id);
  if (!repo || repo === "none") return { action: "none" };
  const sha = await readProvisionedRepoHeadSha(repo.full_name, repo.default_branch);
  return sha ? { action: "publish", sha } : { action: "none" };
}

export async function tenantHasDatabase(tenant_id: string): Promise<boolean | null> {
  try {
    const { data, error } = await serviceClient()
      .from("tenant_resources")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("resource_kind", "db")
      .limit(1);
    if (error) return null;
    return ((data as unknown[] | null) ?? []).length > 0;
  } catch {
    return null;
  }
}

async function readRoutedStaticVerdict(
  tenant_id: string,
  node: ConductorNode | undefined,
  pre_refine_sha: string | null,
): Promise<"ready" | "provisioning" | "failed" | null> {
  let state: Awaited<ReturnType<typeof readStaticState>>;
  try {
    state = await readStaticState(tenant_id);
  } catch {
    return null;
  }
  if (!state || !staticRoutingActive(state)) return null;
  const enqueuedAt = extractBuildDeployEnqueuedAt(node);
  const bound = pre_refine_sha !== null ? refineDeployGateMaxWaitMs() : buildDeployGateMaxWaitMs();
  const wait = (): "provisioning" | "failed" =>
    enqueuedAt !== null && Date.now() - enqueuedAt > bound ? "failed" : "provisioning";
  const repo = await readProvisionedRepoTarget(tenant_id);
  if (!repo || repo === "none") return wait();
  const head = await readProvisionedRepoHeadSha(repo.full_name, repo.default_branch);
  if (!head || head === pre_refine_sha || state.sha !== head) return wait();
  if (state.status === "live") return "ready";
  if (state.status === "failed") return "failed";
  return wait();
}

async function readStaticGateVerdict(
  tenant_id: string,
  node: ConductorNode | undefined,
): Promise<"ready" | "provisioning" | null> {
  const requested = (node?.payload as Record<string, unknown> | null | undefined)?.static_publish_requested_sha;
  if (typeof requested !== "string" || requested.length === 0) return null;
  try {
    const state = await readStaticState(tenant_id);
    if (!state || state.status === "failed") return null;
    const repo = await readProvisionedRepoTarget(tenant_id);
    if (!repo || repo === "none") return null;
    const head = await readProvisionedRepoHeadSha(repo.full_name, repo.default_branch);
    if (!head || state.sha !== head) return null;
    if (state.status === "live") return "ready";
    if (state.status !== "publishing") return null;
    const enqueuedAt = extractBuildDeployEnqueuedAt(node);
    if (enqueuedAt === null) return null;
    return Date.now() - enqueuedAt > buildDeployGateMaxWaitMs() ? null : "provisioning";
  } catch {
    return null;
  }
}

async function readBuildDeployStatus(
  tenant_id: string,
  node?: ConductorNode,
): Promise<"ready" | "failed" | "provisioning" | "none"> {
  const staticVerdict = await readStaticGateVerdict(tenant_id, node);
  if (staticVerdict === "ready") return "ready";
  const render = await readRenderDeployStatus(tenant_id, node);
  if (staticVerdict === "provisioning" && render !== "ready") return "provisioning";
  return render;
}

async function readRenderDeployStatus(
  tenant_id: string,
  node?: ConductorNode,
): Promise<"ready" | "failed" | "provisioning" | "none"> {
  const { error, status, url } = await readHostingRowRaw(tenant_id);
  if (error) return "provisioning";
  if (status === "failed") return "failed";

  const repoTarget = await readProvisionedRepoTarget(tenant_id);
  const maxWaitMs = buildDeployGateMaxWaitMs(
    repoTarget === "none" ? UNPROVISIONED_BUILD_DEPLOY_GATE_MAX_WAIT_MS : BUILD_DEPLOY_GATE_MAX_WAIT_MS,
  );
  const gateEnqueuedAt = extractBuildDeployEnqueuedAt(node);
  const overGateBound =
    gateEnqueuedAt !== null &&
    Date.now() - gateEnqueuedAt > maxWaitMs;
  const gateAgeMin =
    gateEnqueuedAt !== null
      ? Math.round((Date.now() - gateEnqueuedAt) / 60000)
      : null;

  if (!status) {
    if (overGateBound) {
      // eslint-disable-next-line no-console
      console.warn(
        `[deploy-gate] hosting_row_missing_after_deploy_wait tenant=${tenant_id} — failing (no hosting row ${gateAgeMin}min after deploy enqueue)`,
      );
      return "failed";
    }
    return "none";
  }
  if (status !== "ready") {
    if (overGateBound) {
      // eslint-disable-next-line no-console
      console.warn(
        `[deploy-gate] deploy_stalled_non_ready tenant=${tenant_id} status=${status} — failing (${gateAgeMin}min after deploy enqueue)`,
      );
      return "failed";
    }
    return "provisioning";
  }

  const served = await buildCommitServed(tenant_id, repoTarget);
  if (served === "failed") {
    console.warn(
      `[deploy-gate] build_commit_deploy_failed tenant=${tenant_id} — Render failed to deploy the build's final commit`,
    );
    return "failed";
  }
  if (served === "pending" && gateEnqueuedAt !== null) {
    if (overGateBound) {
      console.warn(
        `[deploy-gate] build_commit_not_served_after_deploy_wait tenant=${tenant_id} — failing (${gateAgeMin}min after deploy enqueue)`,
      );
      return "failed";
    }
    return "provisioning";
  }
  if (served === "unknown" && process.env.RENDER_API_KEY && gateEnqueuedAt !== null && !overGateBound) {
    return "provisioning";
  }

  if (process.env.BUILD_DEPLOY_CONTENT_VERIFY === "0") return "ready";
  if (!url) return "ready";

  const content = await probeDeployContent(url);
  if (content === "real") return "ready";

  const enqueuedAt = extractBuildDeployEnqueuedAt(node);
  if (enqueuedAt === null) {
    return content === "seed" ? "failed" : "ready";
  }
  const overBound = Date.now() - enqueuedAt > maxWaitMs;
  return overBound ? "failed" : "provisioning";
}

async function probeDeployContent(
  url: string,
): Promise<"real" | "seed" | "unreachable"> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) return "unreachable";
    const body = await res.text();
    return looksLikeSeedPlaceholder(body) ? "seed" : "real";
  } catch {
    return "unreachable";
  }
}

async function servesSeedPlaceholder(url: string): Promise<boolean> {
  return (await probeDeployContent(url)) === "seed";
}

export type NoChangeChildRow = {
  outcome?: { side_effect?: { kind?: unknown; reason?: unknown; detail?: unknown } | null } | null;
};

export function noChangeEvidenceDetail(child: NoChangeChildRow): string | null {
  const se = child.outcome?.side_effect;
  if (se?.reason === "empty_diff") return typeof se.detail === "string" ? se.detail : null;
  return null;
}

export function noChangeEvidencePasses(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  const fields = new Map(
    detail.split(";").map((kv) => {
      const i = kv.indexOf(":");
      return [kv.slice(0, i), kv.slice(i + 1)] as const;
    }),
  );
  return fields.get("typecheck") === "passed" && fields.get("tests") !== "failed";
}

export function resumeEpochSuffix(payload: unknown): string {
  const e = (payload as { resume_epoch?: unknown } | null | undefined)?.resume_epoch;
  return typeof e === "number" && Number.isInteger(e) && e > 0 ? `:e${e}` : "";
}

export const realConductorTickDeps: ConductorTickDeps = {
  ...(isBuildDeployStageEnabled()
    ? {
        hostingStatus: (tenant_id: string, node?: ConductorNode) =>
          readHostingStatus(tenant_id, node),
      }
    : {}),

  ...(isBuildScreenCheckEnabled()
    ? {
        screenCheck: async ({ tenant_id }: { tenant_id: string }) => {
          const { url } = await readHostingRowRaw(tenant_id);
          return runPostDeployScreenCheck({ url, tenant_id });
        },
      }
    : {}),

  acceptanceProbe: (input: {
    tenant_id: string;
    conductor_run_id: string;
    node: ConductorNode;
    refine?: boolean;
  }) => acceptanceProbe(input),
  acceptanceRepairMaxAttempts: resolveAcceptanceRepairMaxAttempts(),

  siteDeploy: makeSiteDeployDeps(),
  siteAwaitsLook: (input: { tenant_id: string; site_id: string }) =>
    buildAwaitsLook(
      { waitsForLook: (tenant_id) => getBoolSetting(SITE_BUILD_WAITS_FOR_LOOK_SETTING, tenant_id), store: siteDesignStore() },
      input,
    ),
  checkLookPark: checkParkedLookRun,
  autoPickLook: autoPickRecommendedLook,

  async load(conductor_run_id) {
    const { data, error } = await serviceClient()
      .from("conductor_runs")
      .select("id, tenant_id, objective, goal_graph, status, max_usd, spend_usd, kind")
      .eq("id", conductor_run_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const rawKind = (data as { kind?: unknown }).kind;
    return {
      id: data.id as string,
      tenant_id: data.tenant_id as string,
      objective: data.objective as string,
      goal_graph: ((data.goal_graph as ConductorNode[] | null) ?? []),
      status: data.status as "active" | "halted" | "done" | "failed",
      max_usd: data.max_usd === null ? null : Number(data.max_usd),
      spend_usd: Number(data.spend_usd ?? 0),
      kind: rawKind === "company_goal" ? "company_goal" : "build_app",
    };
  },

  async childStatus(child_run_id) {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("status, needs_review, payload")
      .eq("id", child_run_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return mapChildStatus(data?.status as string | undefined, {
      needs_review: (data as { needs_review?: boolean | null } | null)?.needs_review ?? null,
      payload: (data as { payload?: unknown } | null)?.payload,
    });
  },

  async childOutput(child_run_id) {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("output_text")
      .eq("id", child_run_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const out = (data as { output_text?: string | null } | null)?.output_text;
    return typeof out === "string" && out.length > 0 ? out : null;
  },

  async refundBudget(conductor_run_id, amount_usd, refund_key) {
    const { error } = await serviceClient().rpc("refund_conductor_budget", {
      p_conductor_run_id: conductor_run_id,
      p_amount_usd: amount_usd,
      p_refund_key: refund_key,
    });
    if (error) throw new Error(error.message);
  },

  async noChangeCheckpoint({ tenant_id, conductor_run_id, child_run_id, earlier_stage_landed }) {
    const sb = serviceClient();
    const { data: child, error: childErr } = await sb
      .from("agent_runs")
      .select("outcome")
      .eq("id", child_run_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (childErr || !child) return null;
    const detail = noChangeEvidenceDetail(child as NoChangeChildRow);
    if (!noChangeEvidencePasses(detail)) return null;
    const { data: landed, error: landedErr } = await sb
      .from("agent_runs")
      .select("parsed, finished_at")
      .eq("tenant_id", tenant_id)
      .eq("agent_slug", "engineer")
      .eq(`payload->>${BUILD_CONDUCTOR_RUN_ID_KEY}`, conductor_run_id)
      .not("parsed->>commit_sha", "is", null)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (landedErr) return null;
    const sha = (landed as { parsed?: { commit_sha?: unknown } | null } | null)?.parsed?.commit_sha;
    if (typeof sha === "string" && sha.trim().length > 0) return { commit_sha: sha };
    return earlier_stage_landed ? { commit_sha: null } : null;
  },

  async stageCommitSha({ tenant_id, child_run_id }) {
    const { data } = await serviceClient()
      .from("agent_runs")
      .select("parsed")
      .eq("id", child_run_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    const sha = (data as { parsed?: { commit_sha?: unknown } | null } | null)?.parsed?.commit_sha;
    return typeof sha === "string" && sha.trim().length > 0 ? sha : null;
  },

  async childDidNoWork(child_run_id) {
    const { data } = await serviceClient()
      .from("agent_runs")
      .select("status, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, output_text, tool_calls")
      .eq("id", child_run_id)
      .maybeSingle();
    const r = data as {
      status?: string;
      cost_usd?: number | string | null;
      input_tokens?: number | null;
      output_tokens?: number | null;
      cache_read_tokens?: number | null;
      cache_creation_tokens?: number | null;
      output_text?: string | null;
      tool_calls?: unknown;
    } | null;
    if (!r) return false;
    const tokens = [r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens];
    return (
      (r.status === "failed" || r.status === "dispatch_error") &&
      Number(r.cost_usd ?? 0) === 0 &&
      tokens.every((t) => !(Number(t ?? 0) > 0)) &&
      !(typeof r.output_text === "string" && r.output_text.trim().length > 0) &&
      !(Array.isArray(r.tool_calls) && r.tool_calls.length > 0)
    );
  },

  async consumeBudget(conductor_run_id, estimate_usd) {
    const { data, error } = await serviceClient().rpc("consume_conductor_budget_or_reject", {
      p_conductor_run_id: conductor_run_id,
      p_estimate_usd: estimate_usd,
    });
    if (error) throw new Error(error.message);
    return data === "charged" ? "charged" : "over_cap";
  },

  async consumeBudgetOnce(conductor_run_id, estimate_usd, charge_key) {
    const { data, error } = await serviceClient().rpc("consume_conductor_budget_once", {
      p_conductor_run_id: conductor_run_id,
      p_estimate_usd: estimate_usd,
      p_charge_key: charge_key,
    });
    if (error) throw new Error(error.message);
    return data === "charged" || data === "already_charged" ? data : "over_cap";
  },

  async refundBudgetOnce(conductor_run_id, charge_key) {
    const { error } = await serviceClient().rpc("refund_conductor_budget_once", {
      p_conductor_run_id: conductor_run_id,
      p_charge_key: charge_key,
    });
    if (error) throw new Error(error.message);
  },

  consumeClassBudget: (tenant_id, decision_class, estimate_usd) =>
    consumeClassBudget(tenant_id, decision_class, estimate_usd),
  decisionClassForStage: (stage) => decisionClassForStage(stage),

  async updateGoalProgress(tenant_id, goal_id, current_value) {
    const { error } = await serviceClient().rpc("update_goal_progress", {
      p_tenant_id: tenant_id,
      p_goal_id: goal_id,
      p_current_value: current_value,
    });
    if (error) throw new Error(error.message);
  },

  async dispatch(input) {
    const dedup_key = `conductor:${input.conductor_run_id}:${input.node_id}${resumeEpochSuffix(input.payload)}`;
    return dispatchViaA2a({
      tenant_id: input.tenant_id,
      conductor_run_id: input.conductor_run_id,
      target_agent_slug: input.target_agent_slug,
      payload: input.payload,
      dedup_key,
    });
  },

  async captureFailureSignal(child_run_id) {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("error, parse_error, output_text, status")
      .eq("id", child_run_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as
      | {
          error?: string | null;
          parse_error?: string | null;
          output_text?: string | null;
          status?: string | null;
        }
      | null;
    if (!row) return null;
    if (row.error === PARSE_FAILED_USER_ERROR && typeof row.parse_error === "string") {
      const at = row.parse_error.indexOf(`transform_threw:${ROLE_GRANT_ERROR_PREFIX}`);
      if (at >= 0) return row.parse_error.slice(at + "transform_threw:".length).trim().slice(0, 4000);
    }
    for (const field of [row.error, row.parse_error, row.output_text]) {
      const v = typeof field === "string" ? field.trim() : "";
      if (v.length > 0) return v.slice(0, 4000);
    }
    return null;
  },

  async dispatchRepair(input) {
    const dedup_key = `conductor:${input.conductor_run_id}:${input.node_id}:repair:${input.attempt}${resumeEpochSuffix(input.payload)}`;
    return dispatchViaA2a({
      tenant_id: input.tenant_id,
      conductor_run_id: input.conductor_run_id,
      target_agent_slug: input.target_agent_slug,
      payload: input.payload,
      dedup_key,
    });
  },

  repairConfig: ((): RepairConfig => ({
    enabled: isConductorRepairEnabled(),
    maxAttempts: resolveRepairMaxAttempts(),
    repairableStages: [...REPAIRABLE_STAGES],
  }))(),

  async saveGraph(conductor_run_id, goal_graph, _reconcile_spend_delta) {
    const { error } = await serviceClient()
      .from("conductor_runs")
      .update({ goal_graph, updated_at: new Date().toISOString() })
      .eq("id", conductor_run_id)
      .in("status", ["active", "halted"]);
    if (error) throw new Error(error.message);
  },

  async isActive(conductor_run_id) {
    const { data, error } = await serviceClient()
      .from("conductor_runs")
      .select("status")
      .eq("id", conductor_run_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as { status?: string } | null)?.status === "active";
  },

  async stopChild(tenant_id, child_run_id) {
    const { error } = await serviceClient()
      .from("agent_runs")
      .update({ stop_requested: true })
      .eq("tenant_id", tenant_id)
      .eq("id", child_run_id)
      .in("status", ["queued", "running"]);
    if (error) throw new Error(error.message);
  },

  async setStatus(conductor_run_id, status, reason) {
    const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
    if (status === "paused") patch.paused_at = patch.updated_at;
    if (reason) {
      patch.failure_class = coerceFailureClass(reason.failure_class);
      patch.failure_reason = boundFailureReason(reason.failure_reason, "Build failed.");
    }
    const { error } = await serviceClient()
      .from("conductor_runs")
      .update(patch)
      .eq("id", conductor_run_id)
      .eq("status", "active");
    if (error) throw new Error(error.message);
    void (async () => {
      const { data } = await serviceClient()
        .from("sites")
        .select("tenant_id, github_full_name")
        .eq("root_conductor_run_id", conductor_run_id)
        .maybeSingle();
      const site = data as { tenant_id?: string | null; github_full_name?: string | null } | null;
      if (!site?.tenant_id || !site.github_full_name) return;
      const { clearFirstDraftForSite } = await import("@/services/sites/first-draft");
      await clearFirstDraftForSite({ tenant_id: site.tenant_id, repo_full_name: site.github_full_name });
    })().catch(() => undefined);
  },

  startPreview: kickSandboxPreview,

  ingestAppArtifact,

  clearInlineEditsOnRefine: (tenant_id: string) => {
    void clearWebsiteEditsForTenant(tenant_id).catch(() => {});
  },
  clearSiteInlineEditsOnRefine: ({ tenant_id, site_id, rows }) => {
    void clearAppliedSiteEdits(asTenantId(tenant_id), siteEditsAppId(site_id), rows)
      .then((r) => {
        if (r.error) console.error(JSON.stringify({ evt: "site_inline_edits_clear_failed", tenant_id, site_id, cleared: r.cleared, error: r.error.slice(0, 300) }));
      })
      .catch((e: unknown) => {
        console.error(JSON.stringify({ evt: "site_inline_edits_clear_failed", tenant_id, site_id, error: String((e as Error)?.message ?? e).slice(0, 300) }));
      });
  },

  resolveRefineGate,

  childNoActionSignal: readChildNoActionSignal,
  childDeclaredOutcome: readChildDeclaredOutcome,
  childRouteMiss: readChildRouteMiss,
  verifyStagePush: readStagePushLanded,
  pushGateMaxWaitMs: buildPushGateMaxWaitMs,
};

export function conductorScreenCheckClient(): ReturnType<typeof serviceClient> {
  return serviceClient();
}

export function buildPushGateMaxWaitMs(): number {
  const raw = process.env.BUILD_PUSH_GATE_MAX_WAIT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return PUSH_GATE_DEFAULT_MAX_WAIT_MS;
  const MIN = 2 * 60 * 1000;
  const MAX = 30 * 60 * 1000;
  return Math.min(Math.max(Math.floor(parsed), MIN), MAX);
}

export async function readChildDeclaredOutcome(args: { tenant_id: string; child_run_id: string }): Promise<DeclaredRefineOutcome | null> {
  try {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("parsed, outcome")
      .eq("id", args.child_run_id)
      .eq("tenant_id", args.tenant_id)
      .maybeSingle();
    if (error || !data) return null;
    return declaredRefineOutcome(data as { parsed?: unknown; outcome?: unknown });
  } catch {
    return null;
  }
}

export async function readChildRouteMiss(args: { tenant_id: string; child_run_id: string }): Promise<boolean> {
  try {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("parsed, outcome")
      .eq("id", args.child_run_id)
      .eq("tenant_id", args.tenant_id)
      .maybeSingle();
    if (error || !data) return false;
    return isFastPassRouteMiss(data as { parsed?: unknown; outcome?: unknown });
  } catch {
    return false;
  }
}

export async function readChildNoActionSignal(args: {
  tenant_id: string;
  child_run_id: string;
}): Promise<string | null> {
  try {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("parse_error, output_text")
      .eq("id", args.child_run_id)
      .eq("tenant_id", args.tenant_id)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as {
      parse_error?: string | null;
      output_text?: string | null;
    };
    const hasActionMissing = (row.parse_error ?? "")
      .split(";")
      .some((part) => part.trim().startsWith("action_missing:"));
    if (!hasActionMissing) return null;
    const explanation =
      typeof row.output_text === "string" ? row.output_text.trim() : "";
    return (
      explanation || "The build agent finished without proposing a code change."
    );
  } catch {
    return null;
  }
}

export async function readStagePushLanded(args: {
  tenant_id: string;
  child_run_id: string | null;
  repo_full_name: string | null;
}): Promise<"landed" | "missing" | "unknown" | "refused" | "diverted"> {
  const { tenant_id, child_run_id } = args;
  if (!child_run_id) return "unknown";
  try {
    const sb = serviceClient();
    const { data: runRow, error: runErr } = await sb
      .from("agent_runs")
      .select("parsed")
      .eq("id", child_run_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (runErr) return "unknown";
    const parsed = (runRow as { parsed?: unknown } | null)?.parsed;
    const commitSha =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { commit_sha?: unknown }).commit_sha
        : undefined;
    if (typeof commitSha === "string" && commitSha.trim().length > 0) return "landed";
    const prUrl =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { pr_url?: unknown }).pr_url
        : undefined;
    if (typeof prUrl === "string" && prUrl.trim().length > 0) return "diverted";

    const { data: decisions, error: decErr } = await sb
      .from("decisions")
      .select("status, dispatched_at, dispatch_error")
      .eq("tenant_id", tenant_id)
      .eq("agent_run_id", child_run_id)
      .eq("decision_class", "engineer.ship-pr")
      .order("emitted_at", { ascending: false })
      .limit(1);
    if (decErr) return "unknown";
    const row = (decisions as Array<{
      status?: string | null;
      dispatched_at?: string | null;
      dispatch_error?: string | null;
    }> | null)?.[0];
    if (!row) return "missing";
    if (row.status === "dispatch_failed") return "refused";
    if (row.dispatch_error) return "missing";
    if (row.status === "acted" && row.dispatched_at) return "landed";
    return "missing";
  } catch {
    return "unknown";
  }
}
