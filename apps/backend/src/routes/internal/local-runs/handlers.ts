
import { MODELS } from "@/services/llm/models";
import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { macWorkerAuth, getMacWorker } from "./auth";
import { serviceClient } from "@/services/supabase";
import { assertTokenTenantEnabled } from "@/services/auth/mac-worker-token";
import { getRepoInstallationToken } from "@/services/connectors/github/oauth";
import {
  resolveRepoFullName,
  RepoResolutionError,
} from "@/services/agents/repo-resolver";
import { loadAgentDefinition } from "@/services/agents/registry";
import { getSecret } from "@/services/secrets/vault";
import { logEvent } from "@/services/logging/logEvent";
import { makeEmitProgress } from "@/services/agents/progress";
import { buildContext } from "@/services/agents/runner";
import { DispatcherResultSchema, AGENT_TRIGGERS } from "@/services/agents/types";
import type { AgentTrigger, DispatcherResult } from "@/services/agents/types";
import { sourceToTrigger, completeLocalWorkItem } from "@/services/agents/work-queue";
import type { WorkItemSource } from "@/services/agents/work-queue";
import { isInsufficientCreditsError } from "@/services/agents/credits";
import { finalizeRun } from "../../../../workers/functions/finalize-run";
import { recordBilledCreditsForRun } from "@/services/billing/flat-pricing";

const LOCAL_LEASE_SECONDS = 3600;

function nowIso(): string {
  return new Date().toISOString();
}

export async function localRunsList(req: Request, res: Response): Promise<void> {
  const { token_id } = getMacWorker(req);

  const { data: scopeRows, error: scopeErr } = await serviceClient()
    .from("mac_worker_token_tenants")
    .select("tenant_id")
    .eq("token_id", token_id);
  if (scopeErr) {
    res.status(500).json({ error: { code: "read_failed" } });
    return;
  }
  const scoped = (scopeRows ?? []).map((r) => r.tenant_id as string);

  const enabled: string[] = [];
  for (const t of scoped) {
    if (await assertTokenTenantEnabled(token_id, t)) enabled.push(t);
  }
  if (enabled.length === 0) {
    res.json({ pending: [] });
    return;
  }

  const { data: items, error: itemsErr } = await serviceClient()
    .from("agent_work_items")
    .select(
      "id, tenant_id, agent_slug, source, payload, priority, risk_tier, work_type, next_run_at",
    )
    .eq("lane", "local")
    .eq("status", "pending")
    .lte("next_run_at", nowIso())
    .in("tenant_id", enabled)
    .order("priority", { ascending: false })
    .order("next_run_at", { ascending: true });
  if (itemsErr) {
    res.status(500).json({ error: { code: "read_failed" } });
    return;
  }
  res.json({ pending: items ?? [] });
}

const ClaimBody = z.object({
  tenant_id: z.string().uuid(),
  limit: z.number().int().positive().optional(),
});

export async function localRunsClaim(
  req: Request,
  res: Response,
): Promise<void> {
  const { token_id, owner } = getMacWorker(req);
  const parsed = ClaimBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body" } });
    return;
  }
  const tenant_id = parsed.data.tenant_id;
  const limit = Math.min(parsed.data.limit ?? 10, 10);

  if (!(await assertTokenTenantEnabled(token_id, tenant_id))) {
    res.status(403).json({ error: { code: "tenant_not_authorized" } });
    return;
  }

  const { data, error } = await serviceClient().rpc("claim_agent_work_items", {
    p_owner: owner,
    p_limit: limit,
    p_lease_seconds: LOCAL_LEASE_SECONDS,
    p_lane: "local",
    p_tenant_id: tenant_id,
  });
  if (error) {
    res.status(500).json({ error: { code: "claim_failed" } });
    return;
  }
  res.json({ claimed: data ?? [] });
}

const StartBody = z.object({
  trigger: z.enum(AGENT_TRIGGERS).optional(),
});

type WorkItemLeaseRow = {
  id: string;
  tenant_id: string;
  lane: string;
  status: string;
  lease_owner: string | null;
  source?: WorkItemSource | null;
  agent_run_id?: string | null;
};

export async function localRunsStart(
  req: Request,
  res: Response,
): Promise<void> {
  const { token_id, owner } = getMacWorker(req);
  const id = String(req.params.id ?? "");
  const parsed = StartBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body" } });
    return;
  }
  const { data: row, error } = await serviceClient()
    .from("agent_work_items")
    .select("id, tenant_id, lane, status, lease_owner, source")
    .eq("id", id)
    .maybeSingle();
  if (error || !row) {
    res.status(404).json({ error: { code: "work_item_not_found" } });
    return;
  }
  const item = row as WorkItemLeaseRow;

  const trigger: AgentTrigger =
    parsed.data.trigger ??
    (item.source ? sourceToTrigger(item.source as WorkItemSource) : undefined) ??
    "cron";

  if (!(await assertTokenTenantEnabled(token_id, item.tenant_id))) {
    res.status(403).json({ error: { code: "tenant_not_authorized" } });
    return;
  }

  if (
    item.lane !== "local" ||
    item.status !== "leased" ||
    item.lease_owner !== owner
  ) {
    res.status(409).json({ error: { code: "not_lease_holder" } });
    return;
  }

  const { data, error: rpcErr } = await serviceClient().rpc(
    "start_local_agent_run",
    {
      p_work_item_id: id,
      p_tenant_id: item.tenant_id,
      p_owner: owner,
      p_trigger: trigger,
    },
  );
  if (rpcErr) {
    if (isInsufficientCreditsError(rpcErr)) {
      let terminalized = false;
      try {
        terminalized = await completeLocalWorkItem({
          id,
          tenant_id: item.tenant_id,
          owner,
          status: "failed",
          last_error: "insufficient_credits",
        });
      } catch (e) {
        await logEvent({
          level: "error",
          source: "local-runs.start",
          code: "insufficient_credits_terminalize_failed",
          tenant_id: item.tenant_id,
          error: e instanceof Error ? e : new Error(String(e)),
        }).catch(() => {});
      }
      if (!terminalized) {
        await logEvent({
          level: "warn",
          source: "local-runs.start",
          code: "insufficient_credits_work_item_not_terminalized",
          tenant_id: item.tenant_id,
        }).catch(() => {});
      }
      res.status(402).json({ error: { code: "insufficient_credits" } });
      return;
    }
    if ((rpcErr as { code?: string }).code === "42501") {
      res.status(409).json({ error: { code: "not_lease_holder" } });
      return;
    }
    res.status(500).json({ error: { code: "start_failed" } });
    return;
  }
  if (typeof data === "string") {
    const pricingTrigger = (item.source ? sourceToTrigger(item.source as WorkItemSource) : undefined) ?? "cron";
    await recordBilledCreditsForRun(data, item.tenant_id, pricingTrigger);
  }
  res.json({ run_id: data });
}

const RenewBody = z.object({
  lease_seconds: z.number().int().positive().optional(),
});

export async function localRunsRenew(
  req: Request,
  res: Response,
): Promise<void> {
  const { token_id, owner } = getMacWorker(req);
  const id = String(req.params.id ?? "");
  const parsed = RenewBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body" } });
    return;
  }
  const leaseSeconds = Math.min(
    parsed.data.lease_seconds ?? LOCAL_LEASE_SECONDS,
    LOCAL_LEASE_SECONDS,
  );

  const { data: row, error } = await serviceClient()
    .from("agent_work_items")
    .select("id, tenant_id, lane, status, lease_owner, agent_run_id")
    .eq("id", id)
    .maybeSingle();
  if (error || !row) {
    res.status(404).json({ error: { code: "work_item_not_found" } });
    return;
  }
  const item = row as WorkItemLeaseRow;

  if (!(await assertTokenTenantEnabled(token_id, item.tenant_id))) {
    res.status(403).json({ error: { code: "tenant_not_authorized" } });
    return;
  }

  const { data, error: rpcErr } = await serviceClient().rpc(
    "renew_local_lease",
    {
      p_id: id,
      p_tenant_id: item.tenant_id,
      p_owner: owner,
      p_lease_seconds: leaseSeconds,
    },
  );
  if (rpcErr) {
    res.status(500).json({ error: { code: "renew_failed" } });
    return;
  }
  if (data === true) {
    if (item.agent_run_id) {
      const { error: progErr } = await serviceClient()
        .from("agent_runs")
        .update({ last_progress_at: new Date().toISOString() })
        .eq("id", item.agent_run_id)
        .eq("status", "running");
      if (progErr) {
        void logEvent({
          level: "warn",
          source: "route",
          code: "local_renew_progress_touch_failed",
          run_id: item.agent_run_id,
          tenant_id: item.tenant_id,
        });
      }
    }
    res.json({ renewed: true });
    return;
  }
  res.status(409).json({ error: { code: "lease_lost" } });
}

export async function localRunsSecrets(
  req: Request,
  res: Response,
): Promise<void> {
  const { token_id, owner } = getMacWorker(req);
  const id = String(req.params.id ?? "");

  const { data: row, error } = await serviceClient()
    .from("agent_work_items")
    .select("id, tenant_id, lane, status, lease_owner")
    .eq("id", id)
    .maybeSingle();
  if (error || !row) {
    res.status(404).json({ error: { code: "work_item_not_found" } });
    return;
  }
  const item = row as WorkItemLeaseRow;
  const tenant_id = item.tenant_id;

  if (!(await assertTokenTenantEnabled(token_id, tenant_id))) {
    res.status(403).json({ error: { code: "tenant_not_authorized" } });
    return;
  }

  if (
    item.lane !== "local" ||
    item.status !== "leased" ||
    item.lease_owner !== owner
  ) {
    res.status(403).json({ error: { code: "not_lease_holder" } });
    return;
  }

  const { data: secretRow, error: secretErr } = await serviceClient()
    .from("agent_work_items")
    .select("payload, agent_slug")
    .eq("id", id)
    .eq("tenant_id", tenant_id)
    .eq("lane", "local")
    .eq("status", "leased")
    .eq("lease_owner", owner)
    .maybeSingle();
  if (secretErr || !secretRow) {
    res.status(409).json({ error: { code: "lease_lost" } });
    return;
  }
  const payload = (secretRow as { payload?: unknown }).payload ?? null;
  const agent_slug = (secretRow as { agent_slug?: string }).agent_slug ?? "";

  const bundle: {
    tenant_id: string;
    agent_slug: string;
    github_token?: string;
    github_repo?: string;
    slack_bot_token?: string;
  } = { tenant_id, agent_slug };

  const rawHintValue = (payload as { repo_hint?: unknown } | null)?.repo_hint;
  const trimmedHint =
    typeof rawHintValue === "string" ? rawHintValue.trim() : "";
  const rawRepoHint = trimmedHint.length > 0 ? trimmedHint : null;

  let wantRepo = rawRepoHint !== null;
  if (!wantRepo) {
    try {
      const def = await loadAgentDefinition(agent_slug, tenant_id);
      wantRepo = def?.metadata_praxis?.requires_sandbox === true;
    } catch {
      wantRepo = false;
    }
  }

  let resolvedRepo: string | null = null;
  if (wantRepo) {
    try {
      resolvedRepo = await resolveRepoFullName({
        tenant_id,
        repo_hint: rawRepoHint,
      });
    } catch (e) {
      if (!(e instanceof RepoResolutionError)) throw e;
      resolvedRepo = null;
    }
  }
  if (resolvedRepo) {
    const gh = await getRepoInstallationToken({
      tenant_id,
      repo_full_name: resolvedRepo,
    });
    if (gh) {
      bundle.github_token = gh;
      bundle.github_repo = resolvedRepo;
    }
  }

  const { data: teamRow } = await serviceClient()
    .from("slack_workspaces")
    .select("team_id")
    .eq("tenant_id", tenant_id)
    .order("is_primary", { ascending: false })
    .order("connected_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const teamId = (teamRow as { team_id?: string } | null)?.team_id ?? null;
  let slack: string | null = teamId
    ? await getSecret(tenant_id, "slack.bot_token:" + teamId)
    : null;
  if (!slack) slack = await getSecret(tenant_id, "slack.bot_token");
  if (slack) bundle.slack_bot_token = slack;

  res.json(bundle);
}

type RunRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  agent_definition_hash: string | null;
  trigger: AgentTrigger;
  status: string;
  payload: unknown;
};

const LocalPrSchema = z.object({
  pr_number: z.number().int().positive(),
  pr_url: z.string().url(),
  pr_repo: z.string().min(1),
  head_branch: z.string().min(1),
});

export async function localRunsTerminal(
  req: Request,
  res: Response,
): Promise<void> {
  const { token_id, owner } = getMacWorker(req);
  const runId = String(req.params.run_id ?? "");

  try {
    await serviceClient().rpc("reclaim_local_delegated_run", {
      p_run_id: runId,
      p_owner: owner,
    });
  } catch (e) {
    console.warn(
      `[local-runs/terminal] reclaim_local_delegated_run failed for run=${runId}: ${(e as Error).message}`,
    );
  }

  const { data: runData, error: runErr } = await serviceClient()
    .from("agent_runs")
    .select("id, tenant_id, agent_slug, agent_definition_hash, trigger, status, payload")
    .eq("id", runId)
    .maybeSingle();
  if (runErr || !runData) {
    res.status(404).json({ error: { code: "run_not_found" } });
    return;
  }
  const run = runData as RunRow;
  const tenant = run.tenant_id;

  if (!(await assertTokenTenantEnabled(token_id, tenant))) {
    res.status(403).json({ error: { code: "tenant_not_authorized" } });
    return;
  }

  const parsed = DispatcherResultSchema.safeParse(req.body?.result);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_envelope" } });
    return;
  }
  delete (parsed.data as Record<string, unknown>).egress_email_allowlist;

  if (run.status !== "running") {
    res.status(410).json({ error: { code: "run_not_running" } });
    return;
  }
  const { data: itemData, error: itemErr } = await serviceClient()
    .from("agent_work_items")
    .select("id, lane, status, lease_owner")
    .eq("agent_run_id", runId)
    .eq("tenant_id", tenant)
    .eq("lane", "local")
    .maybeSingle();
  const item = itemData as {
    id: string;
    lane: string;
    status: string;
    lease_owner: string | null;
  } | null;
  if (
    itemErr ||
    !item ||
    item.status !== "leased" ||
    item.lease_owner !== owner
  ) {
    res.status(409).json({ error: { code: "not_lease_holder" } });
    return;
  }

  let validatedLocalPr: z.infer<typeof LocalPrSchema> | null = null;
  const rawLocalPr = (parsed.data as { local_pr?: unknown }).local_pr;
  if (rawLocalPr !== undefined && rawLocalPr !== null) {
    if (run.agent_slug !== "engineer" || run.agent_definition_hash !== "local") {
      res.status(400).json({ error: { code: "local_pr_not_allowed" } });
      return;
    }
    const prParsed = LocalPrSchema.safeParse(rawLocalPr);
    if (!prParsed.success) {
      res.status(400).json({ error: { code: "invalid_local_pr" } });
      return;
    }
    const pr = prParsed.data;
    const rawHint = (run.payload as { repo_hint?: unknown } | null)?.repo_hint;
    const repoHint =
      typeof rawHint === "string" && rawHint.trim().length > 0
        ? rawHint.trim()
        : null;
    let resolvedRepo: string | null = null;
    try {
      resolvedRepo = await resolveRepoFullName({
        tenant_id: tenant,
        repo_hint: repoHint,
      });
    } catch (e) {
      if (!(e instanceof RepoResolutionError)) throw e;
      resolvedRepo = null;
    }
    const expectedBranch = `engineer/${item.id}`;
    const expectedUrl = `https://github.com/${pr.pr_repo}/pull/${pr.pr_number}`;
    if (
      !resolvedRepo ||
      pr.pr_repo !== resolvedRepo ||
      pr.head_branch !== expectedBranch ||
      pr.pr_url !== expectedUrl
    ) {
      res.status(400).json({ error: { code: "local_pr_validation_failed" } });
      return;
    }
    validatedLocalPr = pr;
  }

  const { data: claimedItemId, error: claimErr } = await serviceClient().rpc(
    "claim_local_run_terminal",
    { p_run_id: runId, p_tenant_id: tenant, p_owner: owner },
  );
  if (claimErr) {
    res.status(500).json({ error: { code: "finalize_claim_failed" } });
    return;
  }
  const itemId = (claimedItemId as string | null) ?? null;
  if (!itemId) {
    res.status(409).json({ error: { code: "finalize_in_progress" } });
    return;
  }

  const result = parsed.data as unknown as DispatcherResult;

  if (validatedLocalPr) {
    result.output_text = `Opened PR #${validatedLocalPr.pr_number}: ${validatedLocalPr.pr_url}`;
  }

  const model =
    (parsed.data as { routing?: { model?: string } }).routing?.model ??
    MODELS.anthropic.sonnet;

  const emitWorker = makeEmitProgress(runId, tenant);
  const rebuildContext = () =>
    buildContext(
      {
        id: runId,
        tenant_id: tenant,
        agent_slug: run.agent_slug,
        trigger: run.trigger,
        payload: run.payload,
      },
      runId,
    );

  await finalizeRun(
    {
      run_id: runId,
      tenant_id: tenant,
      agent_slug: run.agent_slug,
      trigger: run.trigger,
      model,
      result,
      payload: run.payload,
    },
    { step: undefined, emitWorker, rebuildContext },
  );

  if (validatedLocalPr) {
    const { error: prMetaErr } = await serviceClient().rpc(
      "agent_run_set_pr_meta",
      {
        p_run_id: runId,
        p_pr_url: validatedLocalPr.pr_url,
        p_pr_repo: validatedLocalPr.pr_repo,
        p_pr_number: validatedLocalPr.pr_number,
      },
    );
    if (prMetaErr) {
      void logEvent({
        level: "warn",
        source: "route",
        code: "local_pr_meta_write_failed",
        run_id: runId,
        tenant_id: tenant,
      });
    }
  }

  const parseError = (parsed.data as { parse_error?: string }).parse_error;
  const { data: completed, error: completeErr } = await serviceClient().rpc(
    "complete_local_work_item",
    {
      p_id: itemId,
      p_tenant_id: tenant,
      p_owner: owner,
      p_status: parsed.data.parse_ok ? "done" : "failed",
      p_agent_run_id: runId,
      p_last_error: parseError ?? null,
    },
  );
  if (completeErr || completed !== true) {
    void logEvent({
      level: "warn",
      source: "route",
      code: "local_complete_work_item_noop",
      run_id: runId,
      tenant_id: tenant,
    });
  }

  res.json({
    run_id: runId,
    status: parsed.data.parse_ok ? "success" : "parse_failed",
  });
}

export function localRunsRouter(): Router {
  const r = Router();
  r.use(macWorkerAuth);
  r.post("/list", localRunsList);
  r.post("/claim", localRunsClaim);
  r.post("/:id/start", localRunsStart);
  r.post("/:id/renew", localRunsRenew);
  r.post("/:id/secrets", localRunsSecrets);
  r.post("/:run_id/terminal", localRunsTerminal);
  return r;
}
