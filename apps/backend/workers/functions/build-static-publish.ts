import { inngest } from "../client";
import { requestConductorTick, targetedRunId } from "@/services/agents/conductor-kick";
import { realConductorTickDeps, tenantHasDatabase } from "@/services/agents/conductor-driver";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { isBuiltinHostname } from "@/services/provisioning/builtin-url";
import {
  e2bSandboxExec,
  ensureStaticRouting,
  isStaticEligible,
  publishStatic,
  readStaticState,
  restoreRenderRouting,
  rollbackStaticHosting,
  restoreStaticKv,
  STATIC_SUPERSEDED,
  staticRoutingActive,
  verifyStaticHost,
  writeStaticState,
  type SandboxExec,
  type StaticState,
} from "@/services/hosting/static-publish";
import { pauseSandbox, resumeSandbox } from "@/services/sandbox/e2b-client";
import { readProvisionedRepoHeadSha } from "@/services/provisioning/github-repo";
import { withSandboxGithubToken } from "@/agents/engineer/sandbox-token-rearm";

export const BUILD_STATIC_PUBLISH_REQUESTED = "build/static-publish.requested" as const;

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export const STATIC_PUBLISH_REASONS = ["live_edit_publish", "revert"] as const;
export type StaticPublishReason = (typeof STATIC_PUBLISH_REASONS)[number];

type SendStaticPublish = (event: { id: string; name: typeof BUILD_STATIC_PUBLISH_REQUESTED; data: Record<string, string> }) => Promise<unknown>;

const realSend: SendStaticPublish = (event) => inngest.send(event as Parameters<typeof inngest.send>[0]);

export async function requestBuildStaticPublish(
  data: { tenant_id: string; conductor_run_id: string; sha: string },
  deps: { hostname: (tenant_id: string) => Promise<string | null>; send: SendStaticPublish } = {
    hostname: realTenantHostname,
    send: realSend,
  },
): Promise<boolean> {
  const hostname = await deps.hostname(data.tenant_id);
  if (!hostname) return false;
  await deps.send({
    id: `static-publish:${data.conductor_run_id}:${data.sha}`,
    name: BUILD_STATIC_PUBLISH_REQUESTED,
    data: { ...data, hostname },
  });
  return true;
}

export async function requestTenantStaticPublish(
  data: { tenant_id: string; sha: string; reason: StaticPublishReason },
  deps: {
    readStaticState: (tenant_id: string) => Promise<StaticState | null>;
    send: SendStaticPublish;
    rollback: (tenant_id: string) => Promise<unknown>;
  } = {
    readStaticState: (tenant_id) => readStaticState(tenant_id),
    send: realSend,
    rollback: (tenant_id) => rollbackStaticHosting(tenant_id),
  },
): Promise<boolean> {
  try {
    const state = await deps.readStaticState(data.tenant_id);
    if (!staticRoutingActive(state) || !state?.hostname) return false;
    if (!SHA_RE.test(data.sha)) throw new Error(`invalid sha: ${data.sha}`);
    await deps.send({
      id: `static-publish:${data.reason}:${data.tenant_id}:${data.sha}`,
      name: BUILD_STATIC_PUBLISH_REQUESTED,
      data: { tenant_id: data.tenant_id, sha: data.sha, hostname: state.hostname, reason: data.reason },
    });
    return true;
  } catch (e) {
    await deps.rollback(data.tenant_id);
    throw e;
  }
}

export type StaticPublishTarget = {
  hostname: string;
  repo_full_name: string;
  sandbox: SandboxExec;
  withRepoToken?: <T>(fn: () => Promise<T>) => Promise<T>;
  mainHead?: () => Promise<string | null>;
  afterPublish?: () => Promise<void>;
};

export type BuildStaticPublishDeps = {
  runTenant: (conductor_run_id: string) => Promise<string | null>;
  resolveTarget: (tenant_id: string) => Promise<StaticPublishTarget | { skip: string }>;
  checkEligible: (tenant_id: string, sandbox: SandboxExec) => Promise<{ eligible: boolean; reason?: string }>;
  publishStatic: typeof publishStatic;
  ensureStaticRouting: typeof ensureStaticRouting;
  restoreRenderRouting: typeof restoreRenderRouting;
  restoreStaticKv: (hostname: string, previous: string | null) => Promise<{ ok: true } | { ok: false; error: string }>;
  verifyStaticHost: (hostname: string, expectedDeployId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  readStaticState: (tenant_id: string) => Promise<StaticState | null>;
  writeStaticState: typeof writeStaticState;
  rollback: (tenant_id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  kick: (conductor_run_id: string) => Promise<unknown>;
  now?: () => Date;
};

export type BuildStaticPublishResult =
  | { published: true; deploy_id: string }
  | { failed: true; error: string; rolled_back?: boolean }
  | { skipped: true; reason: string; rolled_back?: boolean };

export async function handleBuildStaticPublish(
  data: unknown,
  deps: BuildStaticPublishDeps,
): Promise<BuildStaticPublishResult> {
  const conductor_run_id = targetedRunId({ data });
  const d = (data ?? {}) as { tenant_id?: unknown; sha?: unknown; hostname?: unknown; reason?: unknown };
  const tenant_id = typeof d.tenant_id === "string" ? d.tenant_id : "";
  const sha = typeof d.sha === "string" ? d.sha : "";
  const hostname = typeof d.hostname === "string" ? d.hostname.trim().toLowerCase() : "";
  const reason = STATIC_PUBLISH_REASONS.find((r) => r === d.reason) ?? null;
  if (!tenant_id || !SHA_RE.test(sha) || !hostname || (!conductor_run_id && !reason)) {
    return { skipped: true, reason: "bad_request" };
  }

  if (conductor_run_id) {
    const owner = await deps.runTenant(conductor_run_id);
    if (owner !== tenant_id) return { skipped: true, reason: "run_not_found" };
  }
  const prior = await deps.readStaticState(tenant_id);
  if (!conductor_run_id && !staticRoutingActive(prior, hostname)) return { skipped: true, reason: "not_static" };

  const result = await publishOrRollBack(tenant_id, sha, hostname, prior, deps);
  if (conductor_run_id) {
    await Promise.resolve()
      .then(() => deps.kick(conductor_run_id))
      .catch(() => undefined);
  }
  return result;
}

async function publishOrRollBack(
  tenant_id: string,
  sha: string,
  hostname: string,
  prior: StaticState | null,
  deps: BuildStaticPublishDeps,
): Promise<BuildStaticPublishResult> {
  const target = await deps
    .resolveTarget(tenant_id)
    .catch((e: unknown) => ({ skip: `resolve_failed: ${String((e as Error)?.message ?? e).slice(0, 300)}` }));
  let result: BuildStaticPublishResult;
  let stillRouted: boolean;
  if ("skip" in target) {
    result = { skipped: true, reason: target.skip };
    stillRouted = staticRoutingActive(prior);
  } else if (target.hostname !== hostname) {
    result = { skipped: true, reason: "hostname_mismatch" };
    stillRouted = staticRoutingActive(prior);
  } else {
    ({ result, stillRouted } = await publishAndRecord(tenant_id, sha, target, prior, deps));
  }
  if ("published" in result || !stillRouted) return result;
  const rolled = await deps
    .rollback(tenant_id)
    .catch((e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }));
  if (!rolled.ok) {
    return "failed" in result ? { ...result, error: `${result.error}; rollback: ${rolled.error}` } : result;
  }
  return { ...result, rolled_back: true };
}

async function publishAndRecord(
  tenant_id: string,
  sha: string,
  target: StaticPublishTarget,
  prior: StaticState | null,
  deps: BuildStaticPublishDeps,
): Promise<{ result: BuildStaticPublishResult; stillRouted: boolean }> {
  const at = () => (deps.now ? deps.now() : new Date()).toISOString();
  const hostname = target.hostname;
  const priorRouting = staticRoutingActive(prior, hostname) ? prior?.routing_previous : undefined;
  const kept = priorRouting ? { routing_previous: priorRouting } : {};
  const write = (state: Omit<StaticState, "at" | "sha">) => deps.writeStaticState(tenant_id, { ...state, sha, at: at() });
  const fail = async (
    error: string,
    opts: { extra?: Partial<StaticState>; status?: "failed" | "rolled_back"; routed?: boolean } = {},
  ): Promise<{ result: BuildStaticPublishResult; stillRouted: boolean }> => {
    const trimmed = error.slice(0, 500);
    await write({ status: opts.status ?? "failed", deploy_id: null, error: trimmed, hostname, ...(opts.extra ?? kept) });
    return { result: { failed: true, error: trimmed }, stillRouted: opts.routed ?? priorRouting !== undefined };
  };
  const restoreNote = (r: { ok: boolean; error?: string }, label: string) => (r.ok ? "" : `; ${label}: ${r.error}`);

  const superseded = async (): Promise<boolean> => {
    if (!target.mainHead) return false;
    const head = await target.mainHead().catch(() => null);
    return head === null || !head.toLowerCase().startsWith(sha.toLowerCase());
  };
  const skipSuperseded = { result: { skipped: true, reason: "superseded" } as BuildStaticPublishResult, stillRouted: false };
  if (await superseded()) return skipSuperseded;

  const verdict = await deps.checkEligible(tenant_id, target.sandbox);
  if (!verdict.eligible) return fail(`ineligible: ${verdict.reason ?? "unknown"}`);

  await write({ status: "publishing", deploy_id: null, hostname, ...kept });
  let published: Awaited<ReturnType<typeof publishStatic>>;
  try {
    const publish = () =>
      deps.publishStatic({
        tenant_id,
        hostname,
        repo_full_name: target.repo_full_name,
        sha,
        sandbox: target.sandbox,
        verify: false,
        withRepoToken: target.withRepoToken,
        beforeFlip: async () => !(await superseded()),
      });
    published = await publish();
  } catch (e) {
    await target.afterPublish?.();
    return fail(`publish: ${String((e as Error)?.message ?? e)}`);
  }
  await target.afterPublish?.();
  if (!published.ok && published.error === STATIC_SUPERSEDED) {
    if (prior) await deps.writeStaticState(tenant_id, prior);
    else await write({ status: "failed", deploy_id: null, error: STATIC_SUPERSEDED, hostname });
    return skipSuperseded;
  }
  if (!published.ok) return fail(`${published.stage}: ${published.error}`);
  const deploy_id = published.deploy_id;
  const kvPrevious = published.kv_previous ?? null;

  const routing = await deps.ensureStaticRouting(hostname);
  if (!routing.ok && routing.previous) {
    return fail(`routing: ${routing.error}`, { extra: { routing_previous: priorRouting ?? routing.previous }, routed: true });
  }
  if (!routing.ok) {
    const kv = await deps.restoreStaticKv(hostname, kvPrevious);
    return fail(`routing: ${routing.error}${restoreNote(kv, "kv")}`);
  }
  const routing_previous = priorRouting ?? routing.previous;
  await write({ status: "publishing", deploy_id, hostname, routing_previous });

  const verified = await deps.verifyStaticHost(hostname, deploy_id);
  if (verified.ok) {
    await write({ status: "live", deploy_id, hostname, routing_previous });
    return { result: { published: true, deploy_id }, stillRouted: true };
  }
  const kv = await deps.restoreStaticKv(hostname, kvPrevious);
  if (!routing.changed) {
    return fail(`verify: ${verified.error}${restoreNote(kv, "kv")}`, { extra: { routing_previous }, routed: true });
  }
  const render = await deps
    .restoreRenderRouting(hostname, routing_previous)
    .catch((e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }));
  return fail(`verify: ${verified.error}${restoreNote(kv, "kv")}${restoreNote(render, "restore")}`, {
    extra: { routing_previous },
    status: render.ok ? "rolled_back" : "failed",
    routed: !render.ok,
  });
}

async function realTenantHostname(tenant_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_resources")
    .select("external_ref")
    .eq("resource_kind", "domain")
    .maybeSingle();
  if (error) throw new Error(`tenant_resources read failed: ${error.message}`);
  const raw = (data as { external_ref?: { hostname?: unknown } | null } | null)?.external_ref?.hostname;
  return isBuiltinHostname(raw) ? (raw as string).trim().toLowerCase() : null;
}

async function realRunTenant(conductor_run_id: string): Promise<string | null> {
  const row = await realConductorTickDeps.load(conductor_run_id);
  return row?.kind === "build_app" ? row.tenant_id : null;
}

async function realResolveTarget(tenant_id: string): Promise<StaticPublishTarget | { skip: string }> {
  const sb = tenantClient(asTenantId(tenant_id));
  const [{ data: repoRows, error: repoErr }, { data: domainRow, error: domainErr }] = await Promise.all([
    sb
      .from("tenant_resources")
      .select("external_ref")
      .eq("resource_kind", "repo")
      .eq("mode", "provisioned")
      .order("updated_at", { ascending: false })
      .limit(1),
    sb
      .from("tenant_resources")
      .select("external_ref")
      .eq("resource_kind", "domain")
      .maybeSingle(),
  ]);
  if (repoErr || domainErr) throw new Error(`tenant_resources read failed: ${(repoErr ?? domainErr)?.message}`);
  const repoRef = (repoRows as Array<{ external_ref?: Record<string, unknown> | null }> | null)?.[0]?.external_ref;
  const repo_full_name = typeof repoRef?.github_full_name === "string" ? repoRef.github_full_name.trim() : "";
  const default_branch =
    typeof repoRef?.default_branch === "string" && repoRef.default_branch.trim() ? repoRef.default_branch.trim() : "main";
  if (!/^[^/]+\/[^/]+$/.test(repo_full_name)) return { skip: "no_repo" };
  const hostRaw = (domainRow as { external_ref?: { hostname?: unknown } | null } | null)?.external_ref?.hostname;
  if (!isBuiltinHostname(hostRaw)) return { skip: "no_hostname" };
  const hostname = (hostRaw as string).trim().toLowerCase();

  const { data: sbRow, error: sbErr } = await sb
    .from("tenant_sandbox")
    .select("e2b_sandbox_id")
    .eq("repo_full_name", repo_full_name)
    .maybeSingle();
  if (sbErr) throw new Error(`tenant_sandbox read failed: ${sbErr.message}`);
  const e2bId = (sbRow as { e2b_sandbox_id?: string | null } | null)?.e2b_sandbox_id;
  if (!e2bId) return { skip: "no_sandbox" };
  await resumeSandbox(e2bId);
  let tokenFailed = false;
  return {
    hostname,
    repo_full_name,
    sandbox: e2bSandboxExec(e2bId),
    mainHead: () => readProvisionedRepoHeadSha(repo_full_name, default_branch),
    withRepoToken: (fn) =>
      withSandboxGithubToken(
        tenant_id,
        { stage: "build", target: { github_full_name: repo_full_name, github_target_mode: "umbrella" } },
        e2bId,
        fn,
        { strictRevoke: true },
      ).catch((e: unknown) => {
        tokenFailed = true;
        throw e;
      }),
    afterPublish: async () => {
      if (tokenFailed) await pauseSandbox(e2bId).catch(() => undefined);
    },
  };
}

async function realCheckEligible(
  tenant_id: string,
  sandbox: SandboxExec,
): Promise<{ eligible: boolean; reason?: string }> {
  const hasDatabase = await tenantHasDatabase(tenant_id);
  if (hasDatabase === null) return { eligible: false, reason: "db_unreadable" };
  return isStaticEligible({ tenant_id, hasDatabase, sandbox });
}

export const buildStaticPublishFn = inngest.createFunction(
  {
    id: "build-static-publish",
    retries: 0,
    concurrency: [{ limit: 1, key: "event.data.hostname" }, { limit: 3 }],
  },
  { event: BUILD_STATIC_PUBLISH_REQUESTED },
  async ({ event }: { event: { data?: unknown } }) =>
    handleBuildStaticPublish(event.data, {
      runTenant: realRunTenant,
      resolveTarget: realResolveTarget,
      checkEligible: realCheckEligible,
      publishStatic,
      ensureStaticRouting,
      restoreRenderRouting,
      restoreStaticKv: (hostname, previous) => restoreStaticKv(hostname, previous),
      verifyStaticHost: (hostname, expectedDeployId) => verifyStaticHost(hostname, expectedDeployId),
      readStaticState: (tenant_id) => readStaticState(tenant_id),
      writeStaticState,
      rollback: (tenant_id) => rollbackStaticHosting(tenant_id),
      kick: (conductor_run_id) => requestConductorTick(inngest, conductor_run_id),
    }),
);
