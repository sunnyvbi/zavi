import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  readError: null as string | null,
  rpc: vi.fn(),
  heal: vi.fn(),
  switched: vi.fn(),
}));

vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: m.row, error: m.readError ? { message: m.readError } : null }),
        }),
      }),
    }),
  }),
  tenantRpc: m.rpc,
}));

import { healChatRunStamp } from "@/services/channels/direct-run";

beforeEach(() => {
  m.readError = null;
  m.rpc.mockReset().mockResolvedValue({ data: true, error: null });
});

describe("healChatRunStamp", () => {
  it("returns the stamp and writes nothing when the run is already stamped", async () => {
    m.row = { channel_slug: "meta_ads", agent_slug: "meta_ads", trigger: "chat" };
    expect(await healChatRunStamp("t1", "r1")).toBe("meta_ads");
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("stamps an unstamped chat run of a channel agent with its own channel", async () => {
    m.row = { channel_slug: null, agent_slug: "meta_ads", trigger: "chat" };
    expect(await healChatRunStamp("t1", "r1")).toBe("meta_ads");
    expect(m.rpc).toHaveBeenCalledWith("t1", "stamp_channel_run", { p_run_id: "r1", p_channel_slug: "meta_ads" });
  });

  it("is 'failed' when the stamp is refused, and 'unreadable' when the read fails or anything stalls past the one deadline", async () => {
    m.row = { channel_slug: null, agent_slug: "meta_ads", trigger: "chat" };
    m.rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await healChatRunStamp("t1", "r1")).toBe("failed");

    m.rpc.mockImplementationOnce(() => new Promise(() => {}));
    expect(await healChatRunStamp("t1", "r1", 20)).toBe("unreadable");

    m.readError = "db down";
    expect(await healChatRunStamp("t1", "r1")).toBe("unreadable");
  });

  it("leaves other unstamped runs alone: a non-chat channel run, and the operator's chat", async () => {
    m.row = { channel_slug: null, agent_slug: "meta_ads", trigger: "a2a" };
    expect(await healChatRunStamp("t1", "r1")).toBeNull();
    m.row = { channel_slug: null, agent_slug: "operator", trigger: "chat" };
    expect(await healChatRunStamp("t1", "r1")).toBeNull();
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
