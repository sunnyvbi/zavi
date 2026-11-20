// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, render } from "@testing-library/react";

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
vi.mock("./WorkspaceMembersPanel", () => ({ WorkspaceMembersPanel: () => React.createElement("div", { "data-panel": "members" }) }));
vi.mock("./CompanyFactsPanel", () => ({ CompanyFactsPanel: () => React.createElement("div", { "data-panel": "company" }) }));
vi.mock("./settings/DataNotesPanel", () => ({ DataNotesPanel: () => null }));
vi.mock("./settings/McpClientsPanel", () => ({ McpClientsPanel: () => React.createElement("div", { "data-panel": "mcp" }) }));
vi.mock("./settings/BillingCreditsPanel", () => ({ BillingCreditsPanel: () => React.createElement("div", { "data-panel": "billing" }) }));
vi.mock("@/components/account/AccountSecurityPanel", () => ({
  AccountSecurityPanel: () => React.createElement("div", { "data-panel": "account" }),
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

beforeEach(() => {
  window.history.replaceState(null, "", "/workspace?tab=settings");
});
afterEach(() => {
  cleanup();
  nav.query = "";
});

async function open(query: string) {
  nav.query = query;
  const view = render(<SettingsTab />);
  await act(async () => {});
  return view.container;
}

describe("Settings deep links name a section the way the founder reads it", () => {
  it("?section=members opens Members, not Company", async () => {
    const root = await open("tab=settings&section=members");
    expect(root.querySelector("section#team")).not.toBeNull();
    expect(root.querySelector('[data-panel="members"]')).not.toBeNull();
    expect(root.querySelector("section#company")).toBeNull();
  });

  it("the section id itself still works", async () => {
    const root = await open("tab=settings&section=team");
    expect(root.querySelector("section#team")).not.toBeNull();
  });

  it("a label with spaces or symbols resolves too, and is case-blind", async () => {
    const mcp = await open("tab=settings&section=MCP");
    expect(mcp.querySelector('[data-panel="mcp"]')).not.toBeNull();
    cleanup();
    const billing = await open("tab=settings&section=billing-credits");
    expect(billing.querySelector('[data-panel="billing"]')).not.toBeNull();
  });

  it("an unknown section stays on Company", async () => {
    const root = await open("tab=settings&section=nope");
    expect(root.querySelector("section#company")).not.toBeNull();
  });

  it("?section=account opens the Account section", async () => {
    const root = await open("tab=settings&section=account");
    expect(root.querySelector('[data-panel="account"]')).not.toBeNull();
  });
});

describe("the account menu re-opening Settings on a section", () => {
  it("switches an open Settings tab to a newly requested section, again and again", async () => {
    const view = render(<SettingsTab initialSection="team" />);
    await act(async () => {});
    expect(view.container.querySelector("section#team")).not.toBeNull();

    const later = Date.now() + 1000;
    view.rerender(<SettingsTab initialSection="account" sectionRequestedAt={later} />);
    await act(async () => {});
    expect(view.container.querySelector('[data-panel="account"]')).not.toBeNull();
    expect(window.location.hash).toBe("#account");

    view.rerender(<SettingsTab initialSection="feedback" sectionRequestedAt={later + 1} />);
    await act(async () => {});
    expect(view.container.querySelector("section#feedback")).not.toBeNull();
    view.rerender(<SettingsTab initialSection="account" sectionRequestedAt={later + 2} />);
    await act(async () => {});
    expect(view.container.querySelector('[data-panel="account"]')).not.toBeNull();
  });

  it("ignores a request older than the tab (a restored payload), so a deep link wins", async () => {
    nav.query = "tab=settings&section=email";
    const view = render(<SettingsTab />);
    await act(async () => {});
    view.rerender(<SettingsTab initialSection="account" sectionRequestedAt={1} />);
    await act(async () => {});
    expect(view.container.querySelector("section#email")).not.toBeNull();
    expect(view.container.querySelector('[data-panel="account"]')).toBeNull();
  });
});
