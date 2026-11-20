// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { DomainsView } from "./WebsiteConsole";

const LIVE = { label: "acme", hostname: "acme.zaviagent.com", url: "https://acme.zaviagent.com", status: "live" };
const DOMAIN = {
  id: "d1",
  hostname: "app.acme.com",
  domain_type: "subdomain",
  status: "verified",
  dns_records: [],
  last_error: null,
  last_checked_at: null,
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("DomainsView — Zavi address lock", () => {
  it("disables Edit URL with the reason while a custom domain exists, and re-enables it once the last one is removed", async () => {
    let domains = [DOMAIN];
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/website/builtin-url") return ok({ builtin: LIVE, base_domain: "zaviagent.com", custom_domain_attached: domains.length > 0 });
      if (url === "/api/website/custom-domains/d1" && init?.method === "DELETE") {
        domains = [];
        return ok({});
      }
      if (url === "/api/website/custom-domains") return ok({ domains });
      return ok({});
    });
    render(<DomainsView deployedUrl={null} />);
    const edit = await screen.findByRole("button", { name: /Edit URL/ });
    await waitFor(() => expect(edit).toHaveProperty("disabled", true));
    expect(screen.getByText("Remove your custom domain first to change your Zavi address.")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /remove/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Edit URL/ })).toHaveProperty("disabled", false));
    expect(screen.queryByText("Remove your custom domain first to change your Zavi address.")).toBeNull();
  });
});
