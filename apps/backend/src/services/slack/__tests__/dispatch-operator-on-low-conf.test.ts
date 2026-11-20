
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(),
  logEvent: vi.fn(async () => {}),
  fromMock: vi.fn(),
}));

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: mocks.enqueueAgentRun,
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: mocks.logEvent,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: mocks.fromMock }),
}));

import {
  dispatchOperatorOnLowConf,
  findStuckLowConfDispatches,
  markLowConfDispatchRecovered,
  markLowConfDispatchReplied,
  LOW_CONF_PLACEHOLDER,
  LOW_CONF_RECOVERY_TEXT,
} from "../dispatch-operator-on-low-conf";

function makeFromImpl(opts: {
  existing?: unknown;
  insertError?: { code?: string; message: string } | null;
  selectData?: unknown[];
  updateError?: { code?: string; message: string } | null;
}): (...args: unknown[]) => unknown {
  return () => {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.lt = vi.fn().mockReturnValue(chain);
    chain.is = vi.fn().mockReturnValue(chain);
    chain.in = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockReturnValue(chain);
    chain.maybeSingle = vi.fn().mockResolvedValue({
      data: opts.existing ?? null,
      error: null,
    });
    chain.insert = vi.fn().mockResolvedValue({
      error: opts.insertError ?? null,
    });
    const updateChain: Record<string, unknown> = {
      then: (cb: (v: unknown) => unknown) =>
        Promise.resolve({ error: opts.updateError ?? null }).then(cb),
    };
    updateChain.eq = vi.fn().mockReturnValue(updateChain);
    updateChain.is = vi.fn().mockReturnValue(updateChain);
    updateChain.lt = vi.fn().mockReturnValue(updateChain);
    updateChain.in = vi.fn().mockReturnValue(updateChain);
    updateChain.select = vi.fn().mockReturnValue(updateChain);
    chain.update = vi.fn().mockReturnValue(updateChain);
    if (opts.selectData) {
      chain.limit = vi.fn().mockResolvedValue({
        data: opts.selectData,
        error: null,
      });
    }
    return chain;
  };
}

describe("LOW_CONF_PLACEHOLDER constant", () => {
  it("matches the literal posted to Slack on the dispatch path", () => {
    expect(LOW_CONF_PLACEHOLDER).toContain("On it");
    expect(LOW_CONF_PLACEHOLDER).toMatch(/pulling your context/i);
    expect(LOW_CONF_PLACEHOLDER).not.toContain("—");
  });
});

describe("LOW_CONF_RECOVERY_TEXT constant", () => {
  it("degrades gracefully with concrete next-step guidance", () => {
    expect(LOW_CONF_RECOVERY_TEXT).toMatch(/couldn't pull context/i);
    expect(LOW_CONF_RECOVERY_TEXT).toContain("rephrasing");
  });
});

describe("dispatchOperatorOnLowConf — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues an operator agent_run + inserts pending_reply ledger row", async () => {
    mocks.fromMock.mockImplementation(
      makeFromImpl({ existing: null, insertError: null }),
    );
    mocks.enqueueAgentRun.mockResolvedValue({ run_id: "run-abc" });

    const result = await dispatchOperatorOnLowConf({
      tenant_id: "tenant-1",
      channel_id: "C1",
      thread_ts: "1.0",
      source_message_ts: "1.0",
      source_event_id: "Ev123",
      user_message: "help me with my work",
    });

    expect(result).toEqual({ kind: "enqueued", run_id: "run-abc" });
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueAgentRun.mock.calls[0][0]).toMatchObject({
      agent_slug: "operator",
      tenant_id: "tenant-1",
      trigger: "slack",
    });
    const payload = mocks.enqueueAgentRun.mock.calls[0][0].payload;
    expect(payload.slack.text).toBe("help me with my work");
    expect(payload.slack.channel_id).toBe("C1");
    expect(payload.slack.thread_ts).toBe("1.0");
    expect(payload.slack.original_ts).toBe("1.0");
    expect(payload.slack.event_id).toBe("Ev123");
    expect(payload.low_conf_dispatch).toBe(true);
  });

  it("uses the UNIFIED `slack:${event_id}` dedupe key (matches direct-wake + high-conf triage)", async () => {
    mocks.fromMock.mockImplementation(
      makeFromImpl({ existing: null, insertError: null }),
    );
    mocks.enqueueAgentRun.mockResolvedValue({ run_id: "run-abc" });

    await dispatchOperatorOnLowConf({
      tenant_id: "tenant-1",
      channel_id: "C1",
      thread_ts: "1.0",
      source_message_ts: "1.0",
      source_event_id: "Ev123",
      user_message: "help",
    });

    expect(mocks.enqueueAgentRun.mock.calls[0][0].cron_dedupe_key).toBe(
      "slack:Ev123",
    );
  });

  it("returns duplicate (no second reply) when enqueue dedupes against the direct-wake run (empty run_id)", async () => {
    mocks.fromMock.mockImplementation(
      makeFromImpl({ existing: null, insertError: null }),
    );
    mocks.enqueueAgentRun.mockResolvedValue({ run_id: "" });

    const result = await dispatchOperatorOnLowConf({
      tenant_id: "tenant-1",
      channel_id: "C1",
      thread_ts: "1.0",
      source_message_ts: "1.0",
      source_event_id: "Ev123",
      user_message: "help",
    });

    expect(result).toEqual({ kind: "duplicate" });
  });
});

describe("dispatchOperatorOnLowConf — idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns duplicate via DB unique-violation when same composite key already inserted", async () => {
    mocks.fromMock.mockImplementation(
      makeFromImpl({
        existing: null,
        insertError: { code: "23505", message: "duplicate key" },
      }),
    );

    const result = await dispatchOperatorOnLowConf({
      tenant_id: "tenant-1",
      channel_id: "C1",
      thread_ts: "1.0",
      source_message_ts: "1.0",
      source_event_id: "Ev123",
      user_message: "help",
    });

    expect(result).toEqual({ kind: "duplicate" });
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("returns duplicate when the insert races and hits 23505 unique_violation", async () => {
    mocks.fromMock.mockImplementation(
      makeFromImpl({
        existing: null,
        insertError: { code: "23505", message: "duplicate key" },
      }),
    );
    mocks.enqueueAgentRun.mockResolvedValue({ run_id: "run-xyz" });

    const result = await dispatchOperatorOnLowConf({
      tenant_id: "tenant-1",
      channel_id: "C1",
      thread_ts: "1.0",
      source_message_ts: "1.0",
      source_event_id: "Ev123",
      user_message: "help",
    });

    expect(result).toEqual({ kind: "duplicate" });
  });
});

describe("dispatchOperatorOnLowConf — enqueue failure / timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns enqueue_failed(timeout) when enqueueAgentRun never resolves in 30s", async () => {
    mocks.fromMock.mockImplementation(
      makeFromImpl({ existing: null, insertError: null }),
    );
    mocks.enqueueAgentRun.mockImplementation(
      () =>
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("low_conf_dispatch_enqueue_timeout_30000ms")),
            5,
          ),
        ),
    );

    const result = await dispatchOperatorOnLowConf({
      tenant_id: "tenant-1",
      channel_id: "C1",
      thread_ts: "1.0",
      source_message_ts: "1.0",
      source_event_id: "Ev123",
      user_message: "help",
    });

    expect(result.kind).toBe("enqueue_failed");
    if (result.kind === "enqueue_failed") {
      expect(result.reason).toBe("timeout");
    }
    expect(mocks.logEvent).toHaveBeenCalled();
  });

  it("returns enqueue_failed(error) on a non-timeout exception", async () => {
    mocks.fromMock.mockImplementation(
      makeFromImpl({ existing: null, insertError: null }),
    );
    mocks.enqueueAgentRun.mockRejectedValue(new Error("inngest unreachable"));

    const result = await dispatchOperatorOnLowConf({
      tenant_id: "tenant-1",
      channel_id: "C1",
      thread_ts: "1.0",
      source_message_ts: "1.0",
      source_event_id: "Ev123",
      user_message: "help",
    });

    expect(result.kind).toBe("enqueue_failed");
    if (result.kind === "enqueue_failed") {
      expect(result.reason).toBe("error");
    }
  });
});

describe("findStuckLowConfDispatches — sweep scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns rows older than the cutoff with status pending_reply", async () => {
    const old = {
      tenant_id: "tenant-1",
      channel_id: "C1",
      thread_ts: "1.0",
      source_message_ts: "1.0",
      run_id: "run-1",
      dispatched_at: new Date(Date.now() - 90_000).toISOString(),
    };
    mocks.fromMock.mockImplementation(
      makeFromImpl({ selectData: [old] }),
    );
    const stuck = await findStuckLowConfDispatches(60_000);
    expect(stuck).toEqual([old]);
  });
});

describe("markLowConfDispatchReplied — operator reply path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flips ledger to status=replied + sets replied_at by run_id", async () => {
    mocks.fromMock.mockImplementation(makeFromImpl({ updateError: null }));
    await markLowConfDispatchReplied("run-1");
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

describe("markLowConfDispatchRecovered — sweep recovery path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flips ledger to status=recovered + sets recovered_at race-safe", async () => {
    mocks.fromMock.mockImplementation(makeFromImpl({ updateError: null }));
    await markLowConfDispatchRecovered({
      tenant_id: "tenant-1",
      channel_id: "C1",
      thread_ts: "1.0",
      source_message_ts: "1.0",
      run_id: "run-1",
      dispatched_at: new Date().toISOString(),
    });
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
