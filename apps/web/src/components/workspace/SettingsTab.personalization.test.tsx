// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, render } from "@testing-library/react";

const nav = vi.hoisted(() => ({ query: "", role: "owner" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/workspace",
}));
const DOC = {
  id: "doc-1",
  filename: "pricing-history.pdf",
  mime: "application/pdf",
  size_bytes: 2048,
  status: "approved",
  version: 1,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (path === "/api/personalization/documents" ? { documents: [DOC] } : {}),
    }),
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));
vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({ role: nav.role, currentUserId: "user-1", openTab: vi.fn(), tenantName: "Pixel Drift" }),
  useWorkspaceOptional: () => ({ role: nav.role, currentUserId: "user-1" }),
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

import { SettingsTab, settingsSectionsFor } from "./SettingsTab";

beforeEach(() => {
  window.history.replaceState(null, "", "/workspace?tab=settings");
});
afterEach(() => {
  cleanup();
  nav.query = "";
  nav.role = "owner";
});

async function open(query: string) {
  nav.query = query;
  const view = render(<SettingsTab />);
  await act(async () => {});
  await act(async () => {});
  return view.container;
}

describe("Settings → Personalization", () => {
  it("is a Settings section for owners and members", () => {
    for (const readOnly of [false, true]) {
      const personalization = settingsSectionsFor(readOnly).find((s) => s.id === "personalization");
      expect(personalization?.label).toBe("Personalization");
    }
  });

  it("lists uploaded files with a Remove button", async () => {
    const root = await open("tab=settings&section=personalization");
    expect(root.querySelector("section#personalization")).not.toBeNull();
    expect(root.textContent).toContain("pricing-history.pdf");
    const remove = Array.from(root.querySelectorAll("section#personalization button")).filter((b) =>
      /remove/i.test(b.textContent ?? ""),
    );
    expect(remove.length).toBeGreaterThan(0);
  });

  it("members see the files but cannot remove them", async () => {
    nav.role = "member";
    const root = await open("tab=settings&section=personalization");
    expect(root.textContent).toContain("pricing-history.pdf");
    const remove = Array.from(root.querySelectorAll("section#personalization button")).filter((b) =>
      /remove/i.test(b.textContent ?? ""),
    );
    expect(remove).toHaveLength(0);
  });
});
