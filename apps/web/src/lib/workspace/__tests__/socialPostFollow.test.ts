// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workspace/socialPostWatch", () => ({ watchSocialPost: vi.fn() }));

import { watchSocialPost } from "../socialPostWatch";

import {
  followSocialPost,
  pendingSocialPosts,
  rememberSocialPost,
  SOCIAL_POST_PENDING_TTL_MS,
  socialPostFollowActive,
  socialPostNotice,
} from "../socialPostFollow";

beforeEach(() => window.localStorage.clear());

describe("durable social-post reconciliation", () => {
  it("passes the platform through to the real default watcher", async () => {
    vi.mocked(watchSocialPost).mockResolvedValueOnce({ state: "failed", message: "Instagram did not accept it." });
    await expect(followSocialPost("ig", "Instagram", "tenant-a")).resolves.toEqual({ state: "failed", message: "Instagram did not accept it." });
    expect(watchSocialPost).toHaveBeenCalledWith("ig", undefined, { platform: "Instagram" });
  });
  it("keeps a slow post for this tenant and clears it only after a terminal answer", async () => {
    const slow = vi.fn(async () => ({ state: "slow" as const }));
    await followSocialPost("d1", "Pinterest", "tenant-a", slow);
    expect(pendingSocialPosts("tenant-a")).toEqual([
      expect.objectContaining({ decisionId: "d1", platform: "Pinterest", attempts: 1 }),
    ]);
    expect(pendingSocialPosts("tenant-b")).toEqual([]);

    const posted = vi.fn(async () => ({ state: "posted" as const, url: null }));
    await followSocialPost("d1", "Pinterest", "tenant-a", posted);
    expect(pendingSocialPosts("tenant-a")).toEqual([]);
  });

  it("deduplicates a post and ignores malformed stored state", () => {
    rememberSocialPost("tenant-a", { decisionId: "d1", platform: "Pinterest" });
    rememberSocialPost("tenant-a", { decisionId: "d1", platform: "Pinterest" });
    expect(pendingSocialPosts("tenant-a")).toHaveLength(1);
    window.localStorage.setItem("zavi:pending-social-posts:tenant-b", "not json");
    expect(pendingSocialPosts("tenant-b")).toEqual([]);
  });

  it("expires stale records and stops resuming after three slow watches", async () => {
    window.localStorage.setItem(
      "zavi:pending-social-posts:tenant-a",
      JSON.stringify([{ decisionId: "old", platform: "Pinterest", attempts: 0, expiresAt: Date.now() - 1 }]),
    );
    expect(pendingSocialPosts("tenant-a")).toEqual([]);
    expect(window.localStorage.getItem("zavi:pending-social-posts:tenant-a")).toBeNull();

    const slow = vi.fn(async () => ({ state: "slow" as const }));
    await followSocialPost("d1", "Pinterest", "tenant-a", slow);
    await followSocialPost("d1", "Pinterest", "tenant-a", slow);
    await followSocialPost("d1", "Pinterest", "tenant-a", slow);
    expect(slow).toHaveBeenCalledTimes(3);
    expect(pendingSocialPosts("tenant-a")).toEqual([]);
  });

  it("gives a new pending post a bounded lifetime", () => {
    const before = Date.now();
    rememberSocialPost("tenant-a", { decisionId: "d1", platform: "Pinterest" });
    const [post] = pendingSocialPosts("tenant-a");
    expect(post.expiresAt).toBeGreaterThanOrEqual(before + SOCIAL_POST_PENDING_TTL_MS);
  });

  it("shares one active poll for the same tenant and decision", async () => {
    let finish: (value: { state: "posted"; url: null }) => void = () => {};
    const watch = vi.fn(() => new Promise<{ state: "posted"; url: null }>((resolve) => (finish = resolve)));
    const first = followSocialPost("d1", "Pinterest", "tenant-a", watch);
    const second = followSocialPost("d1", "Pinterest", "tenant-a", watch);
    expect(socialPostFollowActive("tenant-a", "d1")).toBe(true);
    expect(watch).toHaveBeenCalledTimes(1);
    finish({ state: "posted", url: null });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { state: "posted", url: null },
      { state: "posted", url: null },
    ]);
    expect(socialPostFollowActive("tenant-a", "d1")).toBe(false);
  });

  it("uses the same slow copy for every surface", () => {
    expect(socialPostNotice({ state: "slow" }, "Pinterest")).toMatchObject({
      type: "info",
      title: "Still posting to Pinterest",
      description: expect.stringMatching(/check again/),
    });
  });

  it("distinguishes a retryable approval from an uncertain enqueue and a future schedule", () => {
    expect(socialPostNotice({ state: "approval_uncertain" }, "Pinterest")).toMatchObject({ title: "Could not confirm approval" });
    expect(socialPostNotice({ state: "uncertain", message: "Check first." }, "Pinterest")).toMatchObject({
      type: "info",
      title: "Pinterest outcome uncertain",
      description: "Check first.",
    });
    expect(socialPostNotice({ state: "scheduled", scheduledAt: "2099-01-02T09:30:00.000Z" }, "Pinterest")).toMatchObject({
      type: "success",
      title: "Scheduled for Pinterest",
    });
  });
});

it("reports partial X publication without success wording or another root-post attempt", async () => {
  const out = { state: "partial" as const, url: "https://x.com/company/status/1", publishedParts: 1, totalParts: 3, message: "Only 1 of 3 posts published. Do not repost the whole thread." };
  const watch = vi.fn(async () => out);
  await followSocialPost("partial-x", "X", "tenant-a", watch);
  expect(socialPostNotice(out, "X")).toMatchObject({ type: "info", title: "X thread partly posted", description: out.message });
  expect(pendingSocialPosts("tenant-a")).toEqual([]);
  expect(watch).toHaveBeenCalledTimes(1);
});
