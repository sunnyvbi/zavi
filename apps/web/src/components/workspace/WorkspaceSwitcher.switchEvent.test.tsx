// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const order = vi.hoisted(() => [] as string[]);
const calls = () =>
  order.filter(
    (c) =>
      !c.endsWith("/api/onboarding/can-add-company") &&
      !c.endsWith("/api/billing/credits"),
  );
const fixture = vi.hoisted(() => ({ tier: "free", tenantCount: 2, canAdd: true }));

vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, opts: { method?: string } = {}) => {
    order.push(`${opts.method ?? "GET"} ${path}`);
    if (path === "/api/v1/tenants/mine") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tenants: [
            { tenant_id: "tenant-a", slug: "a", display_name: "Acme", role: "owner", website: "https://acme.com" },
            { tenant_id: "tenant-b", slug: "b", display_name: "Beta", role: "owner", website: "https://beta.io" },
          ].slice(0, fixture.tenantCount),
        }),
      };
    }
    if (path === "/api/billing/credits") {
      return { ok: true, status: 200, json: async () => ({ tier: fixture.tier }) };
    }
    if (path === "/api/onboarding/can-add-company") {
      return { ok: true, status: 200, json: async () => ({ allowed: fixture.canAdd }) };
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

import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { TENANT_SWITCH_EVENT } from "@/lib/workspace/tenantSwitch";

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};

afterEach(() => {
  cleanup();
  order.length = 0;
  fixture.tier = "free";
  fixture.tenantCount = 2;
  fixture.canAdd = true;
});

describe("WorkspaceSwitcher company icon", () => {
  it("shows each workspace's website favicon in the button and the dropdown", async () => {
    const { container } = render(
      <WorkspaceSwitcher companyName="Acme" companyInitial="A" onOpenHome={() => {}} />,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Acme: switch workspace" }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const sources = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(sources).toEqual([
      "https://acme.com/favicon.ico",
      "https://acme.com/favicon.ico",
      "https://beta.io/favicon.ico",
    ]);
  });
});

describe("WorkspaceSwitcher company-count gate", () => {
  it("one company on the Pro plan gets the plain header, not the switcher", async () => {
    fixture.tenantCount = 1;
    fixture.tier = "pro";
    const onOpenHome = vi.fn();
    render(<WorkspaceSwitcher companyName="Acme" companyInitial="A" onOpenHome={onOpenHome} />);
    await flush();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByRole("button", { name: "Acme: switch workspace" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Acme: workspace home" }));
    expect(onOpenHome).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("two companies on the Free plan get the switcher, listing both plus Add company", async () => {
    const onOpenHome = vi.fn();
    render(<WorkspaceSwitcher companyName="Acme" companyInitial="A" onOpenHome={onOpenHome} />);
    await flush();
    const trigger = screen.getByRole("button", { name: "Acme: switch workspace" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);
    expect(onOpenHome).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["AAcme", "BBeta", "Add company"]);
    expect((screen.getByRole("menuitem", { name: /Acme/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: /Beta/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("WorkspaceSwitcher Add company", () => {
  const originalLocation = window.location;
  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  it("goes to /start?new=1 without switching tenants", async () => {
    const loc = { href: "https://www.zaviagent.com/workspace", reload: vi.fn(), replace: vi.fn() };
    Object.defineProperty(window, "location", { configurable: true, value: loc });
    render(<WorkspaceSwitcher companyName="Acme" companyInitial="A" onOpenHome={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Acme: switch workspace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Add company/ }));
    await flush();
    expect(loc.href).toBe("/start?new=1");
    expect(order).not.toContain("POST /api/v1/tenants/switch");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("stays hidden when the add-company gate says no, while switching still works", async () => {
    fixture.canAdd = false;
    render(<WorkspaceSwitcher companyName="Acme" companyInitial="A" onOpenHome={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Acme: switch workspace" }));
    expect(screen.queryByText("Add company")).toBeNull();
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["AAcme", "BBeta"]);
  });
});

describe("WorkspaceSwitcher switch announcement", () => {
  it("announces the switch before the switch request leaves, exactly once", async () => {
    const heard = () => order.push("switch-event");
    window.addEventListener(TENANT_SWITCH_EVENT, heard);
    render(<WorkspaceSwitcher companyName="Acme" companyInitial="A" onOpenHome={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Acme: switch workspace" }));
    expect(calls()).toEqual(["GET /api/v1/tenants/mine"]);

    fireEvent.click(screen.getByRole("menuitem", { name: /Beta/ }));
    await flush();
    window.removeEventListener(TENANT_SWITCH_EVENT, heard);

    expect(calls()).toEqual(["GET /api/v1/tenants/mine", "switch-event", "POST /api/v1/tenants/switch"]);
    expect(screen.queryByText("Couldn't switch workspace. Try again.")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("does not announce a switch when the current workspace is picked", async () => {
    const heard = vi.fn();
    window.addEventListener(TENANT_SWITCH_EVENT, heard);
    render(<WorkspaceSwitcher companyName="Acme" companyInitial="A" onOpenHome={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Acme: switch workspace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Acme/ }));
    await flush();
    window.removeEventListener(TENANT_SWITCH_EVENT, heard);
    expect(heard).not.toHaveBeenCalled();
    expect(order).not.toContain("POST /api/v1/tenants/switch");
  });
});
