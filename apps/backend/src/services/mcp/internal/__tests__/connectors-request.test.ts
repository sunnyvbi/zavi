
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ slug: string; account_login?: string | null }>,
  blob: {} as Record<string, unknown>,
  metaError: null as null | { message: string },
  productUrl: null as unknown,
  getAppName: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "system_config") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { blob: mocks.blob }, error: null }) }),
          }),
        };
      }
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { product_url: mocks.productUrl }, error: null }) }),
          }),
        };
      }
      const filters: Record<string, string> = {};
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: string, val: string) => {
        filters[col] = val;
        return b;
      };
      b.in = async (_col: string, slugs: string[]) => ({
        data: mocks.metaError
          ? null
          : mocks.rows.filter((r) => slugs.includes(r.slug) && filters.tenant_id === "tenant-1"),
        error: mocks.metaError,
      });
      return b;
    },
  }),
}));
vi.mock("@/services/connectors/pipedream/api", () => ({ getAppName: mocks.getAppName }));
vi.mock("@/services/connectors/composio/catalog", () => ({ listComposioCatalog: async () => [] }));

import {
  validateConnectorRequest,
  callConnectorSearchTool,
  listConnectorSearchTools,
  takeRecordedConnectorRequest,
} from "../connectors-search";

beforeEach(() => {
  mocks.rows = [];
  mocks.blob = {};
  mocks.metaError = null;
  mocks.productUrl = null;
  mocks.getAppName.mockReset();
});

describe("connectors__request — advertised on the connectors server", () => {
  it("lists a `request` tool beside `search`", () => {
    const names = listConnectorSearchTools().map((t) => `${t.server_id}__${t.tool_name}`);
    expect(names).toContain("connectors__request");
  });
});

describe("validateConnectorRequest", () => {
  it("rejects an unknown slug", async () => {
    const v = await validateConnectorRequest("tenant-1", "not_a_connector");
    expect(v).toMatchObject({ ok: false, error: "unknown_connector" });
  });

  it("accepts a descriptor slug the tenant has not connected", async () => {
    const v = await validateConnectorRequest("tenant-1", "meta_ads");
    expect(v).toEqual({ ok: true, slug: "meta_ads", label: "Meta Ads" });
  });

  it("rejects a slug that already has a connector_metadata row for THIS tenant", async () => {
    mocks.rows = [{ slug: "meta_ads" }];
    const v = await validateConnectorRequest("tenant-1", "meta_ads");
    expect(v).toMatchObject({ ok: false, error: "already_connected" });
  });

  it("an alias row satisfies the request (instagram_social ← composio.instagram)", async () => {
    mocks.rows = [{ slug: "composio.instagram" }];
    const v = await validateConnectorRequest("tenant-1", "instagram_social");
    expect(v).toMatchObject({ ok: false, error: "already_connected" });
  });

  it("composio.youtube is satisfied by the composio.youtube row the card connects", async () => {
    mocks.rows = [{ slug: "composio.youtube" }];
    const v = await validateConnectorRequest("tenant-1", "composio.youtube");
    expect(v).toMatchObject({ ok: false, error: "already_connected" });
  });

  it("Zavi-built tenant (no own site) with only the umbrella github row: github is already connected", async () => {
    mocks.rows = [{ slug: "github", account_login: "Praxis-build" }];
    mocks.productUrl = { marketing: "https://acme.onrender.com" };
    expect(await validateConnectorRequest("tenant-1", "github")).toMatchObject({ error: "already_connected" });
    mocks.productUrl = null;
    expect(await validateConnectorRequest("tenant-1", "github")).toMatchObject({ error: "already_connected" });
  });

  it("own external site + only the umbrella github row: github can still be requested", async () => {
    mocks.rows = [{ slug: "github", account_login: "Praxis-build" }];
    mocks.productUrl = { marketing: "https://acme.com" };
    const v = await validateConnectorRequest("tenant-1", "github");
    expect(v.ok).toBe(true);
  });

  it("does not see another tenant's row as connected", async () => {
    mocks.rows = [{ slug: "meta_ads" }];
    const v = await validateConnectorRequest("tenant-2", "meta_ads");
    expect(v.ok).toBe(true);
  });

  it("a pipedream.<app> slug is an unknown connector (Pipedream is not a rail)", async () => {
    for (const slug of ["pipedream.posthog", "pipedream.hubspot"]) {
      expect(await validateConnectorRequest("tenant-1", slug)).toMatchObject({ ok: false, error: "unknown_connector" });
    }
    expect(mocks.getAppName).not.toHaveBeenCalled();
  });

  it("is disabled only by an explicit connector_request_enabled=false", async () => {
    mocks.blob = { connector_request_enabled: false };
    const v = await validateConnectorRequest("tenant-1", "meta_ads");
    expect(v).toMatchObject({ ok: false, error: "connector_request_disabled" });
  });
});

describe("connectors__request tool handler (not intercepted)", () => {
  it("returns the typed error so the model can read it", async () => {
    const res = await callConnectorSearchTool("tenant-1", "request", { slug: "nope", reason: "x" });
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toBe("unknown_connector");
  });

  it("does not claim a card was shown when it ran un-intercepted", async () => {
    const res = await callConnectorSearchTool("tenant-1", "request", { slug: "github", reason: "x" });
    expect(res.ok).toBe(true);
    expect(res.content).not.toMatch(/card shown/i);
    expect(JSON.parse(res.content).label).toBe("GitHub");
  });

  it("records the validated request by run so any engine can promote it (taken once)", async () => {
    await callConnectorSearchTool("tenant-1", "request", { slug: "github", reason: "fix footer" }, "run-9");
    expect(takeRecordedConnectorRequest("run-9")).toEqual({ slug: "github", label: "GitHub", reason: "fix footer" });
    expect(takeRecordedConnectorRequest("run-9")).toBeNull();
    await callConnectorSearchTool("tenant-1", "request", { slug: "nope", reason: "x" }, "run-10");
    expect(takeRecordedConnectorRequest("run-10")).toBeNull();
  });
});
