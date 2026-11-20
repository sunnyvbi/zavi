
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TENANT_B = "bbbbbbbb-0000-4000-8000-000000000002";
const BRIEF_A = "cccccccc-0000-4000-8000-000000000003";
const BRIEF_B = "dddddddd-0000-4000-8000-000000000004";
const ENG_A = "eeeeeeee-0000-4000-8000-000000000005";
const MEMBER_ID = "55555555-0000-4000-8000-000000000055";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

function makeQuery(table: string) {
  let rows = [...(db[table] ?? [])];
  const api: Record<string, unknown> = {
    select: () => api,
    order: () => api,
    limit: () => Promise.resolve({ data: rows, error: null }),
    eq: (col: string, val: unknown) => {
      rows = rows.filter((r) => r[col] === val);
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      rows = rows.filter((r) => vals.includes(r[col]));
      return api;
    },
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null }),
  };
  return api;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ from: (t: string) => makeQuery(t) }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(async () => ({ data: [], error: null })),
}));
vi.mock("@/services/humans/store", () => ({
  readHandles: vi.fn(async () => [{ handle: "@creator", platform: "instagram" }]),
}));

import { listBriefs, getBriefDetail, getEngagement } from "@/services/humans/tenantViews";

beforeEach(() => {
  db.creator_briefs = [
    { id: BRIEF_A, tenant_id: TENANT_A, title: "A brief", utm_campaign: "zavi_a", status: "sent", deliverables: 3, created_at: "2026-09-01T00:00:00Z" },
    { id: BRIEF_B, tenant_id: TENANT_B, title: "B brief", utm_campaign: "zavi_b", status: "sent", deliverables: 1, created_at: "2026-09-01T00:00:00Z" },
  ];
  db.brief_applications = [
    { id: "app-1", tenant_id: TENANT_A, brief_id: BRIEF_A, human_member_id: MEMBER_ID, status: "applied", quoted_rate_usd: 500, pitch: "hi", created_at: "2026-09-01T01:00:00Z" },
  ];
  db.engagements = [
    { id: ENG_A, tenant_id: TENANT_A, brief_id: BRIEF_A, application_id: "app-1", human_member_id: MEMBER_ID, status: "active", agreed_rate_usd: 500, created_at: "2026-09-01T02:00:00Z", utm_campaign: "zavi_a" },
  ];
});

describe("human tenant views — isolation", () => {
  it("lists only the active tenant's briefs", async () => {
    const briefs = await listBriefs("tok", TENANT_A);
    expect(briefs.map((b) => b.id)).toEqual([BRIEF_A]);
  });

  it("returns null for another tenant's brief (so the route 404s)", async () => {
    expect(await getBriefDetail("tok", TENANT_A, BRIEF_B)).toBeNull();
  });

  it("returns null for another tenant's engagement", async () => {
    expect(await getEngagement("tok", TENANT_B, ENG_A)).toBeNull();
  });
});

describe("human tenant views — honest absence", () => {
  it("reports deliverables as empty rather than inventing rows from the brief's count", async () => {
    const view = await getEngagement("tok", TENANT_A, ENG_A);
    expect(view?.deliverables).toEqual([]);
  });

  it("says why the receipt is unavailable instead of showing zeros", async () => {
    const view = await getEngagement("tok", TENANT_A, ENG_A);
    expect(view?.receipt.available).toBe(false);
    expect(view?.receipt.reason).toMatch(/operator database/i);
    expect(view?.receipt.attributed_revenue_usd).toBeNull();
    expect(view?.receipt.spend_usd).toBeNull();
  });

  it("reports match_count as null on the list, not 0", async () => {
    const [brief] = await listBriefs("tok", TENANT_A);
    expect(brief.match_count).toBeNull();
    expect(brief.application_count).toBe(1);
    expect(brief.engagement_count).toBe(1);
  });
});
