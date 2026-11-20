// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { VideoLibrary } from "./VideoLibrary";
import { forgetPostTargets } from "./PostDialog";
import type { GalleryVideo } from "./types";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

const NOW = Date.parse("2026-10-26T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const VIDEOS: GalleryVideo[] = [
  { artifact_id: "art-3d", filename: "talking_head-3fa9c2b1.mp4", created_at: daysAgo(3), source: "chat", thread_id: "th-a" },
  { artifact_id: "art-20d", filename: "hook.mp4", created_at: daysAgo(20), source: "card", thread_id: null },
  { artifact_id: "art-60d", filename: "summer.mp4", created_at: daysAgo(60), source: "chat", thread_id: "th-b" },
  { artifact_id: "art-200d", filename: null, created_at: daysAgo(200), source: "card", thread_id: null },
];

const assign = vi.fn();

beforeEach(() => {
  forgetPostTargets();
  apiFetch.mockReset();
  assign.mockReset();
  apiFetch.mockImplementation(async (path: string) =>
    path.includes("download=1") ? res({ signed_url: `https://cdn.example/dl/${path.split("/")[3]}` }) : res({ signed_url: `https://cdn.example/${path.split("/")[3]}.mp4` }),
  );
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign } });
});
afterEach(() => cleanup());

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

const cards = () => screen.queryAllByTestId("video-library-item");
describe("VideoLibrary", () => {
  it("lists every video however old, with no period menu, and the count matches", async () => {
    render(<VideoLibrary videos={VIDEOS} error={null} now={() => NOW} onRefresh={() => {}} />);
    await flush();
    expect(cards().map((c) => c.querySelector("h3")?.textContent)).toEqual(["Talking head video", "hook", "summer", "Video"]);
    expect(screen.getByTestId("video-library-count").textContent).toBe("4");
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(screen.queryByText(/Last \d+ days|All time/)).toBeNull();
    expect(screen.getByTestId("video-library-refresh")).toBeTruthy();
  });

  it("a date in this year drops the year and an older one keeps it", async () => {
    const lastYear = { ...VIDEOS[1], artifact_id: "art-old", created_at: "2025-12-01T12:00:00Z" };
    render(<VideoLibrary videos={[VIDEOS[0], lastYear]} error={null} now={() => NOW} />);
    await flush();
    const [recent, old] = cards().map((c) => c.querySelector("p")?.textContent ?? "");
    expect(recent).toBe(new Date(daysAgo(3)).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    expect(recent).not.toContain("2026");
    expect(old).toContain("2025");
  });

  it("each unposted card is marked Ready and named for screen readers, and no card offers Open ad even with a chat to open", async () => {
    const onOpenChat = vi.fn();
    render(<VideoLibrary videos={VIDEOS} error={null} now={() => NOW} onOpenChat={onOpenChat} />);
    await flush();
    expect(screen.getAllByTestId("video-library-status").map((s) => s.textContent)).toEqual(["Ready", "Ready", "Ready", "Ready"]);
    expect(cards()[0].getAttribute("aria-label")).toBe("Talking head video: Ready");
    expect(document.body.textContent).not.toMatch(/Made in chat|From a channel card/);
    expect(screen.queryAllByRole("button", { name: /open ad/i })).toHaveLength(0);
    expect(onOpenChat).not.toHaveBeenCalled();
  });

  it("each card offers Play, Download and Post, with no Coming soon tag", async () => {
    render(<VideoLibrary videos={VIDEOS.slice(0, 2)} error={null} now={() => NOW} onOpenChat={vi.fn()} />);
    await flush();
    expect(document.body.textContent).not.toContain("Coming soon");
    for (const c of cards()) expect(within(c).getAllByRole("button").map((x) => x.getAttribute("aria-label")?.split(" ")[0])).toEqual(["Play", "Download", "Post"]);
  });

  it("the Post button carries the paper-plane icon like Download does, hidden from screen readers, and is still named Post <name>", async () => {
    render(<VideoLibrary videos={VIDEOS.slice(0, 1)} error={null} now={() => NOW} onOpenChat={vi.fn()} />);
    await flush();
    const post = screen.getByTestId("video-library-post");
    const icon = post.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("aria-hidden")).toBe("true");
    expect(post.textContent).toBe("Post");
    expect(screen.getByRole("button", { name: "Post Talking head video" })).toBe(post);
    expect(icon!.querySelector("path")!.getAttribute("d")!.length).toBe(2760);
  });

  it("the status badge names every channel the server says the video went out on, in channel order, ignoring names it does not know, with no separate chip", async () => {
    const posted = { ...VIDEOS[0], posted_on: ["youtube", "instagram", "myspace"] };
    render(<VideoLibrary videos={[posted, VIDEOS[1]]} error={null} now={() => NOW} />);
    await flush();
    const [a, b] = cards();
    expect(within(a).getByTestId("video-library-status").textContent).toBe("Posted on Instagram and YouTube");
    expect(a.getAttribute("aria-label")).toBe("Talking head video: Posted on Instagram and YouTube");
    expect(within(b).getByTestId("video-library-status").textContent).toBe("Ready");
    expect(screen.queryAllByTestId("video-library-posted")).toHaveLength(0);
  });

  it("one LinkedIn post replaces Ready with Posted on LinkedIn, and a live one still going out says Posting", async () => {
    const done = { ...VIDEOS[0], posted_on: ["linkedin"] };
    const going = { ...VIDEOS[1], posting_on: ["linkedin"] };
    const both = { ...VIDEOS[2], posted_on: ["instagram"], posting_on: ["linkedin", "instagram"] };
    render(<VideoLibrary videos={[done, going, both]} error={null} now={() => NOW} />);
    await flush();
    expect(screen.getAllByTestId("video-library-status").map((s) => s.textContent)).toEqual([
      "Posted on LinkedIn",
      "Posting to LinkedIn…",
      "Posted on Instagram, posting to LinkedIn…",
    ]);
    expect(cards()[1].getAttribute("aria-label")).toBe("hook: Posting to LinkedIn…");
  });

  it("says a TikTok post is private, because an unaudited TikTok app can only post videos only the creator can see", async () => {
    const one = { ...VIDEOS[0], posted_on: ["tiktok"] };
    const two = { ...VIDEOS[1], posted_on: ["tiktok", "instagram"] };
    render(<VideoLibrary videos={[one, two]} error={null} now={() => NOW} />);
    await flush();
    const [a, b] = screen.getAllByTestId("video-library-status");
    expect(a.textContent).toBe("Posted privately on TikTok (only you can see it)");
    expect(b.textContent).toBe("Posted on Instagram and TikTok (private)");
    expect(document.body.textContent).not.toContain("Posted on TikTok");
    expect(a.className.split(/\s+/)).not.toContain("truncate");
    expect(a.className.split(/\s+/)).not.toContain("whitespace-nowrap");
  });

  it("loads the channels as soon as the library has a video, once, so Post opens with them already there and no loader", async () => {
    const targets = [
      { name: "linkedin", label: "LinkedIn", status: "connected" },
      { name: "instagram", label: "Instagram", status: "connected" },
    ];
    apiFetch.mockImplementation(async (path: string) => (path.endsWith("/post-targets") ? res({ targets }) : res({ signed_url: "https://cdn.example/v.mp4" })));
    render(<VideoLibrary videos={VIDEOS.slice(0, 2)} error={null} now={() => NOW} />);
    await flush();
    const loads = () => apiFetch.mock.calls.filter(([p]) => String(p).endsWith("/post-targets")).length;
    expect(loads()).toBe(1);
    fireEvent.click(within(cards()[0]).getByTestId("video-library-post"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).not.toContain("Loading your channels");
    expect(within(dialog).queryByRole("status")).toBeNull();
    expect(within(dialog).getByTestId("video-post-row-linkedin")).toBeTruthy();
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(2);
  });

  it("an empty library fetches no channels", async () => {
    render(<VideoLibrary videos={[]} error={null} now={() => NOW} />);
    await flush();
    expect(apiFetch.mock.calls.filter(([p]) => String(p).endsWith("/post-targets"))).toHaveLength(0);
  });

  it("a background channel refresh that fails keeps the loaded channels instead of showing an error", async () => {
    const targets = [{ name: "linkedin", label: "LinkedIn", status: "connected" }];
    let fail = false;
    apiFetch.mockImplementation(async (path: string) => {
      if (!path.endsWith("/post-targets")) return res({ signed_url: "https://cdn.example/v.mp4" });
      return fail ? res({ error: { message: "boom" } }, 500) : res({ targets });
    });
    render(<VideoLibrary videos={VIDEOS.slice(0, 1)} error={null} now={() => NOW} />);
    await flush();
    fail = true;
    fireEvent.click(screen.getByTestId("video-library-post"));
    await flush();
    const dialog = screen.getByRole("dialog");
    expect(apiFetch.mock.calls.filter(([p]) => String(p).endsWith("/post-targets")).length).toBe(2);
    expect(within(dialog).getByTestId("video-post-row-linkedin")).toBeTruthy();
    expect(dialog.textContent).not.toContain("could not be loaded");
    expect(dialog.textContent).not.toContain("boom");
  });

  it("after a post the card polls the library until the server says it went out, then shows Posted on and stops polling", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    try {
      apiFetch.mockImplementation(async (path: string, opts?: { method?: string; body?: string }) => {
        if (path.endsWith("/post-targets")) return res({ targets: [{ name: "linkedin", label: "LinkedIn", status: "connected" }] });
        if (opts?.method === "POST") return res({ results: [{ name: "linkedin", status: "posted" }] });
        return res({ signed_url: "https://cdn.example/v.mp4" });
      });
      let server: GalleryVideo[] = [{ ...VIDEOS[0], posting_on: ["linkedin"] }];
      const onRefresh = vi.fn(async () => {
        view.rerender(<VideoLibrary videos={server} error={null} now={() => NOW} onRefresh={onRefresh} />);
      });
      const view = render(<VideoLibrary videos={VIDEOS.slice(0, 1)} error={null} now={() => NOW} onRefresh={onRefresh} />);
      await flush();
      const status = () => screen.getByTestId("video-library-status").textContent;
      expect(onRefresh).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("video-library-post"));
      fireEvent.click(within(screen.getByTestId("video-post-row-linkedin")).getByRole("checkbox"));
      fireEvent.click(screen.getByTestId("video-post-submit"));
      await flush();
      expect(status()).toBe("Posting to LinkedIn…");
      await act(async () => void vi.advanceTimersByTime(5000));
      await flush();
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(status()).toBe("Posting to LinkedIn…");
      server = [{ ...VIDEOS[0], posted_on: ["linkedin"] }];
      await act(async () => void vi.advanceTimersByTime(5000));
      await flush();
      expect(onRefresh).toHaveBeenCalledTimes(2);
      expect(status()).toBe("Posted on LinkedIn");
      expect(cards()[0].getAttribute("aria-label")).toBe("Talking head video: Posted on LinkedIn");
      await act(async () => void vi.advanceTimersByTime(60_000));
      await flush();
      expect(onRefresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a just-posted card stays posting when a library read comes back without post states, until the server lists the channel", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    try {
      apiFetch.mockImplementation(async (path: string, opts?: { method?: string; body?: string }) => {
        if (path.endsWith("/post-targets")) return res({ targets: [{ name: "linkedin", label: "LinkedIn", status: "connected" }] });
        if (opts?.method === "POST") return res({ results: [{ name: "linkedin", status: "posted" }] });
        return res({ signed_url: "https://cdn.example/v.mp4" });
      });
      let server: GalleryVideo[] = [{ ...VIDEOS[0] }];
      const onRefresh = vi.fn(async () => {
        view.rerender(<VideoLibrary videos={server.map((v) => ({ ...v }))} error={null} now={() => NOW} onRefresh={onRefresh} />);
      });
      const view = render(<VideoLibrary videos={VIDEOS.slice(0, 1)} error={null} now={() => NOW} onRefresh={onRefresh} />);
      await flush();
      const status = () => screen.getByTestId("video-library-status").textContent;
      fireEvent.click(screen.getByTestId("video-library-post"));
      fireEvent.click(within(screen.getByTestId("video-post-row-linkedin")).getByRole("checkbox"));
      fireEvent.click(screen.getByTestId("video-post-submit"));
      await flush();
      expect(status()).toBe("Posting to LinkedIn…");
      await act(async () => void vi.advanceTimersByTime(5000));
      await flush();
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(status()).toBe("Posting to LinkedIn…");
      expect(cards()[0].getAttribute("aria-label")).toBe("Talking head video: Posting to LinkedIn…");
      server = [{ ...VIDEOS[0], posted_on: ["linkedin"] }];
      await act(async () => void vi.advanceTimersByTime(5000));
      await flush();
      expect(status()).toBe("Posted on LinkedIn");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a card stuck posting stops polling after ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    try {
      const stuck = [{ ...VIDEOS[0], posting_on: ["linkedin"] }];
      const onRefresh = vi.fn(async () => {
        view.rerender(<VideoLibrary videos={[{ ...stuck[0] }]} error={null} now={() => NOW} onRefresh={onRefresh} />);
      });
      const view = render(<VideoLibrary videos={stuck} error={null} now={() => NOW} onRefresh={onRefresh} />);
      await flush();
      for (let i = 0; i < 160; i++) {
        await act(async () => void vi.advanceTimersByTime(5000));
        await flush();
      }
      expect(onRefresh.mock.calls.length).toBeGreaterThanOrEqual(115);
      expect(onRefresh.mock.calls.length).toBeLessThanOrEqual(125);
      expect(screen.getByTestId("video-library-status").textContent).toBe("Posting to LinkedIn…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling a TikTok post past two minutes and shows Posted on once the server confirms it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    try {
      let server: GalleryVideo[] = [{ ...VIDEOS[0], posting_on: ["tiktok"] }];
      const onRefresh = vi.fn(async () => {
        view.rerender(<VideoLibrary videos={server} error={null} now={() => NOW} onRefresh={onRefresh} />);
      });
      const view = render(<VideoLibrary videos={server} error={null} now={() => NOW} onRefresh={onRefresh} />);
      await flush();
      for (let i = 0; i < 50; i++) {
        await act(async () => void vi.advanceTimersByTime(5000));
        await flush();
      }
      const calls = onRefresh.mock.calls.length;
      expect(calls).toBeGreaterThanOrEqual(49);
      expect(screen.getByTestId("video-library-status").textContent).toMatch(/^Posting to TikTok/);
      server = [{ ...VIDEOS[0], posted_on: ["tiktok"] }];
      await act(async () => void vi.advanceTimersByTime(5000));
      await flush();
      expect(screen.getByTestId("video-library-status").textContent).toMatch(/^Posted privately on TikTok/);
      const settled = onRefresh.mock.calls.length;
      await act(async () => void vi.advanceTimersByTime(60_000));
      await flush();
      expect(onRefresh.mock.calls.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Refresh after the watch window ran out starts watching a post the server still lists as posting", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    try {
      const stuck = [{ ...VIDEOS[0], posting_on: ["linkedin"] }];
      const poll = vi.fn(async () => {
        view.rerender(<VideoLibrary videos={[{ ...stuck[0] }]} error={null} now={() => NOW} onRefresh={poll} />);
      });
      const view = render(<VideoLibrary videos={stuck} error={null} now={() => NOW} onRefresh={poll} />);
      await flush();
      for (let i = 0; i < 125; i++) {
        await act(async () => void vi.advanceTimersByTime(5000));
        await flush();
      }
      const before = poll.mock.calls.length;
      await act(async () => void vi.advanceTimersByTime(30_000));
      await flush();
      expect(poll.mock.calls.length).toBe(before);
      await act(async () => fireEvent.click(screen.getByTestId("video-library-refresh")));
      await flush();
      expect(poll.mock.calls.length).toBe(before + 1);
      await act(async () => void vi.advanceTimersByTime(5000));
      await flush();
      expect(poll.mock.calls.length).toBe(before + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Download asks for a download link and goes to it, once per press while it is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    apiFetch.mockImplementation(async (path: string) =>
      path.includes("download=1") ? new Promise((r) => (release = r)) : res({ signed_url: "https://cdn.example/v.mp4" }),
    );
    render(<VideoLibrary videos={VIDEOS.slice(0, 1)} error={null} now={() => NOW} />);
    await flush();
    expect(assign).not.toHaveBeenCalled();
    const btn = screen.getByRole("button", { name: "Download Talking head video" }) as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn);
    await flush();
    expect(apiFetch.mock.calls.filter(([p]) => p === "/api/run-artifacts/art-3d/url?download=1")).toHaveLength(1);
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Downloading…");
    await act(async () => release(res({ signed_url: "https://cdn.example/dl/art-3d" })));
    await flush();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("https://cdn.example/dl/art-3d");
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Download again");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a Download that does not start says so, keeps the button as Download, and a retry that works clears the error", async () => {
    let fail = true;
    apiFetch.mockImplementation(async (path: string) =>
      path.includes("download=1")
        ? fail
          ? res({ error: "boom" }, 500)
          : res({ signed_url: "https://cdn.example/dl/art-3d" })
        : res({ signed_url: "https://cdn.example/v.mp4" }),
    );
    render(<VideoLibrary videos={VIDEOS.slice(0, 1)} error={null} now={() => NOW} />);
    await flush();
    const btn = screen.getByRole("button", { name: "Download Talking head video" }) as HTMLButtonElement;
    fireEvent.click(btn);
    await flush();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("The download did not start. Try again.");
    expect(btn.textContent).toBe("Download");
    expect(btn.disabled).toBe(false);
    apiFetch.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    fireEvent.click(btn);
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("The download did not start. Try again.");
    expect(btn.textContent).toBe("Download");
    fail = false;
    fireEvent.click(btn);
    await flush();
    expect(assign).toHaveBeenCalledWith("https://cdn.example/dl/art-3d");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(btn.textContent).toBe("Download again");
  });

  it("labels the duration with the video's real kind, not AI video for every intent (1b6c)", async () => {
    render(<VideoLibrary videos={[{ ...VIDEOS[0], intent: "animate" }]} error={null} now={() => NOW} />);
    await flush();
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "duration", { configurable: true, value: 8 });
    fireEvent.loadedMetadata(video);
    expect(screen.getByTestId("video-library-duration").textContent).toBe("Animated image · 8s");
  });

  it("the poster has no controls until Play, then plays with our themed controls, never the browser ones, and drops the overlay", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    render(<VideoLibrary videos={VIDEOS.slice(0, 1)} error={null} now={() => NOW} />);
    await flush();
    const video = document.querySelector("video")!;
    expect(video.getAttribute("src")).toBe("https://cdn.example/art-3d.mp4");
    expect(video.controls).toBe(false);
    Object.defineProperty(video, "duration", { configurable: true, value: 24.4 });
    fireEvent.loadedMetadata(video);
    expect(screen.getByTestId("video-library-duration").textContent).toBe("AI video · 24s");
    fireEvent.click(screen.getByRole("button", { name: "Play Talking head video" }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(video.controls).toBe(false);
    expect(screen.getByTestId("video-controls")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Seek" })).toBeTruthy();
    expect(screen.queryByTestId("video-library-status")).toBeNull();
    expect(screen.queryByTestId("video-library-duration")).toBeNull();
    fireEvent.ended(video);
    expect(screen.queryByTestId("video-controls")).toBeNull();
    expect(screen.getByTestId("video-library-status").textContent).toBe("Ready");
    play.mockRestore();
  });

  it("pressing Play moves focus to the video controls, and the end of the video moves it back to Play", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    render(<VideoLibrary videos={VIDEOS.slice(0, 1)} error={null} now={() => NOW} />);
    await flush();
    expect(document.activeElement).toBe(document.body);
    const playButton = screen.getByRole("button", { name: "Play Talking head video" });
    playButton.focus();
    fireEvent.click(playButton);
    await flush();
    const controls = screen.getByTestId("video-controls");
    expect(document.activeElement).not.toBe(document.body);
    expect(controls.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(controls).getAllByRole("button")[0]);
    fireEvent.ended(document.querySelector("video")!);
    await flush();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Play Talking head video" }));
    play.mockRestore();
  });

  it("Full screen on an iPhone hands the video itself to the system player, and elsewhere puts the whole box full screen", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    const enabled = Object.getOwnPropertyDescriptor(document, "fullscreenEnabled");
    render(<VideoLibrary videos={VIDEOS.slice(0, 1)} error={null} now={() => NOW} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Play Talking head video" }));
    const video = document.querySelector("video")! as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    const box = video.parentElement!;
    const enter = vi.fn();
    const boxFull = vi.fn(() => Promise.resolve());
    video.webkitEnterFullscreen = enter;
    Object.defineProperty(box, "requestFullscreen", { configurable: true, value: boxFull });
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => false });
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(enter).toHaveBeenCalledTimes(1);
    expect(boxFull).not.toHaveBeenCalled();
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => true });
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(boxFull).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledTimes(1);
    if (enabled) Object.defineProperty(document, "fullscreenEnabled", enabled);
    else delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
    play.mockRestore();
  });

  it("a video whose link expires is signed again once, then the card says it could not load", async () => {
    render(<VideoLibrary videos={VIDEOS.slice(0, 1)} error={null} now={() => NOW} />);
    await flush();
    fireEvent.error(document.querySelector("video")!);
    await flush();
    expect(apiFetch.mock.calls.filter(([p]) => p === "/api/run-artifacts/art-3d/url")).toHaveLength(2);
    fireEvent.error(document.querySelector("video")!);
    await flush();
    expect(screen.getByText("This video could not be loaded. Refresh the page.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Play/ })).toBeNull();
  });

  it("Refresh runs one reload at a time, keeps its label, and says Updated just now only after a reload that worked", async () => {
    let done: () => void = () => {};
    const onRefresh = vi.fn(() => new Promise<void>((r) => (done = r)));
    render(<VideoLibrary videos={VIDEOS} error={null} now={() => NOW} onRefresh={onRefresh} />);
    await flush();
    const btn = screen.getByTestId("video-library-refresh") as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn);
    await flush();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Refresh");
    expect(screen.queryByTestId("video-library-updated")).toBeNull();
    await act(async () => done());
    await flush();
    expect(btn.disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("Updated just now");
    let fail: (e: Error) => void = () => {};
    onRefresh.mockImplementationOnce(() => new Promise<void>((_, r) => (fail = r)));
    fireEvent.click(btn);
    await flush();
    expect(screen.queryByTestId("video-library-updated")).toBeNull();
    await act(async () => fail(new Error("offline")));
    await flush();
    expect(btn.disabled).toBe(false);
    expect(screen.queryByTestId("video-library-updated")).toBeNull();
  });

  it("Updated just now goes away a few seconds after the refresh, and a later refresh says it again", async () => {
    vi.useFakeTimers();
    try {
      const onRefresh = vi.fn(async () => true);
      render(<VideoLibrary videos={VIDEOS} error={null} now={() => NOW} onRefresh={onRefresh} />);
      await flush();
      const btn = screen.getByTestId("video-library-refresh");
      fireEvent.click(btn);
      await flush();
      expect(screen.getByTestId("video-library-updated").textContent).toBe("Updated just now");
      await act(async () => vi.advanceTimersByTime(3000));
      expect(screen.getByTestId("video-library-updated")).toBeTruthy();
      await act(async () => vi.advanceTimersByTime(1500));
      expect(screen.queryByTestId("video-library-updated")).toBeNull();
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(screen.queryByText("Updated just now")).toBeNull();
      fireEvent.click(btn);
      await flush();
      expect(onRefresh).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("video-library-updated").textContent).toBe("Updated just now");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refresh whose reload reports failure does not say Updated just now", async () => {
    const onRefresh = vi.fn(async () => false);
    render(<VideoLibrary videos={VIDEOS} error="Your videos could not be loaded." now={() => NOW} onRefresh={onRefresh} />);
    await flush();
    await act(async () => fireEvent.click(screen.getByTestId("video-library-refresh")));
    await flush();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("video-library-updated")).toBeNull();
  });

  it("a video made today says Today, and one made late yesterday does not", async () => {
    const today = { ...VIDEOS[0], created_at: new Date(NOW - 60_000).toISOString() };
    const y = new Date(NOW);
    y.setDate(y.getDate() - 1);
    y.setHours(23, 59, 0, 0);
    const yesterday = { ...VIDEOS[1], created_at: y.toISOString() };
    render(<VideoLibrary videos={[today, yesterday]} error={null} now={() => NOW} />);
    await flush();
    const [a, b] = cards().map((c) => c.querySelector("p")?.textContent ?? "");
    expect(a).toBe("Today");
    expect(b).toBe(y.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  });

  it("an empty library says so and Make a video sends you to make one", async () => {
    const onMake = vi.fn();
    render(<VideoLibrary videos={[]} error={null} now={() => NOW} onMake={onMake} />);
    await flush();
    expect(screen.getByText("No videos yet.")).toBeTruthy();
    expect(screen.getByText("Every video you make here or from a suggested ad shows up in this list.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/approved|channel card/i);
    expect(screen.queryByTestId("video-library-count")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Make a video" }));
    expect(onMake).toHaveBeenCalledTimes(1);
  });

  it("a card with an internal file name is titled in plain words, never the file name or its code, while a real name is kept", async () => {
    render(<VideoLibrary videos={[VIDEOS[0], VIDEOS[1], { ...VIDEOS[0], artifact_id: "x", filename: "cinematic-00ff11aa22.mp4" }]} error={null} now={() => NOW} />);
    await flush();
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Talking head video", "hook", "Cinematic video"]);
    expect(document.body.textContent).not.toMatch(/3fa9c2b1|00ff11aa22|\.mp4/);
    expect(document.body.innerHTML).not.toMatch(/aria-label="[^"]*(3fa9c2b1|00ff11aa22)|title="[^"]*(3fa9c2b1|00ff11aa22)/);
    expect(screen.getByRole("button", { name: "Download Talking head video" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Post Talking head video" })).toBeTruthy();
  });

  it("a suggested-ad video drops the card code from its name on the card, its buttons, its player and its Post dialog, while real names keep their last word", async () => {
    const HOOK = "The worst cake problem is finding out on the birthday that";
    const keep = ["Batch 2026", "Our new facade", "Ten years, one decade", "Promo 9b0c1d2e cut", "Video aaaaaaaa"];
    const videos: GalleryVideo[] = [
      { artifact_id: "art-ad", filename: `${HOOK} 7553adc2.mp4`, created_at: daysAgo(1), source: "card", thread_id: null },
      { artifact_id: "art-digits", filename: "Stop paying for empty shifts 12345678.mp4", created_at: daysAgo(1), source: "card", thread_id: null },
      ...keep.map((filename, i) => ({ artifact_id: `art-keep-${i}`, filename: `${filename}.mp4`, created_at: daysAgo(2), source: "card" as const, thread_id: null })),
    ];
    render(<VideoLibrary videos={videos} error={null} now={() => NOW} />);
    await flush();
    expect(cards().map((c) => c.querySelector("h3")?.textContent)).toEqual([HOOK, "Stop paying for empty shifts", ...keep]);
    const ad = cards()[0];
    expect(ad.getAttribute("aria-label")).toBe(`${HOOK}: Ready`);
    expect(within(ad).getByRole("button", { name: `Download ${HOOK}` })).toBeTruthy();
    expect(within(ad).getByRole("button", { name: `Post ${HOOK}` })).toBeTruthy();
    fireEvent.click(within(ad).getByRole("button", { name: `Play ${HOOK}` }));
    await flush();
    fireEvent.click(within(ad).getByRole("button", { name: `Post ${HOOK}` }));
    await flush();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe(`Post "${HOOK}"`);
    expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe(`Post \u201c${HOOK}\u201d`);
    expect(document.body.textContent).not.toMatch(/7553adc2|12345678|\.mp4/);
    const attrs = Array.from(document.body.querySelectorAll("*")).flatMap((el) => ["aria-label", "title", "alt"].map((a) => el.getAttribute(a) ?? ""));
    expect(attrs.filter((a) => /7553adc2|12345678/.test(a))).toEqual([]);
  });

  it("shows a question mark and a trailing ellipsis in a card title without the code or extension", async () => {
    const videos: GalleryVideo[] = [
      { artifact_id: "art-q", filename: "Got a birthday coming up? Let's talk cake 7553adc2.mp4", created_at: daysAgo(1), source: "card", thread_id: null },
      { artifact_id: "art-e", filename: "The worst cake problem is finding out on the birthday that\u2026 7553adc2.mp4", created_at: daysAgo(1), source: "card", thread_id: null },
    ];
    render(<VideoLibrary videos={videos} error={null} now={() => NOW} />);
    await flush();
    expect(cards().map((c) => c.querySelector("h3")?.textContent)).toEqual(["Got a birthday coming up? Let's talk cake", "The worst cake problem is finding out on the birthday that\u2026"]);
  });

  it("the subtitle tells the founder they can both download and post", async () => {
    render(<VideoLibrary videos={VIDEOS} error={null} now={() => NOW} />);
    await flush();
    const sub = screen.getByText(/Every ad you have made/).textContent ?? "";
    expect(sub).toMatch(/download/i);
    expect(sub).toMatch(/post/i);
    expect(sub).not.toContain("Download it here");
  });

  it("loading and downloading text use a real ellipsis, never three dots", async () => {
    const { unmount } = render(<VideoLibrary videos={null} error={null} now={() => NOW} />);
    expect(screen.getByRole("status").textContent).toBe("Loading your videos…");
    expect(document.body.textContent).not.toContain("...");
    unmount();
  });

  it("a load error shows the error, not an empty library", async () => {
    render(<VideoLibrary videos={null} error="Your videos could not be loaded." now={() => NOW} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Your videos could not be loaded.");
    expect(screen.queryByText("No videos yet.")).toBeNull();
  });
});
