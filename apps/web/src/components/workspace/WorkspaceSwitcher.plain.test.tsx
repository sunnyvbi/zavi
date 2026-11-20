// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const calls = vi.hoisted(() => [] as string[]);
const gate = vi.hoisted(() => ({ canAdd: true as boolean | null }));

vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, opts: { method?: string } = {}) => {
    calls.push(`${opts.method ?? "GET"} ${path}`);
    if (path === "/api/v1/tenants/mine") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tenants: [
            { tenant_id: "tenant-a", slug: "a", display_name: "Yoga Studio", role: "owner", website: "https://yoga.studio" },
          ],
        }),
      };
    }
    if (path === "/api/billing/credits") {
      return { ok: true, status: 200, json: async () => ({ tier: "pro" }) };
    }
    if (path === "/api/onboarding/can-add-company") {
      return { ok: true, status: 200, json: async () => ({ allowed: true }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  },
}));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({
  getActiveTenantId: async () => "tenant-a",
  clearActiveTenantCache: () => {},
}));
vi.mock("@/lib/browser-tenant", () => ({ writeStoredTenant: async () => {} }));
vi.mock("@/lib/ensure-tenant-claim", () => ({ refreshSessionUntilClaim: async () => false }));
vi.mock("@/lib/gatekeeper", () => ({ useCanAddCompany: () => gate.canAdd }));

import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
};

afterEach(() => {
  cleanup();
  calls.length = 0;
  gate.canAdd = true;
});

describe("company header is plain for a user with one company", () => {
  it("a Pro user with one company and Add company allowed gets no menu, chevron or switch, only an Add company link", async () => {
    const onOpenHome = vi.fn();
    const { container } = render(
      <WorkspaceSwitcher companyName="Yoga Studio" companyInitial="Y" onOpenHome={onOpenHome} />,
    );
    await flush();

    expect(container.querySelector("[aria-haspopup]")).toBeNull();
    expect(container.querySelector("[aria-expanded]")).toBeNull();
    expect(screen.queryByRole("button", { name: /switch workspace/ })).toBeNull();
    const header = screen.getByRole("button", { name: "Yoga Studio: workspace home" });
    expect(header.querySelector("svg")).toBeNull();
    expect(header.textContent).toMatch(/^Y?Yoga Studio$/);
    expect(container.querySelectorAll("button")).toHaveLength(1);

    fireEvent.click(header);
    await flush();
    expect(onOpenHome).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
    const add = screen.getByRole("link", { name: "Add company" });
    expect(add.getAttribute("href")).toBe("/start?new=1");
    expect(add.closest("button")).toBeNull();
    expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("a one-company user who may not add a company sees no Add company entry", async () => {
    for (const canAdd of [false, null]) {
      gate.canAdd = canAdd;
      const { unmount } = render(<WorkspaceSwitcher companyName="Yoga Studio" companyInitial="Y" onOpenHome={() => {}} />);
      await flush();
      expect(screen.getByRole("button", { name: "Yoga Studio: workspace home" })).toBeTruthy();
      expect(screen.queryByRole("link", { name: "Add company" })).toBeNull();
      expect(screen.queryByText("Add company")).toBeNull();
      unmount();
    }
  });

  it("shows the current company's own favicon as the avatar", async () => {
    const { container } = render(
      <WorkspaceSwitcher companyName="Yoga Studio" companyInitial="Y" onOpenHome={() => {}} />,
    );
    await flush();
    const sources = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(sources).toEqual(["https://yoga.studio/favicon.ico"]);
  });
});
