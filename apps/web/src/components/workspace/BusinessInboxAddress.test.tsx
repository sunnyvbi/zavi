// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: api.fetch }));

import { BusinessInboxAddress } from "./BusinessInboxAddress";
import { OverviewView } from "./website/WebsiteConsole";

const ADDRESS = "home-cleaning@inbox.zaviagent.com";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  api.fetch.mockReset();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(cleanup);

function overview(site: boolean) {
  return (
    <OverviewView
      data={{
        app: { name: "Home Cleaning", description: null, created_at: "2026-10-29T00:00:00.000Z", deployed_url: "https://home-cleaning.zaviagent.com", build_status: "done" },
        visibility: "public",
        badge_hidden: false,
        ...(site ? { site: { id: "33333333-3333-4333-8333-333333333333" } } : {}),
      } as Parameters<typeof OverviewView>[0]["data"]}
      canManage
      onPatch={async () => true}
      onOpenSettings={() => {}}
      onSendInvites={() => {}}
    />
  );
}

describe("BusinessInboxAddress", () => {
  it("shows the workspace inbox address from the inbox endpoint and copies exactly that address", async () => {
    api.fetch.mockResolvedValue(json({ address: `  ${ADDRESS} `, addresses: [] }));
    render(<BusinessInboxAddress variant="card" />);
    expect((await screen.findByTestId("business-inbox")).textContent).toContain(ADDRESS);
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(api.fetch).toHaveBeenCalledWith("/api/workspace/inbox-addresses");
    await act(async () => fireEvent.click(screen.getByTestId("business-inbox-copy")));
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(screen.getByTestId("business-inbox-copy").textContent).toContain("Copied");
  });

  it("renders nothing, not an empty heading, when there is no address, the read fails, or the body is malformed", async () => {
    for (const reply of [
      () => Promise.resolve(json({ address: null, addresses: [] })),
      () => Promise.resolve(json({ error: { code: "x" } }, 500)),
      () => Promise.reject(new Error("offline")),
      () => Promise.resolve(json({ address: 42 })),
      () => Promise.resolve(json({ address: "   " })),
    ]) {
      api.fetch.mockImplementationOnce(reply);
      const view = render(<BusinessInboxAddress variant="card" />);
      await waitFor(() => expect(api.fetch).toHaveBeenCalled());
      await act(async () => undefined);
      expect(view.container.innerHTML).toBe("");
      view.unmount();
      api.fetch.mockClear();
    }
  });

  it("a denied clipboard does not claim it copied", async () => {
    api.fetch.mockResolvedValue(json({ address: ADDRESS }));
    writeText.mockRejectedValue(new Error("denied"));
    render(<BusinessInboxAddress variant="inline" />);
    await screen.findByTestId("business-inbox");
    await act(async () => fireEvent.click(screen.getByTestId("business-inbox-copy")));
    expect(screen.getByTestId("business-inbox-copy").textContent).not.toContain("Copied");
  });

  it("the site Overview shows the inbox card and the old workspace-app Overview does not ask for it", async () => {
    api.fetch.mockImplementation(async (path: string) => path === "/api/workspace/inbox-addresses" ? json({ address: ADDRESS }) : json({}));
    const site = render(overview(true));
    expect((await screen.findByTestId("business-inbox")).textContent).toContain(ADDRESS);
    site.unmount();
    api.fetch.mockClear();
    render(overview(false));
    await act(async () => undefined);
    expect(screen.queryByTestId("business-inbox")).toBeNull();
    expect(api.fetch.mock.calls.some((call) => call[0] === "/api/workspace/inbox-addresses")).toBe(false);
  });
});
