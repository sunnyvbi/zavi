import { describe, it, expect, vi, beforeEach } from "vitest";

const getBoolSetting = vi.fn();
const runsUpdateEq2 = vi.fn();
const workItemsInsert = vi.fn();
const fromFn = vi.fn();

vi.mock("@/services/settings", () => ({
  getBoolSetting: (...a: unknown[]) => getBoolSetting(...a),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (t: string) => fromFn(t) }),
  serverClientFromBearer: () => ({}),
}));

vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: () => Promise.resolve(false),
  FleetHaltedError: class extends Error {},
}));
vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: vi.fn(),
}));

import {
  isE2bOnlySource,
  shouldDelegateConversationalEngineerToLocal,
  delegateConversationalRunToLocal,
} from "../work-queue";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function tenantLaneChain(enabled: boolean) {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve({ data: { enabled }, error: null }),
      }),
    }),
  };
}

beforeEach(() => {
  getBoolSetting.mockReset();
  runsUpdateEq2.mockReset();
  workItemsInsert.mockReset();
  fromFn.mockReset();
});

function linkChain(linked: boolean) {
  return {
    select: () => ({
      eq: () => ({
        limit: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: linked ? { id: "wi" } : null, error: null }),
        }),
      }),
    }),
  };
}

function mockGates(opts: {
  flag: boolean;
  master: boolean;
  tenant: boolean;
  linked?: boolean;
}) {
  getBoolSetting.mockImplementation((key: string) =>
    Promise.resolve(
      key === "engineer_runs_local"
        ? opts.flag
        : key === "fleet_local_lane_enabled"
          ? opts.master
          : false,
    ),
  );
  fromFn.mockImplementation((t: string) =>
    t === "tenant_local_lane"
      ? tenantLaneChain(opts.tenant)
      : t === "agent_work_items"
        ? linkChain(opts.linked ?? false)
        : ({} as never),
  );
}

describe("isE2bOnlySource — the shared cloud-only gate", () => {
  it("webhook_slack is e2b-only (live customer-workspace send)", () => {
    expect(isE2bOnlySource("webhook_slack")).toBe(true);
  });
  it("laptop-eligible sources are NOT e2b-only", () => {
    expect(isE2bOnlySource("chat")).toBe(false);
    expect(isE2bOnlySource("webhook_github")).toBe(false);
    expect(isE2bOnlySource("cron")).toBe(false);
  });
});

describe("shouldDelegateConversationalEngineerToLocal", () => {
  it("engineer + flag ON + master ON + tenant ON → true", async () => {
    mockGates({ flag: true, master: true, tenant: true });
    expect(await shouldDelegateConversationalEngineerToLocal(TENANT, "engineer", "chat", "run-1")).toBe(true);
  });

  it("NON-engineer → false with ZERO setting reads (cheapest gate first)", async () => {
    mockGates({ flag: true, master: true, tenant: true });
    expect(await shouldDelegateConversationalEngineerToLocal(TENANT, "research", "chat", "run-1")).toBe(false);
    expect(getBoolSetting).not.toHaveBeenCalled();
  });

  it("money-path slug → false (never local)", async () => {
    mockGates({ flag: true, master: true, tenant: true });
    expect(
      await shouldDelegateConversationalEngineerToLocal(TENANT, "performance-marketer", "chat", "run-1"),
    ).toBe(false);
  });

  it("BACKGROUND trigger → false even with all gates ON (no re-hand of cloud-rescued items)", async () => {
    mockGates({ flag: true, master: true, tenant: true });
    expect(await shouldDelegateConversationalEngineerToLocal(TENANT, "engineer", "webhook", "run-1")).toBe(false);
    expect(await shouldDelegateConversationalEngineerToLocal(TENANT, "engineer", "cron", "run-1")).toBe(false);
    expect(await shouldDelegateConversationalEngineerToLocal(TENANT, "engineer", "a2a", "run-1")).toBe(false);
  });

  it("slack trigger → false (e2b-only source: delivers into the customer's live Slack)", async () => {
    mockGates({ flag: true, master: true, tenant: true });
    expect(await shouldDelegateConversationalEngineerToLocal(TENANT, "engineer", "slack", "run-1")).toBe(false);
  });

  it("run ALREADY linked to a work_item → false (drained-origin chat_pr_followup/webhook_slack, not a fresh conversational run)", async () => {
    mockGates({ flag: true, master: true, tenant: true, linked: true });
    expect(await shouldDelegateConversationalEngineerToLocal(TENANT, "engineer", "chat", "run-1")).toBe(false);
  });

  it("engineer + flag OFF → false (inert until opt-in)", async () => {
    mockGates({ flag: false, master: true, tenant: true });
    expect(await shouldDelegateConversationalEngineerToLocal(TENANT, "engineer", "chat", "run-1")).toBe(false);
  });

  it("engineer + flag ON but master OFF → false", async () => {
    mockGates({ flag: true, master: false, tenant: true });
    expect(await shouldDelegateConversationalEngineerToLocal(TENANT, "engineer", "chat", "run-1")).toBe(false);
  });

  it("engineer + flag ON + master ON but tenant_local_lane OFF → false", async () => {
    mockGates({ flag: true, master: true, tenant: false });
    expect(await shouldDelegateConversationalEngineerToLocal(TENANT, "engineer", "chat", "run-1")).toBe(false);
  });

  it("fails CLOSED: tenant_local_lane read errors → false", async () => {
    getBoolSetting.mockImplementation((key: string) =>
      Promise.resolve(key === "engineer_runs_local" || key === "fleet_local_lane_enabled"),
    );
    fromFn.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: { message: "blip" } }),
        }),
      }),
    }));
    expect(await shouldDelegateConversationalEngineerToLocal(TENANT, "engineer", "chat", "run-1")).toBe(false);
  });
});

describe("delegateConversationalRunToLocal", () => {
  function armWrites() {
    const runsChain = {
      update: (patch: unknown) => ({
        eq: () => ({ eq: (...a: unknown[]) => runsUpdateEq2(patch, ...a) }),
      }),
    };
    const itemsChain = { insert: (row: unknown) => workItemsInsert(row) };
    fromFn.mockImplementation((t: string) =>
      t === "agent_runs" ? runsChain : t === "agent_work_items" ? itemsChain : ({} as never),
    );
    runsUpdateEq2.mockResolvedValue({ error: null });
    workItemsInsert.mockResolvedValue({ error: null });
  }

  it("slack trigger → THROWS before any write (e2b-only source, never to laptop)", async () => {
    armWrites();
    await expect(
      delegateConversationalRunToLocal({
        run_id: "run-1",
        tenant_id: TENANT,
        agent_slug: "engineer",
        trigger: "slack",
        payload: { thread_id: "t1" },
      }),
    ).rejects.toThrow(/e2b-only/);
    expect(runsUpdateEq2).not.toHaveBeenCalled();
    expect(workItemsInsert).not.toHaveBeenCalled();
  });

  it("chat trigger → source 'chat' (round-trips to trigger chat)", async () => {
    armWrites();
    await delegateConversationalRunToLocal({
      run_id: "run-2",
      tenant_id: TENANT,
      agent_slug: "engineer",
      trigger: "chat",
      payload: null,
    });
    expect((workItemsInsert.mock.calls[0][0] as { source: string }).source).toBe("chat");
  });

  it("insert error → throws (run-agent treats as fail-OPEN to cloud)", async () => {
    armWrites();
    workItemsInsert.mockResolvedValue({ error: { message: "boom" } });
    await expect(
      delegateConversationalRunToLocal({
        run_id: "run-3",
        tenant_id: TENANT,
        agent_slug: "engineer",
        trigger: "chat",
        payload: null,
      }),
    ).rejects.toThrow(/delegate-to-local/);
  });
});
