import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  a2aDispatch: vi.fn(),
  serviceClientMock: vi.fn(),
}));

vi.mock("@/services/agents/a2a-dispatch", () => ({ a2aDispatch: mocks.a2aDispatch }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/hosting/static-publish", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/hosting/static-publish")>()),
  readStaticState: vi.fn(async () => null),
}));

import {
  mapChildStatus,
  isConductorEnabled,
  realConductorTickDeps,
  isConductorRepairEnabled,
  resolveRepairMaxAttempts,
  DEFAULT_REPAIR_MAX_ATTEMPTS,
  REPAIRABLE_STAGES,
  isBuildDeployStageEnabled,
  isBuildScreenCheckEnabled,
  readHostingStatus,
  REFINE_DEPLOY_GATE_MAX_WAIT_MS,
  refineDeployGateMaxWaitMs,
  BUILD_DEPLOY_GATE_MAX_WAIT_MS,
  noChangeEvidencePasses,
  noChangeEvidenceDetail,
  resumeEpochSuffix,
  readChildNoActionSignal,
} from "../conductor-driver";
import type { ConductorNode } from "../conductor";

describe("mapChildStatus", () => {
  it("maps success → success", () => {
    expect(mapChildStatus("success")).toBe("success");
  });
  it("maps every failure variant → failed", () => {
    expect(mapChildStatus("failed")).toBe("failed");
    expect(mapChildStatus("parse_failed")).toBe("failed");
    expect(mapChildStatus("dispatch_error")).toBe("failed");
  });
  it("maps in-flight / unknown / missing → running", () => {
    expect(mapChildStatus("queued")).toBe("running");
    expect(mapChildStatus("running")).toBe("running");
    expect(mapChildStatus(undefined)).toBe("running");
    expect(mapChildStatus(null)).toBe("running");
    expect(mapChildStatus("weird")).toBe("running");
  });
});

describe("readChildNoActionSignal", () => {
  beforeEach(() => {
    mocks.serviceClientMock.mockReset();
  });

  function runRow(data: { parse_error: string | null; output_text: string | null } | null) {
    const maybeSingle = vi.fn(async () => ({ data, error: null }));
    const tenantEq = vi.fn(() => ({ maybeSingle }));
    const idEq = vi.fn(() => ({ eq: tenantEq }));
    mocks.serviceClientMock.mockReturnValue({
      from: vi.fn(() => ({ select: vi.fn(() => ({ eq: idEq })) })),
    });
    return { idEq, tenantEq, maybeSingle };
  }

  it("returns the child's explanation for the durable action-missing marker", async () => {
    const q = runRow({
      parse_error: "note; action_missing:no_decision_emitted",
      output_text: "I need real customer quotes before I can add testimonials.",
    });

    await expect(
      readChildNoActionSignal({ tenant_id: "tenant-1", child_run_id: "child-1" }),
    ).resolves.toBe("I need real customer quotes before I can add testimonials.");
    expect(q.idEq).toHaveBeenCalledWith("id", "child-1");
    expect(q.tenantEq).toHaveBeenCalledWith("tenant_id", "tenant-1");
  });

  it("returns null when a successful child may still have a push settling", async () => {
    runRow({ parse_error: null, output_text: "Implemented the update." });

    await expect(
      readChildNoActionSignal({ tenant_id: "tenant-1", child_run_id: "child-1" }),
    ).resolves.toBeNull();
  });
});

describe("isConductorEnabled", () => {
  it("is ON by default; only the exact value '0' disables it (global break-glass)", async () => {
    const prev = process.env.PRAXIS_CONDUCTOR_ENABLED;
    delete process.env.PRAXIS_CONDUCTOR_ENABLED;
    expect(await isConductorEnabled()).toBe(true);
    process.env.PRAXIS_CONDUCTOR_ENABLED = "true";
    expect(await isConductorEnabled()).toBe(true);
    process.env.PRAXIS_CONDUCTOR_ENABLED = "1";
    expect(await isConductorEnabled()).toBe(true);
    process.env.PRAXIS_CONDUCTOR_ENABLED = "0";
    expect(await isConductorEnabled()).toBe(false);
    if (prev === undefined) delete process.env.PRAXIS_CONDUCTOR_ENABLED;
    else process.env.PRAXIS_CONDUCTOR_ENABLED = prev;
  });
});

describe("dispatch dep — dedupe-recovery (Phase-2 P0 fix)", () => {
  const dispatchInput = {
    tenant_id: "t-1",
    conductor_run_id: "cr-1",
    node_id: "n-build",
    target_agent_slug: "engineer",
    payload: { stage: "build" },
  };

  beforeEach(() => {
    mocks.a2aDispatch.mockReset();
    mocks.serviceClientMock.mockReset();
  });

  it("passes through ok:true from a2aDispatch unchanged", async () => {
    const claims = claimsClient();
    mocks.serviceClientMock.mockReturnValueOnce(claims);
    mocks.a2aDispatch.mockResolvedValueOnce({ ok: true, child_run_id: "run-fresh" });
    const r = await realConductorTickDeps.dispatch(dispatchInput);
    expect(r).toEqual({ ok: true, child_run_id: "run-fresh" });
  });

  it("on 'deduped', looks up dispatch_history + returns ok:true with the success-twin run id", async () => {
    mocks.a2aDispatch.mockResolvedValueOnce({ ok: false, reason: "deduped" });
    mocks.serviceClientMock.mockReturnValueOnce(claimsClient());
    mocks.serviceClientMock
      .mockReturnValueOnce({
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({
                    data: [{ target_run_id: "run-stuck" }, { target_run_id: "run-prior" }],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          select: () => ({
            in: async () => ({
              data: [
                { id: "run-stuck", status: "running" },
                { id: "run-prior", status: "success" },
              ],
              error: null,
            }),
          }),
        }),
      });
    const r = await realConductorTickDeps.dispatch(dispatchInput);
    expect(r).toEqual({ ok: true, child_run_id: "run-prior", adopted: true });
  });

  it("on 'deduped' with no prior found (lookup miss), returns 'deduped_no_prior_found' so node re-tries next tick (NOT failed)", async () => {
    mocks.a2aDispatch.mockResolvedValueOnce({ ok: false, reason: "deduped" });
    mocks.serviceClientMock.mockReturnValueOnce(claimsClient());
    mocks.serviceClientMock.mockReturnValueOnce({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
    });
    const r = await realConductorTickDeps.dispatch(dispatchInput);
    expect(r).toEqual({ ok: false, reason: "deduped_no_prior_found" });
  });

  it("on non-deduped failure, passes through reason unchanged (e.g. over_cap)", async () => {
    const claims = claimsClient();
    mocks.serviceClientMock.mockReturnValueOnce(claims);
    mocks.a2aDispatch.mockResolvedValueOnce({ ok: false, reason: "over_cap" });
    const r = await realConductorTickDeps.dispatch(dispatchInput);
    expect(r).toEqual({ ok: false, reason: "over_cap" });
    expect(mocks.serviceClientMock).toHaveBeenCalledOnce();
    expect(claims.calls.deletes).toBe(1);
  });
});

function claimsClient(insertError: { code?: string; message: string } | null = null) {
  const calls = { inserts: [] as unknown[], deletes: 0 };
  const chain: Record<string, unknown> = {};
  chain.eq = () => chain;
  chain.lt = () => chain;
  chain.then = (res: (v: { error: null }) => unknown) => res({ error: null });
  const client = {
    calls,
    from: (table: string) => {
      if (table !== "conductor_dispatch_claims") throw new Error(`unexpected table ${table}`);
      return {
        insert: async (row: unknown) => {
          calls.inserts.push(row);
          return { error: insertError };
        },
        delete: () => {
          calls.deletes += 1;
          return chain;
        },
      };
    },
  };
  return client;
}

describe("B2 repair-loop driver config", () => {
  it("isConductorRepairEnabled defaults ON — only PRAXIS_CONDUCTOR_REPAIR_ENABLED=0 disables it", () => {
    const prev = process.env.PRAXIS_CONDUCTOR_REPAIR_ENABLED;
    delete process.env.PRAXIS_CONDUCTOR_REPAIR_ENABLED;
    expect(isConductorRepairEnabled()).toBe(true);
    process.env.PRAXIS_CONDUCTOR_REPAIR_ENABLED = "1";
    expect(isConductorRepairEnabled()).toBe(true);
    process.env.PRAXIS_CONDUCTOR_REPAIR_ENABLED = "true";
    expect(isConductorRepairEnabled()).toBe(true);
    process.env.PRAXIS_CONDUCTOR_REPAIR_ENABLED = "0";
    expect(isConductorRepairEnabled()).toBe(false);
    if (prev === undefined) delete process.env.PRAXIS_CONDUCTOR_REPAIR_ENABLED;
    else process.env.PRAXIS_CONDUCTOR_REPAIR_ENABLED = prev;
  });

  it("resolveRepairMaxAttempts defaults to 3, clamps junk/<1 to default and caps at 10", () => {
    const prev = process.env.PRAXIS_CONDUCTOR_REPAIR_MAX_ATTEMPTS;
    delete process.env.PRAXIS_CONDUCTOR_REPAIR_MAX_ATTEMPTS;
    expect(resolveRepairMaxAttempts()).toBe(DEFAULT_REPAIR_MAX_ATTEMPTS);
    process.env.PRAXIS_CONDUCTOR_REPAIR_MAX_ATTEMPTS = "5";
    expect(resolveRepairMaxAttempts()).toBe(5);
    process.env.PRAXIS_CONDUCTOR_REPAIR_MAX_ATTEMPTS = "0";
    expect(resolveRepairMaxAttempts()).toBe(DEFAULT_REPAIR_MAX_ATTEMPTS);
    process.env.PRAXIS_CONDUCTOR_REPAIR_MAX_ATTEMPTS = "999";
    expect(resolveRepairMaxAttempts()).toBe(10);
    process.env.PRAXIS_CONDUCTOR_REPAIR_MAX_ATTEMPTS = "abc";
    expect(resolveRepairMaxAttempts()).toBe(DEFAULT_REPAIR_MAX_ATTEMPTS);
    if (prev === undefined) delete process.env.PRAXIS_CONDUCTOR_REPAIR_MAX_ATTEMPTS;
    else process.env.PRAXIS_CONDUCTOR_REPAIR_MAX_ATTEMPTS = prev;
  });

  it("repairable stages are the codegen/verify stages only (scaffold/build/qa)", () => {
    expect([...REPAIRABLE_STAGES]).toEqual(["scaffold", "build", "qa"]);
  });
});

describe("captureFailureSignal dep", () => {
  beforeEach(() => {
    mocks.a2aDispatch.mockReset();
    mocks.serviceClientMock.mockReset();
  });

  function mockAgentRunsRow(rowData: Record<string, unknown> | null) {
    mocks.serviceClientMock.mockReturnValueOnce({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: rowData, error: null }),
          }),
        }),
      }),
    });
  }

  it("prefers the run's `error` over output_text", async () => {
    mockAgentRunsRow({ error: "build failed: ENOENT", parse_error: null, output_text: "some output" });
    const s = await realConductorTickDeps.captureFailureSignal!("rid");
    expect(s).toBe("build failed: ENOENT");
  });

  it("falls back to parse_error, then output_text", async () => {
    mockAgentRunsRow({ error: null, parse_error: "envelope parse error", output_text: "out" });
    expect(await realConductorTickDeps.captureFailureSignal!("rid")).toBe("envelope parse error");
    mockAgentRunsRow({ error: null, parse_error: null, output_text: "qa: 3 assertions failed" });
    expect(await realConductorTickDeps.captureFailureSignal!("rid")).toBe("qa: 3 assertions failed");
  });

  it("uses parse_error when error is the generic parse message and parse_error carries a role-grant refusal", async () => {
    const { PARSE_FAILED_USER_ERROR } = await import("@/services/agents/runner");
    const { ROLE_GRANT_ERROR_PREFIX } = await import("@/services/provisioning/role-grant-check");
    const detail = `${ROLE_GRANT_ERROR_PREFIX} app/api/signup/route.ts:12 grants a role by signup order / first user / row count`;
    mockAgentRunsRow({ error: PARSE_FAILED_USER_ERROR, parse_error: `transform_threw:${detail}`, output_text: "out" });
    expect(await realConductorTickDeps.captureFailureSignal!("rid")).toBe(detail);
    mockAgentRunsRow({ error: PARSE_FAILED_USER_ERROR, parse_error: `no envelope; transform_threw:${detail}`, output_text: "out" });
    expect(await realConductorTickDeps.captureFailureSignal!("rid")).toBe(detail);
  });

  it("keeps the error-first order for any other parse_error or error", async () => {
    const { PARSE_FAILED_USER_ERROR } = await import("@/services/agents/runner");
    mockAgentRunsRow({ error: PARSE_FAILED_USER_ERROR, parse_error: "transform_threw:boom", output_text: null });
    expect(await realConductorTickDeps.captureFailureSignal!("rid")).toBe(PARSE_FAILED_USER_ERROR);
    mockAgentRunsRow({ error: "build failed", parse_error: "transform_threw:unsafe_role_grant: x.ts:1", output_text: null });
    expect(await realConductorTickDeps.captureFailureSignal!("rid")).toBe("build failed");
  });

  it("returns null when the run row is missing or all signal fields are empty", async () => {
    mockAgentRunsRow(null);
    expect(await realConductorTickDeps.captureFailureSignal!("rid")).toBeNull();
    mockAgentRunsRow({ error: "", parse_error: null, output_text: "  " });
    expect(await realConductorTickDeps.captureFailureSignal!("rid")).toBeNull();
  });
});

describe("dispatchRepair dep", () => {
  beforeEach(() => {
    mocks.a2aDispatch.mockReset();
    mocks.serviceClientMock.mockReset();
  });

  it("dispatches via a2a with an attempt-suffixed dedup_key and returns the repair child id", async () => {
    mocks.serviceClientMock.mockReturnValueOnce(claimsClient());
    mocks.a2aDispatch.mockResolvedValueOnce({ ok: true, child_run_id: "repair-run-1" });
    const r = await realConductorTickDeps.dispatchRepair!({
      tenant_id: "t-1",
      conductor_run_id: "cr-1",
      node_id: "qa",
      attempt: 2,
      target_agent_slug: "engineer",
      payload: { stage: "qa", refine_mode: true },
      failure_signal: "assertion failed",
    });
    expect(r).toEqual({ ok: true, child_run_id: "repair-run-1" });
    expect(mocks.a2aDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ dedup_key: "conductor:cr-1:qa:repair:2", source_agent_slug: "conductor" }),
    );
  });
});

describe("isBuildDeployStageEnabled / isBuildScreenCheckEnabled (default ON; kill-switch ='0')", () => {
  function withEnv(key: string, value: string | undefined, fn: () => void) {
    const prev = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }

  it("BUILD_DEPLOY_STAGE_ENABLED: unset ⇒ ON, '1'/'true' ⇒ ON, '0' ⇒ OFF (kill-switch)", () => {
    withEnv("BUILD_DEPLOY_STAGE_ENABLED", undefined, () =>
      expect(isBuildDeployStageEnabled()).toBe(true),
    );
    withEnv("BUILD_DEPLOY_STAGE_ENABLED", "1", () =>
      expect(isBuildDeployStageEnabled()).toBe(true),
    );
    withEnv("BUILD_DEPLOY_STAGE_ENABLED", "true", () =>
      expect(isBuildDeployStageEnabled()).toBe(true),
    );
    withEnv("BUILD_DEPLOY_STAGE_ENABLED", "0", () =>
      expect(isBuildDeployStageEnabled()).toBe(false),
    );
  });

  it("BUILD_SCREEN_CHECK_ENABLED: unset ⇒ ON, '1' ⇒ ON, '0' ⇒ OFF (kill-switch)", () => {
    withEnv("BUILD_SCREEN_CHECK_ENABLED", undefined, () =>
      expect(isBuildScreenCheckEnabled()).toBe(true),
    );
    withEnv("BUILD_SCREEN_CHECK_ENABLED", "1", () =>
      expect(isBuildScreenCheckEnabled()).toBe(true),
    );
    withEnv("BUILD_SCREEN_CHECK_ENABLED", "0", () =>
      expect(isBuildScreenCheckEnabled()).toBe(false),
    );
  });
});

describe("readHostingStatus (non-throwing; newest-of-many; error→provisioning)", () => {
  beforeEach(() => {
    mocks.serviceClientMock.mockReset();
  });

  function mockHostingQuery(result: { data: unknown; error: unknown }) {
    mocks.serviceClientMock.mockReturnValueOnce({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => result,
                }),
              }),
            }),
          }),
        }),
      }),
    });
  }

  it("does NOT throw on >1 provisioned row — returns the FIRST (newest) row's status", async () => {
    mockHostingQuery({ data: [{ status: "ready" }, { status: "failed" }], error: null });
    await expect(readHostingStatus("t-multi")).resolves.toBe("ready");
  });

  it("maps single-row statuses (ready/failed/provisioning/none)", async () => {
    mockHostingQuery({ data: [{ status: "ready" }], error: null });
    expect(await readHostingStatus("t")).toBe("ready");
    mockHostingQuery({ data: [{ status: "failed" }], error: null });
    expect(await readHostingStatus("t")).toBe("failed");
    mockHostingQuery({ data: [{ status: "building" }], error: null });
    expect(await readHostingStatus("t")).toBe("provisioning");
    mockHostingQuery({ data: [], error: null });
    expect(await readHostingStatus("t")).toBe("none");
  });

  it("on a query error → 'provisioning' (treat as still-deploying; NEVER throws)", async () => {
    mockHostingQuery({ data: null, error: { message: "db read failed" } });
    await expect(readHostingStatus("t-err")).resolves.toBe("provisioning");
  });
});

describe("readHostingStatus — content-verify (placeholder→failed, real app→ready, fail-safe)", () => {
  const SEED_HTML =
    '<html><head><title>Your Company</title></head><body><h1>Your company app is live.</h1></body></html>';
  const REAL_HTML =
    '<html><head><title>LocalPro — find a pro</title></head><body><h1>Book trusted local service providers</h1></body></html>';

  beforeEach(() => {
    mocks.serviceClientMock.mockReset();
    delete process.env.BUILD_DEPLOY_CONTENT_VERIFY;
    vi.unstubAllGlobals();
  });

  function mockHostingQueryWithRef(result: { data: unknown; error: unknown }) {
    mocks.serviceClientMock.mockReturnValueOnce({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({ limit: async () => result }),
              }),
            }),
          }),
        }),
      }),
    });
  }

  function stubFetch(impl: (url: string) => { ok: boolean; status: number; text: () => Promise<string> }) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => impl(url)));
  }

  it("status='ready' but the URL still serves the SEED placeholder → 'failed' (never LIVE)", async () => {
    mockHostingQueryWithRef({
      data: [{ status: "ready", external_ref: { url: "https://localpro-x.onrender.com" } }],
      error: null,
    });
    stubFetch(() => ({ ok: true, status: 200, text: async () => SEED_HTML }));
    await expect(readHostingStatus("t-seed")).resolves.toBe("failed");
  });

  it("status='ready' and the URL serves the REAL generated app → 'ready'", async () => {
    mockHostingQueryWithRef({
      data: [{ status: "ready", external_ref: { url: "https://localpro-x.onrender.com" } }],
      error: null,
    });
    stubFetch(() => ({ ok: true, status: 200, text: async () => REAL_HTML }));
    await expect(readHostingStatus("t-real")).resolves.toBe("ready");
  });

  it("fail-SAFE: fetch throws → 'ready' (a probe hiccup never becomes a false build failure)", async () => {
    mockHostingQueryWithRef({
      data: [{ status: "ready", external_ref: { url: "https://localpro-x.onrender.com" } }],
      error: null,
    });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    await expect(readHostingStatus("t-hiccup")).resolves.toBe("ready");
  });

  it("fail-SAFE: non-2xx body → 'ready' (not a confirmed placeholder)", async () => {
    mockHostingQueryWithRef({
      data: [{ status: "ready", external_ref: { url: "https://localpro-x.onrender.com" } }],
      error: null,
    });
    stubFetch(() => ({ ok: false, status: 502, text: async () => "<h1>Bad Gateway</h1>" }));
    await expect(readHostingStatus("t-502")).resolves.toBe("ready");
  });

  it("no url on the hosting row → 'ready' (can't content-verify → legacy behavior)", async () => {
    mockHostingQueryWithRef({ data: [{ status: "ready", external_ref: {} }], error: null });
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(readHostingStatus("t-nourl")).resolves.toBe("ready");
    expect(f).not.toHaveBeenCalled();
  });

  it("kill-switch BUILD_DEPLOY_CONTENT_VERIFY=0 → 'ready' without probing", async () => {
    process.env.BUILD_DEPLOY_CONTENT_VERIFY = "0";
    mockHostingQueryWithRef({
      data: [{ status: "ready", external_ref: { url: "https://localpro-x.onrender.com" } }],
      error: null,
    });
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(readHostingStatus("t-killswitch")).resolves.toBe("ready");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("readHostingStatus — BUILD deploy bounded wait (deploy_enqueued_at)", () => {
  const SEED_HTML =
    '<html><head><title>Your Company</title></head><body><h1>Your company app is live.</h1></body></html>';
  const REAL_HTML =
    '<html><head><title>LocalPro — find a pro</title></head><body><h1>Book trusted local service providers</h1></body></html>';

  beforeEach(() => {
    mocks.serviceClientMock.mockReset();
    delete process.env.BUILD_DEPLOY_CONTENT_VERIFY;
    delete process.env.BUILD_DEPLOY_GATE_MAX_WAIT_MS;
    vi.unstubAllGlobals();
  });

  function mockHostingQueryWithRef(result: { data: unknown; error: unknown }) {
    mocks.serviceClientMock.mockReturnValueOnce({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({ order: () => ({ limit: async () => result }) }),
            }),
          }),
        }),
      }),
    });
  }
  function stubFetch(impl: (url: string) => { ok: boolean; status: number; text: () => Promise<string> }) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => impl(url)));
  }
  const READY_ROW = {
    data: [{ status: "ready", external_ref: { url: "https://localpro-x.onrender.com" } }],
    error: null,
  };
  function deployNode(enqueuedAt: number): ConductorNode {
    return {
      id: "n-deploy",
      status: "pending",
      target_agent_slug: "deploy-gate",
      estimate_usd: 0,
      payload: { stage: "deploy", deploy_enqueued_at: enqueuedAt },
    };
  }
  const WITHIN_BOUND = Date.now();
  const PAST_BOUND = Date.now() - BUILD_DEPLOY_GATE_MAX_WAIT_MS - 60_000;

  it("Bug #2: seed served (Render mid-swap) + WITHIN bound → 'provisioning' (NOT failed)", async () => {
    mockHostingQueryWithRef(READY_ROW);
    stubFetch(() => ({ ok: true, status: 200, text: async () => SEED_HTML }));
    await expect(readHostingStatus("t", deployNode(WITHIN_BOUND))).resolves.toBe("provisioning");
  });

  it("seed served + PAST bound → 'failed' (the real code never served in time)", async () => {
    mockHostingQueryWithRef(READY_ROW);
    stubFetch(() => ({ ok: true, status: 200, text: async () => SEED_HTML }));
    await expect(readHostingStatus("t", deployNode(PAST_BOUND))).resolves.toBe("failed");
  });

  it("Bug #3: real deploy 500s (non-2xx) + WITHIN bound → 'provisioning' (NOT ready)", async () => {
    mockHostingQueryWithRef(READY_ROW);
    stubFetch(() => ({ ok: false, status: 500, text: async () => "<h1>Internal Error</h1>" }));
    await expect(readHostingStatus("t", deployNode(WITHIN_BOUND))).resolves.toBe("provisioning");
  });

  it("persistent non-2xx + PAST bound → 'failed' (never silently LIVE)", async () => {
    mockHostingQueryWithRef(READY_ROW);
    stubFetch(() => ({ ok: false, status: 500, text: async () => "<h1>Internal Error</h1>" }));
    await expect(readHostingStatus("t", deployNode(PAST_BOUND))).resolves.toBe("failed");
  });

  it("real (2xx non-seed) generated app → 'ready' immediately, regardless of the clock", async () => {
    mockHostingQueryWithRef(READY_ROW);
    stubFetch(() => ({ ok: true, status: 200, text: async () => REAL_HTML }));
    await expect(readHostingStatus("t", deployNode(PAST_BOUND))).resolves.toBe("ready");
  });

  it("row stuck non-ready (e.g. 'building') + PAST bound → 'failed' (loud, not an infinite wait)", async () => {
    mockHostingQueryWithRef({ data: [{ status: "building" }], error: null });
    await expect(readHostingStatus("t", deployNode(PAST_BOUND))).resolves.toBe("failed");
  });

  it("row stuck non-ready + WITHIN bound → 'provisioning' (still deploying)", async () => {
    mockHostingQueryWithRef({ data: [{ status: "building" }], error: null });
    await expect(readHostingStatus("t", deployNode(WITHIN_BOUND))).resolves.toBe("provisioning");
  });

  it("no hosting row + PAST bound → 'failed' (deploy enqueued but row never appeared)", async () => {
    mockHostingQueryWithRef({ data: [], error: null });
    await expect(readHostingStatus("t", deployNode(PAST_BOUND))).resolves.toBe("failed");
  });

  it("no hosting row + WITHIN bound → 'none' (a lagging insert must not false-fail)", async () => {
    mockHostingQueryWithRef({ data: [], error: null });
    await expect(readHostingStatus("t", deployNode(WITHIN_BOUND))).resolves.toBe("none");
  });

  it("non-ready / no-row with NO deploy stamp → legacy (unbounded), never bound-failed", async () => {
    mockHostingQueryWithRef({ data: [{ status: "building" }], error: null });
    await expect(readHostingStatus("t")).resolves.toBe("provisioning");
    mockHostingQueryWithRef({ data: [], error: null });
    await expect(readHostingStatus("t")).resolves.toBe("none");
  });

  it("DB read error → 'provisioning' even PAST bound (observability blip must not fail a build)", async () => {
    mockHostingQueryWithRef({ data: null, error: { message: "db read failed" } });
    await expect(readHostingStatus("t", deployNode(PAST_BOUND))).resolves.toBe("provisioning");
  });
});

describe("readHostingStatus — REFINE DEPLOY GATE overlay (HEAD-advanced + bound)", () => {
  const REAL_HTML =
    '<html><head><title>LocalPro</title></head><body><h1>Book a pro</h1></body></html>';
  const APP_URL = "https://localpro-x.onrender.com";
  const REPO = "praxis-built/acme";
  const PRE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const NEW_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  beforeEach(() => {
    mocks.serviceClientMock.mockReset();
    delete process.env.BUILD_DEPLOY_CONTENT_VERIFY;
    process.env.GITHUB_PROVISION_TOKEN = "ghp_test_token";
    vi.unstubAllGlobals();
  });

  function mockHosting(status: string, url = APP_URL) {
    mocks.serviceClientMock.mockReturnValueOnce({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({
                    data: [{ status, external_ref: { url } }],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    });
  }

  function stubFetchRouted(headSha: string | null) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("api.github.com")) {
          if (headSha === null) return { ok: false, status: 404, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => ({ object: { sha: headSha } }) };
        }
        return { ok: true, status: 200, text: async () => REAL_HTML };
      }),
    );
  }

  function refineNode(over: { pre?: string; enqueuedAt?: number } = {}): ConductorNode {
    return {
      id: "deploy",
      status: "pending",
      target_agent_slug: "",
      estimate_usd: 0,
      child_run_id: null,
      payload: {
        stage: "deploy",
        target: { github_full_name: REPO, default_branch: "main" },
        refine_deploy_enqueued_at: over.enqueuedAt ?? Date.now(),
        ...(over.pre === undefined ? { pre_refine_sha: PRE_SHA } : over.pre ? { pre_refine_sha: over.pre } : {}),
      },
    };
  }

  it("base 'ready' but HEAD still == pre_refine_sha (commit NOT landed) → WAITS ('provisioning')", async () => {
    mockHosting("ready");
    stubFetchRouted(PRE_SHA);
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("provisioning");
  });

  it("base 'ready' AND HEAD advanced past pre_refine_sha (commit landed) → 'ready'", async () => {
    mockHosting("ready");
    stubFetchRouted(NEW_SHA);
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("ready");
  });

  it("base 'ready', HEAD unreadable (null) → WAITS within bound ('provisioning') — never falsely 'ready'", async () => {
    mockHosting("ready");
    stubFetchRouted(null);
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("provisioning");
  });

  it("BOUND: HEAD still == pre_refine_sha AND enqueued > bound ago → 'failed' (slot releases, never holds forever)", async () => {
    mockHosting("ready");
    stubFetchRouted(PRE_SHA);
    const stale = Date.now() - REFINE_DEPLOY_GATE_MAX_WAIT_MS - 60_000;
    await expect(
      readHostingStatus("t", refineNode({ enqueuedAt: stale })),
    ).resolves.toBe("failed");
  });

  it("FALSE-FAILED FIX: base 'ready', commit not yet landed, 15 min elapsed (past OLD 12-min bound, within NEW 25-min bound) → 'provisioning' NOT 'failed'", async () => {
    mockHosting("ready");
    stubFetchRouted(PRE_SHA);
    const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
    await expect(
      readHostingStatus("t", refineNode({ enqueuedAt: fifteenMinAgo })),
    ).resolves.toBe("provisioning");
  });

  it("FALSE-FAILED FIX: base 'ready' + HEAD ADVANCED even PAST the bound → 'ready' (landed + live, clock-independent)", async () => {
    mockHosting("ready");
    stubFetchRouted(NEW_SHA);
    const stale = Date.now() - REFINE_DEPLOY_GATE_MAX_WAIT_MS - 60_000;
    await expect(
      readHostingStatus("t", refineNode({ enqueuedAt: stale })),
    ).resolves.toBe("ready");
  });

  it("BOUND: base 'ready', HEAD CONFIRMED unchanged, past bound → 'provisioning' within bound, 'failed' past bound (slot releases)", async () => {
    mockHosting("ready");
    stubFetchRouted(PRE_SHA);
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("provisioning");

    mockHosting("ready");
    stubFetchRouted(PRE_SHA);
    const stale = Date.now() - REFINE_DEPLOY_GATE_MAX_WAIT_MS - 1;
    await expect(
      readHostingStatus("t", refineNode({ enqueuedAt: stale })),
    ).resolves.toBe("failed");
  });

  it("CODEX-P1#1 GUARD: base 'provisioning' past bound EVEN with HEAD advanced → 'failed' (not-live host is not a live refine)", async () => {
    mockHosting("provisioning");
    stubFetchRouted(NEW_SHA);
    const stale = Date.now() - REFINE_DEPLOY_GATE_MAX_WAIT_MS - 1;
    await expect(
      readHostingStatus("t", refineNode({ enqueuedAt: stale })),
    ).resolves.toBe("failed");
  });

  it("base 'provisioning' within bound → 'provisioning' (still deploying)", async () => {
    mockHosting("provisioning");
    stubFetchRouted(PRE_SHA);
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("provisioning");
  });

  it("BOUND: base 'none' past bound → 'failed' (slot releases on a true non-deploy)", async () => {
    mockHosting("none");
    stubFetchRouted(PRE_SHA);
    const stale = Date.now() - REFINE_DEPLOY_GATE_MAX_WAIT_MS - 1;
    await expect(
      readHostingStatus("t", refineNode({ enqueuedAt: stale })),
    ).resolves.toBe("failed");
  });

  it("CODEX-P1#2 GUARD: base 'ready', HEAD UNREADABLE (null) past bound → 'failed' (terminal; slot-release guarantee preserved, no infinite hold)", async () => {
    mockHosting("ready");
    stubFetchRouted(null);
    const stale = Date.now() - REFINE_DEPLOY_GATE_MAX_WAIT_MS - 1;
    await expect(
      readHostingStatus("t", refineNode({ enqueuedAt: stale })),
    ).resolves.toBe("failed");
  });

  it("base 'failed' (deploy broke) → 'failed' regardless of HEAD", async () => {
    mockHosting("failed");
    stubFetchRouted(NEW_SHA);
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("failed");
  });

  it("NO-REGRESSION: a deploy node WITHOUT pre_refine_sha behaves byte-identically (base only, NEVER hits the github HEAD API)", async () => {
    mockHosting("ready");
    const f = vi.fn(async (url: string) => {
      if (url.includes("api.github.com")) throw new Error("github must NOT be called for a normal build");
      return { ok: true, status: 200, text: async () => REAL_HTML };
    });
    vi.stubGlobal("fetch", f);
    const normalNode = refineNode({ pre: "" });
    await expect(readHostingStatus("t", normalNode)).resolves.toBe("ready");
    expect(f.mock.calls.every(([u]) => !String(u).includes("api.github.com"))).toBe(true);
  });

  it("NO-REGRESSION: node ABSENT entirely → base status only (the wired build path)", async () => {
    mockHosting("ready");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => REAL_HTML })));
    await expect(readHostingStatus("t")).resolves.toBe("ready");
  });
});

describe("readHostingStatus — REFINE gate waits for Render to serve the landed commit", () => {
  const REAL_HTML = "<html><head><title>Loaner</title></head><body><h1>A laptop</h1></body></html>";
  const APP_URL = "https://loaner-x.onrender.com";
  const SERVICE_ID = "srv-loaner";
  const PRE_SHA = "55ef64af55ef64af55ef64af55ef64af55ef64af";
  const NEW_SHA = "8d5dd0c48d5dd0c48d5dd0c48d5dd0c48d5dd0c4";

  type RenderReply = { status: string; commit: string } | "error" | "empty";

  beforeEach(() => {
    mocks.serviceClientMock.mockReset();
    delete process.env.BUILD_DEPLOY_CONTENT_VERIFY;
    process.env.GITHUB_PROVISION_TOKEN = "ghp_test_token";
    process.env.RENDER_API_KEY = "rnd_test_token";
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    delete process.env.RENDER_API_KEY;
  });

  function hostingRow(external_ref: Record<string, unknown>) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({ data: [{ status: "ready", external_ref }], error: null }),
                }),
              }),
            }),
          }),
        }),
      }),
    };
  }

  function mockReadyHostingWithService(serviceId: string | null = SERVICE_ID) {
    const ref = serviceId ? { url: APP_URL, render_service_id: serviceId } : { url: APP_URL };
    mocks.serviceClientMock.mockReturnValue(hostingRow(ref));
  }

  function stubWorld(head: string, render: RenderReply) {
    const f = vi.fn(async (url: string) => {
      if (url.includes("api.github.com")) {
        return { ok: true, status: 200, json: async () => ({ object: { sha: head } }) };
      }
      if (url.includes("api.render.com")) {
        if (render === "error") return { ok: false, status: 500, json: async () => ({}) };
        if (render === "empty") return { ok: true, status: 200, json: async () => [] };
        return {
          ok: true,
          status: 200,
          json: async () => [{ deploy: { status: render.status, commit: { id: render.commit } }, cursor: "c" }],
        };
      }
      return { ok: true, status: 200, text: async () => REAL_HTML };
    });
    vi.stubGlobal("fetch", f);
    return f;
  }

  function refineNode(enqueuedAt = Date.now()): ConductorNode {
    return {
      id: "deploy",
      status: "pending",
      target_agent_slug: "",
      estimate_usd: 0,
      child_run_id: null,
      payload: {
        stage: "deploy",
        target: { github_full_name: "Praxis-build/loaner-x", default_branch: "main" },
        refine_deploy_enqueued_at: enqueuedAt,
        pre_refine_sha: PRE_SHA,
      },
    };
  }

  it("commit pushed but Render still building it → keeps waiting instead of reporting the change live", async () => {
    mockReadyHostingWithService();
    const f = stubWorld(NEW_SHA, { status: "build_in_progress", commit: NEW_SHA });
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("provisioning");
    const renderCalls = f.mock.calls.filter(([u]) => String(u).includes("api.render.com"));
    expect(renderCalls).toHaveLength(1);
    expect(String(renderCalls[0][0])).toContain(`/v1/services/${SERVICE_ID}/deploys`);
  });

  it("commit pushed but Render has not picked it up and still serves the old commit → keeps waiting", async () => {
    mockReadyHostingWithService();
    stubWorld(NEW_SHA, { status: "live", commit: PRE_SHA });
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("provisioning");
  });

  it("replays the incident: tick while Render builds waits, the next tick after Render goes live reports ready", async () => {
    mockReadyHostingWithService();
    stubWorld(NEW_SHA, { status: "build_in_progress", commit: NEW_SHA });
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("provisioning");
    stubWorld(NEW_SHA, { status: "live", commit: NEW_SHA });
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("ready");
  });

  it("Render live on the landed commit (short sha on Render's side) → ready", async () => {
    mockReadyHostingWithService();
    stubWorld(NEW_SHA, { status: "live", commit: NEW_SHA.slice(0, 7) });
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("ready");
  });

  it("Render build of the landed commit failed → failed, never 'Live on your app'", async () => {
    mockReadyHostingWithService();
    stubWorld(NEW_SHA, { status: "build_failed", commit: NEW_SHA });
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("failed");
  });

  it("an older unrelated deploy failed while the landed commit has no deploy yet → keeps waiting", async () => {
    mockReadyHostingWithService();
    stubWorld(NEW_SHA, { status: "build_failed", commit: PRE_SHA });
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("provisioning");
  });

  it("Render still building past the refine bound → ready (landed commit still wins over the clock)", async () => {
    mockReadyHostingWithService();
    stubWorld(NEW_SHA, { status: "build_in_progress", commit: NEW_SHA });
    const stale = Date.now() - REFINE_DEPLOY_GATE_MAX_WAIT_MS - 60_000;
    await expect(readHostingStatus("t", refineNode(stale))).resolves.toBe("ready");
  });

  it("Render API errors → falls back to the HEAD-only verdict (ready), never a false failure", async () => {
    mockReadyHostingWithService();
    stubWorld(NEW_SHA, "error");
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("ready");
  });

  it("Render has no deploys listed → keeps waiting", async () => {
    mockReadyHostingWithService();
    stubWorld(NEW_SHA, "empty");
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("provisioning");
  });

  it("no RENDER_API_KEY → HEAD-only verdict and Render is never called", async () => {
    delete process.env.RENDER_API_KEY;
    mockReadyHostingWithService();
    const f = stubWorld(NEW_SHA, { status: "build_in_progress", commit: NEW_SHA });
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("ready");
    expect(f.mock.calls.some(([u]) => String(u).includes("api.render.com"))).toBe(false);
  });

  it("hosting row has no render_service_id → HEAD-only verdict and Render is never called", async () => {
    mockReadyHostingWithService(null);
    const f = stubWorld(NEW_SHA, { status: "build_in_progress", commit: NEW_SHA });
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("ready");
    expect(f.mock.calls.some(([u]) => String(u).includes("api.render.com"))).toBe(false);
  });

  it("commit not landed yet → Render is not consulted at all", async () => {
    mockReadyHostingWithService();
    const f = stubWorld(PRE_SHA, { status: "live", commit: PRE_SHA });
    await expect(readHostingStatus("t", refineNode())).resolves.toBe("provisioning");
    expect(f.mock.calls.some(([u]) => String(u).includes("api.render.com"))).toBe(false);
  });
});

describe("refineDeployGateMaxWaitMs (env override + clamp)", () => {
  afterEach(() => {
    delete process.env.REFINE_DEPLOY_GATE_MAX_WAIT_MS;
  });

  it("unset → 25-min default (=== exported const)", () => {
    delete process.env.REFINE_DEPLOY_GATE_MAX_WAIT_MS;
    expect(refineDeployGateMaxWaitMs()).toBe(REFINE_DEPLOY_GATE_MAX_WAIT_MS);
    expect(refineDeployGateMaxWaitMs()).toBe(25 * 60 * 1000);
  });

  it("valid in-range value is honored", () => {
    process.env.REFINE_DEPLOY_GATE_MAX_WAIT_MS = String(18 * 60 * 1000);
    expect(refineDeployGateMaxWaitMs()).toBe(18 * 60 * 1000);
  });

  it("garbage / ≤0 → default", () => {
    process.env.REFINE_DEPLOY_GATE_MAX_WAIT_MS = "not-a-number";
    expect(refineDeployGateMaxWaitMs()).toBe(REFINE_DEPLOY_GATE_MAX_WAIT_MS);
    process.env.REFINE_DEPLOY_GATE_MAX_WAIT_MS = "0";
    expect(refineDeployGateMaxWaitMs()).toBe(REFINE_DEPLOY_GATE_MAX_WAIT_MS);
    process.env.REFINE_DEPLOY_GATE_MAX_WAIT_MS = "-5000";
    expect(refineDeployGateMaxWaitMs()).toBe(REFINE_DEPLOY_GATE_MAX_WAIT_MS);
  });

  it("clamps below 5 min up, above 60 min down", () => {
    process.env.REFINE_DEPLOY_GATE_MAX_WAIT_MS = String(1000);
    expect(refineDeployGateMaxWaitMs()).toBe(5 * 60 * 1000);
    process.env.REFINE_DEPLOY_GATE_MAX_WAIT_MS = String(99 * 60 * 1000);
    expect(refineDeployGateMaxWaitMs()).toBe(60 * 60 * 1000);
  });
});

describe("dispatch dep — step claim", () => {
  const input = {
    tenant_id: "t-1",
    conductor_run_id: "cr-1",
    node_id: "n-build",
    target_agent_slug: "engineer",
    payload: { stage: "build" },
  };
  function loserClient(opts: {
    insertError: { code?: string; message: string };
    historyRunId?: string | null;
    orphanRunId?: string | null;
    historyError?: boolean;
    orphanError?: boolean;
  }) {
    const seen = { deletes: 0, orphanFilter: "" };
    const single = (data: unknown) => ({ maybeSingle: async () => ({ data, error: null }) });
    const chain: Record<string, unknown> = {};
    chain.eq = () => chain;
    chain.lt = () => chain;
    chain.then = (res: (v: { error: null }) => unknown) => res({ error: null });
    return {
      seen,
      from: (table: string) => {
        if (table === "conductor_dispatch_claims") {
          return {
            insert: async () => ({ error: opts.insertError }),
            delete: () => {
              seen.deletes += 1;
              return chain;
            },
          };
        }
        if (table === "dispatch_history") {
          const q = {
            eq: () => q,
            order: () => q,
            limit: () =>
              opts.historyError
                ? { maybeSingle: async () => ({ data: null, error: { message: "blip" } }) }
                : single(opts.historyRunId ? { target_run_id: opts.historyRunId } : null),
          };
          return { select: () => q };
        }
        if (table === "agent_runs") {
          const q = {
            eq: (col: string, val: string) => {
              if (col === "payload->>conductor_dispatch_key") seen.orphanFilter = val;
              return q;
            },
            limit: () =>
              opts.orphanError
                ? { maybeSingle: async () => ({ data: null, error: { message: "blip" } }) }
                : single(opts.orphanRunId ? { id: opts.orphanRunId } : null),
          };
          return { select: () => q };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
  }

  beforeEach(() => {
    mocks.a2aDispatch.mockReset();
    mocks.serviceClientMock.mockReset();
  });

  it("stamps the claim key on the child's payload so an orphan can be found", async () => {
    mocks.serviceClientMock.mockReturnValueOnce(claimsClient());
    mocks.a2aDispatch.mockResolvedValueOnce({ ok: true, child_run_id: "run-1" });
    await realConductorTickDeps.dispatch(input);
    expect(mocks.a2aDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ conductor_dispatch_key: "cr-1:conductor:cr-1:n-build" }),
      }),
    );
  });

  it("a lost claim returns the winner's run from dispatch_history and never dispatches", async () => {
    mocks.serviceClientMock.mockReturnValueOnce(
      loserClient({ insertError: { code: "23505", message: "dup" }, historyRunId: "winner-run" }),
    );
    expect(await realConductorTickDeps.dispatch(input)).toEqual({ ok: true, child_run_id: "winner-run", adopted: true });
    expect(mocks.a2aDispatch).not.toHaveBeenCalled();
  });

  it("a lost claim finds a winner that died before writing history, by its payload key", async () => {
    const c = loserClient({ insertError: { code: "23505", message: "dup" }, orphanRunId: "orphan-run" });
    mocks.serviceClientMock.mockReturnValueOnce(c);
    expect(await realConductorTickDeps.dispatch(input)).toEqual({ ok: true, child_run_id: "orphan-run", adopted: true });
    expect(c.seen.orphanFilter).toBe("cr-1:conductor:cr-1:n-build");
    expect(c.seen.deletes).toBe(0);
  });

  it("a lost claim with no run anywhere waits, and releases the claim only if it is stale", async () => {
    const c = loserClient({ insertError: { code: "23505", message: "dup" } });
    mocks.serviceClientMock.mockReturnValueOnce(c);
    expect(await realConductorTickDeps.dispatch(input)).toEqual({ ok: false, reason: "dispatch_in_flight" });
    expect(c.seen.deletes).toBe(1);
    expect(mocks.a2aDispatch).not.toHaveBeenCalled();
  });

  it.each([
    [{ historyError: true }],
    [{ orphanError: true }],
  ])("a recovery read error (%o) waits and never releases the claim", async (err) => {
    const c = loserClient({ insertError: { code: "23505", message: "dup" }, ...err });
    mocks.serviceClientMock.mockReturnValueOnce(c);
    expect(await realConductorTickDeps.dispatch(input)).toEqual({ ok: false, reason: "dispatch_in_flight" });
    expect(c.seen.deletes).toBe(0);
    expect(mocks.a2aDispatch).not.toHaveBeenCalled();
  });

  it("a claims-table blip waits instead of failing the build", async () => {
    mocks.serviceClientMock.mockReturnValueOnce(claimsClient({ code: "57014", message: "timeout" }));
    expect(await realConductorTickDeps.dispatch(input)).toEqual({ ok: false, reason: "dispatch_in_flight" });
    expect(mocks.a2aDispatch).not.toHaveBeenCalled();
  });
});

describe("refundBudget / childDidNoWork deps", () => {
  beforeEach(() => mocks.serviceClientMock.mockReset());

  it("refundBudget calls the keyed refund RPC", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    mocks.serviceClientMock.mockReturnValueOnce({ rpc });
    await realConductorTickDeps.refundBudget!("cr-1", 1, "child:run-1");
    expect(rpc).toHaveBeenCalledWith("refund_conductor_budget", {
      p_conductor_run_id: "cr-1",
      p_amount_usd: 1,
      p_refund_key: "child:run-1",
    });
  });

  it.each([
    [{ status: "failed", cost_usd: 0 }, true],
    [{ status: "failed", cost_usd: "0" }, true],
    [{ status: "dispatch_error", cost_usd: null }, true],
    [{ status: "failed", cost_usd: 1.2 }, false],
    [{ status: "parse_failed", cost_usd: 0 }, false],
    [{ status: "success", cost_usd: 0 }, false],
    [{ status: "dispatch_error", cost_usd: 0, input_tokens: 1200 }, false],
    [{ status: "dispatch_error", cost_usd: 0, output_text: "I changed the hero." }, false],
    [{ status: "dispatch_error", cost_usd: 0, output_tokens: 300 }, false],
    [{ status: "dispatch_error", cost_usd: 0, cache_read_tokens: 90000 }, false],
    [{ status: "dispatch_error", cost_usd: 0, tool_calls: [{ name: "read_file" }] }, false],
    [{ status: "dispatch_error", cost_usd: 0, tool_calls: [] }, true],
    [{ status: "dispatch_error", cost_usd: 0, input_tokens: null, output_text: "  " }, true],
    [null, false],
  ])("childDidNoWork(%o) = %s", async (row, expected) => {
    const q = { eq: () => q, maybeSingle: async () => ({ data: row, error: null }) };
    mocks.serviceClientMock.mockReturnValueOnce({ from: () => ({ select: () => q }) });
    expect(await realConductorTickDeps.childDidNoWork!("run-1")).toBe(expected);
  });
});

describe("noChangeCheckpoint / stageCommitSha deps", () => {
  beforeEach(() => mocks.serviceClientMock.mockReset());

  function client(child: unknown, landed: unknown, errs: { child?: boolean; landed?: boolean } = {}) {
    const calls: string[] = [];
    let n = 0;
    return {
      calls,
      from: (table: string) => {
        expect(table).toBe("agent_runs");
        const which = n++;
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "not", "order", "limit"]) {
          q[m] = (...a: unknown[]) => {
            if (m === "eq" || m === "not") calls.push(`${m}:${String(a[0])}`);
            return q;
          };
        }
        q.maybeSingle = async () =>
          which === 0
            ? { data: errs.child ? null : child, error: errs.child ? { message: "x" } : null }
            : { data: errs.landed ? null : landed, error: errs.landed ? { message: "x" } : null };
        return q;
      },
    };
  }
  const args = { tenant_id: "t1", conductor_run_id: "cond-1", child_run_id: "c1", earlier_stage_landed: false };
  const verified = { outcome: { side_effect: { kind: "refused", reason: "empty_diff", detail: "typecheck:passed" } } };

  it("verified: empty_diff + typecheck passed + a landed commit in this build", async () => {
    const c = client(verified, { parsed: { commit_sha: "30bd5f3" } });
    mocks.serviceClientMock.mockReturnValueOnce(c);
    expect(await realConductorTickDeps.noChangeCheckpoint!(args)).toEqual({ commit_sha: "30bd5f3" });
    expect(c.calls).toEqual(
      expect.arrayContaining(["eq:tenant_id", "eq:agent_slug", "eq:payload->>build_conductor_run_id", "not:parsed->>commit_sha"]),
    );
  });

  it.each([
    ["typecheck not run", { outcome: { side_effect: { reason: "empty_diff", detail: "typecheck:not_run" } } }, { parsed: { commit_sha: "a" } }],
    ["typecheck failed", { outcome: { side_effect: { reason: "empty_diff", detail: "typecheck:failed" } } }, { parsed: { commit_sha: "a" } }],
    ["git error, not empty diff", { outcome: { side_effect: { reason: "builder_rejected:git_numstat_failed" } } }, { parsed: { commit_sha: "a" } }],
    ["no code landed in this build yet", verified, null],
    ["child missing", null, { parsed: { commit_sha: "a" } }],
  ])("not verified: %s", async (_n, child, landed) => {
    mocks.serviceClientMock.mockReturnValueOnce(client(child, landed));
    expect(await realConductorTickDeps.noChangeCheckpoint!(args)).toBeNull();
  });

  it("a read error is never a pass", async () => {
    mocks.serviceClientMock.mockReturnValueOnce(client(verified, { parsed: { commit_sha: "a" } }, { landed: true }));
    expect(await realConductorTickDeps.noChangeCheckpoint!(args)).toBeNull();
    mocks.serviceClientMock.mockReturnValueOnce(client(verified, null, { child: true }));
    expect(await realConductorTickDeps.noChangeCheckpoint!(args)).toBeNull();
  });

  it("stageCommitSha reads the push receipt, or null", async () => {
    const one = (data: unknown) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data, error: null });
      return { from: () => q };
    };
    mocks.serviceClientMock.mockReturnValueOnce(one({ parsed: { commit_sha: "deadbeef" } }));
    expect(await realConductorTickDeps.stageCommitSha!({ tenant_id: "t1", child_run_id: "c1" })).toBe("deadbeef");
    mocks.serviceClientMock.mockReturnValueOnce(one({ parsed: {} }));
    expect(await realConductorTickDeps.stageCommitSha!({ tenant_id: "t1", child_run_id: "c1" })).toBeNull();
  });
});

describe("noChange evidence + landed fallback (review fixes)", () => {
  beforeEach(() => mocks.serviceClientMock.mockReset());
  it.each([
    ["typecheck:passed;tests:not_run", true],
    ["typecheck:passed;tests:passed", true],
    ["typecheck:passed", true],
    ["typecheck:passed;tests:failed", false],
    ["typecheck:failed;tests:passed", false],
    ["typecheck:couldnt_run;tests:passed", false],
    [undefined, false],
  ])("noChangeEvidencePasses(%s) = %s", (detail, expected) => {
    expect(noChangeEvidencePasses(detail)).toBe(expected);
  });

  function twoQueries(child: unknown, landed: unknown) {
    let n = 0;
    return {
      from: () => {
        const which = n++;
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "not", "order", "limit"]) q[m] = () => q;
        q.maybeSingle = async () => ({ data: which === 0 ? child : landed, error: null });
        return q;
      },
    };
  }
  const ok = { outcome: { side_effect: { reason: "empty_diff", detail: "typecheck:passed;tests:not_run" } } };
  const base = { tenant_id: "t1", conductor_run_id: "cond-1", child_run_id: "c1" };

  it("a landed push whose sha stamp failed still counts when an earlier stage of this build passed", async () => {
    mocks.serviceClientMock.mockReturnValueOnce(twoQueries(ok, null));
    expect(await realConductorTickDeps.noChangeCheckpoint!({ ...base, earlier_stage_landed: true })).toEqual({ commit_sha: null });
    mocks.serviceClientMock.mockReturnValueOnce(twoQueries(ok, null));
    expect(await realConductorTickDeps.noChangeCheckpoint!({ ...base, earlier_stage_landed: false })).toBeNull();
  });

  it("failed tests are never a no-change pass", async () => {
    mocks.serviceClientMock.mockReturnValueOnce(
      twoQueries({ outcome: { side_effect: { reason: "empty_diff", detail: "typecheck:passed;tests:failed" } } }, { parsed: { commit_sha: "a" } }),
    );
    expect(await realConductorTickDeps.noChangeCheckpoint!({ ...base, earlier_stage_landed: true })).toBeNull();
  });
});

describe("resume epoch keys a continued stage's dispatch fresh", () => {
  beforeEach(() => {
    mocks.a2aDispatch.mockReset();
    mocks.serviceClientMock.mockReset();
  });
  it("suffix only for a positive integer epoch", () => {
    expect(resumeEpochSuffix({})).toBe("");
    expect(resumeEpochSuffix({ resume_epoch: 0 })).toBe("");
    expect(resumeEpochSuffix({ resume_epoch: 2 })).toBe(":e2");
    expect(resumeEpochSuffix({ resume_epoch: "2" })).toBe("");
  });
  it("normal and repair dispatch keys carry the epoch", async () => {
    mocks.serviceClientMock.mockReturnValue(claimsClient());
    mocks.a2aDispatch.mockResolvedValue({ ok: true, child_run_id: "x" });
    await realConductorTickDeps.dispatch({
      tenant_id: "t", conductor_run_id: "c", node_id: "qa", target_agent_slug: "qa", payload: { stage: "qa", resume_epoch: 1 },
    });
    await realConductorTickDeps.dispatchRepair!({
      tenant_id: "t", conductor_run_id: "c", node_id: "qa", attempt: 1, target_agent_slug: "qa",
      payload: { stage: "qa", resume_epoch: 1 }, failure_signal: "x",
    });
    expect(mocks.a2aDispatch.mock.calls.map((c) => (c[0] as { dedup_key: string }).dedup_key)).toEqual([
      "conductor:c:qa:e1",
      "conductor:c:qa:repair:1:e1",
    ]);
  });
});

describe("noChangeCheckpoint — a child that answered without a decision", () => {
  beforeEach(() => mocks.serviceClientMock.mockReset());

  function twoQueries(child: unknown, landed: unknown) {
    let n = 0;
    return {
      from: () => {
        const which = n++;
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "not", "order", "limit"]) q[m] = () => q;
        q.maybeSingle = async () => ({ data: which === 0 ? child : landed, error: null });
        return q;
      },
    };
  }
  const base = { tenant_id: "t1", conductor_run_id: "cond-1", child_run_id: "c1", earlier_stage_landed: true };
  const platformTypecheckPassed = {
    name: "mcp__sandbox__run_typecheck",
    typecheck_receipt: { tool: "mcp__sandbox__run_typecheck", status: "passed", command: "npm run typecheck", platform: true, attempted: true, exit_code: 0 },
  };

  it("only an explicit empty_diff is evidence; a reply with no decision is not", () => {
    expect(
      noChangeEvidenceDetail({ outcome: { side_effect: { reason: "empty_diff", detail: "typecheck:passed;tests:passed" } } }),
    ).toBe("typecheck:passed;tests:passed");
    expect(noChangeEvidenceDetail({ outcome: { side_effect: { kind: "unknown" } } })).toBeNull();
    expect(noChangeEvidenceDetail({ outcome: { side_effect: { kind: "shipped" } } })).toBeNull();
  });

  it("not verified: no decision and a passing typecheck, even though this build already landed code", async () => {
    mocks.serviceClientMock.mockReturnValueOnce(
      twoQueries(
        { parse_error: "action_missing:no_decision_emitted", outcome: { side_effect: { kind: "unknown" } }, tool_calls: [platformTypecheckPassed] },
        { parsed: { commit_sha: "b3911a3" } },
      ),
    );
    expect(await realConductorTickDeps.noChangeCheckpoint!(base)).toBeNull();
  });

  it("not verified: a shipped child is never judged on traces", async () => {
    mocks.serviceClientMock.mockReturnValueOnce(
      twoQueries({ parse_error: null, outcome: { side_effect: { kind: "shipped" } }, tool_calls: [platformTypecheckPassed] }, { parsed: { commit_sha: "a" } }),
    );
    expect(await realConductorTickDeps.noChangeCheckpoint!(base)).toBeNull();
  });
});
