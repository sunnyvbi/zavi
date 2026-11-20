// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: vi.fn() }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: vi.fn() }));

import { ComposioDone as ComposioDonePage } from "./ComposioDone";
import { COMPOSIO_DONE_CHANNEL } from "../../composioConnect";

function listen() {
  const got: unknown[] = [];
  const ch = new BroadcastChannel(COMPOSIO_DONE_CHANNEL);
  ch.onmessage = (e) => {
    if ((e.data as { toolkit?: string } | null)?.toolkit === "acme_pins") got.push(e.data);
  };
  return { got, close: () => ch.close() };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("Composio done page (the tab Composio returns to)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("says the app is connected, tells the Zavi tab, and closes itself", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    const l = listen();
    const { container } = render(<ComposioDonePage searchParams={{ toolkit: "acme_pins", status: "connected" }} />);
    await tick();
    l.close();
    expect(container.textContent).toContain("Acme Pins is connected.");
    expect(container.textContent).toContain("You can close this tab.");
    expect(close).toHaveBeenCalledOnce();
    expect(l.got).toEqual([{ toolkit: "acme_pins", status: "connected" }]);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/workspace?tab=settings&composio_acme_pins=connected");
    cleanup();
    expect(render(<ComposioDonePage searchParams={{ toolkit: "pinterest", status: "connected" }} />).container.textContent).toContain(
      "Pinterest is connected.You can close this tab.",
    );
    expect(container.querySelector("nav, aside, [data-workspace-shell]")).toBeNull();
  });

  it("shows the plain failure reason, stays open, and tells the Zavi tab to stop waiting", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    const l = listen();
    const { container } = render(
      <ComposioDonePage searchParams={{ toolkit: "acme_pins", status: "error", reason: "connection_not_owned" }} />,
    );
    await tick();
    l.close();
    expect(container.textContent).toContain("Acme Pins didn't connect.");
    expect(container.textContent).toContain("Composio could not confirm this account for your workspace.");
    expect(close).not.toHaveBeenCalled();
    expect(l.got).toEqual([{ toolkit: "acme_pins", status: "error" }]);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/workspace?tab=settings&composio_error=acme_pins&code=connection_not_owned",
    );
  });

  it("never echoes a hostile toolkit or an unknown reason", async () => {
    vi.spyOn(window, "close").mockImplementation(() => {});
    const { container } = render(
      <ComposioDonePage searchParams={{ toolkit: "<img src=x>", status: "error", reason: "<b>pwned</b>" }} />,
    );
    await tick();
    expect(container.innerHTML).not.toContain("img");
    expect(container.innerHTML).not.toContain("pwned");
    expect(container.textContent).toContain("The app didn't connect.");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/workspace?tab=settings&composio_error=unknown");
  });
});
