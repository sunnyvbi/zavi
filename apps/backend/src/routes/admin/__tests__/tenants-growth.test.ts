import { beforeEach, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
const { rpc, from, records, failures } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  records: {} as Record<string, any[]>,
  failures: new Set<string>(),
}));
vi.mock("@/services/tenant-client", () => ({
  staffCrossTenantClient: () => ({ rpc, from }),
}));
import {
  staffTenantsGrowth,
  staffClassifyGrowthAccounts,
  validGrowthRange,
} from "../tenants-growth";
const request = (over: object = {}) =>
  ({
    staff: {
      user_id: "10000000-0000-4000-8000-000000000001",
      email: "staff@upcar.ai",
    },
    query: { from: "2026-10-01", to: "2026-10-13" },
    ...over,
  }) as unknown as Request;
const response = () => {
  const r = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response;
};
beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  for (const k of Object.keys(records)) delete records[k];
  failures.clear();
  from.mockImplementation((table: string) => {
    let ids: string[] = [];
    const q: any = {
      select: vi.fn(() => q),
      eq: vi.fn(() => q),
      in: vi.fn((_key: string, values: string[]) => {
        ids = values;
        return q;
      }),
      limit: vi.fn(async () => ({
        data: (records[table] ?? []).filter((r) =>
          ids.includes(r.tenant_id ?? r.id),
        ),
        error: failures.has(table) ? { message: "read failed" } : null,
      })),
    };
    return q;
  });
  rpc.mockResolvedValue({
    data: { users: [], tenants: [], activity: [] },
    error: null,
  });
});
it("requires the real staff assertion before touching cross-tenant data", async () => {
  await expect(
    staffTenantsGrowth(request({ staff: undefined }), response()),
  ).rejects.toThrow("assertStaff");
  expect(rpc).not.toHaveBeenCalled();
});
it("rejects invalid calendar dates and applies IST today", () => {
  const now = new Date("2026-10-13T18:30:00Z");
  expect(validGrowthRange("2026-02-30", "2026-10-13", now)).toBe(false);
  expect(validGrowthRange("2026-10-14", "2026-10-14", now)).toBe(true);
  expect(validGrowthRange("2026-10-15", "2026-10-15", now)).toBe(false);
});
it("uses one RPC, never auth-user pagination, and forbids shared caching", async () => {
  const r = response();
  await staffTenantsGrowth(request(), r);
  expect(rpc).toHaveBeenCalledWith("admin_tenants_growth", {
    p_from: "2026-10-01",
    p_to: "2026-10-13",
    p_include_usage: false,
  });
  expect(r.setHeader).toHaveBeenCalledWith(
    "Cache-Control",
    "private, no-store",
  );
});
it("does not turn database failures into zero customers", async () => {
  rpc.mockResolvedValue({ data: null, error: { code: "boom" } });
  const r = response();
  await staffTenantsGrowth(request(), r);
  expect(r.status).toHaveBeenCalledWith(503);
});
it("does not accept a body-supplied staff identity", async () => {
  const r = response();
  await staffClassifyGrowthAccounts(
    request({
      body: {
        subject_type: "tenant",
        ids: ["20000000-0000-4000-8000-000000000001"],
        is_test: true,
        reason: "Reviewed",
        p_actor: "attacker",
      },
    }),
    r,
  );
  expect(r.status).toHaveBeenCalledWith(400);
  expect(rpc).not.toHaveBeenCalled();
});
it("pins classification to authenticated staff identity", async () => {
  const r = response();
  await staffClassifyGrowthAccounts(
    request({
      body: {
        subject_type: "tenant",
        ids: ["20000000-0000-4000-8000-000000000001"],
        is_test: true,
        reason: "Ravi approved",
      },
    }),
    r,
  );
  expect(rpc).toHaveBeenCalledWith(
    "admin_growth_classify",
    expect.objectContaining({
      p_actor: "10000000-0000-4000-8000-000000000001",
      p_reason: "Ravi approved",
    }),
  );
});

it("joins source records only for returned workspaces, using the Funnel precedence and creator account", async () => {
  rpc.mockResolvedValue({
    data: {
      tenants: [{ id: "one" }, { id: "two" }, { id: "three" }],
      users: [],
      activity: [],
    },
    error: null,
  });
  records.tenant_app_setting = [
    { tenant_id: "one", value: { from: "cr-demo", utm_source: "social" } },
    { tenant_id: "two", value: { from: "other", utm_source: "email" } },
    { tenant_id: "outside", value: { from: "must-not-leak" } },
  ];
  records.affiliate_referrals = [{ tenant_id: "two", member_id: "creator" }];
  records.human_members = [{ id: "creator", display_name: "QA Creator" }];
  const r = response();
  await staffTenantsGrowth(request(), r);
  expect(r.json).toHaveBeenCalledWith(
    expect.objectContaining({
      tenants: [
        {
          id: "one",
          source: { source: "cr-demo", kind: "from" },
          source_detail: null,
        },
        {
          id: "two",
          source: {
            source: "QA Creator",
            kind: "affiliate",
            creator_id: "creator",
          },
          source_detail: null,
        },
        {
          id: "three",
          source: { source: "Unknown", kind: "unknown" },
          source_detail: "No recorded source",
        },
      ],
    }),
  );
});
it.each(["tenant_app_setting", "affiliate_referrals", "human_members"])(
  "does not present a failed %s read as Unknown",
  async (table) => {
    rpc.mockResolvedValue({ data: { tenants: [{ id: "one" }] }, error: null });
    records.affiliate_referrals = [{ tenant_id: "one", member_id: "creator" }];
    failures.add(table);
    const r = response();
    await staffTenantsGrowth(request(), r);
    expect(r.status).not.toHaveBeenCalled();
    expect(r.json).toHaveBeenCalledWith({
      tenants: [{ id: "one" }],
      sources_available: false,
    });
  },
);
it("batches attribution reads without losing tenants beyond the first batch", async () => {
  const tenants = Array.from({ length: 101 }, (_, i) => ({
    id: `tenant-${i}`,
  }));
  rpc.mockResolvedValue({ data: { tenants }, error: null });
  records.tenant_app_setting = [
    { tenant_id: "tenant-100", value: { utm_source: "newsletter" } },
  ];
  const r = response();
  await staffTenantsGrowth(request(), r);
  const body = vi.mocked(r.json).mock.calls[0][0];
  expect(body.tenants).toHaveLength(101);
  expect(body.tenants[100].source).toEqual({
    source: "newsletter",
    kind: "utm_source",
  });
  expect(
    from.mock.calls.filter(([table]) => table === "tenant_app_setting"),
  ).toHaveLength(2);
});
it("distinguishes missing capture diagnostics from a login-only record", async () => {
  rpc.mockResolvedValue({
    data: { tenants: [{ id: "one" }, { id: "two" }] },
    error: null,
  });
  records.tenant_app_setting = [
    { tenant_id: "one", value: { capture_status: "analytics_disabled" } },
    {
      tenant_id: "two",
      value: { landing_path: "/login", referrer_host: "accounts.google.com" },
    },
  ];
  const r = response();
  await staffTenantsGrowth(request(), r);
  const body = vi.mocked(r.json).mock.calls[0][0];
  expect(body.tenants.map((t: any) => t.source.kind)).toEqual([
    "unknown",
    "unknown",
  ]);
  expect(body.tenants.map((t: any) => t.source_detail)).toEqual([
    "Browser reported analytics disabled",
    "Only a sign-in page was captured",
  ]);
});
