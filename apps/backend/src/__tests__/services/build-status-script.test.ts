import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteLiveUrl } from "@/services/sites/site-build-status";
import type { SiteRow, SiteStatus } from "@/services/sites/contract";

const buildStatusScript: string = "../../../scripts/build-status.mjs";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped .mjs script
let describeBuild: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped .mjs script
let liveTargetOf: (...args: any[]) => any;
beforeAll(async () => {
  ({ describeBuild, liveTargetOf } = await import(buildStatusScript));
});

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function fakeDb(tables: Tables) {
  const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  return {
    reads,
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      reads.push({ table, filters });
      const rows = () =>
        (tables[table] ?? []).filter((r) =>
          filters.every(([col, v]) => (Array.isArray(v) ? v.includes(r[col]) : r[col] === v)),
        );
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => {
          filters.push([col, v]);
          return q;
        },
        in: (col: string, v: unknown[]) => {
          filters.push([col, v]);
          return q;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok: (v: { data: Row[]; error: null }) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve({ data: rows(), error: null }).then(ok, bad),
      };
      return q;
    },
  };
}

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const SITE_ID = "3a3a3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a";
const HOST = "bakery-k7.zaviagent.com";

function siteRun(overrides: Row = {}): Row {
  return {
    id: "run-1",
    tenant_id: TENANT,
    status: "done",
    created_at: "2026-10-05T10:00:00Z",
    updated_at: "2026-10-05T10:05:00Z",
    goal_graph: [
      { id: "g-provision", status: "done", payload: { stage: "provision", site_id: SITE_ID } },
      { id: "g-build", status: "done", payload: { stage: "build", site_id: SITE_ID, fast_single_pass: true } },
      { id: "g-deploy", status: "done", payload: { stage: "deploy", site_id: SITE_ID } },
    ],
    ...overrides,
  };
}

function liveSite(overrides: Row = {}): Row {
  return {
    id: SITE_ID,
    tenant_id: TENANT,
    hostname: HOST,
    status: "live",
    live_url: null,
    live_deploy_id: "dep_1",
    ...overrides,
  };
}

let fetched: string[] = [];

beforeEach(() => {
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(String(url));
      return new Response("<html><body>Fresh bread daily</body></html>", { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("build-status.mjs on a new-flow site build", () => {
  it("reports the published site as live from its sites row when tenant_resources has no hosting row", async () => {
    const db = fakeDb({ tenant_resources: [], sites: [liveSite()] });
    const d = await describeBuild(siteRun(), false, db);
    expect(d.liveUrl).toBe(`https://${HOST}`);
    expect(d.hosting.status).toBe("live");
    expect(plain(d.verdict)).toContain(`LIVE — https://${HOST}`);
    expect(plain(d.verdict)).not.toContain("NOT live");
    expect(fetched).toEqual([`https://${HOST}`]);
  });

  it("probes the site's own address, never the tenant's old-flow app, when both exist", async () => {
    const db = fakeDb({
      tenant_resources: [
        { tenant_id: TENANT, resource_kind: "hosting", status: "ready", external_ref: { url: "https://old-app.onrender.com" } },
      ],
      sites: [liveSite()],
    });
    const d = await describeBuild(siteRun(), false, db);
    expect(d.liveUrl).toBe(`https://${HOST}`);
    expect(fetched).toEqual([`https://${HOST}`]);
  });

  it("never reads another tenant's site row through a run's site id", async () => {
    const db = fakeDb({ tenant_resources: [], sites: [liveSite({ tenant_id: OTHER_TENANT })] });
    const d = await describeBuild(siteRun(), false, db);
    expect(d.liveUrl).toBeNull();
    expect(d.hosting.status).toBe("missing");
    expect(plain(d.verdict)).toContain("NOT live");
    expect(fetched).toEqual([]);
    const siteRead = db.reads.find((r) => r.table === "sites");
    expect(siteRead?.filters).toContainEqual(["tenant_id", TENANT]);
  });

  it("does not call a site live before a deploy was activated on it", async () => {
    const db = fakeDb({ tenant_resources: [], sites: [liveSite({ status: "publishing", live_deploy_id: null })] });
    const d = await describeBuild(siteRun(), false, db);
    expect(d.liveUrl).toBeNull();
    expect(plain(d.verdict)).toContain("NOT live — hosting=publishing url=none");
    expect(fetched).toEqual([]);
  });

  it("a run that fell back to the old flow keeps reading tenant_resources", async () => {
    const db = fakeDb({
      tenant_resources: [
        { tenant_id: TENANT, resource_kind: "hosting", status: "ready", external_ref: { url: "https://old-app.onrender.com" } },
      ],
      sites: [liveSite({ status: "fell_back_old" })],
    });
    const d = await describeBuild(siteRun(), false, db);
    expect(d.liveUrl).toBe("https://old-app.onrender.com");
    expect(fetched).toEqual(["https://old-app.onrender.com"]);
  });

  it("an old-flow run still reads its hosting row and never queries sites", async () => {
    const db = fakeDb({
      tenant_resources: [
        { tenant_id: TENANT, resource_kind: "hosting", status: "ready", external_ref: { url: "https://old-app.onrender.com" } },
      ],
      sites: [liveSite()],
    });
    const run = siteRun({ goal_graph: [{ id: "g-deploy", status: "done", payload: { stage: "deploy" } }] });
    const d = await describeBuild(run, false, db);
    expect(d.liveUrl).toBe("https://old-app.onrender.com");
    expect(db.reads.some((r) => r.table === "sites")).toBe(false);
  });

  it("agrees with the product's siteLiveUrl for every site status", () => {
    const statuses: SiteStatus[] = [
      "provisioning", "building", "publishing", "live", "failed", "paused", "waking", "deleting", "deleted",
    ] as SiteStatus[];
    for (const status of statuses) {
      for (const live_deploy_id of ["dep_9", null]) {
        for (const live_url of [null, "https://custom.example.com", "http://insecure.example.com"]) {
          const site = liveSite({ status, live_deploy_id, live_url }) as unknown as SiteRow;
          const t = liveTargetOf({ siteId: SITE_ID, site, resources: [] });
          expect({ status, live_deploy_id, live_url, url: t.liveUrl }).toEqual({
            status, live_deploy_id, live_url, url: siteLiveUrl(site),
          });
        }
      }
    }
  });
});
