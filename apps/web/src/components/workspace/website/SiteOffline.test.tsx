// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn(), update: vi.fn(), close: vi.fn() } }));

import { DomainsView } from "./WebsiteConsole";
import { PublishPopover } from "./PublishPopover";

const HOST = "create-a-wedding-website-7f3f7cd1.zaviagent.com";
const builtin = (status: string) => ({
  label: "create-a-wedding-website-7f3f7cd1",
  hostname: HOST,
  url: `https://${HOST}`,
  status,
  dns_ready: true,
});

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function wire(status: string) {
  apiFetch.mockImplementation(async (url: string) => {
    if (url === "/api/website/builtin-url") return ok({ builtin: builtin(status), base_domain: "zaviagent.com", custom_domain_attached: false });
    if (url === "/api/website/custom-domains") return ok({ domains: [] });
    if (url === "/api/website/overview?app=workspace") return ok({ visibility: "public" });
    if (url.startsWith("/api/website/publish-status")) return ok({ pending: 0, published: 1, last_published_at: "2026-09-29T12:00:00Z" });
    return ok({});
  });
}

function popover() {
  return render(
    <PublishPopover
      appUrl="https://create-a-wedding-website-7f3f7cd1.onrender.com"
      appHost={HOST}
      publishable
      onGetDomain={() => {}}
      onClose={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("a suspended site is never shown as Live (DEL-1323 B4)", () => {
  it("Settings > Domains shows Offline with the reason, not Live", async () => {
    wire("offline");
    render(<DomainsView deployedUrl={null} />);
    await screen.findByText("Offline");
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.getByText("Your site is offline. Its hosting is suspended, so visitors see an error page.")).toBeTruthy();
  });

  it("Settings > Domains still says Live for a serving site", async () => {
    wire("live");
    render(<DomainsView deployedUrl={null} />);
    await screen.findByText("Live");
    expect(screen.queryByText("Offline")).toBeNull();
  });

  it("the Publish popover says Offline, offers no dead link to copy, and no Publish to a suspended host", async () => {
    wire("offline");
    popover();
    await screen.findByText("Offline");
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.getByText("Your site's hosting is suspended, so visitors see an error page")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull());
    const publish = screen.queryByRole("button", { name: /^Publish$/ });
    expect(publish === null || (publish as HTMLButtonElement).disabled).toBe(true);
  });

  it("the Publish popover still says Live for a serving site", async () => {
    wire("live");
    popover();
    await screen.findByText("Live");
    expect(screen.queryByText("Offline")).toBeNull();
  });
});
