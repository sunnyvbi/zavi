import { describe, it, expect, beforeEach, vi } from "vitest";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER_TENANT = "e0fe9ea8-0000-0000-0000-000000000000";
const OWNER = "mac:tok-1";
const TOKEN = "tok-1";
const RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ITEM_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

type RpcCall = { name: string; args: Record<string, unknown> };

const state = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: unknown }>,
  rpcResults: {} as Record<string, { data: unknown; error: unknown }>,
  rpcCalls: [] as RpcCall[],
  writes: [] as { table: string; op: string; patch: unknown }[],
  tenantEnabled: true,
  ghToken: null as string | null,
  ghArgs: null as unknown,
  resolvedRepo: null as string | null,
  resolveArgs: null as unknown,
  requiresSandbox: true,
  secrets: {} as Record<string, string | null>,
}));

function tableChain(table: string) {
  const result = () =>
    Promise.resolve(state.tables[table] ?? { data: null, error: null });
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "lte", "in", "order", "limit"]) {
    chain[m] = () => chain;
  }
  chain.update = (patch: unknown) => {
    state.writes.push({ table, op: "update", patch });
    return chain;
  };
  chain.insert = (row: unknown) => {
    state.writes.push({ table, op: "insert", patch: row });
    return chain;
  };
  chain.maybeSingle = result;
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => result().then(resolve, reject);
  return chain;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (t: string) => tableChain(t),
    rpc: (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      return Promise.resolve(
        state.rpcResults[name] ?? { data: null, error: null },
      );
    },
  }),
}));

const mocks = vi.hoisted(() => {
  class RepoResolutionError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "RepoResolutionError";
    }
  }
  return {
    assertTokenTenantEnabled: vi.fn(),
    getRepoInstallationToken: vi.fn(),
    resolveRepoFullName: vi.fn(),
    loadAgentDefinition: vi.fn(),
    RepoResolutionError,
    getSecret: vi.fn(),
    makeEmitProgress: vi.fn(() => async () => {}),
    buildContext: vi.fn(async () => ({}) as never),
    finalizeRun: vi.fn(async () => ({ run_id: RUN_ID, status: "success" as const })),
    logEvent: vi.fn(async () => {}),
  };
});

vi.mock("@/services/auth/mac-worker-token", () => ({
  assertTokenTenantEnabled: mocks.assertTokenTenantEnabled,
}));
vi.mock("@/services/connectors/github/oauth", () => ({
  getRepoInstallationToken: mocks.getRepoInstallationToken,
}));
vi.mock("@/services/agents/repo-resolver", () => ({
  resolveRepoFullName: mocks.resolveRepoFullName,
  RepoResolutionError: mocks.RepoResolutionError,
}));
vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: mocks.loadAgentDefinition,
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: mocks.getSecret }));
vi.mock("@/services/agents/progress", () => ({
  makeEmitProgress: mocks.makeEmitProgress,
}));
vi.mock("@/services/agents/runner", () => ({ buildContext: mocks.buildContext }));
vi.mock("../../../../../workers/functions/finalize-run", () => ({
  finalizeRun: mocks.finalizeRun,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.logEvent }));

import {
  localRunsList,
  localRunsClaim,
  localRunsStart,
  localRunsRenew,
  localRunsSecrets,
  localRunsTerminal,
} from "../handlers";

function mockReq(opts: {
  params?: Record<string, string>;
  body?: unknown;
  caller?: { token_id: string; owner: string };
}) {
  return {
    params: opts.params ?? {},
    body: opts.body ?? {},
    macWorker: opts.caller ?? { token_id: TOKEN, owner: OWNER },
  } as unknown as Parameters<typeof localRunsStart>[0];
}

function mockRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

function validEnvelope(parse_ok = true) {
  return {
    output_text: "done",
    parsed: { x: 1 },
    parse_ok,
    raw_response_text: "raw",
    prompt_snapshot: "snap",
    usage: { input_tokens: 10, output_tokens: 5 },
    routing: { model: "claude-opus-4-8" },
  };
}

beforeEach(() => {
  state.tables = {};
  state.rpcResults = {};
  state.rpcCalls = [];
  state.writes = [];
  state.tenantEnabled = true;
  state.ghToken = null;
  state.resolvedRepo = null;
  state.requiresSandbox = true;
  state.secrets = {};
  for (const m of Object.values(mocks)) {
    (m as { mockReset?: () => void }).mockReset?.();
  }
  mocks.assertTokenTenantEnabled.mockImplementation(async () => state.tenantEnabled);
  mocks.getRepoInstallationToken.mockImplementation(async (a: unknown) => {
    state.ghArgs = a;
    return state.ghToken;
  });
  mocks.resolveRepoFullName.mockImplementation(async (a: { repo_hint?: string | null }) => {
    state.resolveArgs = a;
    if (state.resolvedRepo === null) {
      throw new mocks.RepoResolutionError("no_github_connection", "no connection");
    }
    return state.resolvedRepo;
  });
  mocks.loadAgentDefinition.mockImplementation(async () => ({
    metadata_praxis: { requires_sandbox: state.requiresSandbox },
  }));
  mocks.getSecret.mockImplementation(async (_t: string, k: string) =>
    state.secrets[k] ?? null,
  );
  mocks.makeEmitProgress.mockReturnValue(async () => {});
  mocks.buildContext.mockResolvedValue({} as never);
  mocks.finalizeRun.mockResolvedValue({ run_id: RUN_ID, status: "success" });
  mocks.logEvent.mockResolvedValue(undefined);
});

function sideEffectRpcs() {
  return state.rpcCalls.filter((c) =>
    [
      "claim_agent_work_items",
      "start_local_agent_run",
      "renew_local_lease",
      "complete_local_work_item",
      "claim_local_run_terminal",
    ].includes(c.name),
  );
}

describe("POST /claim", () => {
  it("F6/F7: 403 tenant_not_authorized with ZERO writes when gate denies", async () => {
    state.tenantEnabled = false;
    const res = mockRes();
    await localRunsClaim(mockReq({ body: { tenant_id: TENANT } }), res as never);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: { code: "tenant_not_authorized" } });
    expect(sideEffectRpcs()).toHaveLength(0);
  });

  it("400 on a non-uuid body tenant_id", async () => {
    const res = mockRes();
    await localRunsClaim(mockReq({ body: { tenant_id: "nope" } }), res as never);
    expect(res.statusCode).toBe(400);
    expect(sideEffectRpcs()).toHaveLength(0);
  });

  it("forces owner + lane=local + pins tenant; clamps limit to 10", async () => {
    state.rpcResults["claim_agent_work_items"] = { data: [{ id: ITEM_ID }], error: null };
    const res = mockRes();
    await localRunsClaim(
      mockReq({ body: { tenant_id: TENANT, limit: 999 } }),
      res as never,
    );
    expect(res.statusCode).toBe(0);
    expect(res.body).toEqual({ claimed: [{ id: ITEM_ID }] });
    const call = state.rpcCalls.find((c) => c.name === "claim_agent_work_items");
    expect(call?.args).toMatchObject({
      p_owner: OWNER,
      p_lane: "local",
      p_tenant_id: TENANT,
      p_limit: 10,
    });
  });
});

describe("POST /:id/start", () => {
  it("404 when the work item is missing", async () => {
    state.tables["agent_work_items"] = { data: null, error: null };
    const res = mockRes();
    await localRunsStart(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.statusCode).toBe(404);
    expect(sideEffectRpcs()).toHaveLength(0);
  });

  it("F6/F7: 403 with ZERO writes when gate denies (tenant re-derived from row)", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: OWNER },
      error: null,
    };
    state.tenantEnabled = false;
    const res = mockRes();
    await localRunsStart(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.statusCode).toBe(403);
    expect(sideEffectRpcs()).toHaveLength(0);
  });

  it("F8: 409 not_lease_holder when owner mismatches (ZERO writes)", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: "mac:someone-else" },
      error: null,
    };
    const res = mockRes();
    await localRunsStart(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: { code: "not_lease_holder" } });
    expect(sideEffectRpcs()).toHaveLength(0);
  });

  it("maps RPC 42501 → 409 not_lease_holder", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: OWNER },
      error: null,
    };
    state.rpcResults["start_local_agent_run"] = { data: null, error: { code: "42501" } };
    const res = mockRes();
    await localRunsStart(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.statusCode).toBe(409);
  });

  it("happy path returns the run_id; falls back to trigger=cron when source absent", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: OWNER },
      error: null,
    };
    state.rpcResults["start_local_agent_run"] = { data: RUN_ID, error: null };
    const res = mockRes();
    await localRunsStart(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.body).toEqual({ run_id: RUN_ID });
    const call = state.rpcCalls.find((c) => c.name === "start_local_agent_run");
    expect(call?.args).toMatchObject({ p_owner: OWNER, p_trigger: "cron", p_tenant_id: TENANT });
  });

  it("derives trigger from source server-side (webhook_github → webhook), no client trigger", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: OWNER, source: "webhook_github" },
      error: null,
    };
    state.rpcResults["start_local_agent_run"] = { data: RUN_ID, error: null };
    const res = mockRes();
    await localRunsStart(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.body).toEqual({ run_id: RUN_ID });
    const call = state.rpcCalls.find((c) => c.name === "start_local_agent_run");
    expect(call?.args).toMatchObject({ p_trigger: "webhook" });
  });

  it("an explicit body.trigger still overrides the source-derived one", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: OWNER, source: "webhook_github" },
      error: null,
    };
    state.rpcResults["start_local_agent_run"] = { data: RUN_ID, error: null };
    const res = mockRes();
    await localRunsStart(mockReq({ params: { id: ITEM_ID }, body: { trigger: "manual" } }), res as never);
    const call = state.rpcCalls.find((c) => c.name === "start_local_agent_run");
    expect(call?.args).toMatchObject({ p_trigger: "manual" });
  });
});

describe("POST /:id/renew", () => {
  it("F7: 403 with ZERO writes when gate denies", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: OWNER },
      error: null,
    };
    state.tenantEnabled = false;
    const res = mockRes();
    await localRunsRenew(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.statusCode).toBe(403);
    expect(sideEffectRpcs()).toHaveLength(0);
  });

  it("returns renewed:true on RPC true; clamps lease to 3600", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: OWNER },
      error: null,
    };
    state.rpcResults["renew_local_lease"] = { data: true, error: null };
    const res = mockRes();
    await localRunsRenew(
      mockReq({ params: { id: ITEM_ID }, body: { lease_seconds: 999999 } }),
      res as never,
    );
    expect(res.body).toEqual({ renewed: true });
    const call = state.rpcCalls.find((c) => c.name === "renew_local_lease");
    expect(call?.args.p_lease_seconds).toBe(3600);
  });

  it("409 lease_lost when RPC returns false", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: OWNER },
      error: null,
    };
    state.rpcResults["renew_local_lease"] = { data: false, error: null };
    const res = mockRes();
    await localRunsRenew(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: { code: "lease_lost" } });
  });
});

describe("POST /:id/secrets", () => {
  const leasedItem = (payload: unknown = null) => ({
    data: {
      id: ITEM_ID,
      tenant_id: TENANT,
      lane: "local",
      status: "leased",
      lease_owner: OWNER,
      payload,
      agent_slug: "engineer",
    },
    error: null,
  });

  it("F8: 403 not_lease_holder without the lease (no creds derived)", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: "mac:other", payload: null, agent_slug: "engineer" },
      error: null,
    };
    const res = mockRes();
    await localRunsSecrets(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: { code: "not_lease_holder" } });
    expect(mocks.getRepoInstallationToken).not.toHaveBeenCalled();
    expect(mocks.getSecret).not.toHaveBeenCalled();
  });

  it("F12: ignores any extra body key; returns ONLY the derived bundle", async () => {
    state.tables["agent_work_items"] = leasedItem(null);
    state.tables["slack_workspaces"] = { data: null, error: null };
    const res = mockRes();
    await localRunsSecrets(
      mockReq({ params: { id: ITEM_ID }, body: { vault_key: "stripe.secret", any: "thing" } }),
      res as never,
    );
    expect(res.body).toEqual({ tenant_id: TENANT, agent_slug: "engineer" });
  });

  it("F13: includes github_token when repo resolves + mint non-null", async () => {
    state.tables["agent_work_items"] = leasedItem({ repo_hint: "rravi149/upcar" });
    state.tables["slack_workspaces"] = { data: null, error: null };
    state.resolvedRepo = "rravi149/upcar";
    state.ghToken = "ghs_scoped";
    const res = mockRes();
    await localRunsSecrets(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.body).toMatchObject({
      github_token: "ghs_scoped",
      github_repo: "rravi149/upcar",
    });
    expect(state.ghArgs).toMatchObject({ tenant_id: TENANT, repo_full_name: "rravi149/upcar" });
    expect(state.resolveArgs).toMatchObject({ tenant_id: TENANT, repo_hint: "rravi149/upcar" });
  });

  it("resolves an EMPTY repo_hint to the tenant default → token minted (the local-lane gap fix)", async () => {
    state.tables["agent_work_items"] = leasedItem(null);
    state.tables["slack_workspaces"] = { data: null, error: null };
    state.resolvedRepo = "rravi149/upcar";
    state.ghToken = "ghs_scoped";
    const res = mockRes();
    await localRunsSecrets(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.body).toMatchObject({
      github_token: "ghs_scoped",
      github_repo: "rravi149/upcar",
    });
    expect(state.resolveArgs).toMatchObject({ tenant_id: TENANT });
    expect(state.ghArgs).toMatchObject({ repo_full_name: "rravi149/upcar" });
  });

  it("does NOT default-resolve a repo for a non-sandbox agent with no hint (least-privilege, codex P2 r2)", async () => {
    state.tables["agent_work_items"] = leasedItem(null);
    state.tables["slack_workspaces"] = { data: null, error: null };
    state.requiresSandbox = false;
    state.resolvedRepo = "rravi149/upcar";
    state.ghToken = "ghs_scoped";
    const res = mockRes();
    await localRunsSecrets(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.body).not.toHaveProperty("github_token");
    expect(mocks.resolveRepoFullName).not.toHaveBeenCalled();
    expect(mocks.getRepoInstallationToken).not.toHaveBeenCalled();
  });

  it("treats a blank/whitespace repo_hint as no-hint → non-sandbox agent gets no token (codex P2 r3)", async () => {
    state.tables["agent_work_items"] = leasedItem({ repo_hint: "   " });
    state.tables["slack_workspaces"] = { data: null, error: null };
    state.requiresSandbox = false;
    state.resolvedRepo = "rravi149/upcar";
    state.ghToken = "ghs_scoped";
    const res = mockRes();
    await localRunsSecrets(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.body).not.toHaveProperty("github_token");
    expect(mocks.resolveRepoFullName).not.toHaveBeenCalled();
  });

  it("rejects an unconnected/forged repo_hint → no token minted (owner-spoof guard)", async () => {
    state.tables["agent_work_items"] = leasedItem({ repo_hint: "evil/upcar" });
    state.tables["slack_workspaces"] = { data: null, error: null };
    state.resolvedRepo = null;
    state.ghToken = "ghs_scoped";
    const res = mockRes();
    await localRunsSecrets(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.body).not.toHaveProperty("github_token");
    expect(mocks.getRepoInstallationToken).not.toHaveBeenCalled();
    expect(res.statusCode).not.toBe(500);
    expect(res.body).toMatchObject({ tenant_id: TENANT, agent_slug: "engineer" });
  });

  it("soft-fails a malformed (non-string) repo_hint without 500ing or dropping other creds (codex P2)", async () => {
    state.tables["agent_work_items"] = leasedItem({ repo_hint: 123 as unknown as string });
    state.tables["slack_workspaces"] = { data: { team_id: "T123" }, error: null };
    state.secrets["slack.bot_token:T123"] = "xoxb-primary";
    state.ghToken = "ghs_scoped";
    const res = mockRes();
    await localRunsSecrets(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.statusCode).not.toBe(500);
    expect(res.body).not.toHaveProperty("github_token");
    expect(state.resolveArgs).toMatchObject({ tenant_id: TENANT, repo_hint: null });
    expect(res.body).toMatchObject({ slack_bot_token: "xoxb-primary" });
  });

  it("omits github_token when mint returns null (soft-fail)", async () => {
    state.tables["agent_work_items"] = leasedItem({ repo_hint: "rravi149/upcar" });
    state.tables["slack_workspaces"] = { data: null, error: null };
    state.resolvedRepo = "rravi149/upcar";
    state.ghToken = null;
    const res = mockRes();
    await localRunsSecrets(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.body).not.toHaveProperty("github_token");
  });

  it("includes slack_bot_token (primary-team key) when found", async () => {
    state.tables["agent_work_items"] = leasedItem(null);
    state.tables["slack_workspaces"] = { data: { team_id: "T123" }, error: null };
    state.secrets["slack.bot_token:T123"] = "xoxb-primary";
    const res = mockRes();
    await localRunsSecrets(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(res.body).toMatchObject({ slack_bot_token: "xoxb-primary" });
  });

  it("never includes a service-role key or raw vault keys in the bundle", async () => {
    state.tables["agent_work_items"] = leasedItem(null);
    state.tables["slack_workspaces"] = { data: null, error: null };
    const res = mockRes();
    await localRunsSecrets(mockReq({ params: { id: ITEM_ID } }), res as never);
    const keys = Object.keys(res.body as object);
    expect(keys).not.toContain("service_role_key");
    expect(keys).not.toContain("supabase_service_role_key");
    expect(keys.every((k) =>
      ["tenant_id", "agent_slug", "github_token", "github_repo", "slack_bot_token"].includes(k),
    )).toBe(true);
  });
});

describe("POST /:run_id/terminal — load-bearing order", () => {
  const runningRun = {
    data: { id: RUN_ID, tenant_id: TENANT, agent_slug: "engineer", trigger: "cron", status: "running", payload: { x: 1 } },
    error: null,
  };
  const leasedLink = {
    data: { id: ITEM_ID, lane: "local", status: "leased", lease_owner: OWNER },
    error: null,
  };

  it("404 when the run is missing", async () => {
    state.tables["agent_runs"] = { data: null, error: null };
    const res = mockRes();
    await localRunsTerminal(mockReq({ params: { run_id: RUN_ID }, body: { result: validEnvelope() } }), res as never);
    expect(res.statusCode).toBe(404);
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
  });

  it("F6/F7: 403 with ZERO writes when gate denies (tenant from RUN row)", async () => {
    state.tables["agent_runs"] = runningRun;
    state.tenantEnabled = false;
    const res = mockRes();
    await localRunsTerminal(mockReq({ params: { run_id: RUN_ID }, body: { result: validEnvelope() } }), res as never);
    expect(res.statusCode).toBe(403);
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
    expect(sideEffectRpcs()).toHaveLength(0);
  });

  it("F9: 400 invalid_envelope on a malformed body — BEFORE loading the work item, ZERO writes", async () => {
    state.tables["agent_runs"] = runningRun;
    const res = mockRes();
    await localRunsTerminal(
      mockReq({ params: { run_id: RUN_ID }, body: { result: { output_text: 123 } } }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { code: "invalid_envelope" } });
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
    expect(sideEffectRpcs()).toHaveLength(0);
  });

  it("F10: 410 run_not_running when the run is already terminal", async () => {
    state.tables["agent_runs"] = {
      data: { ...runningRun.data, status: "success" },
      error: null,
    };
    const res = mockRes();
    await localRunsTerminal(mockReq({ params: { run_id: RUN_ID }, body: { result: validEnvelope() } }), res as never);
    expect(res.statusCode).toBe(410);
    expect(res.body).toEqual({ error: { code: "run_not_running" } });
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
  });

  it("F8: 409 not_lease_holder when the linked item isn't leased to this owner", async () => {
    state.tables["agent_runs"] = runningRun;
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, lane: "local", status: "leased", lease_owner: "mac:other" },
      error: null,
    };
    const res = mockRes();
    await localRunsTerminal(mockReq({ params: { run_id: RUN_ID }, body: { result: validEnvelope() } }), res as never);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: { code: "not_lease_holder" } });
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
  });

  it("reclaims a spuriously-stamped local_delegated run BEFORE finalizing (owner-gated)", async () => {
    state.tables["agent_runs"] = runningRun;
    state.tables["agent_work_items"] = leasedLink;
    state.rpcResults["claim_local_run_terminal"] = { data: ITEM_ID, error: null };
    state.rpcResults["complete_local_work_item"] = { data: true, error: null };
    const res = mockRes();
    await localRunsTerminal(mockReq({ params: { run_id: RUN_ID }, body: { result: validEnvelope() } }), res as never);
    const reclaim = state.rpcCalls.find((c) => c.name === "reclaim_local_delegated_run");
    expect(reclaim?.args).toMatchObject({ p_run_id: RUN_ID, p_owner: OWNER });
    expect(res.body).toEqual({ run_id: RUN_ID, status: "success" });
    expect(mocks.finalizeRun).toHaveBeenCalledTimes(1);
  });

  it("F11 + happy: CAS win → finalizeRun ONCE → complete_local_work_item, returns success", async () => {
    state.tables["agent_runs"] = runningRun;
    state.tables["agent_work_items"] = leasedLink;
    state.rpcResults["claim_local_run_terminal"] = { data: ITEM_ID, error: null };
    state.rpcResults["complete_local_work_item"] = { data: true, error: null };
    const res = mockRes();
    await localRunsTerminal(mockReq({ params: { run_id: RUN_ID }, body: { result: validEnvelope() } }), res as never);
    expect(res.body).toEqual({ run_id: RUN_ID, status: "success" });
    expect(mocks.finalizeRun).toHaveBeenCalledTimes(1);
    const finalizeCall = (mocks.finalizeRun.mock.calls as unknown[][])[0];
    expect(finalizeCall[0]).toMatchObject({
      tenant_id: TENANT,
      model: "claude-opus-4-8",
    });
    expect(finalizeCall[1]).toMatchObject({ step: undefined });
    const complete = state.rpcCalls.find((c) => c.name === "complete_local_work_item");
    expect(complete?.args).toMatchObject({ p_id: ITEM_ID, p_status: "done", p_owner: OWNER });
  });

  it("F11: double-POST — second loses the CAS → 409 finalize_in_progress, finalizeRun NOT called again", async () => {
    state.tables["agent_runs"] = runningRun;
    state.tables["agent_work_items"] = leasedLink;
    state.rpcResults["claim_local_run_terminal"] = { data: ITEM_ID, error: null };
    state.rpcResults["complete_local_work_item"] = { data: true, error: null };
    const res1 = mockRes();
    await localRunsTerminal(mockReq({ params: { run_id: RUN_ID }, body: { result: validEnvelope() } }), res1 as never);
    expect(res1.body).toMatchObject({ status: "success" });
    expect(mocks.finalizeRun).toHaveBeenCalledTimes(1);

    state.rpcResults["claim_local_run_terminal"] = { data: null, error: null };
    const res2 = mockRes();
    await localRunsTerminal(mockReq({ params: { run_id: RUN_ID }, body: { result: validEnvelope() } }), res2 as never);
    expect(res2.statusCode).toBe(409);
    expect(res2.body).toEqual({ error: { code: "finalize_in_progress" } });
    expect(mocks.finalizeRun).toHaveBeenCalledTimes(1);
  });

  it("complete_local_work_item false-return does NOT fail the 200 (run already finalized)", async () => {
    state.tables["agent_runs"] = runningRun;
    state.tables["agent_work_items"] = leasedLink;
    state.rpcResults["claim_local_run_terminal"] = { data: ITEM_ID, error: null };
    state.rpcResults["complete_local_work_item"] = { data: false, error: null };
    const res = mockRes();
    await localRunsTerminal(mockReq({ params: { run_id: RUN_ID }, body: { result: validEnvelope() } }), res as never);
    expect(res.body).toEqual({ run_id: RUN_ID, status: "success" });
    expect(mocks.logEvent).toHaveBeenCalled();
  });

  it("parse_ok=false → status parse_failed + complete with p_status=failed", async () => {
    state.tables["agent_runs"] = runningRun;
    state.tables["agent_work_items"] = leasedLink;
    state.rpcResults["claim_local_run_terminal"] = { data: ITEM_ID, error: null };
    state.rpcResults["complete_local_work_item"] = { data: true, error: null };
    const res = mockRes();
    await localRunsTerminal(
      mockReq({ params: { run_id: RUN_ID }, body: { result: validEnvelope(false) } }),
      res as never,
    );
    expect(res.body).toMatchObject({ status: "parse_failed" });
    const complete = state.rpcCalls.find((c) => c.name === "complete_local_work_item");
    expect(complete?.args.p_status).toBe("failed");
  });

  it("C8: a body-supplied tenant_id is IGNORED — tenant comes from the run row", async () => {
    state.tables["agent_runs"] = runningRun;
    state.tables["agent_work_items"] = leasedLink;
    state.rpcResults["claim_local_run_terminal"] = { data: ITEM_ID, error: null };
    state.rpcResults["complete_local_work_item"] = { data: true, error: null };
    const res = mockRes();
    await localRunsTerminal(
      mockReq({
        params: { run_id: RUN_ID },
        body: { tenant_id: OTHER_TENANT, result: validEnvelope() },
      }),
      res as never,
    );
    expect(mocks.assertTokenTenantEnabled).toHaveBeenCalledWith(TOKEN, TENANT);
    expect(mocks.assertTokenTenantEnabled).not.toHaveBeenCalledWith(TOKEN, OTHER_TENANT);
    expect((mocks.finalizeRun.mock.calls as unknown[][])[0][0]).toMatchObject({ tenant_id: TENANT });
  });
});

describe("POST /:run_id/terminal — local engineer PR (design D)", () => {
  const REPO = "upcar-ai/OraiCar";
  const localEngineerRun = {
    data: {
      id: RUN_ID,
      tenant_id: TENANT,
      agent_slug: "engineer",
      agent_definition_hash: "local",
      trigger: "cron",
      status: "running",
      payload: { repo_hint: REPO },
    },
    error: null,
  };
  const leasedLink = {
    data: { id: ITEM_ID, lane: "local", status: "leased", lease_owner: OWNER },
    error: null,
  };
  function envWithPr(over: Partial<Record<string, unknown>> = {}) {
    return {
      ...validEnvelope(),
      local_pr: {
        pr_number: 5,
        pr_url: `https://github.com/${REPO}/pull/5`,
        pr_repo: REPO,
        head_branch: `engineer/${ITEM_ID}`,
        ...over,
      },
    };
  }
  function armCas() {
    state.tables["agent_runs"] = localEngineerRun;
    state.tables["agent_work_items"] = leasedLink;
    state.resolvedRepo = REPO;
    state.rpcResults["claim_local_run_terminal"] = { data: ITEM_ID, error: null };
    state.rpcResults["complete_local_work_item"] = { data: true, error: null };
    state.rpcResults["agent_run_set_pr_meta"] = { data: null, error: null };
  }

  it("valid local_pr → records pr meta AFTER finalizeRun + surfaces the link", async () => {
    armCas();
    let prMetaCallsAtFinalize = -1;
    mocks.finalizeRun.mockImplementation(async () => {
      prMetaCallsAtFinalize = state.rpcCalls.filter(
        (c) => c.name === "agent_run_set_pr_meta",
      ).length;
      return { run_id: RUN_ID, status: "success" as const };
    });
    const res = mockRes();
    await localRunsTerminal(mockReq({ params: { run_id: RUN_ID }, body: { result: envWithPr() } }), res as never);
    expect(res.body).toMatchObject({ status: "success" });
    expect(prMetaCallsAtFinalize).toBe(0);
    const meta = state.rpcCalls.find((c) => c.name === "agent_run_set_pr_meta");
    expect(meta?.args).toMatchObject({
      p_run_id: RUN_ID,
      p_pr_repo: REPO,
      p_pr_number: 5,
      p_pr_url: `https://github.com/${REPO}/pull/5`,
    });
    const finalizeArg = (mocks.finalizeRun.mock.calls as unknown[][])[0][0] as {
      result: { output_text: string };
    };
    expect(finalizeArg.result.output_text).toContain(`https://github.com/${REPO}/pull/5`);
    expect(mocks.finalizeRun).toHaveBeenCalledTimes(1);
  });

  it("rejects local_pr on a NON-local run (agent_definition_hash!=local) — 400, ZERO writes", async () => {
    armCas();
    state.tables["agent_runs"] = {
      data: { ...localEngineerRun.data, agent_definition_hash: "abc123" },
      error: null,
    };
    const res = mockRes();
    await localRunsTerminal(mockReq({ params: { run_id: RUN_ID }, body: { result: envWithPr() } }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { code: "local_pr_not_allowed" } });
    expect(sideEffectRpcs()).toHaveLength(0);
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
  });

  it("rejects a pr_repo that isn't the server-resolved connected repo — 400, ZERO writes", async () => {
    armCas();
    const res = mockRes();
    await localRunsTerminal(
      mockReq({ params: { run_id: RUN_ID }, body: { result: envWithPr({ pr_repo: "attacker/evil", pr_url: "https://github.com/attacker/evil/pull/5" }) } }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { code: "local_pr_validation_failed" } });
    expect(sideEffectRpcs()).toHaveLength(0);
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
  });

  it("rejects a head_branch not keyed on the work item — 400 (anti-branch-hijack)", async () => {
    armCas();
    const res = mockRes();
    await localRunsTerminal(
      mockReq({ params: { run_id: RUN_ID }, body: { result: envWithPr({ head_branch: "engineer/someone-else" }) } }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { code: "local_pr_validation_failed" } });
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical pr_url (url must match repo/pull/number) — 400", async () => {
    armCas();
    const res = mockRes();
    await localRunsTerminal(
      mockReq({ params: { run_id: RUN_ID }, body: { result: envWithPr({ pr_url: "https://github.com/upcar-ai/OraiCar/pull/999" }) } }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { code: "local_pr_validation_failed" } });
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
  });

  it("no local_pr → unchanged terminal (no pr-meta write)", async () => {
    armCas();
    const res = mockRes();
    await localRunsTerminal(mockReq({ params: { run_id: RUN_ID }, body: { result: validEnvelope() } }), res as never);
    expect(res.body).toMatchObject({ status: "success" });
    expect(state.rpcCalls.find((c) => c.name === "agent_run_set_pr_meta")).toBeUndefined();
  });
});

describe("POST /:id/start — derive trigger from work_item.source", () => {
  it("source=webhook_slack → start_local_agent_run called with p_trigger='slack'", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: OWNER, source: "webhook_slack" },
      error: null,
    };
    state.rpcResults["start_local_agent_run"] = { data: RUN_ID, error: null };
    const res = mockRes();
    await localRunsStart(mockReq({ params: { id: ITEM_ID }, body: {} }), res as never);
    const call = state.rpcCalls.find((c) => c.name === "start_local_agent_run");
    expect(call?.args.p_trigger).toBe("slack");
  });

  it("source=chat → p_trigger='chat'", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: OWNER, source: "chat" },
      error: null,
    };
    state.rpcResults["start_local_agent_run"] = { data: RUN_ID, error: null };
    const res = mockRes();
    await localRunsStart(mockReq({ params: { id: ITEM_ID } }), res as never);
    expect(state.rpcCalls.find((c) => c.name === "start_local_agent_run")?.args.p_trigger).toBe("chat");
  });
});

describe("POST /:id/renew — heartbeat the linked run's progress clock", () => {
  it("on successful renew, touches agent_runs.last_progress_at for the linked run", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: OWNER, agent_run_id: RUN_ID },
      error: null,
    };
    state.rpcResults["renew_local_lease"] = { data: true, error: null };
    const res = mockRes();
    await localRunsRenew(mockReq({ params: { id: ITEM_ID }, body: {} }), res as never);
    expect(res.body).toEqual({ renewed: true });
    const touch = state.writes.find((w) => w.table === "agent_runs" && w.op === "update");
    expect(touch).toBeTruthy();
    expect(touch?.patch).toMatchObject({ last_progress_at: expect.any(String) });
  });

  it("no agent_run_id linked → no progress touch (background items unaffected)", async () => {
    state.tables["agent_work_items"] = {
      data: { id: ITEM_ID, tenant_id: TENANT, lane: "local", status: "leased", lease_owner: OWNER },
      error: null,
    };
    state.rpcResults["renew_local_lease"] = { data: true, error: null };
    const res = mockRes();
    await localRunsRenew(mockReq({ params: { id: ITEM_ID }, body: {} }), res as never);
    expect(res.body).toEqual({ renewed: true });
    expect(state.writes.find((w) => w.table === "agent_runs")).toBeUndefined();
  });
});
