// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyPostAndOpenComposer, copyReplyAndOpenThread, redditSubmitUrl, replyPasteHint } from "./handoff";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redditSubmitUrl", () => {
  it("opens the subreddit's text post form with no pre-fill params", () => {
    const u = new URL(redditSubmitUrl("r/SaaS"));
    expect(u.origin + u.pathname).toBe("https://www.reddit.com/r/SaaS/submit");
    expect([...u.searchParams.keys()]).toEqual(["type"]);
  });
});

describe("handoffs", () => {
  it("opens the thread synchronously, before the clipboard write settles", async () => {
    let resolveCopy: () => void = () => undefined;
    const writeText = vi.fn(() => new Promise<void>((r) => (resolveCopy = r)));
    Object.assign(navigator, { clipboard: { writeText } });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const pending = copyReplyAndOpenThread("https://www.reddit.com/r/x/comments/abc/", "my reply");
    expect(openSpy).toHaveBeenCalledWith("https://www.reddit.com/r/x/comments/abc/", "_blank", "noopener,noreferrer");
    expect(writeText).toHaveBeenCalledWith("my reply");
    resolveCopy();
    expect(await pending).toEqual({ copied: true, opened: true });
  });

  it("reports opened=false only when window.open throws", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
    vi.spyOn(window, "open").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(await copyReplyAndOpenThread("https://www.reddit.com/r/x/comments/abc/", "r")).toEqual({
      copied: true,
      opened: false,
    });
  });

  it("still opens the post page when the clipboard is blocked", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const r = await copyPostAndOpenComposer("saas", "Body");
    expect(r).toEqual({ copied: false, opened: true });
    expect(String(openSpy.mock.calls[0][0])).toBe("https://www.reddit.com/r/saas/submit?type=TEXT");
  });
});

describe("replyPasteHint", () => {
  it("never claims the thread is open (a popup blocker is undetectable)", () => {
    for (const copied of [true, false]) {
      const hint = replyPasteHint(copied);
      expect(hint).toMatch(/Opening the thread…/);
      expect(hint).not.toMatch(/is open/);
    }
  });
});
