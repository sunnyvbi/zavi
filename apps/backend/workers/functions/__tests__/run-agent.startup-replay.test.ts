import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const log: string[] = [];
  return {
    log,
    handlers: [] as Array<(ctx: unknown) => Promise<unknown>>,
    emits: [] as string[],
    emitFailures: 0,
    claimTaken: false,
    casClaim: false,
    dbWrites: [] as Array<{ table: string; values: unknown }>,
    localRow: null as unknown,
    localDelayMs: 0,
    agentDef: null as unknown,
    claim: null as unknown,
    visibility: { visible: true, reason: "default_enabled" } as { visible: boolean; reason: string },
    tier: { enforced: false, tier: "pro", required_tier: "pro", allowed: true } as Record<string, unknown>,
    conductorStop: null as string | null,
    connectGate: null as string | null,
    repoCreds: null as unknown,
    revokeFails: false,
    bootstrapFails: false,
    sessions: [] as string[],
    dispatchCtx: null as unknown,
    concurrent: { inFlight: 0, max: 0 },
    previewMode: null as { dry: boolean; keepCards: boolean } | null,
    sentEvents: [] as string[],
    finalizeInput: null as unknown,
    finalizeError: null as unknown,
    gate: null as null | { runStatus: string; tenantCreatedAt: string; memoryStatuses: string[] },
  };
});

function track<T>(name: string, value: () => T | Promise<T>, delayMs = 0): Promise<T> {
  h.log.push(`${name}:start`);
  h.concurrent.inFlight += 1;
  h.concurrent.max = Math.max(h.concurrent.max, h.concurrent.inFlight);
  return new Promise<T>((resolve, reject) => {
    setTimeout(async () => {
      h.concurrent.inFlight -= 1;
      h.log.push(`${name}:end`);
      try {
        resolve(await value());
      } catch (e) {
        reject(e);
      }
    }, delayMs);
  });
}

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, _trigger: unknown, handler: (ctx: unknown) => Promise<unknown>) => {
      h.handlers.push(handler);
      return {};
    },
  },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit", "not", "gte"]) b[m] = () => b;
      b.update = (values: unknown) => {
        h.dbWrites.push({ table, values });
        return b;
      };
      b.maybeSingle = () =>
        h.gate && table === "tenants"
          ? Promise.resolve({ data: { created_at: h.gate.tenantCreatedAt }, error: null })
          : table === "agent_work_items"
          ? track("local", () => ({ data: h.localRow, error: null }), h.localDelayMs)
          : Promise.resolve({ data: null, error: null });
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: [{ id: "run-1", tenant_id: "t" }], error: null }).then(res, rej);
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

vi.mock("@/services/onboarding/background-memory", () => ({
  readMemoryStatus: async () =>
    !h.gate ? null : h.gate.memoryStatuses.length > 1 ? h.gate.memoryStatuses.shift() : h.gate.memoryStatuses[0],
}));

vi.mock("@/services/agents/runner", () => ({
  AgentNotFoundError: class AgentNotFoundError extends Error {},
  readRunStatusAndTenant: vi.fn(async () => (h.gate ? { status: h.gate.runStatus, tenant_id: T1 } : null)),
  claimAgentRun: vi.fn(async () => {
    if (!h.casClaim) return h.claim;
    if (h.claimTaken) return null;
    h.claimTaken = true;
    return h.claim;
  }),
  buildContext: vi.fn(async () => ({
    agent: { slug: "engineer", metadata_praxis: { model: "claude-opus-5-5" } },
    tenant_id: (h.claim as { tenant_id: string }).tenant_id,
    runId: "run-1",
  })),
  runDispatch: vi.fn(async (ctx: unknown) => {
    h.dispatchCtx = ctx;
    return { output_text: "ok", parsed: null, parse_ok: true, raw_response_text: "", prompt_snapshot: "", usage: { input_tokens: 0, output_tokens: 0 }, tool_calls: [], resolved_tool_names: [] };
  }),
  enqueueAgentRun: vi.fn(),
  persistTerminal: vi.fn(),
  postRunDistill: vi.fn(),
}));
vi.mock("@/services/agents/progress", () => ({
  makeEmitProgress: () => async (stage: string) => {
    if (h.emitFailures > 0) {
      h.emitFailures -= 1;
      throw new Error("worker lost mid-emit");
    }
    h.emits.push(stage);
  },
}));
vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: vi.fn(() => track("def", () => (h.agentDef ? JSON.parse(JSON.stringify(h.agentDef)) : null))),
}));
vi.mock("@/services/agents/visibility", () => ({
  getEffectiveVisibility: vi.fn(() => track("vis", () => h.visibility)),
}));
vi.mock("@/services/agents/entitlement", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: vi.fn(() => track("tier", () => h.tier)),
}));
vi.mock("@/services/agents/conductor-child-guard", () => ({
  conductorRunIdOf: (p: { conductor_run_id?: string } | null) => p?.conductor_run_id ?? null,
  stoppedConductorReason: vi.fn(() => track("conductor", () => h.conductorStop)),
}));
vi.mock("@/services/sandbox/sandbox-enablement-flag", () => ({
  resolveSandboxMode: vi.fn((d: { metadata_praxis: { requires_sandbox?: boolean } }) =>
    track("mode", () => ({ requires_sandbox: d.metadata_praxis.requires_sandbox === true, lazyEligible: false })),
  ),
}));
vi.mock("@/services/agents/work-queue", () => ({
  shouldDelegateConversationalEngineerToLocal: vi.fn(async () => false),
  delegateConversationalRunToLocal: vi.fn(),
}));
vi.mock("@/services/agents/connect-gate", () => ({
  connectGateSlugFor: vi.fn(() => track("connect-gate", () => h.connectGate, 5)),
}));
vi.mock("@/services/sandbox/repo-creds", () => ({
  resolveRepoCredsForRun: vi.fn(() => track("repo-creds", () => h.repoCreds, 5)),
}));
vi.mock("@/services/sites/site-backend", () => ({
  payloadSiteId: (p: { site_id?: unknown } | null) => (typeof p?.site_id === "string" && p.site_id ? p.site_id : null),
  resolvePayloadSiteBackend: vi.fn(() => track("site-backend", () => "dedicated", 5)),
  resolveSiteBackendForRepo: vi.fn(async () => null),
}));
vi.mock("@/services/sandbox/lifecycle", () => ({
  resolveSandboxForRun: vi.fn(async () => {
    h.log.push("op:resolve-sandbox");
    return { row_id: "row-1", e2b_sandbox_id: "sbx-1" };
  }),
  injectSandboxSecrets: vi.fn(async () => {
    h.log.push("op:inject");
  }),
  bootstrapRepoIfNeeded: vi.fn(async () => {
    h.log.push("op:bootstrap");
    if (h.bootstrapFails) throw new Error("clone failed");
  }),
  pauseAndMarkPaused: vi.fn(async (_s: unknown, o?: { force?: boolean }) => {
    h.log.push(`op:pause${o?.force ? ":force" : ""}`);
  }),
  quarantineSandbox: vi.fn(async () => {
    h.log.push("op:quarantine");
    return "paused";
  }),
  sandboxScrubFailureReason: vi.fn(async (_s: unknown, preModelFailed: boolean) =>
    preModelFailed ? { reason: "pre-model revoke failed", retiredElsewhere: false } : null,
  ),
  resolveStoredDefaultBranch: vi.fn(async () => "main"),
  sandboxTemplateForRun: vi.fn(() => "vite"),
  wipeSandboxSecrets: vi.fn(),
}));
vi.mock("@/services/sites/sandbox-ready", () => ({
  onSiteSandboxReady: vi.fn(async () => {
    h.log.push("op:site-ready");
    return "preview_starting";
  }),
}));
vi.mock("@/services/sandbox/e2b-client", () => ({
  extendSandboxTimeout: vi.fn(),
  revokeSandboxGithubToken: vi.fn(async () => {
    h.log.push("op:revoke");
    if (h.revokeFails) throw new Error("scrub failed");
  }),
  withSandboxSession: vi.fn(async (tenant: string, fn: () => Promise<unknown>) => {
    h.sessions.push(tenant);
    return fn();
  }),
  ENGINEER_NODE_OPTIONS: "--max-old-space-size=6144",
}));
vi.mock("@/services/build/first-build-preview", () => ({
  ensureProvisionedBuildDeps: vi.fn(async () => {
    h.log.push("op:deps");
    return { ok: true };
  }),
  hideStaleFirstBuildPreview: vi.fn(async () => {
    h.log.push("op:hide-stale");
    return "none";
  }),
  isFirstBuildScaffold: (p: { stage?: string } | null) => p?.stage === "scaffold",
  isProvisionedBuildPayload: (p: { stage?: string } | null) => p?.stage === "build" || p?.stage === "scaffold",
  prepareFirstBuildPreview: vi.fn(async () => {
    h.log.push("op:first-build-install");
  }),
}));
vi.mock("@/services/build/live-edit", () => ({
  checkoutDraftOrThrow: vi.fn(async () => {
    h.log.push("op:checkout-draft");
  }),
  isLiveEditPayload: (p: { live_edit?: boolean } | null) => p?.live_edit === true,
  kickLiveEditPreview: vi.fn(),
}));
vi.mock("@/services/agents/eta-estimate", () => ({ estimateRunEta: vi.fn(async () => ({ p50_ms: 1, p95_ms: 2, basis: "fleet_default", n: 0 })) }));
vi.mock("@/services/agents/model-router", () => ({ resolveModelForRun: vi.fn(async () => null) }));
vi.mock("@/services/agents/cap-dispatch-result", () => ({ capDispatchResultForInngest: (r: unknown) => r }));
vi.mock("@/services/growth/preview-dry-run", async () => ({
  isPreviewClaim: () => h.previewMode !== null,
  previewRunMode: vi.fn(async () => h.previewMode),
  asPreviewRunMode: (await vi.importActual<typeof import("@/services/growth/preview-plan")>("@/services/growth/preview-plan"))
    .asPreviewRunMode,
  makePreviewDryCtx: (c: Record<string, unknown>, opts?: { keepCards?: boolean }) => ({
    ...c,
    preview_dry: true,
    ...(opts?.keepCards === true ? { preview_keep_cards: true } : {}),
  }),
  stripDryPreviewResult: (r: Record<string, unknown>) => ({ ...r, output_text: "", stripped: true }),
  PREVIEW_RUN_FAILED: "preview_run_failed",
}));
vi.mock("@/services/growth/preview-upgrade", () => ({
  maybeSendUpgradeActionsReadyEmail: vi.fn(),
  recordPreviewActionTypes: vi.fn(),
}));
vi.mock("@/services/growth/preview-ready-email", () => ({ maybeSendPreviewReadyEmail: vi.fn(async () => ({ sent: false, reason: "nothing_found" })) }));
vi.mock("../finalize-run", () => ({
  finalizeRun: vi.fn(async (input: unknown) => {
    h.finalizeInput = input;
    if (h.finalizeError) throw h.finalizeError;
    return { ok: true };
  }),
}));
vi.mock("@/services/sandbox/run-worktree", () => ({
  createRunWorktree: vi.fn(),
  reapOrphanWorktrees: vi.fn(),
  removeRunWorktree: vi.fn(),
  resolveCheckoutBase: vi.fn(),
}));
vi.mock("@/services/sandbox/shared-install", () => ({ ensureRunWorktreeDeps: vi.fn() }));
vi.mock("@/services/sandbox/lazy-provision", () => ({ takeLazyProvisionedSandbox: vi.fn(() => null) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/services/sandbox/keepalive-flag", () => ({ getTenantSandboxKeepalive: vi.fn(async () => false) }));
vi.mock("@/services/sandbox/browser-mcp/anchor-backend", () => ({
  closeAnchorRun: vi.fn(),
  anchorBackend: { runOp: vi.fn() },
  getBrowserActionEmitter: vi.fn(() => ({ emit: vi.fn() })),
  BROWSER_ACTION_DECISION_CLASS: "browser_action",
}));
vi.mock("@/services/sandbox/browser-mcp/backend", () => ({ _clearRunBrowserState: vi.fn() }));
vi.mock("@/services/agents/engine/capture-ledger", () => ({ clearCaptureLedger: vi.fn() }));
vi.mock("@/services/agents/cron-summary", () => ({ writeCronRunSummary: vi.fn() }));
vi.mock("@/services/sandbox/repo-picker", () => ({ pickRepoForTask: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/agents/predictions", () => ({ recordPredictions: vi.fn() }));
vi.mock("@/services/memory/takes-service", () => ({ recordAgentTake: vi.fn() }));
vi.mock("@/services/memory/fill-placeholder-docs", () => ({
  placeholderDocSlugsFor: (slug: string) =>
    slug === "support-lead" ? ["policies", "disputes", "support"] : slug === "dispute-response" ? ["disputes"] : [],
  fillPlaceholderDocs: vi.fn(async () => ({ filled: [], refused: [], failed: [] })),
}));
vi.mock("@/agents/index", () => ({ postProcessors: {} }));
vi.mock("@/services/notifications/push-fanout", () => ({ sendPushForEvent: vi.fn() }));
vi.mock("@/services/connectors/github/oauth", () => ({ mintInstallationToken: vi.fn() }));
vi.mock("@/services/provisioning/provisioned-repo-gate", () => ({
  assertProvisionedRepoTarget: vi.fn(),
  realProvisionedRepoGateDeps: {},
}));

import "../run-agent";

const T1 = "11111111-1111-4111-8111-111111111111";
const SITE = "55555555-5555-4555-8555-555555555555";
const REPO = "praxis-built/acme-site";

type Signal = { kind: "step"; id: string } | { kind: "error"; id: string; error: unknown };

async function drive(stopAfter = "dispatch", opts: { retryErrors?: boolean; failErrors?: boolean } = {}) {
  const handler = h.handlers[0];
  const memo = new Map<string, string>();
  const failed = new Map<string, unknown>();
  const executed: string[] = [];
  const defLoadsPerInvocation: number[] = [];
  const { loadAgentDefinition } = await import("@/services/agents/registry");
  const loads = loadAgentDefinition as unknown as { mock: { calls: unknown[] } };
  for (let i = 0; i < 40; i++) {
    let signal!: (s: Signal) => void;
    const signalled = new Promise<Signal>((r) => {
      signal = r;
    });
    let ran = false;
    const step = {
      run: async (id: string, fn: () => Promise<unknown>) => {
        if (memo.has(id)) return JSON.parse(memo.get(id)!);
        if (failed.has(id)) throw failed.get(id);
        if (ran) return new Promise(() => {});
        ran = true;
        try {
          const v = await fn();
          memo.set(id, JSON.stringify(v === undefined ? null : v));
          executed.push(id);
          signal({ kind: "step", id });
        } catch (error) {
          executed.push(`${id}!`);
          if (opts.failErrors) failed.set(id, Object.assign(new Error((error as Error).message), { name: "StepError", stepId: id }));
          signal({ kind: "error", id, error });
        }
        return new Promise(() => {});
      },
      sleep: async (id: string) => {
        if (memo.has(id)) return null;
        if (ran) return new Promise(() => {});
        ran = true;
        memo.set(id, "null");
        executed.push(id);
        signal({ kind: "step", id });
        return new Promise(() => {});
      },
      sendEvent: async (_id: string, payload: { name?: string }) => {
        if (payload?.name) h.sentEvents.push(payload.name);
        return { ids: [] };
      },
    };
    const before = loads.mock.calls.length;
    const out = await Promise.race([
      handler({
        event: { data: { run_id: "run-1", tenant_id: "forged-tenant" } },
        step,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }).then(
        (result) => ({ kind: "done" as const, result }),
        (error) => ({ kind: "threw" as const, error }),
      ),
      signalled,
    ]);
    await new Promise((r) => setTimeout(r, 15));
    defLoadsPerInvocation.push(loads.mock.calls.length - before);
    if (out.kind === "step" && out.id !== stopAfter) continue;
    if (out.kind === "error" && opts.retryErrors) continue;
    return { out, executed, invocations: i + 1, defLoadsPerInvocation };
  }
  throw new Error("driver: too many invocations");
}

const ENGINEER = { slug: "engineer", metadata_praxis: { requires_sandbox: true, model: "claude-opus-5-5", setup: null } };

function siteClaim(payload: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    tenant_id: T1,
    agent_slug: "engineer",
    trigger: "a2a",
    enqueued_by: null,
    cron_dedupe_key: null,
    payload: { site_id: SITE, stage: "build", repo_hint: REPO, ...payload },
  };
}

const prevWorktrees = process.env.UNIVERSAL_RUN_WORKTREES;

beforeEach(async () => {
  h.log.length = 0;
  h.emits.length = 0;
  h.emitFailures = 0;
  h.claimTaken = false;
  h.casClaim = false;
  h.dbWrites.length = 0;
  h.sessions.length = 0;
  h.localRow = null;
  h.localDelayMs = 0;
  h.agentDef = ENGINEER;
  h.claim = siteClaim();
  h.visibility = { visible: true, reason: "default_enabled" };
  h.tier = { enforced: false, tier: "pro", required_tier: "pro", allowed: true };
  h.conductorStop = null;
  h.connectGate = null;
  h.repoCreds = { kind: "resolved", repo_full_name: REPO, installation_token: "ghs_tok", provisioned: true };
  h.revokeFails = false;
  h.bootstrapFails = false;
  h.dispatchCtx = null;
  h.concurrent = { inFlight: 0, max: 0 };
  h.previewMode = null;
  h.sentEvents.length = 0;
  h.finalizeInput = null;
  h.finalizeError = null;
  h.gate = null;
  process.env.UNIVERSAL_RUN_WORKTREES = "0";
  vi.clearAllMocks();
});

afterEach(() => {
  if (prevWorktrees === undefined) delete process.env.UNIVERSAL_RUN_WORKTREES;
  else process.env.UNIVERSAL_RUN_WORKTREES = prevWorktrees;
});

describe("run-agent start-up under Inngest replay (one new step per invocation, memoized after)", () => {
  it("emits `claimed` exactly once however many times the function replays", async () => {
    const r = await drive();
    expect(r.invocations).toBeGreaterThanOrEqual(4);
    expect(h.emits.filter((s) => s === "claimed")).toEqual(["claimed"]);
    expect(h.emits.filter((s) => s === "loaded_context")).toEqual(["loaded_context"]);
  });

  it("reads the agent definition once per replay (the gate reuses it)", async () => {
    const r = await drive();
    expect(r.defLoadsPerInvocation.every((n) => n <= 1)).toBe(true);
    expect(r.defLoadsPerInvocation.slice(3).every((n) => n === 1)).toBe(true);
  });

  it("runs the local-lane, definition, visibility and tier reads together instead of one after another", async () => {
    h.localDelayMs = 30;
    h.claim = siteClaim();
    await drive("claim");
    h.log.length = 0;
    await drive();
    const firstReplay = h.log.slice(0, h.log.indexOf("local:end") + 1);
    expect(firstReplay).toContain("def:start");
    expect(firstReplay).toContain("vis:start");
    expect(firstReplay).toContain("tier:start");
    expect(firstReplay).toContain("mode:start");
  });

  it("a worker lost after the claim but before the claimed event still runs the build on retry, and never re-claims", async () => {
    h.casClaim = true;
    h.emitFailures = 1;
    const r = await drive("dispatch", { retryErrors: true });
    const { claimAgentRun } = await import("@/services/agents/runner");
    expect(claimAgentRun).toHaveBeenCalledTimes(1);
    expect(r.out.kind).toBe("step");
    expect(r.executed).toContain("dispatch");
    expect(r.executed.filter((id) => id === "emit-claimed!")).toEqual(["emit-claimed!"]);
    expect(h.emits.filter((s) => s === "claimed")).toEqual(["claimed"]);
  });

  it("a site build runs four steps before dispatch: claim, resolve-site-run, resolve-sandbox, prepare-site-sandbox", async () => {
    const r = await drive();
    expect(r.out.kind).toBe("step");
    expect(r.executed).toEqual(["memory-gate-0", "claim", "emit-claimed", "resolve-site-run", "resolve-sandbox", "prepare-site-sandbox", "dispatch"]);
  });

  it("resolves the site backend, connect gate and repo creds concurrently in the first step", async () => {
    await drive("resolve-site-run");
    const i = h.log.indexOf("site-backend:start");
    const firstEnd = h.log.findIndex((l, k) => k > i && /^(site-backend|connect-gate|repo-creds):end$/.test(l));
    const started = h.log.slice(0, firstEnd);
    expect(started).toEqual(expect.arrayContaining(["site-backend:start", "connect-gate:start", "repo-creds:start"]));
  });

  it("prepares the sandbox inside one session: secrets, clone, revoke BEFORE the site's own code starts, then preview and deps", async () => {
    await drive();
    expect(h.log.filter((l) => l.startsWith("op:"))).toEqual([
      "op:resolve-sandbox",
      "op:inject",
      "op:bootstrap",
      "op:revoke",
      "op:site-ready",
    ]);
    expect(h.sessions).toEqual([T1, T1]);
  });

  it("a failed clone still revokes the injected token before the step fails (a retry re-injects)", async () => {
    h.bootstrapFails = true;
    const r = await drive("prepare-site-sandbox");
    expect(r.out).toMatchObject({ kind: "error", id: "prepare-site-sandbox" });
    const ops = h.log.filter((l) => l.startsWith("op:"));
    expect(ops.slice(-2)).toEqual(["op:bootstrap", "op:revoke"]);
    expect(ops).not.toContain("op:site-ready");
  });

  it("hands the dispatcher the repo and sandbox the worker already resolved, from the claim row's tenant", async () => {
    await drive();
    expect((h.dispatchCtx as { worker_sandbox?: unknown }).worker_sandbox).toEqual({ repo_full_name: REPO, e2b_sandbox_id: "sbx-1" });
  });

  it("a failed token revoke quarantines the box and fails the step before any tenant code (deps) runs", async () => {
    h.revokeFails = true;
    const r = await drive("prepare-site-sandbox");
    expect(r.out).toMatchObject({ kind: "error", id: "prepare-site-sandbox" });
    const ops = h.log.filter((l) => l.startsWith("op:"));
    expect(ops.slice(-2)).toEqual(["op:revoke", "op:quarantine"]);
    expect(ops).not.toContain("op:deps");
  });

  it("a non-site engineer run keeps every step id it had, plus the claimed event in its own step", async () => {
    h.claim = { ...siteClaim(), payload: { repo_hint: "acme/app", task_description: "fix" } };
    h.repoCreds = { kind: "resolved", repo_full_name: "acme/app", installation_token: "ghs_tok", provisioned: false };
    const r = await drive();
    expect(r.executed).toEqual([
      "memory-gate-0",
      "claim",
      "emit-claimed",
      "connect-gate-check",
      "resolve-repo-creds",
      "resolve-site-for-repo",
      "resolve-sandbox",
      "inject-secrets",
      "bootstrap-repo",
      "revoke-sandbox-github-token",
      "dispatch",
    ]);
    expect(h.sessions).toEqual([]);
  });

  it("a live-edit site run keeps its separate steps so the draft checkout still runs with the token present", async () => {
    h.claim = siteClaim({ live_edit: true });
    const r = await drive();
    expect(r.executed).toContain("inject-secrets");
    expect(r.executed).toContain("site-sandbox-ready");
    expect(r.executed).not.toContain("prepare-site-sandbox");
    const ops = h.log.filter((l) => l.startsWith("op:"));
    expect(ops.indexOf("op:checkout-draft")).toBeLessThan(ops.indexOf("op:revoke"));
    expect(ops.indexOf("op:revoke")).toBeLessThan(ops.indexOf("op:deps"));
  });

  it("a first-build scaffold site run keeps its separate steps (hide-stale preview sits between)", async () => {
    h.claim = siteClaim({ stage: "scaffold" });
    const r = await drive();
    expect(r.executed).not.toContain("prepare-site-sandbox");
    expect(r.executed).toEqual(expect.arrayContaining(["site-sandbox-ready", "hide-stale-first-build-preview", "revoke-sandbox-github-token", "first-build-preview-install"]));
  });

  it("a site run the connect gate defers provisions nothing and never uses the creds it resolved alongside", async () => {
    h.connectGate = "github";
    const r = await drive();
    expect(r.executed).toEqual(["memory-gate-0", "claim", "emit-claimed", "resolve-site-run", "dispatch"]);
    expect(h.log.filter((l) => l.startsWith("op:"))).toEqual([]);
    expect((h.dispatchCtx as { worker_sandbox?: unknown }).worker_sandbox).toBeUndefined();
  });

  it("a site run whose repo creds throw (no repo) fails that step for retry rather than provisioning", async () => {
    h.repoCreds = null;
    const { resolveRepoCredsForRun } = await import("@/services/sandbox/repo-creds");
    (resolveRepoCredsForRun as unknown as { mockImplementationOnce: (f: () => Promise<never>) => void }).mockImplementationOnce(async () => {
      throw new Error("no repo connected");
    });
    const r = await drive("resolve-site-run");
    expect(r.out).toMatchObject({ kind: "error", id: "resolve-site-run" });
  });
});

describe("run-agent start-up checks keep their meaning with the parallel prelude", () => {
  it("a local-lane run is skipped before anything else, even when the gate would refuse it", async () => {
    h.localRow = { id: "wi-1" };
    h.visibility = { visible: false, reason: "staff_locked_hide" };
    h.conductorStop = "conductor_stopped: failed";
    h.claim = siteClaim({ conductor_run_id: "c-1" });
    const r = await drive();
    expect(r.out).toEqual({ kind: "done", result: { skipped: true, reason: "local-delegated" } });
    expect(r.executed).toEqual(["memory-gate-0", "claim", "emit-claimed"]);
    expect(h.dbWrites).toEqual([]);
  });

  it("a stopped conductor still stops the run (and wins over a gate refusal)", async () => {
    h.conductorStop = "conductor_stopped: the build this run belongs to is failed, so the run was not started";
    h.visibility = { visible: false, reason: "staff_locked_hide" };
    h.claim = siteClaim({ conductor_run_id: "c-1" });
    const r = await drive();
    expect(r.out).toEqual({ kind: "done", result: { skipped: true, reason: "conductor-stopped" } });
    expect(r.executed).toEqual(["memory-gate-0", "claim", "emit-claimed", "finalize-conductor-stopped"]);
    expect(h.dbWrites).toEqual([{ table: "agent_runs", values: expect.objectContaining({ status: "failed", error: h.conductorStop }) }]);
  });

  it("a kill-switched agent is refused at execution and never provisions a sandbox", async () => {
    h.visibility = { visible: false, reason: "staff_locked_hide" };
    const r = await drive();
    expect(r.out).toEqual({ kind: "done", result: { skipped: true, reason: "gate:staff_locked_hide" } });
    expect(r.executed).toEqual(["memory-gate-0", "claim", "emit-claimed"]);
    expect(h.dbWrites[0]).toMatchObject({ table: "agent_runs", values: { status: "failed" } });
    expect(h.log.filter((l) => l.startsWith("op:"))).toEqual([]);
  });

  it("a tenant below the agent's tier is refused at execution", async () => {
    h.tier = { enforced: true, tier: "free", required_tier: "pro", allowed: false };
    const r = await drive();
    expect(r.out).toEqual({ kind: "done", result: { skipped: true, reason: "gate:plan_upgrade_required" } });
  });

  it("an unreadable agent definition throws for an Inngest retry (never treated as runnable)", async () => {
    const { loadAgentDefinition } = await import("@/services/agents/registry");
    (loadAgentDefinition as unknown as { mockImplementation: (f: () => Promise<never>) => void }).mockImplementation(async () => {
      throw new Error("registry down");
    });
    const r = await drive();
    expect(r.out).toMatchObject({ kind: "threw" });
    expect(r.executed).toEqual(["memory-gate-0", "claim", "emit-claimed"]);
    expect(h.dbWrites).toEqual([]);
  });

  it("a claim that loses the CAS emits nothing and runs no prelude read", async () => {
    h.claim = null;
    const r = await drive();
    expect(r.out).toEqual({ kind: "done", result: { skipped: true, reason: "not-queued" } });
    expect(h.emits).toEqual([]);
    expect(h.log).toEqual([]);
  });
});

describe("run-agent signup preview: dry, and dry with its cards kept", () => {
  const SEO = { slug: "seo", metadata_praxis: { requires_sandbox: false, model: "claude-opus-5-5", setup: null } };
  const previewClaim = () => ({
    id: "run-1",
    tenant_id: T1,
    agent_slug: "seo",
    trigger: "channel_recipe",
    enqueued_by: null,
    cron_dedupe_key: `first-run-preview:${T1}:seo`,
    payload: {},
  });
  const types = async () =>
    ((await import("@/services/growth/preview-upgrade")).recordPreviewActionTypes as unknown as { mock: { calls: unknown[][] } }).mock.calls;

  beforeEach(async () => {
    h.agentDef = SEO;
    h.claim = previewClaim();
    const { loadAgentDefinition } = await import("@/services/agents/registry");
    (loadAgentDefinition as unknown as { mockImplementation: (f: () => Promise<unknown>) => void }).mockImplementation(
      async () => JSON.parse(JSON.stringify(h.agentDef)),
    );
  });

  it("keep-cards: preview_action_types is NEVER written, at claim or after the run", async () => {
    h.previewMode = { dry: true, keepCards: true };
    const r = await drive("__end__");
    expect(r.out.kind).toBe("done");
    expect(r.executed).toContain("preview-dry");
    expect(r.executed).toContain("dispatch");
    expect(r.executed).not.toContain("preview-action-types");
    expect(await types()).toEqual([]);
    expect(h.dbWrites).toEqual([]);
  });

  it("keep-cards: the run is still dry (draft ctx, stripped result, preview finalize) with the one flag added", async () => {
    h.previewMode = { dry: true, keepCards: true };
    await drive("__end__");
    expect(h.dispatchCtx).toMatchObject({ preview_dry: true, preview_keep_cards: true });
    expect(h.finalizeInput).toMatchObject({ preview: true, result: { stripped: true, output_text: "" } });
  });

  it("keep-cards: no upgrade re-run is requested, and the email step is the dry one (which counts nothing)", async () => {
    h.previewMode = { dry: true, keepCards: true };
    const r = await drive("__end__");
    expect(h.sentEvents).not.toContain("growth.preview_upgrade.requested");
    expect(r.executed).toContain("preview-ready-email");
    const { maybeSendPreviewReadyEmail } = await import("@/services/growth/preview-ready-email");
    const { maybeSendUpgradeActionsReadyEmail } = await import("@/services/growth/preview-upgrade");
    expect(maybeSendPreviewReadyEmail).toHaveBeenCalledTimes(1);
    expect(maybeSendUpgradeActionsReadyEmail).not.toHaveBeenCalled();
  });

  it("switch OFF: the dry run is unchanged (marked at claim, types after, upgrade asked, no keep flag)", async () => {
    h.previewMode = { dry: true, keepCards: false };
    const r = await drive("__end__");
    expect(r.executed).toContain("preview-action-types");
    expect(await types()).toEqual([
      [T1, "run-1", []],
      [T1, "run-1", []],
    ]);
    expect(h.sentEvents).toContain("growth.preview_upgrade.requested");
    expect(h.dispatchCtx).toMatchObject({ preview_dry: true });
    expect((h.dispatchCtx as { preview_keep_cards?: boolean }).preview_keep_cards).toBeUndefined();
    expect(h.finalizeInput).toMatchObject({ preview: true, result: { stripped: true } });
  });

  it("a preview-key run the plan includes is a real run: no preview ctx, no strip, the upgrade email path", async () => {
    h.previewMode = { dry: false, keepCards: false };
    await drive("__end__");
    expect((h.dispatchCtx as { preview_dry?: boolean }).preview_dry).toBeUndefined();
    expect(h.finalizeInput).toMatchObject({ preview: false, result: { output_text: "ok" } });
    expect(await types()).toEqual([]);
    const { maybeSendUpgradeActionsReadyEmail } = await import("@/services/growth/preview-upgrade");
    expect(maybeSendUpgradeActionsReadyEmail).toHaveBeenCalledTimes(1);
  });
});

describe("run-agent onboarding memory hold + first-use docs", () => {
  const SUPPORT = { slug: "support-lead", metadata_praxis: { requires_sandbox: false, model: "claude-opus-5-5", setup: null } };
  const supportClaim = () => ({
    id: "run-1",
    tenant_id: T1,
    agent_slug: "support-lead",
    trigger: "manual",
    enqueued_by: "u-1",
    cron_dedupe_key: null,
    payload: {},
  });

  beforeEach(async () => {
    h.agentDef = SUPPORT;
    h.claim = supportClaim();
    const { loadAgentDefinition } = await import("@/services/agents/registry");
    (loadAgentDefinition as unknown as { mockImplementation: (f: () => Promise<unknown>) => void }).mockImplementation(
      async () => JSON.parse(JSON.stringify(h.agentDef)),
    );
  });

  it("holds a queued run while a young tenant's memory is pending, then claims once it is ready", async () => {
    h.gate = { runStatus: "queued", tenantCreatedAt: new Date().toISOString(), memoryStatuses: ["pending", "pending", "ready"] };
    const r = await drive();
    expect(r.executed.slice(0, 7)).toEqual([
      "memory-gate-0",
      "memory-gate-sleep-0",
      "memory-gate-1",
      "memory-gate-sleep-1",
      "memory-gate-2",
      "claim",
      "emit-claimed",
    ]);
  });

  it("an old tenant is not held, even with a pending row", async () => {
    h.gate = { runStatus: "queued", tenantCreatedAt: new Date(Date.now() - 60 * 60_000).toISOString(), memoryStatuses: ["pending"] };
    const r = await drive();
    expect(r.executed.slice(0, 2)).toEqual(["memory-gate-0", "claim"]);
  });

  it("support-lead fills placeholder docs for the claimed row's tenant, after claim and before dispatch", async () => {
    const r = await drive();
    const ex = r.executed;
    expect(ex).toContain("fill-placeholder-docs");
    expect(ex.indexOf("claim")).toBeLessThan(ex.indexOf("fill-placeholder-docs"));
    expect(ex.indexOf("fill-placeholder-docs")).toBeLessThan(ex.indexOf("dispatch"));
    const { fillPlaceholderDocs } = await import("@/services/memory/fill-placeholder-docs");
    expect(fillPlaceholderDocs).toHaveBeenCalledWith(T1, "support-lead");
  });

  it("other agents never run the fill step", async () => {
    h.agentDef = { ...SUPPORT, slug: "operator" };
    h.claim = { ...supportClaim(), agent_slug: "operator" };
    const r = await drive();
    expect(r.executed).toContain("dispatch");
    expect(r.executed).not.toContain("fill-placeholder-docs");
  });
});

describe("run-agent failure path under Inngest replay", () => {
  const SEO = { slug: "seo", metadata_praxis: { requires_sandbox: false, model: "claude-opus-5-5", setup: null } };
  const stepError = () => Object.assign(new Error("send failed"), { name: "StepError", stepId: "emit-completed" });
  const terminalLogs = async () => {
    const { logEvent } = await import("@/services/logging/logEvent");
    return (logEvent as unknown as { mock: { calls: Array<[{ code: string; meta?: Record<string, unknown> }]> } }).mock.calls
      .map((c) => c[0])
      .filter((a) => a.code === "run_terminal_error");
  };

  beforeEach(async () => {
    h.agentDef = SEO;
    h.claim = {
      id: "run-1",
      tenant_id: T1,
      agent_slug: "seo",
      trigger: "channel_recipe",
      enqueued_by: null,
      cron_dedupe_key: null,
      payload: {},
    };
    const { loadAgentDefinition } = await import("@/services/agents/registry");
    (loadAgentDefinition as unknown as { mockImplementation: (f: () => Promise<unknown>) => void }).mockImplementation(
      async () => JSON.parse(JSON.stringify(h.agentDef)),
    );
  });

  it("logs run_terminal_error and emits `failed` exactly once across every replay, naming the failed step", async () => {
    h.finalizeError = stepError();
    const r = await drive("__end__");
    expect(r.out.kind).toBe("done");
    expect(r.invocations).toBeGreaterThan(2);
    expect(r.executed.filter((id) => id === "log-terminal-error")).toHaveLength(1);
    expect(r.executed.filter((id) => id === "emit-failed-progress")).toHaveLength(1);
    expect(h.emits.filter((s) => s === "failed")).toHaveLength(1);
    const logs = await terminalLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].meta).toMatchObject({ agent_slug: "seo", stage: "emit-completed" });
  });

  it("a dry preview run keeps the failed step's id though its error text is replaced", async () => {
    h.claim = { ...(h.claim as object), cron_dedupe_key: `first-run-preview:${T1}:seo` };
    h.previewMode = { dry: true, keepCards: false };
    h.finalizeError = stepError();
    await drive("__end__");
    const logs = await terminalLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].meta).toMatchObject({ stage: "emit-completed" });
  });

  it.each([false, true])("a finished run whose preview-action-types step fails stays a success (warning fails: %s)", async (warningFails) => {
    h.claim = { ...(h.claim as object), cron_dedupe_key: `first-run-preview:${T1}:seo` };
    h.previewMode = { dry: true, keepCards: false };
    const { recordPreviewActionTypes } = await import("@/services/growth/preview-upgrade");
    (recordPreviewActionTypes as unknown as { mockResolvedValueOnce: (v: unknown) => { mockRejectedValueOnce: (e: Error) => void } })
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("db down"));
    const { logEvent } = await import("@/services/logging/logEvent");
    vi.mocked(logEvent).mockImplementation(async (event) => {
      if (warningFails && event.code === "preview_action_types_failed") throw new Error("log unavailable");
    });
    const r = await drive("__end__", { retryErrors: true, failErrors: true }).finally(() => vi.mocked(logEvent).mockImplementation(async () => undefined));
    expect(r.out.kind).toBe("done");
    expect(r.executed).toContain("preview-action-types!");
    expect(r.executed.filter((id) => id === `log-preview-action-types-failed${warningFails ? "!" : ""}`)).toHaveLength(1);
    expect(r.out).toMatchObject({ result: { ok: true } });
    expect(r.executed).not.toContain("persist-failure");
    expect(r.executed).not.toContain("log-terminal-error");
    expect(h.emits).not.toContain("failed");
    expect(h.sentEvents).not.toContain("agent.run.failed");
    expect(await terminalLogs()).toHaveLength(0);
  });
});
