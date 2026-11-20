// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({ calls: [] as Array<{ path: string; init?: RequestInit }>, next: [] as Array<() => Promise<Response>> }));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn((path: string, init?: RequestInit) => {
    api.calls.push({ path, init });
    const f = api.next.shift();
    return f ? f() : Promise.resolve(new Response("{}", { status: 200 }));
  }),
}));

import { SearchHoldNote, SEARCH_HOLD_FAILED, SEARCH_HOLD_LINE } from "./SearchHoldNote";
import { readBuildSite } from "@/lib/workspace/useBuildPreview";

const SITE = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  cleanup();
  api.calls.length = 0;
  api.next.length = 0;
});

describe("SearchHoldNote", () => {
  it("Looks good posts once for this site and the note goes away", async () => {
    let resolve!: (r: Response) => void;
    api.next.push(() => new Promise<Response>((r) => (resolve = r)));
    const onReleased = vi.fn();
    render(<SearchHoldNote siteId={SITE} onReleased={onReleased} />);
    expect(screen.getByTestId("search-hold-note").textContent).toContain(SEARCH_HOLD_LINE);
    const button = screen.getByTestId("search-hold-release");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.path).toBe(`/api/workspace/autopilot/sites/${SITE}/looks-good`);
    expect(api.calls[0]!.init?.method).toBe("POST");
    expect(screen.getByTestId("search-hold-note")).toBeTruthy();
    await act(async () => resolve(new Response("{}", { status: 200 })));
    expect(screen.queryByTestId("search-hold-note")).toBeNull();
    expect(onReleased).toHaveBeenCalledTimes(1);
  });

  it("a refused save keeps the note and says so, and a retry can still succeed", async () => {
    api.next.push(() => Promise.resolve(new Response("{}", { status: 500 })));
    const onReleased = vi.fn();
    render(<SearchHoldNote siteId={SITE} onReleased={onReleased} />);
    await act(async () => fireEvent.click(screen.getByTestId("search-hold-release")));
    expect(screen.getByTestId("search-hold-note").textContent).toContain(SEARCH_HOLD_FAILED);
    expect(onReleased).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByTestId("search-hold-release")));
    expect(screen.queryByTestId("search-hold-note")).toBeNull();
    expect(api.calls).toHaveLength(2);
  });

  it("a network error is not treated as released", async () => {
    api.next.push(() => Promise.reject(new Error("offline")));
    render(<SearchHoldNote siteId={SITE} />);
    await act(async () => fireEvent.click(screen.getByTestId("search-hold-release")));
    expect(screen.getByTestId("search-hold-note").textContent).toContain(SEARCH_HOLD_FAILED);
  });
});

describe("readBuildSite search_hidden", () => {
  it("only a literal true marks the site held", () => {
    expect(readBuildSite({ id: SITE, status: "live", search_hidden: true })?.searchHidden).toBe(true);
    expect(readBuildSite({ id: SITE, status: "live", search_hidden: "true" })?.searchHidden).toBeUndefined();
    expect(readBuildSite({ id: SITE, status: "live" })?.searchHidden).toBeUndefined();
  });
});
