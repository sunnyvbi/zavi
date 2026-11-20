import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/lib/api";
import { send } from "./shared";

const conflict = (body: unknown) =>
  ({ ok: false, status: 409, json: async () => body }) as unknown as Response;

describe("send() on a 409", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("tells the founder the competitor list is full instead of 'Already saved.'", async () => {
    const message = "Your company record already lists 20 competitors. Remove one first.";
    vi.mocked(apiFetch).mockResolvedValue(conflict({ error: "competitor_list_full", message }));

    expect(await send("/api/reddit/workspace/competitors", "POST", { name: "Goldbelly" })).toBe(message);
  });

  it("says a thread was already replied to rather than a generic save error", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      conflict({ error: "already_posted", message: "You already replied on this thread, so Zavi kept that reply." }),
    );

    expect(await send("/api/reddit/threads/t1/draft", "POST")).toMatch(/already replied/);
  });

  it("keeps 'Already saved.' for a real duplicate and for a body it cannot read", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(conflict({ error: "already_exists" }));
    expect(await send("/api/reddit/workspace/keywords", "POST", { term: "cake" })).toBe("Already saved.");

    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: false, status: 409, json: async () => { throw new Error("html"); } } as unknown as Response);
    expect(await send("/api/reddit/workspace/keywords", "POST", { term: "cake" })).toBe("Already saved.");
  });
});

describe("send() and a draft request on a 403", () => {
  const res = (status: number, body: unknown) => {
    const r = { ok: false, status, json: async () => body, clone: () => r };
    return r as unknown as Response;
  };
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("says only an owner or admin can change it when the server gives no reason", async () => {
    vi.mocked(apiFetch).mockResolvedValue(res(403, {}));
    expect(await send("/api/reddit/workspace/keywords", "POST", { term: "cake" })).toBe("Only an owner or an admin can change this.");
  });

  it("uses the server's own sentence, top-level or nested", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(res(403, { message: "Reddit needs the Starter plan ($20/mo)." }));
    expect(await send("/api/reddit/workspace/keywords", "POST", { term: "cake" })).toBe("Reddit needs the Starter plan ($20/mo).");
    vi.mocked(apiFetch).mockResolvedValueOnce(res(403, { error: { code: "forbidden", message: "Members cannot edit keywords." } }));
    expect(await send("/api/reddit/workspace/keywords", "POST", { term: "cake" })).toBe("Members cannot edit keywords.");
    vi.mocked(apiFetch).mockResolvedValueOnce(res(403, { message: "   " }));
    expect(await send("/api/reddit/workspace/keywords", "POST", { term: "cake" })).toBe("Only an owner or an admin can change this.");
  });

  it.each([
    [429, {}, "You've drafted a lot this hour. Try again later."],
    [404, {}, "This thread is no longer available."],
    [409, {}, "You already replied on this thread, so Zavi kept that reply."],
    [409, { error: { message: "A draft is already being written." } }, "A draft is already being written."],
    [403, {}, "Only an owner or an admin can change this."],
    [500, { message: "ignored" }, "Couldn't draft a reply. Try again in a moment."],
  ])("a draft refused with %i %j says %j", async (status, body, line) => {
    const { draftErrorMessage, requestReplyDraft } = await import("./shared");
    expect(await draftErrorMessage(res(status, body))).toBe(line);
    vi.mocked(apiFetch).mockResolvedValueOnce(res(status, body));
    expect(await requestReplyDraft("t3 abc")).toBe(line);
    expect(vi.mocked(apiFetch).mock.calls.at(-1)?.[0]).toBe("/api/reddit/threads/t3%20abc/draft");
  });

  it("returns null for a draft that landed and names a dropped connection", async () => {
    const { requestReplyDraft } = await import("./shared");
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    expect(await requestReplyDraft("t1")).toBeNull();
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("offline"));
    expect(await requestReplyDraft("t1")).toBe("Couldn't reach Zavi. Check your connection.");
  });
});
