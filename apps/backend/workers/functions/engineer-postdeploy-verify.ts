
import { inngest } from "../client";
import { refreshManagedOperatorDbAfterDeploy } from "@/services/provisioning/managed-operator-db";
import { serviceClient } from "@/services/supabase";
import {
  decideRemediation,
  buildRemediationMessage,
} from "@/services/agents/postdeploy-remediate";
import { refineProduct, NoProvisionedRepo, OldSiteFrozen } from "@/services/agents/refine-product";
import { siteIdFromGraph } from "@/services/sites/site-run";
import { looksLikeSeedPlaceholder } from "@/services/provisioning/seed-markers";

const INITIAL_WAIT_MS = 90_000;
const REPROBE_SLEEP_MS = 45_000;
const MAX_PROBE_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

const BODY_SNIPPET_CAP = 200;

const SEED_PAGE_MARKERS = [
  "Your company app is live",
  "Database not configured yet",
] as const;

const NEXT_ERROR_MARKER = "__next_error__";

const NON_TRIVIAL_IDEA_MIN_CHARS = 30;

export type PostdeployVerdict =
  | "success"
  | "postdeploy_5xx"
  | "postdeploy_next_error"
  | "postdeploy_seed_no_codegen"
  | "deploy_timeout"
  | "no_live_url";

export type PostdeployVerifyRecord = {
  verdict: PostdeployVerdict;
  status_code: number | null;
  snippet: string;
  probed_url: string | null;
  attempts: number;
  decided_at: string;
  repo: string | null;
  commit_sha: string | null;
};

export type ProbeOutcome = {
  status_code: number | null;
  body: string;
  fetch_error: string | null;
};

export function classifyVerdict(args: {
  latest: ProbeOutcome;
  attempts: number;
  conductor_idea: string | null;
}): { verdict: PostdeployVerdict; snippet: string } {
  const snippet = args.latest.body.slice(0, BODY_SNIPPET_CAP);
  if (args.latest.fetch_error !== null && args.latest.status_code === null) {
    return { verdict: "deploy_timeout", snippet: args.latest.fetch_error.slice(0, BODY_SNIPPET_CAP) };
  }
  const status = args.latest.status_code ?? 0;
  if (status >= 500 && status < 600) {
    return { verdict: "postdeploy_5xx", snippet };
  }
  if (status >= 200 && status < 400) {
    if (args.latest.body.includes(NEXT_ERROR_MARKER)) {
      return { verdict: "postdeploy_next_error", snippet };
    }
    const isSeed =
      looksLikeSeedPlaceholder(args.latest.body) ||
      SEED_PAGE_MARKERS.some((m) => args.latest.body.includes(m));
    if (isSeed) {
      const idea = (args.conductor_idea ?? "").trim();
      if (idea.length >= NON_TRIVIAL_IDEA_MIN_CHARS) {
        return { verdict: "postdeploy_seed_no_codegen", snippet };
      }
      return { verdict: "success", snippet: "" };
    }
    return { verdict: "success", snippet: "" };
  }
  return {
    verdict: "deploy_timeout",
    snippet: `unexpected_status:${status} ${snippet}`.slice(0, BODY_SNIPPET_CAP),
  };
}

type FetchLike = (
  url: string,
  init?: { method?: string; signal?: AbortSignal; redirect?: "follow" | "manual" | "error" },
) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

export async function probeUrl(
  url: string,
  fetchFn: FetchLike = (globalThis as { fetch: FetchLike }).fetch,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
    });
    let body = "";
    try {
      body = await res.text();
    } catch (e) {
      body = `<body_read_failed: ${(e as Error).message}>`;
    }
    return { status_code: res.status, body, fetch_error: null };
  } catch (e) {
    const msg = (e as Error)?.message ?? "fetch_failed";
    return { status_code: null, body: "", fetch_error: msg };
  } finally {
    clearTimeout(timer);
  }
}

type AgentRunRow = {
  id: string;
  tenant_id: string;
  payload: unknown;
};

type HostingRow = {
  external_ref: Record<string, unknown> | null;
  status: string;
};

export type LoadContextDeps = {
  loadAgentRun: (run_id: string) => Promise<AgentRunRow | null>;
  loadHostingForTenant: (tenant_id: string) => Promise<HostingRow | null>;
  loadConductorIdea: (run_id: string) => Promise<string | null>;
};

export async function loadContext(
  deps: LoadContextDeps,
  args: { agent_run_id: string; expected_tenant_id: string },
): Promise<
  | { ok: true; tenant_id: string; live_url: string | null; conductor_idea: string | null }
  | { ok: false; reason: string }
> {
  const run = await deps.loadAgentRun(args.agent_run_id);
  if (!run) return { ok: false, reason: `agent_run_not_found:${args.agent_run_id}` };
  if (run.tenant_id !== args.expected_tenant_id) {
    return {
      ok: false,
      reason: `tenant_mismatch:event=${args.expected_tenant_id} row=${run.tenant_id}`,
    };
  }
  if (siteIdFromGraph([{ payload: run.payload as { site_id?: unknown } | null }])) {
    return { ok: false, reason: "site_run" };
  }
  const hosting = await deps.loadHostingForTenant(run.tenant_id);
  const live_url =
    hosting &&
    typeof (hosting.external_ref as { url?: string } | null)?.url === "string" &&
    ((hosting.external_ref as { url: string }).url ?? "").length > 0
      ? (hosting.external_ref as { url: string }).url
      : null;
  const conductor_idea = await deps.loadConductorIdea(args.agent_run_id);
  return { ok: true, tenant_id: run.tenant_id, live_url, conductor_idea };
}

async function realLoadAgentRun(run_id: string): Promise<AgentRunRow | null> {
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("id, tenant_id, payload")
    .eq("id", run_id)
    .maybeSingle();
  if (error) {
    console.warn(
      `[engineer-postdeploy-verify] agent_runs read failed for ${run_id}: ${error.message}`,
    );
    return null;
  }
  return (data as AgentRunRow | null) ?? null;
}

async function realLoadHostingForTenant(tenant_id: string): Promise<HostingRow | null> {
  const { data, error } = await serviceClient()
    .from("tenant_resources")
    .select("external_ref, status")
    .eq("tenant_id", tenant_id)
    .eq("resource_kind", "hosting")
    .eq("mode", "provisioned")
    .maybeSingle();
  if (error) {
    console.warn(
      `[engineer-postdeploy-verify] tenant_resources hosting read failed for ${tenant_id}: ${error.message}`,
    );
    return null;
  }
  return (data as HostingRow | null) ?? null;
}

async function realLoadConductorIdea(agent_run_id: string): Promise<string | null> {
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("payload")
    .eq("id", agent_run_id)
    .maybeSingle();
  if (error || !data) return null;
  const payload = (data as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return null;
  const inline =
    typeof (payload as { task_description?: unknown }).task_description === "string"
      ? (payload as { task_description: string }).task_description
      : typeof (payload as { objective?: unknown }).objective === "string"
        ? (payload as { objective: string }).objective
        : null;
  if (inline && inline.trim().length > 0) return inline;
  const conductor = (payload as { conductor?: unknown }).conductor;
  if (!conductor || typeof conductor !== "object") return null;
  const conductor_run_id =
    typeof (conductor as { run_id?: unknown }).run_id === "string"
      ? (conductor as { run_id: string }).run_id
      : null;
  if (!conductor_run_id) return null;
  const { data: cr } = await serviceClient()
    .from("conductor_runs")
    .select("objective")
    .eq("id", conductor_run_id)
    .maybeSingle();
  if (!cr) return null;
  const obj = (cr as { objective?: unknown }).objective;
  return typeof obj === "string" ? obj : null;
}

type RefineFn = (input: {
  tenant_id: string;
  message: string;
  remediation_attempt: number;
}) => Promise<{ conductor_run_id: string }>;

export type AutoRemediateResult =
  | { remediated: true; attempt: number; conductor_run_id: string }
  | { remediated: false; reason: string };

export async function maybeAutoRemediate(
  args: {
    tenant_id: string;
    verdict: PostdeployVerdict;
    status_code: number | null;
    snippet: string;
    prior_remediations: number;
  },
  refineFn: RefineFn,
): Promise<AutoRemediateResult> {
  const decision = decideRemediation({
    verdict: args.verdict,
    prior_remediations: args.prior_remediations,
  });
  if (!decision.remediate) {
    return { remediated: false, reason: decision.reason };
  }
  const message = buildRemediationMessage({
    verdict: args.verdict,
    status_code: args.status_code,
    snippet: args.snippet,
    attempt: decision.attempt,
  });
  try {
    const res = await refineFn({
      tenant_id: args.tenant_id,
      message,
      remediation_attempt: decision.attempt,
    });
    return {
      remediated: true,
      attempt: decision.attempt,
      conductor_run_id: res.conductor_run_id,
    };
  } catch (e) {
    const why =
      e instanceof NoProvisionedRepo
        ? "no_provisioned_repo"
        : e instanceof OldSiteFrozen
        ? "old_site_frozen"
        : (e as Error)?.message?.slice(0, 200) ?? "refine_enqueue_failed";
    return { remediated: false, reason: `refine_enqueue_failed:${why}` };
  }
}

export const APP_DB_ADDED_NOTICE = "I also set up a database for your site.";

export type AppDbNoticeDeps = {
  loadRun: (run_id: string, tenant_id: string) => Promise<{ payload: unknown; parsed: unknown } | null>;
  threadExists: (thread_id: string, tenant_id: string) => Promise<boolean>;
  insertMessage: (row: Record<string, unknown>) => Promise<void>;
};

export async function maybePostAppDbAddedNotice(
  deps: AppDbNoticeDeps,
  args: { tenant_id: string; run_id: string },
): Promise<"posted" | "skipped"> {
  const run = await deps.loadRun(args.run_id, args.tenant_id);
  const parsed = (run?.parsed ?? {}) as { app_db_added?: unknown };
  const pl = (run?.payload ?? {}) as { refine_mode?: unknown; repair_mode?: unknown; chat_thread_id?: unknown };
  if (parsed.app_db_added !== true || pl.refine_mode !== true || pl.repair_mode === true) return "skipped";
  const thread_id = typeof pl.chat_thread_id === "string" ? pl.chat_thread_id : "";
  if (!thread_id || !(await deps.threadExists(thread_id, args.tenant_id))) return "skipped";
  await deps.insertMessage({
    thread_id,
    tenant_id: args.tenant_id,
    sender_role: "assistant",
    body: APP_DB_ADDED_NOTICE,
    agent_run_id: args.run_id,
    meta: { app_db_added: true },
  });
  return "posted";
}

const realAppDbNoticeDeps: AppDbNoticeDeps = {
  async loadRun(run_id, tenant_id) {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("payload, parsed")
      .eq("id", run_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (error) throw new Error(`agent_runs read failed: ${error.message}`);
    return (data as { payload: unknown; parsed: unknown } | null) ?? null;
  },
  async threadExists(thread_id, tenant_id) {
    const { data, error } = await serviceClient()
      .from("agent_threads")
      .select("id")
      .eq("id", thread_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (error) throw new Error(`agent_threads read failed: ${error.message}`);
    return !!data;
  },
  async insertMessage(row) {
    const { error } = await serviceClient().from("agent_thread_messages").insert(row);
    if (error) throw new Error(`agent_thread_messages insert failed: ${error.message}`);
    await serviceClient()
      .from("agent_threads")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", row.thread_id as string)
      .eq("tenant_id", row.tenant_id as string);
  },
};

export const engineerPostdeployVerifyFn = inngest.createFunction(
  {
    id: "engineer-postdeploy-verify",
    idempotency: "event.data.agent_run_id",
    retries: 2,
  },
  { event: "engineer.postdeploy.verify.requested" },
  async ({ event, step, logger }) => {
    const data = event.data;
    if (!data?.agent_run_id || !data?.tenant_id) {
      throw new Error(
        "engineer-postdeploy-verify: missing agent_run_id or tenant_id in event payload",
      );
    }

    const ctx = await step.run("load-context", async () =>
      loadContext(
        {
          loadAgentRun: realLoadAgentRun,
          loadHostingForTenant: realLoadHostingForTenant,
          loadConductorIdea: realLoadConductorIdea,
        },
        { agent_run_id: data.agent_run_id, expected_tenant_id: data.tenant_id },
      ),
    );
    if (!ctx.ok) {
      logger.warn(`engineer-postdeploy-verify: ${ctx.reason} — skipping`);
      return { status: "skip", reason: ctx.reason };
    }
    if (!ctx.live_url) {
      const record: PostdeployVerifyRecord = {
        verdict: "no_live_url",
        status_code: null,
        snippet: "",
        probed_url: null,
        attempts: 0,
        decided_at: new Date().toISOString(),
        repo: data.repo ?? null,
        commit_sha: data.commit_sha ?? null,
      };
      await step.run("stamp-no-url", async () => {
        await serviceClient().rpc("agent_run_set_postdeploy_verify", {
          p_run_id: data.agent_run_id,
          p_tenant_id: ctx.tenant_id,
          p_verify: record,
        });
      });
      return { status: "skip", reason: "no_live_url" };
    }

    await step.sleep("wait-render-build", `${INITIAL_WAIT_MS}ms`);

    let latest: ProbeOutcome = { status_code: null, body: "", fetch_error: "never_probed" };
    let attempts = 0;
    for (let i = 0; i < MAX_PROBE_ATTEMPTS; i++) {
      attempts++;
      latest = (await step.run(`probe-${i}`, async () => probeUrl(ctx.live_url!))) as ProbeOutcome;
      const reachableOrServed =
        latest.status_code !== null && latest.status_code >= 200 && latest.status_code < 600;
      if (reachableOrServed) break;
      if (i < MAX_PROBE_ATTEMPTS - 1) {
        await step.sleep(`reprobe-wait-${i}`, `${REPROBE_SLEEP_MS}ms`);
      }
    }

    const decision = classifyVerdict({
      latest,
      attempts,
      conductor_idea: ctx.conductor_idea,
    });
    const record: PostdeployVerifyRecord = {
      verdict: decision.verdict,
      status_code: latest.status_code,
      snippet: decision.snippet,
      probed_url: ctx.live_url,
      attempts,
      decided_at: new Date().toISOString(),
      repo: data.repo ?? null,
      commit_sha: data.commit_sha ?? null,
    };

    await step.run("stamp-verdict", async () => {
      const { error } = await serviceClient().rpc("agent_run_set_postdeploy_verify", {
        p_run_id: data.agent_run_id,
        p_tenant_id: ctx.tenant_id,
        p_verify: record,
      });
      if (error) {
        throw new Error(
          `agent_run_set_postdeploy_verify RPC failed: ${error.message}`,
        );
      }
    });

    logger.info(
      `engineer-postdeploy-verify: run=${data.agent_run_id} verdict=${record.verdict} ` +
        `status=${record.status_code} attempts=${record.attempts} url=${ctx.live_url}`,
    );

    if (record.verdict === "success") {
      const notice = await step.run("app-db-notice", async () => {
        try {
          return await maybePostAppDbAddedNotice(realAppDbNoticeDeps, {
            tenant_id: ctx.tenant_id,
            run_id: data.agent_run_id,
          });
        } catch (e) {
          return `error: ${(e as Error).message}`;
        }
      });
      if (notice !== "skipped") logger.info(`engineer-postdeploy-verify: app-db notice ${notice} run=${data.agent_run_id}`);

      const opDb = await step.run("operator-db-refresh", async () => {
        try {
          return await refreshManagedOperatorDbAfterDeploy(ctx.tenant_id);
        } catch (e) {
          return `error: ${(e as Error).name}`;
        }
      });
      logger.info(`engineer-postdeploy-verify: operator-db ${opDb} run=${data.agent_run_id}`);
    }

    const remediation = await step.run("auto-remediate", async () =>
      maybeAutoRemediate(
        {
          tenant_id: ctx.tenant_id,
          verdict: record.verdict,
          status_code: record.status_code,
          snippet: record.snippet,
          prior_remediations:
            typeof data.remediation_attempt === "number" ? data.remediation_attempt : 0,
        },
        (input) => refineProduct({ ...input, singleton_app: true }),
      ),
    );
    if (remediation.remediated) {
      logger.info(
        `engineer-postdeploy-verify: auto-remediate fired for run=${data.agent_run_id} ` +
          `attempt=${remediation.attempt} refine_run=${remediation.conductor_run_id}`,
      );
    } else {
      logger.info(
        `engineer-postdeploy-verify: no auto-remediate for run=${data.agent_run_id} — ${remediation.reason}`,
      );
    }

    return {
      status: "ok",
      verdict: record.verdict,
      attempts: record.attempts,
      remediated: remediation.remediated,
    };
  },
);
