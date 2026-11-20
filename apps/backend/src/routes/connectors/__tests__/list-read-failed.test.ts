import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  auth: { tenant_id: "T1", user_id: "U1" } as { tenant_id: string; user_id: string } | null,
  budgets: [] as Array<{ read_failed: Record<string, string> | null; read_failure_kinds?: Record<string, string> }>,
  budgetsError: null as { message: string } | null,
  connectors: [] as Array<{ slug: string; connected: true }>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (
    _req: unknown,
    res: { status: (c: number) => { json: (b: unknown) => void } },
  ) => {
    if (!m.auth) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return null;
    }
    return m.auth;
  },
}));

vi.mock("@/services/connectors/metadata", () => ({
  readConnectorList: async () => m.connectors,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: async () =>
            table === "ad_budgets"
              ? { data: m.budgets, error: m.budgetsError }
              : { data: [], error: null },
        }),
      }),
    }),
  }),
}));

import { connectorsList } from "../list";

function run() {
  return new Promise<{ status: number; body: unknown }>((resolve) => {
    const res = {
      statusCode: 200,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json(b: unknown) {
        resolve({ status: this.statusCode, body: b });
      },
    };
    void connectorsList({} as never, res as never);
  });
}

type Entry = { slug: string; read_failed?: boolean; read_failed_since?: string; read_slow?: boolean; read_slow_since?: string };

beforeEach(() => {
  m.auth = { tenant_id: "T1", user_id: "U1" };
  m.budgets = [];
  m.budgetsError = null;
  m.connectors = [];
});

describe("GET /api/connectors read_failed", () => {
  it("flags the connector whose platform failed, maps ledger-only keys, leaves others clean", async () => {
    m.connectors = [
      { slug: "tiktok_ads", connected: true },
      { slug: "meta_ads", connected: true },
      { slug: "slack", connected: true },
    ];
    m.budgets = [{ read_failed: { tiktok: "2026-10-12T09:00:00Z" }, read_failure_kinds: { tiktok: "auth" } }];
    const { body } = await run();
    const rows = (body as { connectors: Entry[] }).connectors;
    const tiktok = rows.find((r) => r.slug === "tiktok_ads");
    expect(tiktok?.read_failed).toBe(true);
    expect(tiktok?.read_failed_since).toBe("2026-10-12T09:00:00Z");
    expect(rows.find((r) => r.slug === "meta_ads")?.read_failed).toBeUndefined();
    expect(rows.find((r) => r.slug === "slack")?.read_failed).toBeUndefined();
  });

  it("merges several budgets to the earliest since per slug", async () => {
    m.connectors = [{ slug: "meta_ads", connected: true }];
    m.budgets = [
      { read_failed: { meta: "2026-10-12T09:00:00Z" }, read_failure_kinds: { meta: "auth" } },
      { read_failed: { meta: "2026-10-11T07:00:00Z" }, read_failure_kinds: { meta: "auth" } },
    ];
    const { body } = await run();
    const meta = (body as { connectors: Entry[] }).connectors[0];
    expect(meta.read_failed_since).toBe("2026-10-11T07:00:00Z");
  });

  it("only a login problem asks for a reconnect; a busy platform is 'slow' after 3h and nothing before; disconnected is nothing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
    try {
      m.connectors = [
        { slug: "tiktok_ads", connected: true },
        { slug: "reddit_ads", connected: true },
        { slug: "google_ads", connected: true },
        { slug: "linkedin_ads", connected: true },
        { slug: "meta_ads", connected: true },
      ];
      m.budgets = [{
        read_failed: { tiktok: "2026-10-12T11:00:00Z", reddit: "2026-10-12T08:00:00Z", google: "2026-10-12T08:00:00Z", linkedin: "2026-10-01T00:00:00Z", meta: "2026-10-12T11:30:00Z" },
        read_failure_kinds: { tiktok: "vendor_error", reddit: "rate_limited", linkedin: "disconnected", meta: "account_gone" },
      }];
      const { body } = await run();
      const by = Object.fromEntries((body as { connectors: Entry[] }).connectors.map((r) => [r.slug, r]));
      expect(by.tiktok_ads.read_failed).toBeUndefined();
      expect(by.tiktok_ads.read_slow).toBeUndefined();
      expect(by.reddit_ads).toMatchObject({ read_slow: true, read_slow_since: "2026-10-12T08:00:00Z" });
      expect(by.reddit_ads.read_failed).toBeUndefined();
      expect(by.google_ads).toMatchObject({ read_slow: true });
      expect(by.linkedin_ads.read_failed).toBeUndefined();
      expect(by.linkedin_ads.read_slow).toBeUndefined();
      expect(by.meta_ads).toMatchObject({ read_failed: true, read_failed_since: "2026-10-12T11:30:00Z" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a budgets read error never blanks the panel", async () => {
    m.connectors = [{ slug: "meta_ads", connected: true }];
    m.budgetsError = { message: "boom" };
    const { status, body } = await run();
    expect(status).toBe(200);
    expect((body as { connectors: Entry[] }).connectors).toHaveLength(1);
  });

  it("a composio-only connection carries the flag on its own row (grok G7: the route is row-keyed)", async () => {
    m.connectors = [{ slug: "composio.tiktok_ads", connected: true }];
    m.budgets = [{ read_failed: { tiktok: "2026-10-12T09:00:00Z" }, read_failure_kinds: { tiktok: "auth" } }];
    const { body } = await run();
    const row = (body as { connectors: Entry[] }).connectors[0];
    expect(row.read_failed).toBe(true);
    expect(row.read_failed_since).toBe("2026-10-12T09:00:00Z");
  });
});
