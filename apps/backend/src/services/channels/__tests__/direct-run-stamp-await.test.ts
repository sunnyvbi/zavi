import { describe, it, expect, vi, beforeEach } from "vitest";

const T1 = "00000000-0000-0000-0000-000000000001";
const RUN = "33333333-3333-3333-3333-333333333333";

const { rpcState } = vi.hoisted(() => ({
  rpcState: {
    calls: [] as string[],
    stampGate: null as null | Promise<void>,
    releaseStamp: null as null | (() => void),
    recordGate: null as null | Promise<void>,
    releaseRecord: null as null | (() => void),
  },
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: vi.fn((_tid: string, name: string) => {
    rpcState.calls.push(name);
    if (name === "stamp_channel_run") {
      return rpcState.stampGate
        ? rpcState.stampGate.then(() => ({ data: true, error: null }))
        : Promise.resolve({ data: true, error: null });
    }
    if (name === "record_channel_run") {
      return rpcState.recordGate
        ? rpcState.recordGate.then(() => ({ data: null, error: null }))
        : Promise.resolve({ data: null, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }),
}));

vi.mock("@/services/channels/budget", () => ({
  channelBudgetAllows: vi.fn(async () => ({ allowed: true })),
  CAP_REACHED_MESSAGE: "cap reached",
}));
vi.mock("@/services/channels/lock", () => ({
  isChannelLocked: vi.fn(async () => false),
  comingSoonMessage: (n: string) => `${n} coming soon`,
}));
vi.mock("@/services/agents/credits", () => ({
  reserveEstimateFor: vi.fn(() => 0),
}));
vi.mock("@/services/agents/channel-agents", () => ({
  channelForAgent: vi.fn(() => null),
}));

import { stampDirectChannelRun, stampDirectChannelRunWithin } from "@/services/channels/direct-run";

async function drain(ticks = 15) {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  rpcState.calls = [];
  rpcState.stampGate = null;
  rpcState.releaseStamp = null;
  rpcState.recordGate = null;
  rpcState.releaseRecord = null;
});

describe("stampDirectChannelRun — what awaiting it costs", () => {
  it(
    "resolves once the STAMP has landed, without waiting on the tile bookkeeping",
    async () => {
      rpcState.recordGate = new Promise<void>((r) => {
        rpcState.releaseRecord = r;
      });

      const stamped = await stampDirectChannelRun(T1, RUN, "meta_ads");

      expect(stamped).toBe(true);
      expect(rpcState.calls).toEqual(["stamp_channel_run", "record_channel_run"]);

      rpcState.releaseRecord!();
    },
    2000,
  );

  it("does NOT resolve until the stamp itself has settled", async () => {
    rpcState.stampGate = new Promise<void>((r) => {
      rpcState.releaseStamp = r;
    });

    let settled = false;
    const pending = stampDirectChannelRun(T1, RUN, "meta_ads").then((v) => {
      settled = true;
      return v;
    });

    await drain();

    expect(rpcState.calls).toContain("stamp_channel_run");
    expect(settled).toBe(false);

    rpcState.releaseStamp!();
    await expect(pending).resolves.toBe(true);
  });
});

describe("stampDirectChannelRunWithin — a stamp taken before dispatch", () => {
  it("returns the stamp's result when it lands in time", async () => {
    await expect(stampDirectChannelRunWithin(T1, RUN, "youtube_organic", 500)).resolves.toBe(true);
  });

  it("gives up on a stalled stamp at the deadline instead of parking the caller", async () => {
    rpcState.stampGate = new Promise<void>((r) => {
      rpcState.releaseStamp = r;
    });
    await expect(stampDirectChannelRunWithin(T1, RUN, "youtube_organic", 20)).resolves.toBe("timeout");
    rpcState.releaseStamp!();
  });
});
