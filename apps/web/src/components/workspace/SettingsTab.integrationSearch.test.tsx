// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/workspace",
}));
vi.mock("@/lib/api", () => ({
  apiFetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));
vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({ role: "owner", currentUserId: "user-1", openTab: vi.fn(), tenantName: "Pixel Drift" }),
  useWorkspaceOptional: () => ({ role: "owner", currentUserId: "user-1" }),
}));
vi.mock("./layout/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./layout/shared")>()),
  useOpenStatic: () => vi.fn(),
}));
vi.mock("./TeamRosterCard", () => ({ TeamRosterCard: () => null }));
vi.mock("./AgentInboxAddresses", () => ({ AgentInboxAddresses: () => null }));
vi.mock("./settings/useConnectorRecommendations", () => ({ useConnectorRecommendations: () => [] }));
vi.mock("./settings/useSlackScopeStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings/useSlackScopeStatus")>()),
  useSlackScopeStatus: () => [],
}));
vi.mock("./settings/useConnectorSyncStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings/useConnectorSyncStatus")>()),
  useConnectorSyncStatus: () => ({}),
}));

import { SettingsTab } from "./SettingsTab";

afterEach(() => {
  cleanup();
  nav.query = "";
});

async function openIntegrations() {
  window.history.replaceState(null, "", "/workspace?tab=brain#integration");
  nav.query = "tab=settings&section=integration";
  render(<SettingsTab />);
  await act(async () => {});
  return screen.getByRole("searchbox", { name: "Search integrations" }) as HTMLInputElement;
}

describe("Connect Integrations search box shows one clear control", () => {
  it("hides the browser's native search cancel button on the input", async () => {
    const input = await openIntegrations();
    expect(input.type).toBe("search");
    expect(input.className.split(/\s+/)).toContain("[&::-webkit-search-cancel-button]:appearance-none");
  });

  it("typing shows exactly one clear button, and clicking it empties the box and refocuses it", async () => {
    const input = await openIntegrations();
    expect(screen.queryAllByRole("button", { name: "Clear search" })).toHaveLength(0);

    fireEvent.change(input, { target: { value: "sdf" } });
    expect(input.value).toBe("sdf");
    const clears = screen.getAllByRole("button", { name: "Clear search" });
    expect(clears).toHaveLength(1);
    expect(input.parentElement!.querySelectorAll("button")).toHaveLength(1);

    clears[0].focus();
    expect(document.activeElement).toBe(clears[0]);
    fireEvent.click(clears[0]);

    expect(input.value).toBe("");
    expect(screen.queryAllByRole("button", { name: "Clear search" })).toHaveLength(0);
    expect(document.activeElement).toBe(input);
  });
});
