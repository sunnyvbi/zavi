import { describe, it, expect, vi, beforeEach } from "vitest";

const loadAgentDefinition = vi.fn();
const getEffectiveVisibility = vi.fn();

vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: (...a: unknown[]) => loadAgentDefinition(...a),
}));
vi.mock("@/services/agents/visibility", () => ({
  getEffectiveVisibility: (...a: unknown[]) => getEffectiveVisibility(...a),
}));

const checkAgentTier = vi.fn();
const isLiveBuildStage = vi.fn();
vi.mock("@/services/agents/entitlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../entitlement")>();
  return {
    ...actual,
    checkAgentTier: (...a: unknown[]) => checkAgentTier(...a),
    isLiveBuildStage: (...a: unknown[]) => isLiveBuildStage(...a),
  };
});

import { ensureAgentRunnable, runOriginForTrigger } from "../ensure-runnable";

const fakeAgent = {
  slug: "test-agent",
  content_hash: "abc123",
  metadata_praxis: {
    manual_only: true,
    side_effects: false,
    decision_class: null,
    runtime: "sdk",
    cron: "",
    triggers: [],
    impact_classes: [],
    kill_switch: true,
    cost_class: "cheap",
    model: "claude-sonnet-4-6",
    sla_class: "daily",
    tools: [],
    output_envelope: "digest",
  },
};

beforeEach(() => {
  loadAgentDefinition.mockReset();
  getEffectiveVisibility.mockReset();
  loadAgentDefinition.mockResolvedValue(fakeAgent);
  getEffectiveVisibility.mockResolvedValue({ visible: true, reason: "default_enabled" });
  checkAgentTier.mockReset();
  checkAgentTier.mockResolvedValue({ enforced: false, tier: "free", required_tier: "pro", allowed: true });
  isLiveBuildStage.mockReset();
  isLiveBuildStage.mockResolvedValue(false);
});

describe("ensureAgentRunnable", () => {
  it("returns runnable:true when visibility resolver returns visible", async () => {
    const result = await ensureAgentRunnable("tenant-1", "test-agent");
    expect(result).toEqual({ runnable: true, agent: fakeAgent });
  });

  it("returns not_found when agent missing from registry", async () => {
    loadAgentDefinition.mockResolvedValue(null);
    const result = await ensureAgentRunnable("tenant-1", "missing-agent");
    expect(result).toMatchObject({
      runnable: false,
      reason: "not_found",
    });
    if (!result.runnable) {
      expect(result.detail).toContain("missing-agent");
    }
    expect(getEffectiveVisibility).not.toHaveBeenCalled();
  });

  it("returns default_disabled when agent.md default_state is disabled and no override", async () => {
    getEffectiveVisibility.mockResolvedValue({ visible: false, reason: "default_disabled" });
    const result = await ensureAgentRunnable("tenant-1", "test-agent");
    expect(result).toMatchObject({
      runnable: false,
      reason: "default_disabled",
    });
    if (!result.runnable) {
      expect(result.detail).toContain("default_disabled");
    }
  });

  it("returns global_override_hide when slug in system_config.disabled_agent_slugs", async () => {
    getEffectiveVisibility.mockResolvedValue({ visible: false, reason: "global_override_hide" });
    const result = await ensureAgentRunnable("tenant-1", "test-agent");
    expect(result).toMatchObject({
      runnable: false,
      reason: "global_override_hide",
    });
  });

  it("returns tenant_hidden_override when tenant self-hid the agent", async () => {
    getEffectiveVisibility.mockResolvedValue({ visible: false, reason: "tenant_hidden_override" });
    const result = await ensureAgentRunnable("tenant-1", "test-agent");
    expect(result).toMatchObject({
      runnable: false,
      reason: "tenant_hidden_override",
    });
  });

  it("returns staff_locked_hide when staff set a per-tenant hide for the agent", async () => {
    getEffectiveVisibility.mockResolvedValue({ visible: false, reason: "staff_locked_hide" });
    const result = await ensureAgentRunnable("tenant-1", "test-agent");
    expect(result).toMatchObject({
      runnable: false,
      reason: "staff_locked_hide",
    });
  });

  it("returns runnable:true when always_on overrides any other state", async () => {
    getEffectiveVisibility.mockResolvedValue({ visible: true, reason: "always_on" });
    const result = await ensureAgentRunnable("tenant-1", "test-agent");
    expect(result).toEqual({ runnable: true, agent: fakeAgent });
  });

  it("returns runnable:true when a tenant visible-override beats default_disabled", async () => {
    getEffectiveVisibility.mockResolvedValue({ visible: true, reason: "tenant_visible_override" });
    const result = await ensureAgentRunnable("tenant-1", "test-agent");
    expect(result).toEqual({ runnable: true, agent: fakeAgent });
  });

  it("throws when tenant_id missing", async () => {
    await expect(ensureAgentRunnable("", "test-agent")).rejects.toThrow(
      /tenant_id required/,
    );
  });

  it("throws when slug missing", async () => {
    await expect(ensureAgentRunnable("tenant-1", "")).rejects.toThrow(
      /slug required/,
    );
  });
});

describe("ensureAgentRunnable — channel origin", () => {
  beforeEach(() => {
    loadAgentDefinition.mockReset();
    getEffectiveVisibility.mockReset();
    loadAgentDefinition.mockResolvedValue(fakeAgent);
  });

  it("a channel-only agent IS runnable from a channel run", async () => {
    getEffectiveVisibility.mockResolvedValue({
      visible: false,
      reason: "channel_only_hide",
    });
    const r = await ensureAgentRunnable("t1", "meta_ads", { origin: "channel" });
    expect(r.runnable).toBe(true);
  });

  it("a channel-only agent IS runnable from a normal run too (2026-09-06)", async () => {
    getEffectiveVisibility.mockResolvedValue({
      visible: false,
      reason: "channel_only_hide",
    });
    const r = await ensureAgentRunnable("t1", "meta_ads");
    expect(r.runnable).toBe(true);
  });

  it("STAFF kill switch still refuses a channel run", async () => {
    getEffectiveVisibility.mockResolvedValue({
      visible: false,
      reason: "staff_locked_hide",
    });
    const r = await ensureAgentRunnable("t1", "meta_ads", { origin: "channel" });
    expect(r.runnable).toBe(false);
    if (!r.runnable) expect(r.reason).toBe("staff_locked_hide");
  });

  it("GLOBAL kill switch still refuses a channel run", async () => {
    getEffectiveVisibility.mockResolvedValue({
      visible: false,
      reason: "global_override_hide",
    });
    const r = await ensureAgentRunnable("t1", "meta_ads", { origin: "channel" });
    expect(r.runnable).toBe(false);
    if (!r.runnable) expect(r.reason).toBe("global_override_hide");
  });

  it("an agent that does not exist still refuses a channel run", async () => {
    loadAgentDefinition.mockResolvedValue(null);
    const r = await ensureAgentRunnable("t1", "social", { origin: "channel" });
    expect(r.runnable).toBe(false);
    if (!r.runnable) expect(r.reason).toBe("not_found");
  });

  it("shape_mismatch_hide still refuses a channel run", async () => {
    getEffectiveVisibility.mockResolvedValue({
      visible: false,
      reason: "shape_mismatch_hide",
    });
    const r = await ensureAgentRunnable("t1", "meta_ads", { origin: "channel" });
    expect(r.runnable).toBe(false);
  });
});

describe("runOriginForTrigger — one rule, both gates", () => {
  it("a channel recipe run is channel origin", () => {
    expect(runOriginForTrigger("channel_recipe")).toBe("channel");
  });

  it("every other trigger is standard — the exemption is not general", () => {
    for (const t of ["cron", "manual", "chat", "slack", "handoff", "webhook"]) {
      expect(runOriginForTrigger(t)).toBe("standard");
    }
  });

  it("a null/absent trigger is standard, never channel", () => {
    expect(runOriginForTrigger(null)).toBe("standard");
    expect(runOriginForTrigger(undefined)).toBe("standard");
    expect(runOriginForTrigger("")).toBe("standard");
  });
});

describe("ensureAgentRunnable — three-tier gate", () => {
  it("refuses with plan_upgrade_required + required_tier when the tier is too low", async () => {
    checkAgentTier.mockResolvedValue({ enforced: true, tier: "starter", required_tier: "pro", allowed: false });
    const result = await ensureAgentRunnable("tenant-1", "engineer");
    expect(result).toEqual({
      runnable: false,
      reason: "plan_upgrade_required",
      required_tier: "pro",
      detail: "Engineer needs the Pro plan ($240/mo).",
    });
  });

  it("does NOT bypass the tier gate for manual_only agents", async () => {
    checkAgentTier.mockResolvedValue({ enforced: true, tier: "free", required_tier: "pro", allowed: false });
    const result = await ensureAgentRunnable("tenant-1", "test-agent");
    expect(result).toMatchObject({ runnable: false, reason: "plan_upgrade_required" });
  });

  it("fails closed (not_in_plan) when the tier cannot be read", async () => {
    checkAgentTier.mockRejectedValue(new Error("db down"));
    const result = await ensureAgentRunnable("tenant-1", "test-agent");
    expect(result).toMatchObject({ runnable: false, reason: "not_in_plan" });
  });

  it("engineer started by the server passes engineerBackendRun=true, no conductor read", async () => {
    for (const trigger of ["a2a", "webhook", "cron", "mcp"]) {
      await ensureAgentRunnable("tenant-1", "engineer", { run: { trigger, enqueuedByUser: false, payload: {} } });
      expect(checkAgentTier).toHaveBeenLastCalledWith("tenant-1", "engineer", expect.objectContaining({ engineerBackendRun: true }));
    }
    expect(isLiveBuildStage).not.toHaveBeenCalled();
  });

  it("an @engineer handoff child (founder_direct_agent_mention) is gated at enqueue and at the claim re-gate", async () => {
    for (const runId of [undefined, "child-1"]) {
      await ensureAgentRunnable("tenant-1", "engineer", {
        run: { runId, trigger: "handoff", enqueuedByUser: false, payload: { founder_direct_agent_mention: true } },
      });
      expect(checkAgentTier).toHaveBeenLastCalledWith("tenant-1", "engineer", expect.objectContaining({ engineerBackendRun: false }));
    }
  });

  it("@engineer typed in chat, or no run facts, passes engineerBackendRun=false", async () => {
    await ensureAgentRunnable("tenant-1", "engineer", { run: { trigger: "chat", enqueuedByUser: false, payload: {} } });
    expect(checkAgentTier).toHaveBeenLastCalledWith("tenant-1", "engineer", expect.objectContaining({ engineerBackendRun: false }));
    await ensureAgentRunnable("tenant-1", "engineer");
    expect(checkAgentTier).toHaveBeenLastCalledWith("tenant-1", "engineer", expect.objectContaining({ engineerBackendRun: false }));
  });

  it("a row a signed-in user wrote is never exempt, whatever trigger it claims", async () => {
    await ensureAgentRunnable("tenant-1", "engineer", { run: { trigger: "a2a", enqueuedByUser: true, payload: {} } });
    expect(checkAgentTier).toHaveBeenLastCalledWith("tenant-1", "engineer", expect.objectContaining({ engineerBackendRun: false }));
  });

  it("fundraising and supply-demand-balancer are never exempt", async () => {
    for (const slug of ["fundraising", "supply-demand-balancer", "test-agent"]) {
      await ensureAgentRunnable("tenant-1", slug, { run: { trigger: "a2a", enqueuedByUser: false, payload: {} } });
      expect(checkAgentTier).toHaveBeenLastCalledWith("tenant-1", slug, expect.objectContaining({ engineerBackendRun: false }));
    }
  });

  it("visibility refusals still win before the tier is consulted", async () => {
    getEffectiveVisibility.mockResolvedValue({ visible: false, reason: "staff_locked_hide" });
    const result = await ensureAgentRunnable("tenant-1", "test-agent");
    expect(result).toMatchObject({ runnable: false, reason: "staff_locked_hide" });
    expect(checkAgentTier).not.toHaveBeenCalled();
  });
});

describe("ensureAgentRunnable — a caller-supplied definition (the worker reads it once per replay)", () => {
  it("uses the supplied definition and never re-reads the registry", async () => {
    const result = await ensureAgentRunnable("tenant-1", "test-agent", { agent: fakeAgent as never });
    expect(result).toEqual({ runnable: true, agent: fakeAgent });
    expect(loadAgentDefinition).not.toHaveBeenCalled();
  });

  it("accepts the in-flight read and returns the very object it resolves to", async () => {
    const pending = Promise.resolve(fakeAgent as never);
    const result = await ensureAgentRunnable("tenant-1", "test-agent", { agent: pending });
    expect(result.runnable && result.agent).toBe(fakeAgent);
    expect(loadAgentDefinition).not.toHaveBeenCalled();
  });

  it("a supplied null is not_found, with no visibility or tier read", async () => {
    const result = await ensureAgentRunnable("tenant-1", "test-agent", { agent: null });
    expect(result).toMatchObject({ runnable: false, reason: "not_found" });
    expect(loadAgentDefinition).not.toHaveBeenCalled();
    expect(getEffectiveVisibility).not.toHaveBeenCalled();
    expect(checkAgentTier).not.toHaveBeenCalled();
  });

  it("a rejected read rejects the gate (never reads as runnable)", async () => {
    await expect(
      ensureAgentRunnable("tenant-1", "test-agent", { agent: Promise.reject(new Error("registry down")) }),
    ).rejects.toThrow(/registry down/);
  });

  it("the kill switch and the tier gate still refuse with a supplied definition", async () => {
    getEffectiveVisibility.mockResolvedValueOnce({ visible: false, reason: "staff_locked_hide" });
    await expect(ensureAgentRunnable("tenant-1", "test-agent", { agent: fakeAgent as never })).resolves.toMatchObject({
      runnable: false,
      reason: "staff_locked_hide",
    });
    checkAgentTier.mockResolvedValueOnce({ enforced: true, tier: "free", required_tier: "pro", allowed: false });
    await expect(ensureAgentRunnable("tenant-1", "test-agent", { agent: fakeAgent as never })).resolves.toMatchObject({
      runnable: false,
      reason: "plan_upgrade_required",
    });
    checkAgentTier.mockRejectedValueOnce(new Error("subscriptions read failed"));
    await expect(ensureAgentRunnable("tenant-1", "test-agent", { agent: fakeAgent as never })).resolves.toMatchObject({
      runnable: false,
      reason: "not_in_plan",
    });
  });
});
