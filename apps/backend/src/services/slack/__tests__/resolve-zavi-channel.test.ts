import { describe, it, expect, vi, beforeEach } from "vitest";

const callMcpTool = vi.fn();
vi.mock("@/services/mcp/execute", () => ({
  callMcpTool: (...args: unknown[]) => callMcpTool(...args),
}));

import { resolveZaviChannel, DIGEST_CHANNEL_NAMES } from "../resolve-zavi-channel";

function listChannelsOk(channels: Array<Record<string, unknown>>) {
  return { ok: true, is_error: false, content: JSON.stringify({ channels }), ms: 1 };
}

beforeEach(() => callMcpTool.mockReset());

describe("resolveZaviChannel — canonical zavi-updates + legacy zavi alias", () => {
  it("resolves the canonical #zavi-updates channel", async () => {
    callMcpTool.mockResolvedValueOnce(
      listChannelsOk([
        { id: "C_GEN", name: "general", is_archived: false },
        { id: "C_UPD", name: "zavi-updates", is_archived: false },
      ]),
    );
    expect(await resolveZaviChannel("t1", "r1")).toBe("C_UPD");
  });

  it("still resolves the legacy #zavi (no regression for existing tenants)", async () => {
    callMcpTool.mockResolvedValueOnce(
      listChannelsOk([{ id: "C_LEGACY", name: "zavi", is_archived: false }]),
    );
    expect(await resolveZaviChannel("t1", "r1")).toBe("C_LEGACY");
  });

  it("prefers zavi-updates when a tenant has BOTH (canonical wins over alias)", async () => {
    callMcpTool.mockResolvedValueOnce(
      listChannelsOk([
        { id: "C_LEGACY", name: "zavi", is_archived: false },
        { id: "C_UPD", name: "zavi-updates", is_archived: false },
      ]),
    );
    expect(await resolveZaviChannel("t1", "r1")).toBe("C_UPD");
  });

  it("does NOT match a similarly-named channel (the upcar-ai near-miss)", async () => {
    callMcpTool.mockResolvedValueOnce(
      listChannelsOk([
        { id: "C_FB", name: "zavi-feedback", is_archived: false },
        { id: "C_MAIN", name: "zavi-main", is_archived: false },
      ]),
    );
    expect(await resolveZaviChannel("t1", "r1")).toBeNull();
  });

  it("ignores an archived channel even if the name matches", async () => {
    callMcpTool.mockResolvedValueOnce(
      listChannelsOk([{ id: "C_OLD", name: "zavi-updates", is_archived: true }]),
    );
    expect(await resolveZaviChannel("t1", "r1")).toBeNull();
  });

  it("returns null (never throws) when Slack isn't connected", async () => {
    callMcpTool.mockResolvedValueOnce({ ok: false, is_error: true, content: "{}", ms: 1 });
    expect(await resolveZaviChannel("t1", "r1")).toBeNull();
  });

  it("returns null (never throws) on malformed channel JSON", async () => {
    callMcpTool.mockResolvedValueOnce({ ok: true, is_error: false, content: "{not json", ms: 1 });
    expect(await resolveZaviChannel("t1", "r1")).toBeNull();
  });

  it("keeps zavi-updates FIRST in the preference list (canonical, not the alias)", () => {
    expect(DIGEST_CHANNEL_NAMES[0]).toBe("zavi-updates");
    expect(DIGEST_CHANNEL_NAMES).toContain("zavi");
  });
});
