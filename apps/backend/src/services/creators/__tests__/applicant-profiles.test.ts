import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb } from "./fake-supabase";

const m = vi.hoisted(() => ({ serviceClient: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import { loadApplicantProfiles, type BriefApplicationRow, type TenantBriefRow } from "../briefs-db";
import { hireApplicant, realHireDeps, type HireDeps } from "../brief-hire";
import { listApplicantsForBusiness, realApplicantListDeps } from "../briefs";

const TENANT = "11111111-1111-4111-8111-111111111111";
const BRIEF = "b1111111-1111-4111-8111-111111111111";
const LATE = "c0000000-0000-4000-8000-00000000zzzz";
const T0 = "2026-09-11T00:00:00.000Z";

function roster() {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 150; i++) {
    rows.push({
      id: `c0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      display_name: `Aaron ${String(i).padStart(3, "0")}`,
      slug: `aaron-${i}`,
      city: "Austin",
      country_code: "US",
      vetting_state: "approved",
      email: `aaron${i}@example.com`,
      legal_name: `Aaron Legal ${i}`,
    });
  }
  rows.push({
    id: LATE,
    display_name: "Zoe Whitfield",
    slug: "zoe",
    city: "Leeds",
    country_code: "GB",
    vetting_state: "approved",
    email: "zoe@example.com",
    legal_name: "Zoe Legal",
  });
  rows.push({
    id: "c0000000-0000-4000-8000-0000000pending",
    display_name: "Pending Pat",
    slug: "pat",
    city: null,
    country_code: "US",
    vetting_state: "pending",
    email: "pat@example.com",
  });
  return rows;
}

function world() {
  const db = makeFakeDb({ human_members: roster() });
  const selects: Array<{ table: string; cols: string }> = [];
  const baseFrom = db.client.from;
  const client = {
    ...db.client,
    from: (table: string) => {
      const t = baseFrom(table) as { select: (cols?: string, o?: unknown) => unknown };
      return {
        ...t,
        select: (cols?: string, o?: unknown) => {
          selects.push({ table, cols: cols ?? "" });
          return t.select(cols, o);
        },
      };
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== "search_creators") throw new Error(`unexpected rpc ${name}`);
      const limit = Math.min(Number(args.p_limit ?? 50), 100);
      const offset = Number(args.p_offset ?? 0);
      const rows = (db.tables.human_members ?? [])
        .filter((r) => r.vetting_state === "approved")
        .sort((a, b) => String(a.display_name).toLowerCase().localeCompare(String(b.display_name).toLowerCase()))
        .slice(offset, offset + limit)
        .map((r) => ({
          human_member_id: r.id,
          display_name: r.display_name,
          slug: r.slug,
          city: r.city,
          country_code: r.country_code,
          bookable: true,
        }));
      return { data: rows, error: null };
    },
  };
  m.serviceClient.mockReturnValue(client);
  return { db, selects };
}

beforeEach(() => {
  vi.clearAllMocks();
});

function brief(): TenantBriefRow {
  return {
    id: BRIEF,
    tenant_id: TENANT,
    status: "sent",
    title: "3 ad videos",
    angle: "a",
    hook: "h",
    format: "9:16",
    deliverables: 3,
    rationale: "r",
    evidence: [],
    source_campaign_ref: "",
    source_run_id: null,
    budget_usd: 450,
    utm_campaign: "zavi-brief-1",
    lane: "ugc_video",
    filters: null,
    delivery_days: 7,
    posted_at: T0,
    answer_by: "2026-09-16T00:00:00.000Z",
    applicant_cap: 20,
    decline_note: null,
    closed_at: null,
    created_at: T0,
    updated_at: null,
  };
}

function application(): BriefApplicationRow {
  return {
    id: "a1111111-1111-4111-8111-111111111111",
    tenant_id: TENANT,
    brief_id: BRIEF,
    brief_kind: "creative",
    human_member_id: LATE,
    status: "applied",
    pitch: "I shoot handovers",
    quoted_rate_usd: 150,
    created_at: T0,
  };
}

describe("loadApplicantProfiles reads exactly the applicants, not a page of the roster", () => {
  it("finds an applicant who sorts after the first 100 creators alphabetically", async () => {
    const { selects } = world();
    const out = await loadApplicantProfiles({ tenant_id: TENANT, human_member_ids: [LATE] });
    expect(out.get(LATE)).toEqual({
      display_name: "Zoe Whitfield",
      slug: "zoe",
      city: "Leeds",
      country_code: "GB",
      bookable: true,
    });
    const memberReads = selects.filter((s) => s.table === "human_members");
    expect(memberReads).toHaveLength(1);
    for (const denied of ["email", "legal_name", "*", "auth_user_id", "payout"]) {
      expect(memberReads[0]!.cols).not.toContain(denied);
    }
  });

  it("leaves out a creator who is not approved, and an id that is nobody", async () => {
    world();
    const out = await loadApplicantProfiles({
      tenant_id: TENANT,
      human_member_ids: ["c0000000-0000-4000-8000-0000000pending", "c9999999-9999-4999-8999-999999999999", LATE],
    });
    expect([...out.keys()]).toEqual([LATE]);
  });

  it("marks a creator Zavi cannot pay as not bookable rather than dropping them", async () => {
    const { db } = world();
    db.tables.human_members!.find((r) => r.id === LATE)!.country_code = "NG";
    const out = await loadApplicantProfiles({ tenant_id: TENANT, human_member_ids: [LATE] });
    expect(out.get(LATE)?.country_code).toBe("NG");
    expect(out.get(LATE)?.bookable).toBe(false);
  });
});

describe("an applicant outside the first page of the roster", () => {
  it("can be hired: the payout country is read, not blanked", async () => {
    world();
    let app = application();
    const calls: string[] = [];
    const deps: HireDeps = {
      ...realHireDeps,
      loadBrief: async () => brief(),
      loadApplication: async () => ({ ...app }),
      claimApplication: async () => {
        app = { ...app, status: "approved" };
        calls.push("claim");
        return { ...app };
      },
      releaseClaim: async () => {
        calls.push("release");
      },
      businessName: async () => "Northwind Coffee",
      orders: {
        startApplicantCheckout: async () => {
          calls.push("checkout");
          return { order_id: "o1", checkout_session_id: "cs_1", checkout_url: "https://checkout.test/cs_1" };
        },
      },
      now: () => new Date(T0),
    };
    const res = await hireApplicant(
      {
        tenant_id: TENANT,
        brief_id: BRIEF,
        application_id: app.id,
        booked_by_user_id: null,
        success_url: "https://app.test/ok",
        cancel_url: "https://app.test/no",
      },
      deps,
    );
    expect(res).toMatchObject({ ok: true, checkout_url: "https://checkout.test/cs_1" });
    expect(calls).toEqual(["claim", "checkout"]);
  });

  it("shows up in the business's applicant list with their name and place", async () => {
    world();
    const out = await listApplicantsForBusiness(
      { tenant_id: TENANT, brief_id: BRIEF },
      {
        ...realApplicantListDeps,
        load: async () => brief(),
        listApplications: async () => [application()],
        hireOrders: undefined,
      },
    );
    expect(out?.applicants).toHaveLength(1);
    expect(out?.applicants[0]).toMatchObject({
      human_member_id: LATE,
      display_name: "Zoe Whitfield",
      slug: "zoe",
      city: "Leeds",
      country_code: "GB",
      bookable: true,
    });
  });
});
