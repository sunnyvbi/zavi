// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  routes: [] as Array<{ route: string; label: string; status: string; error: string | null; lists: unknown[] }>,
  gmail: undefined as { status: string } | undefined,
  extraMeta: [] as Array<{ slug: string }>,
  hang: false,
  listsFail: false,
  keyResult: null as unknown,
  listsGate: null as Promise<void> | null,
  startComposioConnect: vi.fn(async (_toolkit: string) => {}),
  calls: [] as Array<{ path: string; method: string }>,
  removed: new Set<string>(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=brain"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/workspace",
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: { method?: string }) => {
    h.calls.push({ path, method: init?.method ?? "GET" });
    if (path === "/api/connectors/composio/klaviyo/disconnect") h.removed.add("composio.klaviyo");
    if (h.listsFail && path === "/api/workspace/email-test-lists") return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: { message: "down" } }) });
    return h.hang ? new Promise(() => {}) : (path === "/api/workspace/email-test-lists" && h.listsGate ? h.listsGate : Promise.resolve()).then(() => ({
      ok: true,
      status: 200,
      json: async () => (path === "/api/workspace/email-test-lists" ? { routes: h.routes, orphans: [], gmail: h.gmail } : path === "/api/connectors/email" && h.keyResult ? h.keyResult : {}),
    }));
  },
}));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-1" }));
const META: Array<{ slug: string }> = [];
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): Record<string, unknown> => {
    const result = { data: table === "connector_metadata" ? [...META, ...h.extraMeta].filter((r) => !h.removed.has(r.slug)) : [], error: null };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad),
    };
    return q;
  };
  return {
    createBrowserSupabase: () => ({
      from: (table: string) => chain(table),
      auth: { getSession: async () => ({ data: { session: null } }) },
    }),
  };
});
vi.mock("@/app/connectors/composioConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/connectors/composioConnect")>()),
  startComposioConnect: (toolkit: string) => h.startComposioConnect(toolkit),
}));
vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({ role: "owner", currentUserId: "user-1", openTab: vi.fn(), tenantName: "Pixel Drift" }),
  useWorkspaceOptional: () => ({ role: "owner", currentUserId: "user-1" }),
}));
vi.mock("./layout/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./layout/shared")>()),
  useOpenStatic: () => vi.fn(),
}));
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

const linkedin = (token_expires_at: string | null) => ({
  slug: "linkedin_social", team_id: "urn:li:person:1", team_name: "Ada Founder", account_login: null, repo_full_names: null,
  repo_ids: null, selected_repo_ids: null, default_repo_full_name: null, connected_at: "2026-10-01T00:00:00Z", token_expires_at, scopes: [],
});

beforeEach(() => {
  h.extraMeta = [];
  h.calls = [];
  h.removed.clear();
});
afterEach(cleanup);

async function openConnectors() {
  render(<SettingsTab only="integration" />);
  for (let i = 0; i < 6; i++) await act(async () => {});
  const strip = screen.getByRole("heading", { name: "Needs attention" }).parentElement as HTMLElement;
  return strip;
}

describe("Integrations shows a LinkedIn the publish worker found revoked as needing reconnect", () => {
  it("a LinkedIn whose token was marked expired at publish moves to Needs attention with a Reconnect button", async () => {
    h.extraMeta = [linkedin(new Date(Date.now() - 1000).toISOString())];
    const strip = await openConnectors();

    expect(within(strip).queryByText(/Every connection is working/)).toBeNull();
    const tile = strip.querySelector("#connector-linkedin_social") as HTMLElement;
    expect(tile).not.toBeNull();
    expect(within(tile).getByText("Needs reconnect")).toBeTruthy();
    expect(within(tile).getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connected" })).toBeNull();
    expect(screen.queryAllByText("Connected").filter((el) => !strip.contains(el))).toHaveLength(0);
    expect(document.querySelectorAll("#connector-linkedin_social")).toHaveLength(1);
  });

  it("a LinkedIn with a live token stays in Connected", async () => {
    h.extraMeta = [linkedin(new Date(Date.now() + 40 * 86400_000).toISOString())];
    const strip = await openConnectors();

    expect(strip.querySelector("#connector-linkedin_social")).toBeNull();
    expect(within(strip).getByText(/Every connection is working/)).toBeTruthy();
    const connected = screen.getByRole("heading", { name: "Connected" }).parentElement as HTMLElement;
    expect(connected.querySelector("#connector-linkedin_social")).not.toBeNull();
  });
});
