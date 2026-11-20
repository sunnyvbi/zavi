import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getBoolSetting: vi.fn(),
  getBoolSettingStrict: vi.fn(),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: mocks.getBoolSetting,
  getBoolSettingStrict: mocks.getBoolSettingStrict,
}));

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "ilike" | "in"; column: string; value: unknown };
type Read = { table: string; filters: Filter[]; rowsServed: number };

const tables: Record<string, Row[]> = { tenant_resources: [], tenant_custom_domains: [], website_edits: [] };
const reads: Read[] = [];

function col(r: Row, k: string): unknown {
  const [base, ...path] = k.split("->>");
  let v: unknown = r[base];
  for (const seg of path) v = v && typeof v === "object" ? (v as Row)[seg] : undefined;
  return v;
}

function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function builder(table: string) {
  const filters: Filter[] = [];
  const notNull: string[] = [];
  const order: [string, boolean][] = [];
  const matches = (r: Row) =>
    filters.every((f) => {
      const v = col(r, f.column);
      if (f.op === "eq") return v === f.value;
      if (f.op === "in") return (f.value as unknown[]).includes(v);
      return typeof v === "string" && likeToRegExp(f.value as string).test(v);
    }) && notNull.every((k) => r[k] != null);
  const b = {
    select() {
      return b;
    },
    eq(column: string, value: unknown) {
      filters.push({ op: "eq", column, value });
      return b;
    },
    ilike(column: string, value: string) {
      filters.push({ op: "ilike", column, value });
      return b;
    },
    in(column: string, value: unknown[]) {
      filters.push({ op: "in", column, value });
      return b;
    },
    not(column: string) {
      notNull.push(column);
      return b;
    },
    order(k: string, opts?: { ascending?: boolean }) {
      order.push([k, opts?.ascending !== false]);
      return b;
    },
    then(resolve: (r: { data: Row[]; error: null }) => void) {
      const rows = (tables[table] ?? []).filter(matches);
      rows.sort((x, y) => {
        for (const [k, asc] of order) {
          const a = x[k] as string;
          const c = y[k] as string;
          if (a === c) continue;
          return (a < c ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
      reads.push({ table, filters, rowsServed: rows.length });
      resolve({ data: rows, error: null });
    },
  };
  return b;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (table: string) => builder(table) }),
}));

import { getPublishedWebsiteEditsHandler } from "../website-edits";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

const FOREIGN_TENANTS = 500;
const OWNER = "tnt-owner";

function seedFleet() {
  for (let i = 0; i < FOREIGN_TENANTS; i++) {
    const t = `tnt-${i}`;
    tables.tenant_resources.push(
      { tenant_id: t, resource_kind: "hosting", status: "ready", external_ref: { url: `https://app-${i}.onrender.com` } },
      { tenant_id: t, resource_kind: "domain", status: "ready", external_ref: { hostname: `app-${i}.zaviagent.com` } },
    );
    tables.tenant_custom_domains.push({ tenant_id: t, hostname: `shop-${i}.example.com`, status: "verified" });
    tables.website_edits.push({
      tenant_id: t,
      app_id: `app-${i}.onrender.com`,
      selector: "#h1",
      published_patch: { text: `foreign-${i}` },
      published_removed: false,
      published_at: "2026-07-17T00:00:00Z",
    });
  }
  tables.tenant_resources.push(
    { tenant_id: OWNER, resource_kind: "hosting", status: "ready", external_ref: { url: "https://acme.onrender.com" } },
    { tenant_id: OWNER, resource_kind: "domain", status: "ready", external_ref: { hostname: "acme.zaviagent.com" } },
  );
  tables.tenant_custom_domains.push({ tenant_id: OWNER, hostname: "www.acme.com", status: "verified" });
  tables.website_edits.push({
    tenant_id: OWNER,
    app_id: "acme.onrender.com",
    selector: "#hero",
    published_patch: { text: "Acme live" },
    published_removed: false,
    published_at: "2026-07-20T00:00:00Z",
  });
}

const ownerRows = (table: string) => tables[table].filter((r) => r.tenant_id === OWNER).length;

function scoped(f: Filter): boolean {
  if (f.column === "tenant_id") return true;
  return /hostname|url/.test(f.column) && f.op === "ilike";
}

beforeEach(() => {
  tables.tenant_resources = [];
  tables.tenant_custom_domains = [];
  tables.website_edits = [];
  reads.length = 0;
  mocks.getBoolSetting.mockReset().mockResolvedValue(true);
  mocks.getBoolSettingStrict.mockReset().mockResolvedValue(false);
  seedFleet();
});

async function call(app: string) {
  const res = mockRes();
  await getPublishedWebsiteEditsHandler({ query: { app } } as never, res as never);
  return res;
}

describe("public published-edits read stays scoped to the requested host", () => {
  it("serves the owner's edits on every serving host without reading other tenants' rows", async () => {
    for (const host of ["acme.zaviagent.com", "www.acme.com", "acme.onrender.com"]) {
      reads.length = 0;
      const res = await call(host);
      expect(res.statusCode).toBe(200);
      expect((res.body as { edits: Array<{ selector: string; patch: { text: string } }> }).edits).toEqual([
        { selector: "#hero", patch: { text: "Acme live" }, removed: false },
      ]);
      expect((res.body as { badge_hidden: boolean }).badge_hidden).toBe(false);
      const resourceRows = reads.filter((r) => r.table === "tenant_resources").reduce((n, r) => n + r.rowsServed, 0);
      const customRows = reads.filter((r) => r.table === "tenant_custom_domains").reduce((n, r) => n + r.rowsServed, 0);
      expect(resourceRows).toBeLessThanOrEqual(2 * ownerRows("tenant_resources"));
      expect(customRows).toBeLessThanOrEqual(2 * ownerRows("tenant_custom_domains"));
      const editRows = reads.filter((r) => r.table === "website_edits").reduce((n, r) => n + r.rowsServed, 0);
      expect(editRows).toBe(1);
    }
  });

  it("every ownership read carries a host or tenant filter", async () => {
    await call("acme.zaviagent.com");
    const ownership = reads.filter((r) => r.table !== "website_edits");
    expect(ownership.length).toBeGreaterThan(0);
    for (const r of ownership) {
      expect(r.filters.some(scoped)).toBe(true);
    }
  });

  it("still fails closed when two tenants claim the host, with scoped reads only", async () => {
    tables.tenant_resources.push({
      tenant_id: "tnt-squatter",
      resource_kind: "domain",
      status: "ready",
      external_ref: { hostname: "acme.zaviagent.com" },
    });
    const res = await call("acme.zaviagent.com");
    expect(res.body).toEqual({ edits: [], badge_hidden: true });
    expect(mocks.getBoolSettingStrict).not.toHaveBeenCalled();
    for (const r of reads) expect(r.filters.some(scoped)).toBe(true);
  });

  it("a candidate whose host only contains the wanted host never claims it", async () => {
    tables.tenant_resources.push({
      tenant_id: "tnt-lookalike",
      resource_kind: "hosting",
      status: "ready",
      external_ref: { url: "https://acme.onrender.com.evil.example" },
    });
    const res = await call("acme.onrender.com");
    expect((res.body as { edits: unknown[] }).edits).toHaveLength(1);
    expect(mocks.getBoolSettingStrict).toHaveBeenCalledWith("website_platform_badge_hidden", OWNER);
  });

  it("refuses a host with pattern or filter metacharacters before touching the database", async () => {
    for (const app of ["%", "acme%.onrender.com", "acme_.onrender.com", "a,b.example", "x(y).example", "acme.onrender.com;drop"]) {
      reads.length = 0;
      const res = await call(app);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ edits: [], badge_hidden: true });
      expect(reads).toHaveLength(0);
    }
  });

  it("refuses a host that is not a real hostname before any database read", async () => {
    for (const app of [".", "com", "..", "a.", ".com", "acme..onrender.com", "-.co", "a.b", "localhost", ":443", ".:80", "a-.com"]) {
      reads.length = 0;
      const res = await call(app);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ edits: [], badge_hidden: true });
      expect(reads).toHaveLength(0);
    }
    expect(mocks.getBoolSettingStrict).not.toHaveBeenCalled();
  });

  it("still serves a real host with a port and a custom domain", async () => {
    reads.length = 0;
    await call("acme.onrender.com:443");
    expect(reads.length).toBeGreaterThan(0);
    reads.length = 0;
    await call("shop.example.co.uk");
    expect(reads.length).toBeGreaterThan(0);
  });

  it("an unknown host reads nothing from website_edits and serves nothing", async () => {
    const res = await call("nobody.onrender.com");
    expect(res.body).toEqual({ edits: [], badge_hidden: true });
    expect(reads.filter((r) => r.table === "website_edits")).toHaveLength(0);
    expect(reads.reduce((n, r) => n + r.rowsServed, 0)).toBe(0);
  });
});
