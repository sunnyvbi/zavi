import { beforeEach, describe, expect, it, vi } from "vitest";

const t = vi.hoisted(() => ({ add: vi.fn(() => "toast-1"), update: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ toast: { add: t.add, update: t.update, close: vi.fn(), promise: vi.fn() } }));
vi.mock("@/lib/workspace/socialPostWatch", () => ({ watchSocialPost: vi.fn() }));

import { watchSocialPost } from "@/lib/workspace/socialPostWatch";
import { followPostInToast } from "../postToast";

beforeEach(() => {
  t.add.mockClear();
  t.update.mockClear();
});

describe("followPostInToast", () => {
  it("resumes Instagram with its own watcher label and an Open post receipt", async () => {
    vi.mocked(watchSocialPost).mockResolvedValueOnce({ state: "posted", url: "https://www.instagram.com/p/receipt/" });
    await followPostInToast("ig", "Instagram");
    expect(watchSocialPost).toHaveBeenCalledWith("ig", undefined, { platform: "Instagram" });
    expect(t.update.mock.calls[0][1]).toMatchObject({ title: "Posted to Instagram", actionProps: { children: "Open post" } });
  });
  it("shows a loading popup that stays until the post settles, then turns it into Posted with an Open pin action", async () => {
    await followPostInToast("d1", "Pinterest", async () => ({ state: "posted", url: "https://www.pinterest.com/pin/9/" }));
    expect(t.add).toHaveBeenCalledWith({ type: "loading", title: "Posting to Pinterest…", timeout: 0, dismissible: false });
    const [id, opts] = t.update.mock.calls[0] as unknown as [string, { type: string; title: string; actionProps?: { children: string } }];
    expect(id).toBe("toast-1");
    expect(opts).toMatchObject({ type: "success", title: "Posted to Pinterest" });
    expect(opts.actionProps?.children).toBe("Open pin");
  });

  it("turns the same popup into the failure with its reason, never a success", async () => {
    await followPostInToast("d1", "Pinterest", async () => ({ state: "failed", message: "Pinterest did not accept it. Board not found." }));
    expect(t.update).toHaveBeenCalledTimes(1);
    expect(t.update.mock.calls[0][1]).toMatchObject({ type: "error", title: "Couldn't post to Pinterest", description: "Pinterest did not accept it. Board not found." });
  });

  it("a slow answer says still posting, never failed", async () => {
    await followPostInToast("d1", "Pinterest", async () => ({ state: "slow" }));
    expect(t.update.mock.calls[0][1]).toMatchObject({ type: "info", title: "Still posting to Pinterest" });
  });

  it("turns a future post into a scheduled confirmation instead of a posting timeout", async () => {
    await followPostInToast("d1", "Pinterest", async () => ({ state: "scheduled", scheduledAt: "2099-01-02T09:30:00.000Z" }));
    expect(t.update.mock.calls[0][1]).toMatchObject({ type: "success", title: "Scheduled for Pinterest" });
  });
});


it("keeps an Open post action on the partial-thread warning", async () => {
  await followPostInToast("x-partial", "X", async () => ({ state: "partial", url: "https://x.com/company/status/1", publishedParts: 1, totalParts: 3, message: "Only 1 of 3 posts published. Do not repost the whole thread." }));
  expect(t.update.mock.calls[0][1]).toMatchObject({ type: "info", title: "X thread partly posted", actionProps: { children: "Open post" } });
});
