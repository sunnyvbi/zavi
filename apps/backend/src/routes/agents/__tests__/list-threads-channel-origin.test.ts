import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serverClientFromBearer: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/agents/run-display-state", () => ({ presentationStatus: vi.fn() }));
vi.mock("@/services/agents/thread-unread", () => ({ attachThreadUnread: vi.fn() }));

import { attachChannelOrigin } from "../list-threads";

function fakeClient(result: { data: unknown; error: unknown }) {
  const inFn = vi.fn().mockResolvedValue(result);
  const select = vi.fn(() => ({ in: inFn }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as never, from, inFn };
}

describe("attachChannelOrigin", () => {
  it("labels each thread with the channel it was started from and whether an email conversation made it", async () => {
    const { client, from, inFn } = fakeClient({
      data: [
        { id: "t1", channel_slug: "reddit_organic", channel_action_id: "a1" },
        { id: "t2", channel_slug: null, channel_action_id: null, email_thread_id: "et-9" },
      ],
      error: null,
    });
    const out = await attachChannelOrigin(client, [{ id: "t1" }, { id: "t2" }, { id: "t3" }]);
    expect(from).toHaveBeenCalledWith("agent_threads");
    expect(inFn).toHaveBeenCalledWith("id", ["t1", "t2", "t3"]);
    expect(out).toEqual([
      { id: "t1", channel_slug: "reddit_organic", channel_action_id: "a1", from_email: false },
      { id: "t2", channel_slug: null, channel_action_id: null, from_email: true },
      { id: "t3", channel_slug: null, channel_action_id: null, from_email: false },
    ]);
  });

  it("a failed read leaves every label off instead of failing the list", async () => {
    const { client } = fakeClient({ data: null, error: { message: "boom" } });
    expect(await attachChannelOrigin(client, [{ id: "t1" }])).toEqual([{ id: "t1", channel_slug: null, channel_action_id: null, from_email: false }]);
  });

  it("reads nothing for an empty list", async () => {
    const { client, from } = fakeClient({ data: [], error: null });
    expect(await attachChannelOrigin(client, [])).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });
});
