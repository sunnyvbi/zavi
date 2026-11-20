
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logEventMock = vi.fn();
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: (input: unknown) => logEventMock(input),
}));

import { logHandoffIntent } from "@/services/agents/handoff-intent";

describe("logHandoffIntent", () => {
  beforeEach(() => {
    logEventMock.mockClear();
    delete process.env.HANDOFF_INTENT_LOGGING;
  });
  afterEach(() => {
    delete process.env.HANDOFF_INTENT_LOGGING;
  });

  it("emits a handoff.intent praxis_logs event with C14-safe meta (authorized)", async () => {
    await logHandoffIntent({
      tenant_id: "t1",
      source_agent_slug: "pm",
      target_agent_slug: "engineer",
      surface: "chat",
      authorized: true,
      run_id: "r1",
    });
    expect(logEventMock).toHaveBeenCalledTimes(1);
    const arg = logEventMock.mock.calls[0]![0] as Record<string, any>;
    expect(arg.source).toBe("handoff_intent");
    expect(arg.code).toBe("handoff.intent");
    expect(arg.level).toBe("info");
    expect(arg.tenant_id).toBe("t1");
    expect(arg.run_id).toBe("r1");
    expect(arg.meta).toEqual({
      agent_slug: "pm",
      target_agent_slug: "engineer",
      surface: "chat",
      authorized: 1,
    });
    expect(JSON.stringify(arg.meta)).not.toMatch(/intent|prompt|message/i);
  });

  it("encodes a blocked attempt with authorized=0 + reject_reason", async () => {
    await logHandoffIntent({
      tenant_id: "t1",
      source_agent_slug: "growth-lead",
      target_agent_slug: "engineer",
      surface: "chat",
      authorized: false,
      reject_reason: "handoff_not_authorized",
    });
    const arg = logEventMock.mock.calls[0]![0] as Record<string, any>;
    expect(arg.meta.authorized).toBe(0);
    expect(arg.meta.reject_reason).toBe("handoff_not_authorized");
    expect(arg.meta.agent_slug).toBe("growth-lead");
  });

  it("falls back to 'unknown' for null source/target", async () => {
    await logHandoffIntent({
      tenant_id: "t1",
      source_agent_slug: null,
      target_agent_slug: null,
      surface: "slack",
      authorized: false,
      reject_reason: "handoff_not_authorized",
    });
    const arg = logEventMock.mock.calls[0]![0] as Record<string, any>;
    expect(arg.meta.agent_slug).toBe("unknown");
    expect(arg.meta.target_agent_slug).toBe("unknown");
  });

  it("kill-switch: HANDOFF_INTENT_LOGGING=0 silences it", async () => {
    process.env.HANDOFF_INTENT_LOGGING = "0";
    await logHandoffIntent({
      tenant_id: "t1",
      source_agent_slug: "operator",
      target_agent_slug: "engineer",
      surface: "chat",
      authorized: true,
    });
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it("never throws even if logEvent rejects", async () => {
    logEventMock.mockRejectedValueOnce(new Error("sink down"));
    await expect(
      logHandoffIntent({
        tenant_id: "t1",
        source_agent_slug: "operator",
        target_agent_slug: "engineer",
        surface: "chat",
        authorized: true,
      }),
    ).resolves.toBeUndefined();
  });
});
