
import { describe, it, expect, vi, beforeEach } from "vitest";

const readConnectorList = vi.fn();
vi.mock("@/services/connectors/metadata", () => ({
  readConnectorList: (...args: unknown[]) => readConnectorList(...args),
}));

import { build } from "../operator";
import type { DashboardContext } from "../_contract";

function makeSb() {
  const chain: Record<string, unknown> = {
    from: () => chain,
    select: () => chain,
    like: () => chain,
    eq: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => chain,
    rpc: () => Promise.resolve({ data: [], error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  };
  return chain;
}

function ctx(tenantId: string): DashboardContext {
  return { tenantId, sb: makeSb() } as unknown as DashboardContext;
}

const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("operator dashboard — connector panel (derived from live rows)", () => {
  beforeEach(() => {
    readConnectorList.mockReset();
  });

  it("renders ALL live connectors (aggregator + meta/google), not just the hardcoded 4", async () => {
    readConnectorList.mockResolvedValue([
      { slug: "operator_db" },
      { slug: "stripe" },
      { slug: "meta_ads" },
      { slug: "google_ads" },
      { slug: "composio.sentry" },
      { slug: "jira" },
    ]);

    const d = (await build(ctx(TENANT))) as Record<string, any>;
    const bySlug = Object.fromEntries(
      d.connectors.map((c: Record<string, unknown>) => [c.slug, c]),
    );

    expect(bySlug.meta_ads).toMatchObject({ connected: true, label: "Meta Ads" });
    expect(bySlug.google_ads).toMatchObject({ connected: true, label: "Google Ads" });
    expect(bySlug.jira).toMatchObject({ connected: true });
    expect(bySlug["composio.sentry"]).toBeTruthy();
    expect(bySlug["composio.sentry"].connected).toBe(true);
    expect(typeof bySlug["composio.sentry"].label).toBe("string");
    expect(bySlug["composio.sentry"].label.length).toBeGreaterThan(0);
    expect(bySlug["composio.sentry"].label).not.toBe("composio.sentry");

    expect(d.kpis.connected_count).toBe(6);

    expect(bySlug.operator_db).toMatchObject({ connected: true, label: "Business DB" });
    expect(bySlug.slack).toMatchObject({ connected: false });
    expect(bySlug.github).toMatchObject({ connected: false });
  });

  it("still surfaces WARN_IF_MISSING attention cards for missing core connectors", async () => {
    readConnectorList.mockResolvedValue([{ slug: "operator_db" }]);

    const d = (await build(ctx(TENANT))) as Record<string, any>;
    const titles = (d.attention as Array<Record<string, unknown>>).map((a) => a.title);
    expect(titles).toContain("Slack isn't connected");
    expect(titles).toContain("Stripe isn't connected");
    expect(titles).toContain("GitHub isn't connected");
    expect(titles.some((t) => String(t).includes("Business DB"))).toBe(false);
  });

  it("degrades to core-only (all not-connected) when the connector read throws — never throws", async () => {
    readConnectorList.mockRejectedValue(new Error("db down"));
    const d = (await build(ctx(TENANT))) as Record<string, any>;
    expect(d.connectors).toHaveLength(4);
    expect(d.connectors.every((c: Record<string, unknown>) => c.connected === false)).toBe(true);
    expect(d.kpis.connected_count).toBe(0);
  });
});
