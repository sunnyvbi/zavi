
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: vi.fn() }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: vi.fn() }));
vi.mock("@/components/workspace/settings/ConnectorTile", () => ({
  ConnectorTile: () => null,
  TileMenu: () => null,
}));
vi.mock("@/components/workspace/settings/connectorErrorDialog", () => ({
  showConnectorError: vi.fn(),
}));

import { dedupe, PAGE_SIZE } from "./PipedreamApps";

const app = (slug: string) => ({ slug, name: slug, needs_setup: false });

describe("dedupe", () => {
  it("does NOT cap the list (the old 8-tile ceiling is gone)", () => {
    const raw = Array.from({ length: 120 }, (_, i) => app(`app_${i}`));
    expect(dedupe(raw, new Set()).length).toBe(120);
  });

  it("collapses Pipedream auth variants to one tile per app", () => {
    const raw = [app("slack_bot"), app("slack_v2"), app("notion_api_key"), app("notion")];
    expect(dedupe(raw, new Set()).map((a) => a.slug)).toEqual(["slack_bot", "notion_api_key"]);
  });

  it("drops apps already covered by the native / Composio rails", () => {
    const covered = new Set(["stripe", "googlecalendar"]);
    const raw = [app("stripe"), app("google_calendar"), app("linear")];
    expect(dedupe(raw, covered).map((a) => a.slug)).toEqual(["linear"]);
  });

  it("drops apps this tenant already connected (they render in Connected)", () => {
    const raw = [app("linear"), app("posthog")];
    expect(dedupe(raw, new Set(), new Set(["posthog"])).map((a) => a.slug)).toEqual(["linear"]);
  });

  it("shows 50 per page by default", () => {
    expect(PAGE_SIZE).toBe(50);
  });
});
