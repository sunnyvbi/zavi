// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const disconnectStatus = { value: 401 };
const posts: string[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string }) => {
    if (init?.method === "POST") {
      posts.push(url);
      return { ok: disconnectStatus.value < 400, status: disconnectStatus.value, json: () => Promise.resolve({}) };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({ toolkits: [], requested: [] }) };
  },
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ like: () => Promise.resolve({ data: [{ slug: "composio.mailchimp" }, { slug: "composio.klaviyo" }] }) }),
      }),
    }),
  }),
}));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-1" }));
const forgetEmailTestLists = vi.fn();
vi.mock("@/lib/workspace/emailCampaignSettingsApi", () => ({ forgetEmailTestLists: () => forgetEmailTestLists() }));
const showConnectorError = vi.fn();
vi.mock("@/components/workspace/settings/connectorErrorDialog", () => ({
  showConnectorError: (p: unknown) => showConnectorError(p),
}));
vi.mock("../composioConnect", () => ({ startComposioConnect: vi.fn(), COMPOSIO_CONNECT_LINE: "" }));

import { useComposioApps } from "../ComposioApps";

const originalLocation = window.location;

beforeEach(() => {
  posts.length = 0;
  forgetEmailTestLists.mockReset();
  showConnectorError.mockReset();
  vi.stubGlobal("confirm", () => true);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: "http://localhost/workspace/settings", pathname: "/workspace/settings" },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("Disconnecting a Composio email tool", () => {
  for (const tool of ["mailchimp", "klaviyo"]) {
    it(`${tool}: an expired session (401) keeps the tool connected and sends the founder to log in`, async () => {
      disconnectStatus.value = 401;
      const { result } = renderHook(() => useComposioApps());
      await waitFor(() => expect(result.current.connected.has(tool)).toBe(true));
      await act(async () => {
        await result.current.disconnect(tool);
      });
      expect(posts).toEqual([`/api/connectors/composio/${tool}/disconnect`]);
      expect(result.current.connected.has(tool)).toBe(true);
      expect(forgetEmailTestLists).not.toHaveBeenCalled();
      expect(window.location.href).toBe("/login?next=%2Fworkspace%2Fsettings");
    });
  }

  it("a successful disconnect removes the tool", async () => {
    disconnectStatus.value = 200;
    const { result } = renderHook(() => useComposioApps());
    await waitFor(() => expect(result.current.connected.has("mailchimp")).toBe(true));
    await act(async () => {
      await result.current.disconnect("mailchimp");
    });
    expect(result.current.connected.has("mailchimp")).toBe(false);
    expect(forgetEmailTestLists).toHaveBeenCalledTimes(1);
    expect(showConnectorError).not.toHaveBeenCalled();
  });
});
