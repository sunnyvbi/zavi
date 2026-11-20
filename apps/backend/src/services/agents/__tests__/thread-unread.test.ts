import { describe, expect, it, vi } from "vitest";
import { attachThreadUnread } from "../thread-unread";

type Marker = { thread_id: string; seen_at: string };
type Latest = { thread_id: string; created_at: string; body_head: string | null; is_question: boolean | null };

function fakeSupabase(
  markers: Marker[] | null,
  latest: Latest[] | null,
  rpcError: { message: string } | null = null,
  markerError: { message: string } | null = null,
) {
  const rpc = vi.fn(async () => ({ data: latest, error: rpcError }));
  const client = {
    from: () => ({ select: () => ({ in: async () => ({ data: markers, error: markerError }) }) }),
    rpc,
  };
  return { client: client as never, rpc };
}

const T1 = "2026-10-24T10:00:00.123456+00:00";
const T2 = "2026-10-24T10:00:00.123789+00:00";

describe("attachThreadUnread", () => {
  it("marks a thread unread with its newest reply when no seen marker exists", async () => {
    const { client, rpc } = fakeSupabase([], [
      { thread_id: "a", created_at: T1, body_head: "## Done\n41 bookings.", is_question: false },
    ]);
    const out = await attachThreadUnread(client, [{ id: "a", last_message_at: T1 }]);
    expect(rpc).toHaveBeenCalledWith("latest_assistant_messages", { p_thread_ids: ["a"] });
    expect(out[0]).toMatchObject({ unread: true, unread_reply: { head: "## Done\n41 bookings.", kind: "reply", at: T1 } });
  });

  it("flags a clarifying-questions reply as a question", async () => {
    const { client } = fakeSupabase([], [{ thread_id: "a", created_at: T1, body_head: "Which city?", is_question: true }]);
    const [row] = await attachThreadUnread(client, [{ id: "a", last_message_at: T1 }]);
    expect(row.unread_reply?.kind).toBe("question");
  });

  it("keeps microsecond order: a reply 0.3ms after the seen marker is still unread", async () => {
    const { client } = fakeSupabase([{ thread_id: "a", seen_at: T1 }], [
      { thread_id: "a", created_at: T2, body_head: "later", is_question: false },
    ]);
    const [row] = await attachThreadUnread(client, [{ id: "a", last_message_at: T2 }]);
    expect(row.unread).toBe(true);
  });

  it("is read when the newest assistant message is not after the marker (user wrote last)", async () => {
    const { client, rpc } = fakeSupabase([{ thread_id: "a", seen_at: T2 }], [
      { thread_id: "a", created_at: T1, body_head: "old", is_question: false },
    ]);
    const [row] = await attachThreadUnread(client, [{ id: "a", last_message_at: "2026-10-24T11:00:00+00:00" }]);
    expect(rpc).toHaveBeenCalled();
    expect(row).toMatchObject({ unread: false, unread_reply: null });
  });

  it("skips the read entirely when nothing moved since the marker", async () => {
    const { client, rpc } = fakeSupabase([{ thread_id: "a", seen_at: T2 }], []);
    const [row] = await attachThreadUnread(client, [{ id: "a", last_message_at: T1 }]);
    expect(rpc).not.toHaveBeenCalled();
    expect(row.unread).toBe(false);
  });

  it("fails quiet (no unread) when the read errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = fakeSupabase([], null, { message: "boom" });
    const [row] = await attachThreadUnread(client, [{ id: "a", last_message_at: T1 }]);
    expect(row).toMatchObject({ unread: false, unread_reply: null });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never resurrects old replies when the seen-marker read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, rpc } = fakeSupabase(null, [{ thread_id: "a", created_at: T1, body_head: "old", is_question: true }], null, {
      message: "timeout",
    });
    const [row] = await attachThreadUnread(client, [{ id: "a", last_message_at: T1 }]);
    expect(row).toMatchObject({ unread: false, unread_reply: null });
    expect(rpc).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
