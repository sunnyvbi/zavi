import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSb } from "@/services/agents/__tests__/fake-sb";
import { fakeSiteStore, siteRow, T1, T2 } from "@/services/sites/__tests__/fake-site-store";

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  artifacts: [] as Array<Record<string, unknown>>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  store: null as unknown,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn(async () => false) }));
vi.mock("@/services/sites/store", () => ({ siteStore: () => h.store }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => fakeSb(h.tables),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      let tenant: unknown = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (col === "tenant_id") tenant = val;
          return chain;
        },
        in: () => chain,
        order: () => chain,
        limit: () =>
          Promise.resolve({
            data: table === "run_artifacts" ? h.artifacts.filter((r) => r.tenant_id === tenant) : [],
            error: null,
          }),
      };
      return chain;
    },
  }),
  serviceClient: () => ({ storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) } }),
}));

import { listRunArtifacts } from "../list";

const LIVE = "aaaaaaaa-0000-4000-8000-000000000001";
const PAUSED = "aaaaaaaa-0000-4000-8000-000000000002";
const BUILDING = "aaaaaaaa-0000-4000-8000-000000000003";
const FOREIGN = "bbbbbbbb-0000-4000-8000-000000000001";
const RUN_LIVE = "c0000000-0000-4000-8000-000000000001";
const RUN_PAUSED = "c0000000-0000-4000-8000-000000000002";
const RUN_OLD = "c0000000-0000-4000-8000-000000000003";

type Site = { id: string; title: string; hostname: string; live_url: string | null; status: string; build_session_id: string | null };
type Body = { artifacts: Array<{ id: string; type: string }>; sites?: Site[] };

function res() {
  return {
    statusCode: 200,
    body: undefined as unknown as Body,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: Body) {
      this.body = b;
      return this;
    },
  };
}

async function list(tenant: string, query: Record<string, string> = {}) {
  h.requireAuth.mockResolvedValue({ tenant_id: tenant, user_id: "u", access_token: "tok" });
  const r = res();
  await listRunArtifacts({ query } as never, r as never);
  return r;
}

beforeEach(() => {
  h.requireAuth.mockReset();
  h.artifacts = [
    { id: "seo-draft", tenant_id: T1, run_id: "r1", storage_path: `${T1}/r1/post.html`, bucket: null, filename: "post.html", title: "SEO draft", mime: "text/html", bytes: 10, created_at: "2026-09-30T00:00:00Z", updated_at: null, agent_slug: "seo", thread_id: null },
    { id: "deck", tenant_id: T1, run_id: "r1", storage_path: `${T1}/r1/deck.pdf`, bucket: null, filename: "deck.pdf", title: "Deck", mime: "application/pdf", bytes: 10, created_at: "2026-09-30T00:00:00Z", updated_at: null, agent_slug: "pm", thread_id: null },
  ];
  h.store = fakeSiteStore([
    siteRow({ id: LIVE, label: "bakery", name: "Rosie's Bakery", root_conductor_run_id: RUN_LIVE, status: "live", live_deploy_id: "d1", live_url: "https://bakery.zaviagent.com" }),
    siteRow({ id: PAUSED, label: "yoga", root_conductor_run_id: RUN_PAUSED, status: "paused", live_deploy_id: "d2" }),
    siteRow({ id: BUILDING, label: "draft", root_conductor_run_id: "c0000000-0000-4000-8000-000000000009", status: "building" }),
    siteRow({ id: "aaaaaaaa-0000-4000-8000-000000000004", label: "gone", status: "deleted", live_deploy_id: "d4" }),
    siteRow({ id: FOREIGN, tenant_id: T2, label: "rival", name: "Rival Co", root_conductor_run_id: "c0000000-0000-4000-8000-00000000000f", status: "live", live_deploy_id: "d9" }),
  ]).store;
  h.tables = {
    tenant_resources: [
      { tenant_id: T1, resource_kind: "hosting", status: "ready", external_ref: { url: "https://grooming.onrender.com" }, updated_at: "2026-09-29T00:00:00Z" },
      { tenant_id: T2, resource_kind: "hosting", status: "ready", external_ref: { url: "https://rival.onrender.com" } },
    ],
    conductor_runs: [
      { id: RUN_OLD, tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Paws & Suds — grooming", created_at: "2026-09-28T00:00:00Z", goal_graph: [{ payload: { stage: "build" } }] },
      { id: "c0000000-0000-4000-8000-000000000004", tenant_id: T1, kind: "build_app", status: "done", objective: "[refine] tweak", created_at: "2026-09-29T00:00:00Z", goal_graph: [{ payload: { stage: "build", refine_mode: true } }] },
      { id: RUN_LIVE, tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Rosie — bakery", created_at: "2026-09-30T00:00:00Z", goal_graph: [{ payload: { stage: "provision", site_id: LIVE } }] },
    ],
    tenants: [{ id: T1, display_name: "Acme" }, { id: T2, display_name: "Rival" }],
  };
});

describe("Artifacts > Websites lists the sites the workspace built (one list: new-flow sites + the old-flow app)", () => {
  it("the Websites filter returns the built sites with name, address, status and build", async () => {
    const r = await list(T1, { type: "website" });
    expect(r.statusCode).toBe(200);
    expect(r.body.artifacts.map((a) => a.id)).toEqual(["seo-draft"]);
    expect(r.body.sites).toEqual([
      expect.objectContaining({ id: LIVE, title: "Rosie's Bakery", hostname: "bakery.zaviagent.com", live_url: "https://bakery.zaviagent.com", status: "live", build_session_id: RUN_LIVE }),
      expect.objectContaining({ id: PAUSED, title: "Yoga", hostname: "yoga.zaviagent.com", live_url: null, status: "paused", build_session_id: RUN_PAUSED }),
      expect.objectContaining({ id: BUILDING, title: "Draft", status: "building", live_url: null }),
      expect.objectContaining({ id: "app:workspace", title: "Paws & Suds", hostname: "grooming.onrender.com", live_url: "https://grooming.onrender.com", status: "live", build_session_id: RUN_OLD }),
    ]);
  });

  it("the unfiltered list carries them too", async () => {
    const r = await list(T1);
    expect(r.body.sites?.map((s) => s.title)).toEqual(["Rosie's Bakery", "Yoga", "Draft", "Paws & Suds"]);
  });

  it("never lists another tenant's site or app", async () => {
    const mine = await list(T1, { type: "website" });
    const text = JSON.stringify(mine.body);
    expect(text).not.toContain("Rival");
    expect(text).not.toContain("rival");
    const theirs = await list(T2, { type: "website" });
    expect(theirs.body.sites?.map((s) => s.title)).toEqual(["Rival Co", "Rival"]);
    expect(JSON.stringify(theirs.body)).not.toContain("bakery");
  });

  it("a deleted site is not listed", async () => {
    const r = await list(T1, { type: "website" });
    expect((r.body.sites ?? []).map((s) => s.title)).not.toContain("Gone");
  });

  it("search narrows the sites by name or address", async () => {
    expect((await list(T1, { type: "website", q: "BAKERY" })).body.sites?.map((s) => s.title)).toEqual(["Rosie's Bakery"]);
    expect((await list(T1, { type: "website", q: "onrender" })).body.sites?.map((s) => s.title)).toEqual(["Paws & Suds"]);
    expect((await list(T1, { type: "website", q: "nothing-matches" })).body.sites).toEqual([]);
  });

  it("other filters and a channel scope list no sites", async () => {
    expect((await list(T1, { type: "document" })).body.sites).toEqual([]);
    expect((await list(T1, { channel: "seo" })).body.sites).toEqual([]);
  });

  it("a newer refused old-flow build that failed never renames or relinks the live app", async () => {
    const REFUSED = "c0000000-0000-4000-8000-000000000005";
    h.tables.conductor_runs!.unshift({ id: REFUSED, tenant_id: T1, kind: "build_app", status: "failed", objective: "Build product: Dog Spa — refused", created_at: "2026-09-30T06:00:00Z", goal_graph: [] });
    const r = await list(T1, { type: "website" });
    const app = r.body.sites?.find((s) => s.id === "app:workspace");
    expect(app).toMatchObject({ title: "Paws & Suds", build_session_id: RUN_OLD });
  });

  it("an unreadable site store still lists the old app and the files", async () => {
    h.store = { listForTenant: async () => { throw new Error("sites down"); } };
    const r = await list(T1, { type: "website" });
    expect(r.body.artifacts.map((a) => a.id)).toEqual(["seo-draft"]);
    expect(r.body.sites?.map((s) => s.id)).toEqual(["app:workspace"]);
  });

  it("an old-flow app served at a new-flow site's address is listed once", async () => {
    h.tables.tenant_resources = [
      { tenant_id: T1, resource_kind: "hosting", status: "ready", external_ref: { url: "https://bakery.zaviagent.com" }, updated_at: "2026-09-29T00:00:00Z" },
    ];
    const r = await list(T1, { type: "website" });
    expect(r.body.sites?.filter((s) => s.live_url === "https://bakery.zaviagent.com")).toHaveLength(1);
  });
});
