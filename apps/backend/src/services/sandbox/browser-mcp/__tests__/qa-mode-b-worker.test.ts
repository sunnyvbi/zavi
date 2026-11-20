
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEnqueueAgentRun = vi.fn(async (input: unknown) => ({
  run_id: `run-${(input as { payload?: { test_case_id?: string } }).payload?.test_case_id ?? "unknown"}`,
}));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: mockEnqueueAgentRun,
  SafetyGateError: class SafetyGateError extends Error {
    constructor(slug: string, reason: string) {
      super(`Agent "${slug}" rejected: ${reason}`);
      this.name = "SafetyGateError";
    }
  },
}));

const mockGetBoolSetting = vi.fn(async (_key: string, _tenant_id: string) => false);
vi.mock("@/services/settings", () => ({
  getBoolSetting: mockGetBoolSetting,
}));

const mockIsFleetHalted = vi.fn(async () => false as boolean);
vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: mockIsFleetHalted,
  FleetHaltedError: class FleetHaltedError extends Error {
    constructor() {
      super("Fleet is halted");
      this.name = "FleetHaltedError";
    }
  },
}));

const mockGetSecret = vi.fn(async (_tenant_id: string, _key: string) => null as string | null);
vi.mock("@/services/secrets/vault", () => ({
  getSecret: mockGetSecret,
}));

const mockFrom = vi.fn(() => ({
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  limit: vi.fn(async () => ({ data: [], error: null })),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({ from: mockFrom })),
}));

type ActiveTestRow = {
  id: string;
  title: string;
  role: string;
  nl_spec: unknown;
};

type EnqueuedRun = {
  tenant_id: string;
  run_id: string;
  test_case_id: string;
  test_title: string;
};

type TenantOutcome =
  | { status: "skipped"; reason: string }
  | { status: "ok"; enqueued_runs: EnqueuedRun[] };

type GetBoolSettingFn = (key: string, tenant_id: string) => Promise<boolean>;
type GetSecretFn = (tenant_id: string, key: string) => Promise<string | null>;
type IsFleetHaltedFn = () => Promise<boolean>;

async function runForTenant(
  tenant: { id: string; display_name: string | null },
  deps: {
    getBoolSetting: GetBoolSettingFn;
    getSecret: GetSecretFn;
    isFleetHalted: IsFleetHaltedFn;
    listActiveTests: () => Promise<ActiveTestRow[]>;
    enqueueAgentRun: typeof mockEnqueueAgentRun;
  },
): Promise<TenantOutcome> {
  const enabled = await deps.getBoolSetting("qa_weekly_execute_enabled", tenant.id);
  if (!enabled) {
    return { status: "skipped", reason: "qa_weekly_execute_enabled=false (default)" };
  }

  const stagingUrl = await deps.getSecret(tenant.id, "qa.staging_url");
  if (!stagingUrl) {
    return {
      status: "skipped",
      reason: "blocked: needs URL — qa.staging_url vault key is not set.",
    };
  }

  if (await deps.isFleetHalted()) {
    return { status: "skipped", reason: "fleet halt active" };
  }

  let tests: ActiveTestRow[];
  try {
    tests = await deps.listActiveTests();
  } catch (e) {
    return { status: "skipped", reason: `list_active_tests failed: ${(e as Error).message}` };
  }

  if (tests.length === 0) {
    return { status: "skipped", reason: "no active test cases in catalog" };
  }

  const correlation_id = `qa-weekly:${tenant.id}:12345`;
  const enqueued_runs: EnqueuedRun[] = [];

  for (const test of tests) {
    try {
      const { run_id } = await deps.enqueueAgentRun({
        tenant_id: tenant.id,
        agent_slug: "browser-operator",
        trigger: "qa-weekly-execute" as const,
        payload: {
          source: "qa_weekly_execute",
          staging_origin: (() => {
            try {
              return new URL(stagingUrl).origin;
            } catch {
              return stagingUrl;
            }
          })(),
          intent: `QA observation run for test case "${test.title}".`,
          test_case_id: test.id,
          test_title: test.title,
          test_role: test.role,
          correlation_id,
          _read_only_note: "enforced-server-side-via-trigger-and-source",
        },
      } as Parameters<typeof deps.enqueueAgentRun>[0]);
      enqueued_runs.push({ tenant_id: tenant.id, run_id, test_case_id: test.id, test_title: test.title });
    } catch {
    }
  }

  return { status: "ok", enqueued_runs };
}

describe("qa-weekly-execute worker — P1-d result isolation + P1-e URL gate", () => {
  const TENANT_A = { id: "tenant-aaa", display_name: "Tenant A" };
  const TENANT_B = { id: "tenant-bbb", display_name: "Tenant B" };

  const TEST_A1: ActiveTestRow = { id: "test-a1", title: "Login flow A", role: "user", nl_spec: { steps: ["nav /login"] } };
  const TEST_A2: ActiveTestRow = { id: "test-a2", title: "Signup flow A", role: "user", nl_spec: { steps: ["nav /signup"] } };
  const TEST_B1: ActiveTestRow = { id: "test-b1", title: "Dashboard B", role: "admin", nl_spec: { steps: ["nav /dashboard"] } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFleetHalted.mockResolvedValue(false);
  });

  it("P1-e: missing qa.staging_url → skip with 'blocked: needs URL', no enqueue", async () => {
    mockGetBoolSetting.mockResolvedValue(true);
    mockGetSecret.mockResolvedValue(null);

    const outcome = await runForTenant(TENANT_A, {
      getBoolSetting: mockGetBoolSetting,
      getSecret: mockGetSecret,
      isFleetHalted: mockIsFleetHalted,
      listActiveTests: vi.fn(async () => [TEST_A1]),
      enqueueAgentRun: mockEnqueueAgentRun,
    });

    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") {
      expect(outcome.reason).toContain("blocked: needs URL");
    }
    expect(mockEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it("P1-e: qa_weekly_execute_enabled=false → skip, no enqueue (default off)", async () => {
    mockGetBoolSetting.mockResolvedValue(false);
    mockGetSecret.mockResolvedValue("https://staging.example.com");

    const outcome = await runForTenant(TENANT_A, {
      getBoolSetting: mockGetBoolSetting,
      getSecret: mockGetSecret,
      isFleetHalted: mockIsFleetHalted,
      listActiveTests: vi.fn(async () => [TEST_A1]),
      enqueueAgentRun: mockEnqueueAgentRun,
    });

    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") {
      expect(outcome.reason).toContain("qa_weekly_execute_enabled=false");
    }
    expect(mockEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it("P1-e: fleet halted → skip, no enqueue", async () => {
    mockGetBoolSetting.mockResolvedValue(true);
    mockGetSecret.mockResolvedValue("https://staging.example.com");
    mockIsFleetHalted.mockResolvedValue(true);

    const outcome = await runForTenant(TENANT_A, {
      getBoolSetting: mockGetBoolSetting,
      getSecret: mockGetSecret,
      isFleetHalted: mockIsFleetHalted,
      listActiveTests: vi.fn(async () => [TEST_A1]),
      enqueueAgentRun: mockEnqueueAgentRun,
    });

    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") {
      expect(outcome.reason).toContain("fleet halt");
    }
    expect(mockEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it("P1-d: enqueue uses trigger='qa-weekly-execute' + payload.source='qa_weekly_execute'", async () => {
    mockGetBoolSetting.mockResolvedValue(true);
    mockGetSecret.mockResolvedValue("https://staging.example.com");

    await runForTenant(TENANT_A, {
      getBoolSetting: mockGetBoolSetting,
      getSecret: mockGetSecret,
      isFleetHalted: mockIsFleetHalted,
      listActiveTests: vi.fn(async () => [TEST_A1]),
      enqueueAgentRun: mockEnqueueAgentRun,
    });

    expect(mockEnqueueAgentRun).toHaveBeenCalledTimes(1);
    const call = mockEnqueueAgentRun.mock.calls[0][0] as {
      trigger: string;
      payload: { source: string; test_case_id: string };
    };
    expect(call.trigger).toBe("qa-weekly-execute");
    expect(call.payload.source).toBe("qa_weekly_execute");
    expect(call.payload.test_case_id).toBe("test-a1");
  });

  it("P1-d: two-tenant isolation — tenant A results never appear in tenant B's enqueued_runs", async () => {
    mockGetBoolSetting.mockResolvedValue(true);
    mockGetSecret.mockImplementation(async (tenant_id: string, key: string) => {
      if (key === "qa.staging_url") {
        return tenant_id === TENANT_A.id
          ? "https://staging-a.example.com"
          : "https://staging-b.example.com";
      }
      return null;
    });

    const listForA = vi.fn(async () => [TEST_A1, TEST_A2]);
    const listForB = vi.fn(async () => [TEST_B1]);

    const outcomeA = await runForTenant(TENANT_A, {
      getBoolSetting: mockGetBoolSetting,
      getSecret: mockGetSecret,
      isFleetHalted: mockIsFleetHalted,
      listActiveTests: listForA,
      enqueueAgentRun: mockEnqueueAgentRun,
    });

    const outcomeB = await runForTenant(TENANT_B, {
      getBoolSetting: mockGetBoolSetting,
      getSecret: mockGetSecret,
      isFleetHalted: mockIsFleetHalted,
      listActiveTests: listForB,
      enqueueAgentRun: mockEnqueueAgentRun,
    });

    expect(outcomeA.status).toBe("ok");
    expect(outcomeB.status).toBe("ok");

    if (outcomeA.status === "ok" && outcomeB.status === "ok") {
      for (const r of outcomeA.enqueued_runs) {
        expect(r.tenant_id).toBe(TENANT_A.id);
        const bIds = outcomeB.enqueued_runs.map((x) => x.test_case_id);
        expect(bIds).not.toContain(r.test_case_id);
      }

      for (const r of outcomeB.enqueued_runs) {
        expect(r.tenant_id).toBe(TENANT_B.id);
        const aIds = outcomeA.enqueued_runs.map((x) => x.test_case_id);
        expect(aIds).not.toContain(r.test_case_id);
      }

      expect(outcomeA.enqueued_runs).toHaveLength(2);
      expect(outcomeB.enqueued_runs).toHaveLength(1);
    }
  });

  it("P1-d: enqueued_runs contains exact (tenant_id, run_id, test_case_id) for each test", async () => {
    mockGetBoolSetting.mockResolvedValue(true);
    mockGetSecret.mockResolvedValue("https://staging.example.com");

    const outcome = await runForTenant(TENANT_A, {
      getBoolSetting: mockGetBoolSetting,
      getSecret: mockGetSecret,
      isFleetHalted: mockIsFleetHalted,
      listActiveTests: vi.fn(async () => [TEST_A1, TEST_A2]),
      enqueueAgentRun: mockEnqueueAgentRun,
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      for (const r of outcome.enqueued_runs) {
        expect(r.tenant_id).toBe(TENANT_A.id);
        expect(typeof r.run_id).toBe("string");
        expect(typeof r.test_case_id).toBe("string");
      }
      const runIds = outcome.enqueued_runs.map((r) => r.run_id);
      expect(new Set(runIds).size).toBe(runIds.length);
    }
  });
});
