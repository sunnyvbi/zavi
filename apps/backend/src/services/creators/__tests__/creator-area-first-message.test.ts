
import { beforeEach, describe, expect, it, vi } from "vitest";

const thread = vi.hoisted(() => ({
  ensureCreatorThread: vi.fn(),
  postCreatorThreadMessage: vi.fn(),
}));
vi.mock("../thread", () => thread);

vi.mock("@/services/tenant-client", () => {
  const q: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "order", "limit"]) q[m] = () => q;
  q.maybeSingle = async () => ({ data: null, error: null });
  return { creatorAreaClient: () => q, globalClient: () => q };
});

import { postCreatorThreadMessage } from "../creator-area";
import type { CreatorAreaOrderRow } from "../creator-area";

const order = (status: string) =>
  ({
    id: "o1",
    tenant_id: "11111111-1111-1111-1111-111111111111",
    human_member_id: "33333333-3333-3333-3333-333333333333",
    thread_id: null,
    status,
  }) as unknown as CreatorAreaOrderRow;

beforeEach(() => {
  thread.ensureCreatorThread.mockReset().mockResolvedValue({ id: "t1" });
  thread.postCreatorThreadMessage
    .mockReset()
    .mockResolvedValue({ id: "m1", sender_kind: "creator", body: "Hi", created_at: "" });
});

describe("a creator's first message on an accepted job", () => {
  it("opens the pair's thread from the order row, then posts", async () => {
    await postCreatorThreadMessage(order("in_progress"), "Hi", "u1");
    expect(thread.ensureCreatorThread).toHaveBeenCalledWith({
      tenant_id: "11111111-1111-1111-1111-111111111111",
      human_member_id: "33333333-3333-3333-3333-333333333333",
      started_by: "creator",
      started_by_user_id: "u1",
    });
    expect(thread.postCreatorThreadMessage.mock.calls[0][0].access.thread_id).toBe("t1");
  });

  it("does not open a thread before the creator accepts", async () => {
    await expect(postCreatorThreadMessage(order("awaiting_acceptance"), "Hi", "u1")).rejects.toMatchObject({
      code: "no_thread",
    });
    expect(thread.ensureCreatorThread).not.toHaveBeenCalled();
    expect(thread.postCreatorThreadMessage).not.toHaveBeenCalled();
  });
});
