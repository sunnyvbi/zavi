import { describe, it, expect, vi, beforeEach } from "vitest";

const isFleetHalted = vi.fn();
const rpc = vi.fn();
const fromFn = vi.fn();
const serviceClient = vi.fn();
const serverClientFromBearer = vi.fn();
const loadAgentDefinition = vi.fn();
const getBoolSetting = vi.fn();

vi.mock("@/services/settings", () => ({
  getBoolSetting: (...a: unknown[]) => getBoolSetting(...a),
}));

vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: () => isFleetHalted(),
  FleetHaltedError: class FleetHaltedError extends Error {
    code = "fleet_halted";
    constructor() {
      super("fleet halt active");
      this.name = "FleetHaltedError";
    }
  },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => serviceClient(),
  serverClientFromBearer: (...a: unknown[]) => serverClientFromBearer(...a),
}));

vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: (...a: unknown[]) => loadAgentDefinition(...a),
}));

import { enqueueWorkItem, claimWorkItems } from "../work-queue";

function agentDef(over: Partial<{ cost_class: string; side_effects: boolean }> = {}) {
  return {
    slug: "x",
    name: "X",
    description: "",
    body_markdown: "",
    body_path: "",
    content_hash: "hash-x",
    metadata_praxis: {
      model: "m",
      manual_only: true,
      side_effects: over.side_effects ?? false,
      cost_class: over.cost_class ?? "standard",
      kill_switch: true,
      impact_classes: [],
      cron: "",
      triggers: [],
      runtime: "sdk",
      tools: [],
      response_contract: "auto",
      prose_fallback: false,
      requires_sandbox: false,
    },
  };
}

function tenantFlag(enabled: boolean) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { enabled }, error: null }),
        }),
      }),
    }),
    rpc,
  };
}

beforeEach(() => {
  isFleetHalted.mockReset();
  rpc.mockReset();
  fromFn.mockReset();
  serviceClient.mockReset();
  serverClientFromBearer.mockReset();
  loadAgentDefinition.mockReset();
  getBoolSetting.mockReset();
  isFleetHalted.mockResolvedValue(false);
  rpc.mockResolvedValue({ data: "wi-1", error: null });
  mockSettings(false, false);
});

function mockSettings(master: boolean, allowlisted = false) {
  getBoolSetting.mockImplementation((key: string) =>
    Promise.resolve(key === "fleet_local_lane_enabled" ? master : allowlisted),
  );
}

describe("enqueueWorkItem lane router", () => {
  it("standard cost_class → lane e2b (master off)", async () => {
    loadAgentDefinition.mockResolvedValue(agentDef({ cost_class: "standard" }));
    serviceClient.mockReturnValue({ rpc });
    await enqueueWorkItem({ tenant_id: "t1", agent_slug: "pm", source: "cron" });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b", p_work_type: "standard" }),
    );
  });

  it("expensive cost_class but MASTER OFF → still e2b", async () => {
    loadAgentDefinition.mockResolvedValue(agentDef({ cost_class: "expensive" }));
    serviceClient.mockReturnValue({ rpc });
    await enqueueWorkItem({ tenant_id: "t1", agent_slug: "research", source: "cron" });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b" }),
    );
  });

  it("master ON via registry default + tenant flag OFF → clamps to e2b", async () => {
    mockSettings(true);
    loadAgentDefinition.mockResolvedValue(agentDef({ cost_class: "expensive" }));
    serviceClient.mockReturnValue(tenantFlag(false));
    await enqueueWorkItem({ tenant_id: "t1", agent_slug: "engineer", source: "cron" });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b" }),
    );
  });

  it("expensive + master ON + tenant flag ON → lane local", async () => {
    mockSettings(true);
    loadAgentDefinition.mockResolvedValue(agentDef({ cost_class: "expensive" }));
    serviceClient.mockReturnValue(tenantFlag(true));
    await enqueueWorkItem({ tenant_id: "t1", agent_slug: "engineer", source: "cron" });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "local" }),
    );
  });

  it("expensive + master ON but tenant flag OFF → clamps to e2b", async () => {
    mockSettings(true);
    loadAgentDefinition.mockResolvedValue(agentDef({ cost_class: "expensive" }));
    serviceClient.mockReturnValue(tenantFlag(false));
    await enqueueWorkItem({ tenant_id: "t1", agent_slug: "engineer", source: "cron" });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b" }),
    );
  });

  it("ALLOWLIST DROPPED (2026-06-14): side_effects:true expensive + gates ON → local (no allowlist needed)", async () => {
    mockSettings(true, false);
    loadAgentDefinition.mockResolvedValue(
      agentDef({ cost_class: "expensive", side_effects: true }),
    );
    serviceClient.mockReturnValue(tenantFlag(true));
    await enqueueWorkItem({ tenant_id: "t1", agent_slug: "support-lead", source: "cron" });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "local" }),
    );
    expect(getBoolSetting).not.toHaveBeenCalledWith(
      "local_lane_side_effects_allowlist",
      expect.anything(),
    );
  });

  it("HARD CLAMP: MONEY_PATH_SLUGS (performance-marketer) → e2b", async () => {
    mockSettings(true);
    loadAgentDefinition.mockResolvedValue(agentDef({ cost_class: "expensive" }));
    serviceClient.mockReturnValue(tenantFlag(true));
    await enqueueWorkItem({
      tenant_id: "t1",
      agent_slug: "performance-marketer",
      source: "cron",
    });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b" }),
    );
  });

  it("HARD CLAMP: MONEY_PATH_SLUGS + ALLOWLISTED + side_effects + gates ON → STILL e2b", async () => {
    mockSettings(true, true);
    loadAgentDefinition.mockResolvedValue(
      agentDef({ cost_class: "expensive", side_effects: true }),
    );
    serviceClient.mockReturnValue(tenantFlag(true));
    await enqueueWorkItem({
      tenant_id: "t1",
      agent_slug: "performance-marketer",
      source: "cron",
    });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b" }),
    );
  });

  it("HARD CLAMP: chat_pr_followup source → e2b (pushes to a customer repo)", async () => {
    mockSettings(true, false);
    loadAgentDefinition.mockResolvedValue(agentDef({ cost_class: "expensive" }));
    serviceClient.mockReturnValue(tenantFlag(true));
    await enqueueWorkItem({
      tenant_id: "t1",
      agent_slug: "engineer",
      source: "chat_pr_followup",
    });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b", p_work_type: null }),
    );
  });

  it("HARD CLAMP: webhook_slack source → e2b", async () => {
    mockSettings(true);
    loadAgentDefinition.mockResolvedValue(agentDef({ cost_class: "expensive" }));
    serviceClient.mockReturnValue(tenantFlag(true));
    await enqueueWorkItem({
      tenant_id: "t1",
      agent_slug: "engineer",
      source: "webhook_slack",
    });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b" }),
    );
  });

  it("NO EXPANSION: webhook_slack + NON-side-effect + ALLOWLISTED → STILL e2b", async () => {
    mockSettings(true, true);
    loadAgentDefinition.mockResolvedValue(agentDef({ cost_class: "expensive" }));
    serviceClient.mockReturnValue(tenantFlag(true));
    await enqueueWorkItem({
      tenant_id: "t1",
      agent_slug: "engineer",
      source: "webhook_slack",
    });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b" }),
    );
  });

  it("webhook_github engineer PR + side_effects:true + gates ON → local (rides the default, no allowlist)", async () => {
    mockSettings(true, false);
    loadAgentDefinition.mockResolvedValue(
      agentDef({ cost_class: "expensive", side_effects: true }),
    );
    serviceClient.mockReturnValue(tenantFlag(true));
    await enqueueWorkItem({
      tenant_id: "t1",
      agent_slug: "engineer",
      source: "webhook_github",
    });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "local" }),
    );
  });

  it("webhook_github + expensive + tenant flag OFF → e2b (per-tenant gate still holds)", async () => {
    mockSettings(true, false);
    loadAgentDefinition.mockResolvedValue(
      agentDef({ cost_class: "expensive", side_effects: true }),
    );
    serviceClient.mockReturnValue(tenantFlag(false));
    await enqueueWorkItem({
      tenant_id: "t1",
      agent_slug: "engineer",
      source: "webhook_github",
    });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b" }),
    );
  });

  it("MONEY still clamps over webhook relax: performance-marketer + webhook_github + side_effects + ALLOWLISTED → e2b", async () => {
    mockSettings(true, true);
    loadAgentDefinition.mockResolvedValue(
      agentDef({ cost_class: "expensive", side_effects: true }),
    );
    serviceClient.mockReturnValue(tenantFlag(true));
    await enqueueWorkItem({
      tenant_id: "t1",
      agent_slug: "performance-marketer",
      source: "webhook_github",
    });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b" }),
    );
  });

  it("fails CLOSED: webhook_github + expensive + tenant flag READ ERROR → e2b", async () => {
    mockSettings(true, false);
    loadAgentDefinition.mockResolvedValue(
      agentDef({ cost_class: "expensive", side_effects: true }),
    );
    serviceClient.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: null, error: { message: "db blip" } }),
          }),
        }),
      }),
      rpc,
    });
    await enqueueWorkItem({
      tenant_id: "t1",
      agent_slug: "engineer",
      source: "webhook_github",
    });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b" }),
    );
  });

  it("side_effects:true expensive + master ON + tenant flag ON → local (end-to-end)", async () => {
    mockSettings(true, false);
    loadAgentDefinition.mockResolvedValue(
      agentDef({ cost_class: "expensive", side_effects: true }),
    );
    serviceClient.mockReturnValue(tenantFlag(true));
    await enqueueWorkItem({ tenant_id: "t1", agent_slug: "engineer", source: "cron" });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "local" }),
    );
  });

  it("side_effects:true + ALLOWLISTED but tenant flag OFF → e2b (per-tenant lane gate still applies)", async () => {
    mockSettings(true, true);
    loadAgentDefinition.mockResolvedValue(
      agentDef({ cost_class: "expensive", side_effects: true }),
    );
    serviceClient.mockReturnValue(tenantFlag(false));
    await enqueueWorkItem({ tenant_id: "t1", agent_slug: "engineer", source: "cron" });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b" }),
    );
  });

  it("side_effects:true + ALLOWLISTED but MASTER OFF → e2b (master gate still applies)", async () => {
    mockSettings(false, true);
    loadAgentDefinition.mockResolvedValue(
      agentDef({ cost_class: "expensive", side_effects: true }),
    );
    serviceClient.mockReturnValue(tenantFlag(true));
    await enqueueWorkItem({ tenant_id: "t1", agent_slug: "engineer", source: "cron" });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b" }),
    );
  });

  it("side_effects:FALSE expensive + master ON + tenant flag ON → local, NO allowlist read", async () => {
    mockSettings(true, false);
    loadAgentDefinition.mockResolvedValue(
      agentDef({ cost_class: "expensive", side_effects: false }),
    );
    serviceClient.mockReturnValue(tenantFlag(true));
    await enqueueWorkItem({ tenant_id: "t1", agent_slug: "engineer", source: "cron" });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "local" }),
    );
    expect(getBoolSetting).not.toHaveBeenCalledWith(
      "local_lane_side_effects_allowlist",
      expect.anything(),
    );
  });

  it("agent def load failure → fail-safe e2b", async () => {
    mockSettings(true);
    loadAgentDefinition.mockRejectedValue(new Error("boom"));
    serviceClient.mockReturnValue({ rpc });
    await enqueueWorkItem({ tenant_id: "t1", agent_slug: "engineer", source: "cron" });
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b", p_work_type: null }),
    );
  });

  it("user-direct chat path skips lane resolution → e2b, no agent-def read", async () => {
    serverClientFromBearer.mockReturnValue({ rpc });
    await enqueueWorkItem({
      tenant_id: "t1",
      agent_slug: "operator",
      source: "chat",
      user_access_token: "tok",
    });
    expect(loadAgentDefinition).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_work_item",
      expect.objectContaining({ p_lane: "e2b", p_work_type: null }),
    );
  });
});

describe("claimWorkItems lane passthrough", () => {
  it("defaults claim e2b + null tenant (cloud drainer no-op widen)", async () => {
    serviceClient.mockReturnValue({ rpc });
    rpc.mockResolvedValue({ data: [], error: null });
    await claimWorkItems("drainer-1", 25, 300);
    expect(rpc).toHaveBeenCalledWith(
      "claim_agent_work_items",
      expect.objectContaining({ p_lane: "e2b", p_tenant_id: null }),
    );
  });

  it("local claim passes lane local + the one tenant", async () => {
    serviceClient.mockReturnValue({ rpc });
    rpc.mockResolvedValue({ data: [], error: null });
    await claimWorkItems("fleet-1", 10, 3600, "local", "t1");
    expect(rpc).toHaveBeenCalledWith(
      "claim_agent_work_items",
      expect.objectContaining({ p_lane: "local", p_tenant_id: "t1" }),
    );
  });
});
