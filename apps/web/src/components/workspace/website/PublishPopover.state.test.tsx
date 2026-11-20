// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn() } }));
import { PublishPopover, type SitePublishOnRequest } from "./PublishPopover";
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
function view(sitePublish: SitePublishOnRequest) {
  return <PublishPopover appUrl="https://preview.e2b.app" appHost="preview.e2b.app" publishable={false}
    site={{ liveUrl: null, status: "building" }} sitePublish={sitePublish} onGetDomain={() => {}} onClose={() => {}} />;
}
const base: SitePublishOnRequest = { siteId: "site-a", hostname: "a.zaviagent.com", built: true, status: "none" };
afterEach(() => { cleanup(); vi.useRealTimers(); apiFetch.mockReset(); });
async function ready() { await waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull()); }
describe("Publish follows the selected site's server state", () => {
  it("switching sites while a request is pending ignores its late answer", async () => {
    let resolve!: (r: Response) => void;
    apiFetch.mockImplementation(() => new Promise<Response>(r => { resolve = r; }));
    const oldStarted = vi.fn();
    const r = render(view({ ...base, onStarted: oldStarted }));
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    r.rerender(view({ ...base, siteId: "site-b" }));
    await ready();
    expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(false);
    resolve(response({ ok: true }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Publishing…" })).toBeNull());
    expect(oldStarted).not.toHaveBeenCalled();
  });
  it("an already-published answer does not hide a later authoritative failure", async () => {
    apiFetch.mockResolvedValue(response({ error: { code: "already_published" } }, 409));
    const r = render(view(base));
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await screen.findByRole("button", { name: "Up to date" });
    r.rerender(view({ ...base, status: "failed", reason: "Hosting failed" }));
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByText("Hosting failed")).toBeTruthy();
  });
  it("a dropped publish response refreshes the real state", async () => {
    apiFetch.mockRejectedValue(new Error("response lost"));
    const onRefresh = vi.fn();
    render(view({ ...base, onRefresh }));
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });
  it("an optimistic publish times out and refreshes when server updates never arrive", async () => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValue(response({ ok: true }));
    const onRefresh = vi.fn();
    await act(async () => { render(view({ ...base, onRefresh })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Publish" })); });
    expect(screen.getByRole("button", { name: "Publishing…" })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(65_000); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(false);
  });

});

describe("Publish popover while its first reads are in flight", () => {
  it("loads on the shared theme skeleton, announced as a busy status, then hands over to the real panel", async () => {
    const pending: Array<(r: Response) => void> = [];
    apiFetch.mockImplementation(() => new Promise<Response>((r) => pending.push(r)));
    render(
      <PublishPopover appUrl="https://bikes.onrender.com" appHost="bikes.onrender.com" publishable
        site={null} onGetDomain={() => {}} onClose={() => {}} />,
    );
    const status = screen.getByRole("status", { name: "Loading publish options" });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.querySelectorAll(".animate-shimmer")).toHaveLength(5);
    for (const sweep of Array.from(status.querySelectorAll(".animate-shimmer"))) expect(sweep.className).toContain("motion-reduce:hidden");
    expect(document.querySelector(".animate-pulse")).toBeNull();
    expect(status.querySelector(".bg-\\[\\#f4f4f4\\], .bg-\\[\\#ededed\\]")).toBeNull();

    await act(async () => {
      for (const resolve of pending.splice(0)) resolve(response({}, 500));
    });
    await ready();
    expect(screen.queryByRole("status", { name: "Loading publish options" })).toBeNull();
  });
});
