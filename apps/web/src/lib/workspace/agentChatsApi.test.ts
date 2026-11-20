import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: h.fetch }));

import { listAgentChats } from "./agentChatsApi";

function reply(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

beforeEach(() => h.fetch.mockReset());

describe("listAgentChats", () => {
  it("reads the agent's threads, newest first, in the popover's shape", async () => {
    h.fetch.mockResolvedValue(
      reply(200, {
        threads: [
          { id: "old", title: "Old", last_message_at: "2026-10-01T00:00:00Z", last_message: "a\n b" },
          { id: "new", title: null, last_message_at: "2026-10-16T00:00:00Z", last_message: null },
        ],
      }),
    );
    const rows = await listAgentChats("cgo");
    expect(h.fetch).toHaveBeenCalledWith("/api/agents/cgo/threads");
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(rows[1]).toMatchObject({ title: "Old", preview: "a b", card_title: null });
  });

  it("keeps the from-Home mark on a cgo row and adds nothing to the others", async () => {
    h.fetch.mockResolvedValue(
      reply(200, {
        threads: [
          { id: "home", title: "Q", last_message_at: "2026-10-20T00:00:00Z", last_message: null, from_home: true },
          { id: "own", title: "R", last_message_at: "2026-10-19T00:00:00Z", last_message: null },
        ],
      }),
    );
    const rows = await listAgentChats("cgo");
    expect(rows[0].from_home).toBe(true);
    expect("from_home" in rows[1]).toBe(false);
  });

  it("throws on a failed response", async () => {
    h.fetch.mockResolvedValue(reply(500, { error: { message: "rpc_failed" } }));
    await expect(listAgentChats("cgo")).rejects.toThrow("rpc_failed");
  });
});
