
import { describe, it, expect, vi, beforeEach } from "vitest";

type Call = { table: string; scope: string; ops: Array<[string, unknown[]]> };
const calls: Call[] = [];
let results: Record<string, { data: unknown; error: unknown }> = {};
function builder(scope: string, table: string) {
  const call: Call = { table, scope, ops: [] };
  calls.push(call);
  const res = () => results[table] ?? { data: [], error: null };
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve(res()).then(ok);
        if (prop === "maybeSingle") {
          return async () => {
            const r = res();
            return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
          };
        }
        return (...args: unknown[]) => {
          call.ops.push([prop, args]);
          return proxy;
        };
      },
    },
  );
  return proxy;
}
vi.mock("@/services/tenant-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/tenant-client")>()),
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({ from: (table: string) => builder(`tenant:${tid}`, table) }),
  globalClient: () => ({ from: (table: string) => builder("global", table) }),
}));

const guarded = vi.fn(async (..._a: unknown[]) => ({ note_id: "n", chunks: 1 }) as unknown);
vi.mock("@/services/memory/upsert-anchor", () => ({ upsertAnchorGuarded: (...a: unknown[]) => guarded(...a) }));
const projectFact = vi.fn(async (..._a: unknown[]) => ({ written: true, error: null }));
vi.mock("@/services/company/facts", () => ({ projectCompanyFactValue: (...a: unknown[]) => projectFact(...a) }));
const writeProse = vi.fn(async (..._a: unknown[]) => ({ stored: true, reason: "written", error: null }));
vi.mock("@/services/company/brief", () => ({ writeCompanyProse: (...a: unknown[]) => writeProse(...a) }));
const seedCompetitors = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/routes/onboarding/activate", () => ({ seedCompetitorBrandsFromEnrichment: (...a: unknown[]) => seedCompetitors(...a) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));
const generate = vi.fn(async (..._a: unknown[]) => ({ company: "# C", ops: "# O", fallback: false }));
vi.mock("../website-memory", () => ({ generateWebsiteMemory: (...a: unknown[]) => generate(...a) }));
const runScan = vi.fn();
vi.mock("../scan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scan")>()),
  runWebsiteScan: (...a: unknown[]) => runScan(...a),
}));

import {
  applyScan,
  failJob,
  generateForJob,
  loadJob,
  scannedShapeAndStage,
  storableScannedShape,
  writeMemory,
} from "../website-memory-job";

const SCAN = "AbCdEfGhIjKlMnOp12";
const row = { tenant_id: "t1", user_id: "u1", host: "acme.com", initial_name: "Acme", scan_public_id: SCAN, status: "pending" as const, attempt: 0 };
const okScan = (over: Record<string, unknown> = {}) => ({
  status: "done",
  enrichment: {
    status: "ok", domain_pages: [], app_listings: [], research_pages: [],
    company_name: "Acme Coffee Roasters", inferredShape: "ecommerce", inferredStage: 2, shapeConfidence: "high",
    competitors: [{ name: "Blue Bottle", url: "", source_title: "", source_url: "", snippet: "" }],
    ...over,
  },
});
const tenantCalls = () => calls.filter((c) => c.table === "tenants");

beforeEach(() => {
  calls.length = 0;
  results = {};
  for (const f of [guarded, projectFact, writeProse, seedCompetitors, generate, runScan]) f.mockClear();
});

describe("loadJob", () => {
  it("skips a row that is not pending", async () => {
    results.tenant_onboarding_memory = { data: [{ ...row, status: "ready" }], error: null };
    expect(await loadJob("t1")).toEqual({ ok: false, reason: "not_pending" });
  });
  it("skips when the row's user is no longer a member of the tenant", async () => {
    results.tenant_onboarding_memory = { data: [row], error: null };
    results.tenant_users = { data: [], error: null };
    expect(await loadJob("t1")).toEqual({ ok: false, reason: "not_member" });
    const member = calls.find((c) => c.table === "tenant_users")!;
    expect(member.scope).toBe("tenant:t1");
    expect(member.ops).toEqual(expect.arrayContaining([["eq", ["user_id", "u1"]]]));
  });
});

describe("applyScan", () => {
  it("renames only while the name is still the one activate set; shape only over a non-founder value", async () => {
    results.onboarding_scans = { data: [okScan()], error: null };
    results.tenants = { data: [{ id: "t1" }], error: null };
    const out = await applyScan(row, SCAN);
    expect(out).toEqual({ name_updated: true, shape: "ecommerce" });

    const scanRead = calls.find((c) => c.table === "onboarding_scans")!;
    expect(scanRead.ops).toEqual(expect.arrayContaining([["eq", ["claimed_by", "u1"]]]));

    const [rename, shape] = tenantCalls();
    expect(rename.scope).toBe("tenant:t1");
    expect(rename.ops).toEqual(expect.arrayContaining([
      ["update", [{ display_name: "Acme Coffee Roasters" }]],
      ["eq", ["display_name", "Acme"]],
    ]));
    expect(shape.ops).toEqual(expect.arrayContaining([
      ["update", [{ company_shape: "ecommerce", company_shape_source: "inferred" }]],
      ["or", ["company_shape.is.null,company_shape_source.is.null,company_shape_source.neq.founder"]],
    ]));
    expect(projectFact).toHaveBeenCalledWith("t1", "company_name", "Acme Coffee Roasters", "onboarding_enrichment", expect.any(String));
    expect(seedCompetitors).toHaveBeenCalledWith("t1", "u1", ["Blue Bottle"]);
  });

  it("a founder-renamed workspace keeps its name (the conditional update matches nothing)", async () => {
    results.onboarding_scans = { data: [okScan({ inferredShape: undefined })], error: null };
    results.tenants = { data: [], error: null };
    expect((await applyScan(row, SCAN)).name_updated).toBe(false);
  });

  it("never stores a guessed marketplace or a low-confidence shape", async () => {
    results.onboarding_scans = { data: [okScan({ company_name: undefined, inferredShape: "marketplace" })], error: null };
    await applyScan(row, SCAN);
    expect(tenantCalls()).toHaveLength(0);
    calls.length = 0;
    results.onboarding_scans = { data: [okScan({ company_name: undefined, shapeConfidence: "low" })], error: null };
    await applyScan(row, SCAN);
    expect(tenantCalls()).toHaveLength(0);
  });

  it("without a usable scan: no tenant writes, the address guess is recorded at the enrichment rank", async () => {
    await applyScan(row, null);
    expect(tenantCalls()).toHaveLength(0);
    expect(calls.some((c) => c.table === "onboarding_scans")).toBe(false);
    expect(projectFact).toHaveBeenCalledWith("t1", "company_name", "Acme", "onboarding_enrichment", expect.any(String));
    expect(seedCompetitors).not.toHaveBeenCalled();
  });
});

describe("shape rules (ported from /start)", () => {
  it("scannedShapeAndStage drops marketplace and low-confidence other", () => {
    expect(scannedShapeAndStage({ status: "ok", domain_pages: [], app_listings: [], research_pages: [], inferredShape: "marketplace", shapeConfidence: "high" }).marketplaceShape).toBe("other");
    expect(scannedShapeAndStage({ status: "ok", domain_pages: [], app_listings: [], research_pages: [], inferredShape: "saas", inferredStage: 9 })).toEqual({ marketplaceShape: "saas", stage: 0 });
    expect(storableScannedShape({ status: "ok", domain_pages: [], app_listings: [], research_pages: [], inferredShape: "saas", shapeConfidence: "low" })).toBeNull();
    expect(storableScannedShape({ status: "skipped", reason: "feature_flag_off" })).toBeNull();
  });
});

describe("generateForJob", () => {
  it("uses the workspace's current name (a founder rename wins) and the claimed scan", async () => {
    results.onboarding_scans = { data: [okScan()], error: null };
    results.tenants = { data: [{ display_name: "Founder Name" }], error: null };
    await generateForJob(row, SCAN);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ orgName: "Founder Name", host: "acme.com", shape: "ecommerce" }));
    expect((generate.mock.calls[0][0] as { enrichment: { status: string } }).enrichment.status).toBe("ok");
  });
});

describe("writeMemory", () => {
  it("ops is guarded on onboarding_seed (a founder or confirmed edit is never overwritten)", async () => {
    await writeMemory("t1", { company: "# C", ops: "# O", fallback: false });
    expect(writeProse).toHaveBeenCalledWith("t1", "# C", "provisioning", expect.any(String));
    expect(guarded).toHaveBeenCalledWith(
      { tenant_id: "t1", slug: "ops", body_markdown: "# O", source: "onboarding_seed", metadata: { seed: "ai" } },
      ["onboarding_seed"],
      undefined,
    );
  });

  it("reports ops not written when the guard refuses", async () => {
    guarded.mockResolvedValueOnce(null);
    expect((await writeMemory("t1", { company: "# C", ops: "# O", fallback: false })).ops_written).toBe(false);
  });

  it("a fallback ops stays a placeholder (not embedded)", async () => {
    await writeMemory("t1", { company: "# C", ops: "# O", fallback: true });
    expect(guarded.mock.calls[0][0]).toMatchObject({ metadata: { seed: "placeholder" } });
    expect(guarded.mock.calls[0][2]).toEqual({ skipEmbedding: true });
  });
});

describe("failJob", () => {
  it("marks a pending row failed for a member", async () => {
    results.tenant_onboarding_memory = { data: [row], error: null };
    results.tenant_users = { data: [{ user_id: "u1" }], error: null };
    expect(await failJob("t1", "model down")).toEqual({ marked: true });
    const upd = calls.filter((c) => c.table === "tenant_onboarding_memory").find((c) => c.ops[0][0] === "update")!;
    expect(upd.ops[0][1][0]).toMatchObject({ status: "failed", error: "model down" });
  });
  it("leaves a ready row alone", async () => {
    results.tenant_onboarding_memory = { data: [{ ...row, status: "ready" }], error: null };
    expect(await failJob("t1", "x")).toEqual({ marked: false });
  });
});
