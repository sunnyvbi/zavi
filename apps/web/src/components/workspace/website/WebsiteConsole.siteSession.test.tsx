// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role: "owner", openTab: vi.fn() }),
}));

import { WebsiteConsole, overviewUrl, __resetAppCatalogInflight } from "./WebsiteConsole";

const RUN_A = "aaaaaaaa-1111-4000-8000-00000000000a";
const RUN_B = "bbbbbbbb-1111-4000-8000-00000000000b";
const RUN_OLD = "cccccccc-1111-4000-8000-00000000000c";

const siteOverview = (name: string, id: string, host: string) => ({
  app: { name, description: null, created_at: "2026-10-01T00:00:00Z", deployed_url: `https://${host}`, build_status: "done" },
  visibility: null,
  badge_hidden: null,
  site: { id, hostname: host, status: "live" },
});

function wire() {
  apiFetch.mockImplementation(async (url: string) => {
    if (url.includes(`build_session_id=${RUN_A}`)) return { ok: true, json: async () => siteOverview("Lucky Paws", "site-a", "lucky-paws.zavi.site") };
    if (url.includes(`build_session_id=${RUN_B}`)) return { ok: true, json: async () => siteOverview("Mile High", "site-b", "mile-high.zavi.site") };
    if (url.includes("/api/website/app-catalog")) {
      return { ok: true, json: async () => ({ connected: true, supported: true, dialect: "postgres", can_write: true, tables: [] }) };
    }
    if (url.includes("/api/website/app-invites")) return { ok: true, json: async () => ({ connected: true, signup_available: true, invites: [] }) };
    return {
      ok: true,
      json: async () => ({
        app: { name: "Old App", description: null, created_at: null, deployed_url: "https://old.test", build_status: "done" },
        visibility: "public",
        badge_hidden: false,
      }),
    };
  });
}

const called = () => apiFetch.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  apiFetch.mockReset();
  __resetAppCatalogInflight();
  wire();
});
afterEach(() => cleanup());

describe("WebsiteConsole in a site's Build session", () => {
  it("names the session in the overview read", () => {
    expect(overviewUrl(RUN_A)).toBe(`/api/website/overview?build_session_id=${RUN_A}`);
    expect(overviewUrl(null)).toBe("/api/website/overview?app=workspace");
  });

  it("each of two sites shows ITS overview, and only the Overview section", async () => {
    const { rerender } = render(<WebsiteConsole buildSessionId={RUN_A} />);
    expect(await screen.findByRole("heading", { name: "Lucky Paws" })).toBeTruthy();
    const nav = document.querySelector("nav") as HTMLElement;
    expect(nav.textContent).toContain("Overview");
    expect(nav.textContent).not.toMatch(/Users|Data/);
    expect(nav.textContent).toContain("Domains");
    expect(screen.queryByText("Platform Badge")).toBeNull();
    expect(screen.queryByRole("button", { name: /Send Invites/ })).toBeNull();
    expect(screen.queryByText("Invite Users")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit app details" })).toBeNull();

    rerender(<WebsiteConsole buildSessionId={RUN_B} />);
    expect(await screen.findByRole("heading", { name: "Mile High" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Lucky Paws" })).toBeNull();

    expect(called().some((u) => /app-catalog|app-rows|app-invites|custom-domains|builtin-url/.test(u))).toBe(false);
    expect(called().filter((u) => u.startsWith("/api/website/overview"))).toEqual([
      `/api/website/overview?build_session_id=${RUN_A}`,
      `/api/website/overview?build_session_id=${RUN_B}`,
    ]);
  });

  it("an old-flow session keeps the full workspace-app console", async () => {
    render(<WebsiteConsole buildSessionId={RUN_OLD} />);
    expect(await screen.findByRole("heading", { name: "Old App" })).toBeTruthy();
    const nav = document.querySelector("nav") as HTMLElement;
    expect(nav.textContent).toMatch(/Users/);
    expect(nav.textContent).toMatch(/Domains/);
    expect(screen.getByText("Platform Badge")).toBeTruthy();
    await waitFor(() => expect(called().some((u) => u.includes("/api/website/app-catalog"))).toBe(true));
  });
});
