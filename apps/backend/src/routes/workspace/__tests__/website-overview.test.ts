import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  runSelect: "" as string,
  runOr: "" as string,
  details: { name: null, description: null } as { name: string | null; description: string | null },
  role: "owner" as string | null,
  roleLookups: [] as Array<Record<string, unknown>>,
}));
const settings = vi.hoisted(() => ({
  setTenantSetting: vi.fn(async (_tenantId: string, key: string, value: unknown) => {
    if (key === "website_app_details") db.details = value as typeof db.details;
  }),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "tenant-a", user_id: "u1" })),
  authMiddleware: vi.fn(),
}));
vi.mock("@/services/settings", () => ({
  getStringSetting: vi.fn(async () => "public"),
  getBoolSetting: vi.fn(async () => false),
  getSetting: vi.fn(async () => db.details),
  setTenantSetting: settings.setTenantSetting,
}));
vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    listForTenant: async () => [],
    get: async () => null,
    getByRun: async () => null,
    getByRepo: async () => null,
  }),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return q;
        },
        maybeSingle: async () => {
          db.roleLookups.push({ table, ...filters });
          const match = table === "tenant_users" && filters.user_id === "u1" && filters.tenant_id === "tenant-a";
          return { data: match && db.role ? { role: db.role } : null, error: null };
        },
      };
      return q;
    },
  }),
  serverClientFromBearer: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let rootsOnly = false;
      const nullCols: string[] = [];
      const result = (n?: number) => {
        if (table === "tenants") return { data: { display_name: "Mohit", product_url: {}, created_at: "2026-09-01T00:00:00Z" }, error: null };
        if (table === "conductor_runs") {
          const rows = (rootsOnly ? db.runs.filter((run) => run.refine_mode !== "true") : db.runs).filter((run) =>
            nullCols.every((col) => ((run.site_by_col as Record<string, unknown> | undefined)?.[col] ?? null) === null),
          );
          return { data: n === undefined ? rows : rows.slice(0, n), error: null };
        }
        return { data: null, error: null };
      };
      Object.assign(q, {
        select: (cols: string) => {
          if (table === "conductor_runs") db.runSelect = cols;
          return q;
        },
        eq: () => q,
        or: (expr: string) => {
          if (table === "conductor_runs") {
            db.runOr = expr;
            rootsOnly =
              expr === "goal_graph->0->payload->>refine_mode.is.null,goal_graph->0->payload->>refine_mode.neq.true";
          }
          return q;
        },
        is: (col: string, val: null) => {
          if (val === null) nullCols.push(col);
          return q;
        },
        order: () => q,
        limit: (n: number) => Promise.resolve(result(n)),
        maybeSingle: () => Promise.resolve(table === "conductor_runs" ? { data: db.runs[0] ?? null, error: null } : result()),
      });
      return q;
    },
  }),
}));

import { getWebsiteOverviewHandler, setWebsiteSettingsHandler } from "../website-overview";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

beforeEach(() => {
  db.runs = [];
  db.runSelect = "";
  db.runOr = "";
  db.details = { name: null, description: null };
  db.role = "owner";
  db.roleLookups = [];
  settings.setTenantSetting.mockClear();
});

describe("website overview", () => {
  it("describes the app from its build, not from the newest change run", async () => {
    db.runs = [
      {
        objective: "[refine] The operator says the Northline page looks like a template. Current state: https://x.onrender.com",
        status: "halted",
        created_at: "2026-09-24T10:00:00Z",
        refine_mode: "true",
      },
      {
        objective: "Build product: Mohit — Help me build a simple coming-soon page for my car rental website.",
        status: "done",
        created_at: "2026-09-24T06:55:00Z",
        refine_mode: null,
      },
    ];
    const res = mockRes();
    await getWebsiteOverviewHandler({ headers: {} } as never, res as never);
    const app = (res.body as { app: { description: string; build_status: string; created_at: string } }).app;
    expect(app.description).toBe("Help me build a simple coming-soon page for my car rental website.");
    expect(app.description).not.toContain("operator");
    expect(app.build_status).toBe("done");
    expect(app.created_at).toBe("2026-09-24T06:55:00Z");
    expect(db.runSelect).toContain("refine_mode");
  });

  it("two sites in one workspace: a newer SITE build never describes the singleton app", async () => {
    db.runs = [
      {
        objective: "Build product: Mohit — Mile High coffee site",
        status: "active",
        created_at: "2026-10-01T12:00:00Z",
        refine_mode: null,
        site_by_col: { "goal_graph->0->payload->>site_id": "bbbbbbbb-0000-4000-8000-00000000000b" },
      },
      {
        objective: "Build product: Mohit — Lucky Paws pet site",
        status: "failed",
        created_at: "2026-10-01T10:00:00Z",
        refine_mode: null,
        site_by_col: { "goal_graph->1->payload->>site_id": "aaaaaaaa-0000-4000-8000-00000000000a" },
      },
      {
        objective: "Build product: Mohit — Help me build a car rental page.",
        status: "done",
        created_at: "2026-09-24T06:55:00Z",
        refine_mode: null,
      },
    ];
    const res = mockRes();
    await getWebsiteOverviewHandler({ headers: {} } as never, res as never);
    const app = (res.body as { app: { description: string; build_status: string } }).app;
    expect(app.description).toBe("Help me build a car rental page.");
    expect(app.build_status).toBe("done");
  });

  it("never shows the pipeline prefix or the company name in the description", async () => {
    db.runs = [
      {
        objective: "Build product: Laptop Rentals &amp; Co — help me to make landing page for book rental website",
        status: "active",
        created_at: "2026-09-29T12:00:00Z",
        refine_mode: null,
      },
    ];
    const res = mockRes();
    await getWebsiteOverviewHandler({ headers: {} } as never, res as never);
    const app = (res.body as { app: { description: string } }).app;
    expect(app.description).not.toMatch(/build product/i);
    expect(app.description).not.toContain("Laptop Rentals");
    expect(app.description).toMatch(/^help me to make landing page for book rental website$/i);
  });

  it("has no description or status when there are only change runs", async () => {
    db.runs = [{ objective: "[refine] tweak", status: "halted", created_at: "2026-09-24T10:00:00Z", refine_mode: "true" }];
    const res = mockRes();
    await getWebsiteOverviewHandler({ headers: {} } as never, res as never);
    const app = (res.body as { app: { description: string | null; build_status: string | null } }).app;
    expect(app.build_status).toBeNull();
    expect(app.description ?? "").not.toContain("tweak");
  });

  it("still finds the build after more than 25 newer change runs", async () => {
    const changes = Array.from({ length: 30 }, (_, i) => ({
      objective: `[refine] change ${i}`,
      status: "done",
      created_at: `2026-09-24T12:${String(59 - i).padStart(2, "0")}:00Z`,
      refine_mode: "true",
    }));
    db.runs = [
      ...changes,
      {
        objective: "Build product: Mohit — A booking site for my car rental business.",
        status: "done",
        created_at: "2026-09-20T08:00:00Z",
        refine_mode: null,
      },
    ];
    const res = mockRes();
    await getWebsiteOverviewHandler({ headers: {} } as never, res as never);
    const app = (res.body as { app: { description: string; build_status: string; created_at: string } }).app;
    expect(app.description).toBe("A booking site for my car rental business.");
    expect(app.build_status).toBe("done");
    expect(app.created_at).toBe("2026-09-20T08:00:00Z");
    expect(db.runOr).toContain("refine_mode.neq.true");
  });

  it("uses saved app-card details instead of overwriting them with build copy", async () => {
    db.runs = [
      {
        objective: "Build a generic landing page.",
        status: "done",
        created_at: "2026-09-24T06:55:00Z",
        refine_mode: null,
      },
    ];
    db.details = { name: "Northline", description: "Book a car in minutes." };
    const res = mockRes();
    await getWebsiteOverviewHandler({ headers: {} } as never, res as never);
    const app = (res.body as { app: { name: string; description: string } }).app;
    expect(app.name).toBe("Northline");
    expect(app.description).toBe("Book a car in minutes.");
  });

  it("persists edited app-card details without changing visibility or badge settings", async () => {
    const res = mockRes();
    await setWebsiteSettingsHandler(
      { headers: {}, body: { app: { name: "Northline", description: "Book a car in minutes." } } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(settings.setTenantSetting).toHaveBeenCalledTimes(1);
    expect(settings.setTenantSetting).toHaveBeenCalledWith(
      "tenant-a",
      "website_app_details",
      { name: "Northline", description: "Book a car in minutes." },
      "u1",
    );
    expect((res.body as { app: { name: string; description: string } }).app).toEqual({
      name: "Northline",
      description: "Book a car in minutes.",
    });
  });
});

describe("website settings authorization", () => {
  const writes = [
    { badge_hidden: true },
    { visibility: "public" },
    { app: { name: "Hijacked", description: "renamed by a member" } },
  ];

  for (const role of ["member", null] as const) {
    for (const body of writes) {
      it(`refuses ${Object.keys(body)[0]} from a ${role ?? "removed"} caller and writes nothing`, async () => {
        db.role = role;
        const res = mockRes();
        await setWebsiteSettingsHandler({ headers: {}, body } as never, res as never);
        expect(res.statusCode).toBe(403);
        expect(settings.setTenantSetting).not.toHaveBeenCalled();
        expect(db.details).toEqual({ name: null, description: null });
        expect(db.roleLookups).toEqual([{ table: "tenant_users", user_id: "u1", tenant_id: "tenant-a" }]);
      });
    }
  }

  for (const role of ["owner", "admin"] as const) {
    it(`lets an ${role} hide the badge`, async () => {
      db.role = role;
      const res = mockRes();
      await setWebsiteSettingsHandler({ headers: {}, body: { badge_hidden: true } } as never, res as never);
      expect(res.statusCode).toBe(200);
      expect(settings.setTenantSetting).toHaveBeenCalledWith("tenant-a", "website_platform_badge_hidden", true, "u1");
    });
  }
});
