// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({
  useAppReadiness: () => ({ state: "ready", retry: () => {} }),
}));

import { WebsitePreview } from "./WebsitePreview";
import { noteSitePreviewCookie } from "@/lib/workspace/sitePreviewCookie";

const LIVE = "https://bike.zaviagent.com";
const frameSrc = (c: HTMLElement) => (c.querySelector("iframe") as HTMLIFrameElement).getAttribute("src") ?? "";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("the live site frame after a version was opened in this browser", () => {
  it("loads through the end path so the old build's cookie cannot show as latest, cache key included", () => {
    noteSitePreviewCookie(`${LIVE}/__zavi_preview/d0muqzh2uy-1d58fa82/?t=x&zavi_embed=1`, Date.now() + 15 * 60_000);
    const view = render(<WebsitePreview liveUrl={LIVE} cacheKey="7" appId={null} builtApp={false} />);
    expect(frameSrc(view.container)).toBe(`${LIVE}/__zavi_preview_end?next=${encodeURIComponent("/?_v=7")}`);
  });

  it("while a version is framed, the version keeps its cookie", () => {
    noteSitePreviewCookie(`${LIVE}/__zavi_preview/d0muqzh2uy-1d58fa82/?t=x&zavi_embed=1`, Date.now() + 15 * 60_000);
    const view = render(<WebsitePreview liveUrl={`${LIVE}/about`} cacheKey={null} appId={null} builtApp={false} keepPreviewCookie />);
    expect(frameSrc(view.container)).toBe(`${LIVE}/about`);
  });

  it("a browser that never opened a version frames the live site as before", () => {
    const view = render(<WebsitePreview liveUrl={LIVE} cacheKey={null} appId={null} builtApp={false} />);
    expect(frameSrc(view.container)).toBe(LIVE);
  });
});
