import { describe, it, expect } from "vitest";
import {
  computeRunLane,
  buildRunRequestedEvent,
} from "@/services/agents/run-lane";
import {
  buildInfraRetryEvent,
  buildQueuedResendEvent,
} from "@/services/agents/infra-retry";

describe("computeRunLane (GAP 11 canonical rule)", () => {
  it("chat with no batch_id → interactive", () => {
    expect(computeRunLane("chat", null)).toBe("interactive");
    expect(computeRunLane("chat", undefined)).toBe("interactive");
  });
  it("slack with no batch_id → interactive (human waiting)", () => {
    expect(computeRunLane("slack", null)).toBe("interactive");
  });
  it("mcp with no batch_id → interactive (an AI assistant is polling for a person)", () => {
    expect(computeRunLane("mcp", null)).toBe("interactive");
    expect(computeRunLane("mcp", "batch-abc")).toBe("background");
  });
  it("chat batch CHILD (batch_id set) → background, not interactive", () => {
    expect(computeRunLane("chat", "batch-abc")).toBe("background");
    expect(computeRunLane("slack", "batch-abc")).toBe("background");
  });
  it("non-human triggers → background", () => {
    for (const t of ["cron", "a2a", "webhook", "manual", "", null, undefined]) {
      expect(computeRunLane(t, null)).toBe("background");
    }
  });
});

describe("buildRunRequestedEvent", () => {
  it("stamps the lane and keeps id = run_id (event-id dedup)", () => {
    const ev = buildRunRequestedEvent({
      run_id: "r1",
      tenant_id: "t1",
      agent_slug: "chief-of-staff",
      trigger: "chat",
      batch_id: null,
    });
    expect(ev.id).toBe("r1");
    expect(ev.name).toBe("agent.run.requested");
    expect(ev.data).toMatchObject({
      run_id: "r1",
      tenant_id: "t1",
      agent_slug: "chief-of-staff",
      lane: "interactive",
    });
  });
  it("omits empty tenant_id / agent_slug rather than sending empty strings", () => {
    const ev = buildRunRequestedEvent({
      run_id: "r2",
      trigger: "cron",
      batch_id: null,
    });
    expect(ev.data.lane).toBe("background");
    expect("tenant_id" in ev.data).toBe(false);
    expect("agent_slug" in ev.data).toBe(false);
  });
});

describe("infra-retry builders stamp lane", () => {
  it("buildInfraRetryEvent: interactive row keeps interactive lane on re-fire", () => {
    const ev = buildInfraRetryEvent(
      { id: "r3", tenant_id: "t1", agent_slug: "operator", trigger: "chat", batch_id: null },
      1,
    );
    expect(ev.data.lane).toBe("interactive");
    expect(ev.id).toBe("r3-infra-retry-1");
  });
  it("buildInfraRetryEvent: batch child re-fires to background", () => {
    const ev = buildInfraRetryEvent(
      { id: "r4", tenant_id: "t1", agent_slug: "operator", trigger: "chat", batch_id: "b1" },
      2,
    );
    expect(ev.data.lane).toBe("background");
  });
  it("buildInfraRetryEvent: missing trigger/batch_id defaults to background (safe)", () => {
    const ev = buildInfraRetryEvent({ id: "r5", tenant_id: "t1", agent_slug: "operator" }, 1);
    expect(ev.data.lane).toBe("background");
  });
  it("buildQueuedResendEvent: interactive row keeps lane; id is bucketed", () => {
    const ev = buildQueuedResendEvent(
      { id: "r6", tenant_id: "t1", agent_slug: "pm", trigger: "slack", batch_id: null },
      1_000_000_000,
    );
    expect(ev.data.lane).toBe("interactive");
    expect(ev.id).toMatch(/^r6-queued-resend-\d+$/);
  });
});
