// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiUrl: (p: string) => `https://api.zaviagent.com${p}`,
}));

import { LiveAppPreview, runCheckedProductBuilds } from "./LiveAppPreview";
import { __resetLiveAppUrlCache } from "@/lib/workspace/useLiveAppUrl";
import type { ChatRow } from "@/lib/workspace/useChatThread";

const LIVE = "https://upcarai-6ec4d609.onrender.com";

const toolRow = (tool_name: string): ChatRow =>
  ({
    id: `row-${tool_name}`,
    kind: "activity",
    created_at: "2026-09-22T12:18:41Z",
    body: { teKind: "tool_call", tool_name, call_id: "c1" },
  }) as unknown as ChatRow;

const thoughtRow = (): ChatRow =>
  ({
    id: "row-thought",
    kind: "activity",
    created_at: "2026-09-22T12:18:07Z",
    body: { teKind: "assistant_turn", text: "thinking" },
  }) as unknown as ChatRow;

const checkedBuilds = [thoughtRow(), toolRow("mcp__server__praxis__list_product_builds")];

const statusJson = (preview: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ run: { id: "r1", status: "done" }, preview }),
});

const frame = () => document.querySelector("iframe");

beforeEach(() => {
  __resetLiveAppUrlCache();
  apiFetch.mockReset();
});
afterEach(() => cleanup());

describe("runCheckedProductBuilds", () => {
  it("matches the MCP-prefixed tool name the run actually records", () => {
    expect(runCheckedProductBuilds(checkedBuilds)).toBe(true);
  });

  it("does not match a different praxis tool on the same run", () => {
    expect(runCheckedProductBuilds([toolRow("mcp__server__praxis__list_reminders")])).toBe(false);
  });

  it("does not match an assistant turn that merely mentions the tool", () => {
    const row = {
      id: "r",
      kind: "activity",
      created_at: "2026-09-22T12:18:07Z",
      body: { teKind: "assistant_turn", text: "calling list_product_builds now" },
    } as unknown as ChatRow;
    expect(runCheckedProductBuilds([row])).toBe(false);
  });

  it("is false for a reply with no activity at all", () => {
    expect(runCheckedProductBuilds(undefined)).toBe(false);
    expect(runCheckedProductBuilds([])).toBe(false);
  });
});

describe("LiveAppPreview", () => {
  it("frames the shipped app under a reply that reported it live but linked nothing", async () => {
    apiFetch.mockResolvedValue(statusJson({ url: LIVE, kind: "final" }));

    render(<LiveAppPreview activity={checkedBuilds} />);

    await waitFor(() => expect(frame()).not.toBeNull());
    expect(frame()!.getAttribute("src")).toBe(LIVE);
    expect(screen.getByText("Your app is live")).toBeTruthy();
    expect(screen.getByText("upcarai-6ec4d609.onrender.com")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in new tab" }).getAttribute("href")).toBe(LIVE);
  });

  it("refuses to frame the provision-time placeholder while a build is mid-flight", async () => {
    apiFetch.mockResolvedValue(statusJson({ url: LIVE, kind: "early" }));

    render(<LiveAppPreview activity={checkedBuilds} />);

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await Promise.resolve();
    expect(frame()).toBeNull();
    expect(screen.queryByText("Your app is live")).toBeNull();
  });

  it("renders nothing when the server vouches no servable URL", async () => {
    apiFetch.mockResolvedValue(statusJson({ url: null, kind: "none" }));
    render(<LiveAppPreview activity={checkedBuilds} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(frame()).toBeNull();
  });

  it("renders nothing when the URL is blank despite a final verdict", async () => {
    apiFetch.mockResolvedValue(statusJson({ url: "", kind: "final" }));
    render(<LiveAppPreview activity={checkedBuilds} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(frame()).toBeNull();
  });

  it("costs no request on a reply whose run never checked the builds", async () => {
    render(<LiveAppPreview activity={[thoughtRow(), toolRow("mcp__server__praxis__remind")]} />);
    await Promise.resolve();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(frame()).toBeNull();
  });

  it("degrades to no card when the status GET fails, never a broken frame", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<LiveAppPreview activity={checkedBuilds} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(frame()).toBeNull();
  });

  it("costs ONE GET no matter how many replies in the thread checked the builds", async () => {
    apiFetch.mockResolvedValue(statusJson({ url: LIVE, kind: "final" }));

    render(
      <>
        <LiveAppPreview activity={checkedBuilds} />
        <LiveAppPreview activity={checkedBuilds} />
        <LiveAppPreview activity={checkedBuilds} />
      </>,
    );

    await waitFor(() => expect(document.querySelectorAll("iframe")).toHaveLength(3));
    const paths = apiFetch.mock.calls.map((c) => String(c[0]));
    expect(paths.filter((p) => p === "/api/workspace/autopilot/build-status?app=workspace")).toHaveLength(1);
    expect(paths.filter((p) => p.startsWith("/api/workspace/app-preview/readiness"))).toHaveLength(1);
    expect(paths).toHaveLength(2);
  });

  it("two sites in one workspace: each chat's card shows ITS app, never the other's", async () => {
    const THREAD_A = "d0000000-0000-4000-8000-0000000000a1";
    const THREAD_B = "d0000000-0000-4000-8000-0000000000b1";
    const ALPHA = "https://alpha.zaviagent.com";
    const BETA = "https://beta.zaviagent.com";
    apiFetch.mockImplementation(async (path: string) => {
      if (path.includes(`thread_id=${THREAD_A}`)) return statusJson({ url: ALPHA, kind: "final" });
      if (path.includes(`thread_id=${THREAD_B}`)) return statusJson({ url: BETA, kind: "final" });
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const a = render(<LiveAppPreview activity={checkedBuilds} threadId={THREAD_A} />);
    const b = render(<LiveAppPreview activity={checkedBuilds} threadId={THREAD_B} />);

    await waitFor(() => expect(a.container.querySelector("iframe")).not.toBeNull());
    await waitFor(() => expect(b.container.querySelector("iframe")).not.toBeNull());
    expect(a.container.querySelector("iframe")!.getAttribute("src")).toBe(ALPHA);
    expect(b.container.querySelector("iframe")!.getAttribute("src")).toBe(BETA);
    const statusPaths = apiFetch.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("build-status"));
    expect(statusPaths.sort()).toEqual([
      `/api/workspace/autopilot/build-status?thread_id=${THREAD_A}`,
      `/api/workspace/autopilot/build-status?thread_id=${THREAD_B}`,
    ]);
  });

  it("no thread yet: asks for the workspace app, never the tenant's newest build", async () => {
    apiFetch.mockResolvedValue(statusJson({ url: null, kind: "none" }));
    render(<LiveAppPreview activity={checkedBuilds} threadId={null} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(String(apiFetch.mock.calls[0][0])).toBe("/api/workspace/autopilot/build-status?app=workspace");
  });

  it("sandboxes the remote frame and sends it no referrer at all", async () => {
    apiFetch.mockResolvedValue(statusJson({ url: LIVE, kind: "final" }));
    render(<LiveAppPreview activity={checkedBuilds} />);
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(frame()!.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame()!.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame()!.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("uses the shared frame, so an app that refuses embedding falls back instead of showing a blank box", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiFetch.mockResolvedValue(statusJson({ url: LIVE, kind: "final" }));
      render(<LiveAppPreview activity={checkedBuilds} />);

      await act(async () => {
        for (let i = 0; i < 16; i += 1) await Promise.resolve();
      });
      expect(frame()).not.toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_500);
      });

      expect(frame()).toBeNull();
      expect(screen.getByText(/blocks embedding/i)).toBeTruthy();
      expect(screen.getByRole("link", { name: "Open your app" }).getAttribute("href")).toBe(LIVE);
    } finally {
      vi.useRealTimers();
    }
  });
});
