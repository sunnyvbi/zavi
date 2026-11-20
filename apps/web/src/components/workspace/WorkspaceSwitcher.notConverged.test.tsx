// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const fixture = vi.hoisted(() => ({
  result: "ok" as "ok" | "refused" | "not_converged" | "throw",
  switched: [] as string[],
}));
const signOut = vi.hoisted(() => vi.fn(async (): Promise<{ error: unknown }> => ({ error: null })));

vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string) => {
    if (path === "/api/v1/tenants/mine") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tenants: [
            { tenant_id: "tenant-a", slug: "a", display_name: "Acme", role: "owner" },
            { tenant_id: "tenant-b", slug: "b", display_name: "Beta", role: "owner" },
          ],
        }),
      };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  },
}));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signOut } }) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-a" }));
vi.mock("@/lib/workspace/tenantSwitch", () => ({
  switchToTenantDetailed: async (id: string) => {
    fixture.switched.push(id);
    if (fixture.result === "throw") throw new Error("network");
    return fixture.result;
  },
}));

import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const RETRY = "Couldn't switch workspace. Try again.";
const reload = vi.fn();
const replace = vi.fn();
const originalLocation = window.location;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};

beforeEach(() => {
  fixture.result = "ok";
  fixture.switched.length = 0;
  reload.mockClear();
  replace.mockClear();
  signOut.mockClear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: "https://www.zaviagent.com/workspace?tab=build&build=b1&buildThread=new", reload, replace },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

async function switchToBeta() {
  const view = render(
    <div data-testid="workspace-a">
      <button type="button">Acme action</button>
      <WorkspaceSwitcher companyName="Acme" companyInitial="A" onOpenHome={() => {}} />
    </div>,
  );
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Acme: switch workspace" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Beta/ }));
  await flush();
  await flush();
  return view;
}

function workspaceARoot(): HTMLElement {
  const el = screen.getByTestId("workspace-a");
  let top: HTMLElement = el;
  while (top.parentElement && top.parentElement !== document.body) top = top.parentElement;
  return top;
}

describe("WorkspaceSwitcher when the server switched but the token did not converge", () => {
  it("blocks company A and offers sign out instead of the retry message", async () => {
    fixture.result = "not_converged";
    await switchToBeta();
    expect(fixture.switched).toEqual(["tenant-b"]);
    expect(screen.queryByText(RETRY)).toBeNull();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Beta");
    expect(workspaceARoot().hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("button", { name: "Acme action" }).closest("[inert]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();

    await flush();
    expect(workspaceARoot().hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("signs out and leaves for /login only after sign-out succeeds", async () => {
    fixture.result = "not_converged";
    await switchToBeta();
    signOut.mockResolvedValueOnce({ error: new Error("offline") });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await flush();
    expect(screen.getByText("Couldn't sign you out. Try again.")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(workspaceARoot().hasAttribute("inert")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await flush();
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("a switch that throws is treated as not converged, since the server may already have switched", async () => {
    fixture.result = "throw";
    await switchToBeta();
    expect(screen.queryByText(RETRY)).toBeNull();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(workspaceARoot().hasAttribute("inert")).toBe(true);
  });

  it("a network blip is recoverable: Try again re-runs the switch and reloads once it converges, with no sign-out", async () => {
    fixture.result = "throw";
    await switchToBeta();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fixture.result = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(fixture.switched).toEqual(["tenant-b", "tenant-b"]);
    expect(replace.mock.calls).toEqual([["https://www.zaviagent.com/workspace?tab=build"]]);
    expect(reload).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("a retry that still does not converge keeps company A blocked", async () => {
    fixture.result = "not_converged";
    await switchToBeta();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(fixture.switched).toEqual(["tenant-b", "tenant-b"]);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(workspaceARoot().hasAttribute("inert")).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("WorkspaceSwitcher when the server refused the switch", () => {
  it("keeps the retry message and leaves company A usable", async () => {
    fixture.result = "refused";
    await switchToBeta();
    expect(screen.getByText(RETRY)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(workspaceARoot().hasAttribute("inert")).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("WorkspaceSwitcher on a converged switch", () => {
  it("from a settings page with a #section and no build link, it really reloads (a same-URL replace is only a hash jump)", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: "https://www.zaviagent.com/workspace?tab=settings#team", reload, replace },
    });
    fixture.result = "ok";
    await switchToBeta();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("with a build link and a #section, it drops the build link and keeps the section", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: "https://www.zaviagent.com/workspace?tab=build&build=b1#log", reload, replace },
    });
    fixture.result = "ok";
    await switchToBeta();
    expect(replace.mock.calls).toEqual([["https://www.zaviagent.com/workspace?tab=build#log"]]);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads exactly once", async () => {
    fixture.result = "ok";
    await switchToBeta();
    expect(replace.mock.calls).toEqual([["https://www.zaviagent.com/workspace?tab=build"]]);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByText(RETRY)).toBeNull();
  });
});
