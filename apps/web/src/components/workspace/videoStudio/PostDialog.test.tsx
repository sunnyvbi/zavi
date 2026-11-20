// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VideoLibrary } from "./VideoLibrary";
import { forgetPostTargets, joinNames } from "./PostDialog";
import type { GalleryVideo } from "./types";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
const workspace = vi.hoisted(() => ({ current: null as null | { openTab: ReturnType<typeof vi.fn> } }));
vi.mock("../WorkspaceShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../WorkspaceShell")>()),
  useWorkspaceOptional: () => workspace.current,
}));

const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

const VIDEO: GalleryVideo = { artifact_id: "art-1", filename: "Summer drop.mp4", created_at: "2026-10-26T10:00:00Z", source: "chat", thread_id: null };

const TARGETS = [
  { name: "instagram", label: "Instagram", status: "connected" },
  { name: "facebook", label: "Facebook", status: "coming_soon" },
  { name: "linkedin", label: "LinkedIn", status: "connected" },
  { name: "x", label: "X", status: "not_connected" },
  { name: "tiktok", label: "TikTok", status: "connected" },
  { name: "youtube", label: "YouTube", status: "connected" },
];

type Call = { path: string; opts?: { method?: string; body?: string; idempotent?: boolean } };
let calls: Call[];
let onPost: (body: { channels: string[] }) => Promise<unknown>;

const posts = () => calls.filter((c) => c.opts?.method === "POST");

beforeEach(() => {
  forgetPostTargets();
  workspace.current = null;
  calls = [];
  onPost = async (body) => res({ results: body.channels.map((name) => ({ name, status: "posted" })) });
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string, opts?: Call["opts"]) => {
    calls.push({ path, opts });
    if (path.endsWith("/post-targets")) return res({ targets: TARGETS });
    if (opts?.method === "POST") return onPost(JSON.parse(opts.body ?? "{}"));
    return res({ signed_url: "https://cdn.example/v.mp4" });
  });
});
afterEach(() => cleanup());

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

async function open(video: GalleryVideo = VIDEO) {
  render(<VideoLibrary videos={[video]} error={null} now={() => Date.parse("2026-10-27T00:00:00Z")} />);
  await flush();
  fireEvent.click(screen.getByTestId("video-library-post"));
  await flush();
  return screen.getByRole("dialog");
}

const row = (name: string) => screen.getByTestId(`video-post-row-${name}`);
const box = (name: string) => within(row(name)).getByRole("checkbox") as HTMLInputElement;
const submit = () => screen.getByTestId("video-post-submit") as HTMLButtonElement;
const badge = () => screen.getByTestId("video-library-status").textContent;

describe("Post dialog on a Library card", () => {
  it("opens with the video title, the subtitle and all six channels, Post disabled until something is picked", async () => {
    const dialog = await open();
    expect(dialog.getAttribute("aria-label")).toBe('Post "Summer drop"');
    expect(within(dialog).getByRole("heading").textContent).toBe("Post “Summer drop”");
    expect(dialog.textContent).toContain("Pick one or more channels. Zavi posts it for you.");
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(4);
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeTruthy();
    expect(within(row("x")).getByText("Not connected")).toBeTruthy();
    expect(within(row("facebook")).getByText("Coming soon")).toBeTruthy();
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    await flush();
    expect(posts()).toHaveLength(0);
  });

  it("a channel that is not connected has no checkbox, is muted, cannot be picked and is never sent", async () => {
    await open();
    for (const name of ["x", "facebook"]) {
      expect(within(row(name)).queryByRole("checkbox")).toBeNull();
      expect(within(row(name)).queryByTestId(`video-post-box-${name}`)).toBeNull();
      expect(row(name).getAttribute("aria-disabled")).toBe("true");
      expect(row(name).className.split(/\s+/)).toContain("opacity-50");
      expect(row(name).tagName).not.toBe("LABEL");
      fireEvent.click(row(name));
      fireEvent.click(within(row(name)).getByText(name === "x" ? "X" : "Facebook"));
    }
    await flush();
    expect(screen.getByTestId("video-post-summary").textContent).toBe("Pick at least one channel.");
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    await flush();
    expect(posts()).toHaveLength(0);
    fireEvent.click(box("linkedin"));
    fireEvent.click(row("x"));
    fireEvent.click(submit());
    await flush();
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0].opts!.body!)).toEqual({ channels: ["linkedin"] });
  });

  it("the dialog Post button carries the same paper-plane icon as the card, hidden from screen readers", async () => {
    await open();
    const icon = submit().querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("aria-hidden")).toBe("true");
    expect(icon!.querySelector("path")!.getAttribute("d")!.length).toBe(2760);
    expect(submit().textContent).toBe("Post");
  });

  it("while channels load there is no pick hint, no summary and Post stays disabled; the hint appears once they arrive", async () => {
    let arrive: (v: unknown) => void = () => {};
    apiFetch.mockImplementation(async (path: string, opts?: Call["opts"]) => {
      calls.push({ path, opts });
      if (path.endsWith("/post-targets")) return new Promise((r) => (arrive = r));
      if (opts?.method === "POST") return onPost(JSON.parse(opts.body ?? "{}"));
      return res({ signed_url: "https://cdn.example/v.mp4" });
    });
    const dialog = await open();
    expect(within(dialog).getByRole("status").textContent).toBe("Loading your channels…");
    expect(dialog.textContent).not.toContain("Pick at least one channel.");
    expect(dialog.textContent).not.toContain("Zavi posts it on");
    expect(screen.queryByTestId("video-post-summary")).toBeNull();
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    await flush();
    expect(posts()).toHaveLength(0);
    await act(async () => arrive(res({ targets: TARGETS })));
    await flush();
    expect(within(dialog).queryByRole("status")).toBeNull();
    expect(screen.getByTestId("video-post-summary").textContent).toBe("Pick at least one channel.");
    expect(submit().disabled).toBe(true);
    fireEvent.click(box("instagram"));
    expect(submit().disabled).toBe(false);
  });

  it("with no channel connected the dialog offers a link to connect one instead of a dead end, and nothing is ever posted", async () => {
    apiFetch.mockImplementation(async (path: string, opts?: Call["opts"]) => {
      calls.push({ path, opts });
      if (path.endsWith("/post-targets"))
        return res({ targets: TARGETS.map((t) => ({ ...t, status: t.name === "facebook" ? "coming_soon" : "not_connected" })) });
      if (opts?.method === "POST") return onPost(JSON.parse(opts.body ?? "{}"));
      return res({ signed_url: "https://cdn.example/v.mp4" });
    });
    const dialog = await open();
    expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
    const link = within(dialog).getByRole("link", { name: "Connect a channel" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/workspace#integrations");
    expect(dialog.textContent).not.toContain("Pick at least one channel.");
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    await flush();
    expect(posts()).toHaveLength(0);
  });

  it("inside the workspace the connect link opens the Toolkit Integrations tab and closes the dialog instead of landing on Settings", async () => {
    const openTab = vi.fn();
    workspace.current = { openTab };
    apiFetch.mockImplementation(async (path: string, opts?: Call["opts"]) => {
      calls.push({ path, opts });
      if (path.endsWith("/post-targets")) return res({ targets: TARGETS.map((t) => ({ ...t, status: "not_connected" })) });
      if (opts?.method === "POST") return onPost(JSON.parse(opts.body ?? "{}"));
      return res({ signed_url: "https://cdn.example/v.mp4" });
    });
    const dialog = await open();
    const link = within(dialog).getByRole("link", { name: "Connect a channel" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      link.dispatchEvent(click);
    });
    await flush();
    expect(click.defaultPrevented).toBe(true);
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(openTab.mock.calls[0][0]).toMatchObject({ kind: "brain", payload: { kind: "brain" } });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("a modified click on the connect link is left to the browser so it can open a new tab", async () => {
    const openTab = vi.fn();
    workspace.current = { openTab };
    apiFetch.mockImplementation(async (path: string, opts?: Call["opts"]) => {
      calls.push({ path, opts });
      if (path.endsWith("/post-targets")) return res({ targets: TARGETS.map((t) => ({ ...t, status: "not_connected" })) });
      return res({ signed_url: "https://cdn.example/v.mp4" });
    });
    const dialog = await open();
    const link = within(dialog).getByRole("link", { name: "Connect a channel" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
    act(() => {
      link.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(false);
    expect(openTab).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("the connect link stays away while any channel is connected", async () => {
    const dialog = await open();
    expect(within(dialog).queryByRole("link", { name: "Connect a channel" })).toBeNull();
    expect(dialog.textContent).toContain("Pick at least one channel.");
  });

  it("a channel list that fails to load shows the error with no pick hint and Post disabled", async () => {
    apiFetch.mockImplementation(async (path: string, opts?: Call["opts"]) => {
      calls.push({ path, opts });
      if (path.endsWith("/post-targets")) return res({ error: { message: "Your channels could not be loaded. Try again." } }, 500);
      return res({ signed_url: "https://cdn.example/v.mp4" });
    });
    const dialog = await open();
    expect(within(dialog).getByRole("alert").textContent).toBe("Your channels could not be loaded. Try again.");
    expect(dialog.textContent).not.toContain("Pick at least one channel.");
    expect(submit().disabled).toBe(true);
  });

  it("a picked row gets a thick ink border and a filled box on the right, and the footer sums up the picks", async () => {
    apiFetch.mockImplementation(async (path: string, opts?: Call["opts"]) => {
      calls.push({ path, opts });
      if (path.endsWith("/post-targets")) return res({ targets: TARGETS.map((t) => (t.name === "x" ? { ...t, status: "connected" } : t)) });
      if (opts?.method === "POST") return onPost(JSON.parse(opts.body ?? "{}"));
      return res({ signed_url: "https://cdn.example/v.mp4" });
    });
    await open();
    const summary = () => screen.getByTestId("video-post-summary").textContent;
    const cls = (name: string) => row(name).className.split(/\s+/);
    const visual = (name: string) => screen.getByTestId(`video-post-box-${name}`);
    expect(cls("instagram")).toContain("border-2");
    expect(cls("instagram")).toContain("border-rule");
    expect(cls("instagram")).not.toContain("border-ink");
    const kids = Array.from(row("instagram").children);
    expect(kids[0].getAttribute("data-testid")).toBe("video-post-mark");
    expect(kids[kids.length - 1]).toBe(visual("instagram"));
    expect(visual("instagram").querySelector("svg")).toBeNull();
    fireEvent.click(row("instagram"));
    expect(box("instagram").checked).toBe(true);
    expect(cls("instagram")).toContain("border-ink");
    expect(cls("instagram")).not.toContain("border-rule");
    expect(row("instagram").getAttribute("data-selected")).toBe("true");
    expect(visual("instagram").className.split(/\s+/)).toEqual(expect.arrayContaining(["bg-ink", "text-cream"]));
    expect(visual("instagram").querySelector("svg")).not.toBeNull();
    expect(summary()).toBe("Zavi posts it on Instagram.");
    fireEvent.click(row("x"));
    expect(summary()).toBe("Zavi posts it on Instagram and X.");
    fireEvent.click(row("instagram"));
    expect(summary()).toBe("Zavi posts it on X.");
    expect(cls("instagram")).not.toContain("border-ink");
    fireEvent.click(row("x"));
    expect(summary()).toBe("Pick at least one channel.");
    expect(submit().disabled).toBe(true);
  });

  it("every channel row carries a brand mark chip", async () => {
    await open();
    for (const t of TARGETS) expect(within(row(t.name)).getAllByTestId("video-post-mark")).toHaveLength(1);
  });

  it("the close X shuts the dialog without posting, and is locked while a post is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts()).toHaveLength(0);
    onPost = () => new Promise((r) => (release = r));
    fireEvent.click(screen.getByTestId("video-library-post"));
    await flush();
    fireEvent.click(box("instagram"));
    fireEvent.click(submit());
    await flush();
    const close = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.click(close);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => release(res({ results: [{ name: "instagram", status: "posted" }] })));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("in dark mode the portaled panel picks up the workspace dark surface, not the light cream", async () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(__dirname, "../../../app/globals.css"), "utf8").replace(/@tailwind[^;]*;|@import[^;]*;/g, "");
    document.head.appendChild(style);
    document.documentElement.classList.add("dark");
    try {
      const dialog = await open();
      const panel = screen.getByTestId("video-post-dialog");
      expect(dialog.parentElement).toBe(document.body);
      let host: HTMLElement | null = panel;
      while (host && !host.matches("html.dark .workspace-shell")) host = host.parentElement;
      expect(host).not.toBeNull();
      expect(host!.contains(panel)).toBe(true);
      expect(getComputedStyle(host!).getPropertyValue("--c-cream").trim()).toBe("20 20 20");
      expect(getComputedStyle(host!).getPropertyValue("--c-ink").trim()).toBe("236 236 236");
      const cls = panel.className.split(/\s+/);
      expect(cls).toContain("bg-cream");
      expect(cls.some((c) => /^bg-(white|black|\[)/.test(c))).toBe(false);
      expect(submit().className.split(/\s+/)).not.toContain("hover:bg-black");
    } finally {
      document.documentElement.classList.remove("dark");
      style.remove();
    }
  });

  it("the footer names the picked channels in plain words, and Post sends exactly one idempotent request with each picked channel once", async () => {
    await open();
    fireEvent.click(box("linkedin"));
    fireEvent.click(box("instagram"));
    expect(screen.getByText("Zavi posts it on Instagram and LinkedIn.")).toBeTruthy();
    fireEvent.click(box("youtube"));
    expect(screen.getByText("Zavi posts it on Instagram, LinkedIn and YouTube.")).toBeTruthy();
    fireEvent.click(submit());
    await flush();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].path).toBe("/api/channels/generated_video/studio/videos/art-1/post");
    expect(posts()[0].opts?.idempotent).toBe(true);
    expect(JSON.parse(posts()[0].opts!.body!)).toEqual({ channels: ["instagram", "linkedin", "youtube"] });
  });

  it("a double click while the post is in flight sends one request", async () => {
    let release: (v: unknown) => void = () => {};
    onPost = () => new Promise((r) => (release = r));
    await open();
    fireEvent.click(box("tiktok"));
    fireEvent.click(submit());
    fireEvent.click(submit());
    await flush();
    fireEvent.click(submit());
    expect(posts()).toHaveLength(1);
    await act(async () => release(res({ results: [{ name: "tiktok", status: "posted" }] })));
    await flush();
    expect(posts()).toHaveLength(1);
  });

  it("after success the dialog closes and the card badge says it is posting to those channels, with no separate chip", async () => {
    await open();
    fireEvent.click(box("instagram"));
    fireEvent.click(box("linkedin"));
    fireEvent.click(submit());
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(badge()).toBe("Posting to Instagram and LinkedIn…");
    expect(screen.queryAllByTestId("video-library-posted")).toHaveLength(0);
    const card = screen.getByTestId("video-library-item");
    expect(within(card).getByTestId("video-library-post")).toBeTruthy();
    expect(within(card).getByRole("button", { name: /^Download/ })).toBeTruthy();
  });

  it("a TikTok post is labelled private on the card and in the dialog, never as a public post", async () => {
    await open();
    fireEvent.click(box("tiktok"));
    fireEvent.click(box("instagram"));
    fireEvent.click(submit());
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(badge()).toBe("Posting to Instagram and TikTok…");
    expect(document.body.textContent).not.toContain("Posted on TikTok");
    fireEvent.click(screen.getByTestId("video-library-post"));
    await flush();
    expect(within(row("tiktok")).getByText("Posting…")).toBeTruthy();
    expect(within(row("instagram")).getByText("Posting…")).toBeTruthy();
    expect(within(row("tiktok")).queryByRole("checkbox")).toBeNull();
  });

  it("a failed post shows a plain-language error, keeps the dialog open and adds no badge", async () => {
    onPost = async () => res({ error: { code: "social_publish_paused", message: "Posting is paused for your account right now, so nothing was posted." } }, 403);
    await open();
    fireEvent.click(box("instagram"));
    fireEvent.click(submit());
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("video-post-error").textContent).toBe("Posting is paused for your account right now, so nothing was posted.");
    expect(badge()).toBe("Ready");
    expect(submit().disabled).toBe(false);
  });

  it("a network failure says nothing was posted, with no raw error and no badge", async () => {
    onPost = async () => {
      throw new TypeError("Failed to fetch");
    };
    await open();
    fireEvent.click(box("instagram"));
    fireEvent.click(submit());
    await flush();
    expect(screen.getByTestId("video-post-error").textContent).toBe("Nothing was posted. Try again in a minute.");
    expect(document.body.textContent).not.toContain("Failed to fetch");
    expect(badge()).toBe("Ready");
  });

  it("a partial result badges only what went out and explains the rest, keeping the failed channel picked", async () => {
    onPost = async () =>
      res({
        results: [
          { name: "instagram", status: "posted" },
          { name: "tiktok", status: "failed", message: "This post did not go out. Try again in a minute." },
        ],
      });
    await open();
    fireEvent.click(box("instagram"));
    fireEvent.click(box("tiktok"));
    fireEvent.click(submit());
    await flush();
    expect(badge()).toBe("Posting to Instagram…");
    expect(screen.getByTestId("video-post-error").textContent).toBe("TikTok: This post did not go out. Try again in a minute.");
    expect(box("tiktok").checked).toBe(true);
    expect(within(row("instagram")).queryByRole("checkbox")).toBeNull();
    expect(within(row("instagram")).getByText("Posting…")).toBeTruthy();
  });

  it("a channel the video is already on, or still going out on, cannot be picked or sent again", async () => {
    await open({ ...VIDEO, posted_on: ["linkedin"], posting_on: ["instagram"] });
    for (const [name, note] of [["linkedin", "Posted"], ["instagram", "Posting…"]] as const) {
      expect(within(row(name)).queryByRole("checkbox")).toBeNull();
      expect(row(name).getAttribute("aria-disabled")).toBe("true");
      expect(row(name).tagName).not.toBe("LABEL");
      expect(within(row(name)).getByText(note)).toBeTruthy();
      fireEvent.click(row(name));
      fireEvent.click(within(row(name)).getByText(name === "linkedin" ? "LinkedIn" : "Instagram"));
    }
    await flush();
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    await flush();
    expect(posts()).toHaveLength(0);
    fireEvent.click(box("tiktok"));
    fireEvent.click(submit());
    await flush();
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0].opts!.body!)).toEqual({ channels: ["tiktok"] });
  });

  it("right after posting to LinkedIn, reopening Post shows LinkedIn locked, so a second press cannot post it twice", async () => {
    await open();
    fireEvent.click(box("linkedin"));
    fireEvent.click(submit());
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("video-library-post"));
    await flush();
    expect(within(row("linkedin")).queryByRole("checkbox")).toBeNull();
    expect(within(row("linkedin")).getByText("Posting…")).toBeTruthy();
    expect(box("instagram").checked).toBe(false);
    expect(posts()).toHaveLength(1);
  });

  it("once the video is on every connected channel, the dialog says so and Post stays off", async () => {
    await open({ ...VIDEO, posted_on: ["instagram", "linkedin", "tiktok", "youtube"] });
    expect(within(screen.getByRole("dialog")).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(row("tiktok")).getByText("Posted privately")).toBeTruthy();
    expect(screen.getByTestId("video-post-summary").textContent).toBe("This video is already on every channel you have connected.");
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    await flush();
    expect(posts()).toHaveLength(0);
  });

  it("fits a 390px phone: the panel is fluid inside a 16px gutter, with no fixed width and rows that truncate", async () => {
    const dialog = await open();
    const panel = screen.getByTestId("video-post-dialog");
    const scrim = dialog.className.split(/\s+/);
    const cls = panel.className.split(/\s+/);
    expect(scrim).toContain("p-4");
    expect(cls).toContain("w-full");
    expect(cls).toContain("max-w-md");
    expect(cls.some((c) => /^(min-)?w-\[|^w-(\d|px)/.test(c))).toBe(false);
    expect(cls).toContain("overflow-y-auto");
    expect(cls.some((c) => c.startsWith("max-h-["))).toBe(true);
    for (const t of TARGETS) {
      const label = within(row(t.name)).getByText(t.label);
      expect(label.className).toContain("truncate");
      expect(label.className).toContain("min-w-0");
    }
  });

  it("opens on the page itself, not inside the sliding phone panel, so a transformed ancestor cannot push it off-screen", async () => {
    render(
      <div data-testid="phone-track" style={{ width: "200%", transform: "translate3d(-50%, 0, 0)" }}>
        <VideoLibrary videos={[VIDEO]} error={null} now={() => Date.parse("2026-10-27T00:00:00Z")} />
      </div>,
    );
    await flush();
    fireEvent.click(screen.getByTestId("video-library-post"));
    await flush();
    const dialog = screen.getByRole("dialog");
    const track = screen.getByTestId("phone-track");
    expect(dialog.parentElement).toBe(document.body);
    expect(track.contains(dialog)).toBe(false);
    let node: HTMLElement | null = dialog.parentElement;
    while (node) {
      expect(node.style.transform).toBe("");
      node = node.parentElement;
    }
    fireEvent.click(screen.getByTestId("video-post-dialog"));
    expect(screen.getByRole("dialog")).toBe(dialog);
    fireEvent.click(box("instagram"));
    expect(box("instagram").checked).toBe(true);
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.querySelector(".dialog-scrim")).toBeNull();
    fireEvent.click(screen.getByTestId("video-library-post"));
    await flush();
    expect(screen.getByRole("dialog").parentElement).toBe(document.body);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("a channel whose last post was not confirmed stays pickable, warns to check first, and asks the server to post it again", async () => {
    await open({ ...VIDEO, check_on: ["tiktok"] });
    expect(badge()).toBe("Check TikTok");
    expect(within(row("tiktok")).getByTestId("video-post-hint-tiktok").textContent).toBe("Not confirmed. Check TikTok first");
    expect(box("tiktok").disabled).toBe(false);
    fireEvent.click(box("tiktok"));
    fireEvent.click(box("instagram"));
    fireEvent.click(submit());
    await flush();
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0].opts!.body!)).toEqual({ channels: ["instagram", "tiktok"], repost: ["tiktok"] });
  });

  it("never asks to post again a channel that was not picked, even when it was not confirmed", async () => {
    await open({ ...VIDEO, check_on: ["tiktok"] });
    fireEvent.click(box("linkedin"));
    fireEvent.click(submit());
    await flush();
    expect(JSON.parse(posts()[0].opts!.body!)).toEqual({ channels: ["linkedin"] });
  });

  it("a channel whose last post failed says so on the card and the row, and can be posted again normally", async () => {
    await open({ ...VIDEO, posted_on: ["instagram"], failed_on: ["linkedin"] });
    expect(badge()).toBe("Posted on Instagram, post failed on LinkedIn");
    expect(within(row("linkedin")).getByTestId("video-post-hint-linkedin").textContent).toBe("Last post failed");
    fireEvent.click(box("linkedin"));
    fireEvent.click(submit());
    await flush();
    expect(JSON.parse(posts()[0].opts!.body!)).toEqual({ channels: ["linkedin"] });
  });

  it("Escape and Cancel close without posting", async () => {
    await open();
    fireEvent.click(box("instagram"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("video-library-post"));
    await flush();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts()).toHaveLength(0);
  });
});

describe("joinNames", () => {
  it("joins one, two and three names the way a person would say them", () => {
    expect(joinNames(["Instagram"])).toBe("Instagram");
    expect(joinNames(["Instagram", "LinkedIn"])).toBe("Instagram and LinkedIn");
    expect(joinNames(["Instagram", "LinkedIn", "X"])).toBe("Instagram, LinkedIn and X");
  });
});
