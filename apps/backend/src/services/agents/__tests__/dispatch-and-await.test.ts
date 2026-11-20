import { describe, it, expect, vi, beforeEach } from "vitest";

const { ensureAgentRunnable, enqueueAgentRun, FakeAgentNotFoundError, FakeSafetyGateError } = vi.hoisted(() => {
  class FakeAgentNotFoundError extends Error {
    constructor(slug: string) {
      super(`Agent "${slug}" not found in src/agents/`);
      this.name = "AgentNotFoundError";
    }
  }
  class FakeSafetyGateError extends Error {
    constructor(slug: string, reason: string) {
      super(`Agent "${slug}" rejected by safety gate: ${reason}`);
      this.name = "SafetyGateError";
    }
  }
  return {
    ensureAgentRunnable: vi.fn(),
    enqueueAgentRun: vi.fn(),
    FakeAgentNotFoundError,
    FakeSafetyGateError,
  };
});

vi.mock("@/services/agents/ensure-runnable", () => ({
  ensureAgentRunnable: (...a: unknown[]) => ensureAgentRunnable(...a),
}));

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a),
  AgentNotFoundError: FakeAgentNotFoundError,
  SafetyGateError: FakeSafetyGateError,
}));

type Term = { data?: unknown; error?: unknown };
const selectResult: Term[] = [];

function makeClient() {
  return {
    from(_t: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.order = chain;
      builder.limit = chain;
      builder.maybeSingle = () =>
        Promise.resolve(selectResult.shift() ?? { data: null, error: null });
      return builder;
    },
  };
}
vi.mock("@/services/supabase", () => ({
  serviceClient: () => makeClient(),
}));

import {
  dispatchAgentForCompletionEvent,
  DISPATCH_CORRELATION_KEY,
} from "../dispatch-and-await";

const fakeAgent = {
  slug: "test-agent",
  metadata_praxis: { manual_only: true, side_effects: false },
};

beforeEach(() => {
  ensureAgentRunnable.mockReset();
  enqueueAgentRun.mockReset();
  selectResult.length = 0;
  ensureAgentRunnable.mockResolvedValue({ runnable: true, agent: fakeAgent });
});

describe("dispatchAgentForCompletionEvent", () => {
  it("happy path — non-dedupe returns {agent_run_id, was_dedupe_hit:false}", async () => {
    enqueueAgentRun.mockResolvedValue({ run_id: "fresh-uuid-123" });
    const result = await dispatchAgentForCompletionEvent({
      tenant_id: "tenant-1",
      agent_slug: "test-agent",
      payload: { hello: "world" },
      trigger: "cron",
    });
    expect(result).toEqual({
      agent_run_id: "fresh-uuid-123",
      was_dedupe_hit: false,
    });
  });

  it("judges the gate with the facts the enqueue writes (server, this trigger)", async () => {
    enqueueAgentRun.mockResolvedValue({ run_id: "fresh-uuid-123" });
    await dispatchAgentForCompletionEvent({
      tenant_id: "tenant-1",
      agent_slug: "engineer",
      payload: { hello: "world" },
      trigger: "webhook",
    });
    expect(ensureAgentRunnable).toHaveBeenCalledWith("tenant-1", "engineer", {
      run: { trigger: "webhook", enqueuedByUser: false, payload: { hello: "world" } },
    });
  });

  it("dedupe sentinel WITH cron_dedupe_key recovers prior run_id", async () => {
    enqueueAgentRun.mockResolvedValue({ run_id: "" });
    selectResult.push({ data: { id: "prior-uuid-456" }, error: null });
    const result = await dispatchAgentForCompletionEvent({
      tenant_id: "tenant-1",
      agent_slug: "test-agent",
      payload: { hello: "world" },
      trigger: "cron",
      cron_dedupe_key: "daily-brief:tenant-1:2026-05-18",
    });
    expect(result).toEqual({
      agent_run_id: "prior-uuid-456",
      was_dedupe_hit: true,
    });
  });

  it("dedupe sentinel WITHOUT cron_dedupe_key throws (shouldn't happen)", async () => {
    enqueueAgentRun.mockResolvedValue({ run_id: "" });
    await expect(
      dispatchAgentForCompletionEvent({
        tenant_id: "tenant-1",
        agent_slug: "test-agent",
        payload: {},
        trigger: "cron",
      }),
    ).rejects.toThrow(/empty run_id without a cron_dedupe_key/);
  });

  it("dedupe sentinel WITH key but NO prior row throws (cross-tenant collision)", async () => {
    enqueueAgentRun.mockResolvedValue({ run_id: "" });
    selectResult.push({ data: null, error: null });
    await expect(
      dispatchAgentForCompletionEvent({
        tenant_id: "tenant-1",
        agent_slug: "test-agent",
        payload: {},
        trigger: "cron",
        cron_dedupe_key: "shared-key-no-tenant-prefix",
      }),
    ).rejects.toThrow(/no prior row found/);
  });

  it("hidden slug (tenant_hidden_override → kill switch) → throws SafetyGateError", async () => {
    ensureAgentRunnable.mockResolvedValue({
      runnable: false,
      reason: "tenant_hidden_override",
      detail: "agent hidden by tenant for tenant ...: tenant_hidden_override",
    });
    await expect(
      dispatchAgentForCompletionEvent({
        tenant_id: "tenant-1",
        agent_slug: "test-agent",
        payload: {},
        trigger: "cron",
      }),
    ).rejects.toThrow(FakeSafetyGateError);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("hidden slug (staff_locked_hide → staff per-tenant lock) → throws SafetyGateError", async () => {
    ensureAgentRunnable.mockResolvedValue({
      runnable: false,
      reason: "staff_locked_hide",
      detail: "agent locked by staff for tenant ...: staff_locked_hide",
    });
    await expect(
      dispatchAgentForCompletionEvent({
        tenant_id: "tenant-1",
        agent_slug: "test-agent",
        payload: {},
        trigger: "cron",
      }),
    ).rejects.toThrow(FakeSafetyGateError);
  });

  it("hidden slug (default_disabled → no opt-in) → throws SafetyGateError", async () => {
    ensureAgentRunnable.mockResolvedValue({
      runnable: false,
      reason: "default_disabled",
      detail: "agent default-disabled, no opt-in: default_disabled",
    });
    await expect(
      dispatchAgentForCompletionEvent({
        tenant_id: "tenant-1",
        agent_slug: "test-agent",
        payload: {},
        trigger: "cron",
      }),
    ).rejects.toThrow(FakeSafetyGateError);
  });

  it("agent not_found → throws AgentNotFoundError", async () => {
    ensureAgentRunnable.mockResolvedValue({
      runnable: false,
      reason: "not_found",
      detail: 'Agent "missing" not found',
    });
    await expect(
      dispatchAgentForCompletionEvent({
        tenant_id: "tenant-1",
        agent_slug: "missing",
        payload: {},
        trigger: "cron",
      }),
    ).rejects.toThrow(FakeAgentNotFoundError);
  });

  it("correlation_id present → payload gets _dispatch_correlation key", async () => {
    enqueueAgentRun.mockResolvedValue({ run_id: "fresh-uuid" });
    await dispatchAgentForCompletionEvent({
      tenant_id: "tenant-1",
      agent_slug: "test-agent",
      payload: { foo: "bar" },
      trigger: "cron",
      correlation_id: "dispatch-row-xyz",
    });
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { foo: "bar", [DISPATCH_CORRELATION_KEY]: "dispatch-row-xyz" },
      }),
    );
  });

  it("correlation_id absent → payload unchanged", async () => {
    enqueueAgentRun.mockResolvedValue({ run_id: "fresh-uuid" });
    await dispatchAgentForCompletionEvent({
      tenant_id: "tenant-1",
      agent_slug: "test-agent",
      payload: { foo: "bar" },
      trigger: "cron",
    });
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { foo: "bar" } }),
    );
  });

  it("collision: correlation_id provided AND payload already has reserved key → throws", async () => {
    await expect(
      dispatchAgentForCompletionEvent({
        tenant_id: "tenant-1",
        agent_slug: "test-agent",
        payload: { [DISPATCH_CORRELATION_KEY]: "caller-injected" },
        trigger: "cron",
        correlation_id: "helper-supplied",
      }),
    ).rejects.toThrow(/refusing to overwrite/);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("DISPATCH_CORRELATION_KEY is the documented constant", () => {
    expect(DISPATCH_CORRELATION_KEY).toBe("_dispatch_correlation");
  });
});
