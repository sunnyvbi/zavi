import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_ID = "73db45ff-457e-4541-bc8f-bdb625390204";
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const REQUEST_ID = "22222222-3333-4444-8555-666666666666";
const WEBSITE = "https://www.upcar.ai/";

const { assertStaffMock, auditMock, safeUrlMock, renderMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "staff-user", email: "staff@zavi.ai" })),
  auditMock: vi.fn(async () => undefined),
  renderMock: vi.fn(async (_tenant_id: string) => true),
  safeUrlMock: vi.fn(async () => undefined),
}));

vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: auditMock }));
vi.mock("@/services/company/brief", () => ({
  regenerateCompanyBrief: (tenant_id: string) => renderMock(tenant_id),
}));
vi.mock("@/services/onboarding/enrichment/url-guard", () => ({ assertSafeUrl: safeUrlMock }));
vi.mock("@/services/agents/ensure-runnable", () => ({ ensureAgentRunnable: vi.fn(async () => ({ runnable: true })) }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn(async () => ({ run_id: RUN_ID })) }));

const { serviceClientMock, state, rpcCalls, rpcResults, reset } = vi.hoisted(() => {
  type Result = { data: unknown; error: { message: string } | null };
  const s = { queues: {} as Record<string, Result[]> };
  const rpcCalls = [] as Array<{ name: string; args: Record<string, unknown> }>;
  const rpcResults = { byName: {} as Record<string, Result> };
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return Promise.resolve(rpcResults.byName[name] ?? { data: true, error: null });
    },
    from(table: string) {
      const result = () => {
        const q = s.queues[table];
        if (!q?.length) return { data: null, error: null };
        return q.length > 1 ? q.shift()! : q[0];
      };
      const builder: Record<string, unknown> = {};
      for (const op of ["select", "eq", "upsert", "maybeSingle", "single"]) {
        builder[op] = (..._a: unknown[]) =>
          op === "maybeSingle" || op === "single" ? Promise.resolve(result()) : builder;
      }
      builder.then = (res: (v: unknown) => unknown, rej?: (r: unknown) => unknown) =>
        Promise.resolve(result()).then(res, rej);
      return builder;
    },
  };
  return {
    serviceClientMock: vi.fn(() => client),
    state: s,
    rpcCalls,
    rpcResults,
    reset: () => {
      s.queues = {};
      rpcCalls.length = 0;
      rpcResults.byName = {};
      auditMock.mockClear();
      safeUrlMock.mockClear();
    },
  };
});

vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import { staffCompanyProfilePublish } from "../company-profiles";

type Handler = typeof staffCompanyProfilePublish;

function makeReqRes(body: unknown) {
  const req = { body, params: { tenant_id: TENANT_ID }, query: {} } as unknown as Parameters<Handler>[0];
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(p: unknown) { this.payload = p; return this; },
  };
  return { req, res: res as unknown as Parameters<Handler>[1] & typeof res };
}

function arrange(website: string = WEBSITE) {
  state.queues.agent_runs = [{
    data: {
      id: RUN_ID,
      status: "success",
      parse_ok: true,
      error: null,
      payload: { source: "company_profile_research_v1", request_id: REQUEST_ID, website },
      parsed: {
        kind: "report",
        blocks: [{
          type: "table",
          columns: ["Field", "Value"],
          rows: [
            ["industry", "Peer-to-peer car rental marketplace"],
            ["category", "P2P car rental with door delivery"],
            ["founded", "2024"],
            ["location", "San Francisco, CA, USA"],
          ],
          citations: [1],
        }],
        sources: [{ n: 1, url: "https://www.upcar.ai/aboutus" }],
      },
    },
    error: null,
  }];
  state.queues.company_profiles = [{ data: { id: "cp1" }, error: null }];
  state.queues.tenants = [{ data: { display_name: "UpcarAI" }, error: null }];
}

const body = {
  run_id: RUN_ID,
  request_id: REQUEST_ID,
  profile: {
    website: WEBSITE,
    industry: "Peer-to-peer car rental marketplace",
    category: "P2P car rental with door delivery",
    founded: "2024",
    location: "San Francisco, CA, USA",
    social_profiles: [],
  },
};

beforeEach(reset);

describe("staffCompanyProfilePublish — tenant_fact projection", () => {
  it("projects category -> what_we_sell as staff_reviewed", async () => {
    arrange();
    const { req, res } = makeReqRes(body);
    await staffCompanyProfilePublish(req, res);

    expect(res.statusCode).toBe(200);
    const proj = rpcCalls.find((c) => c.name === "project_tenant_fact");
    expect(proj).toBeDefined();
    expect(proj!.args).toMatchObject({
      p_tenant_id: TENANT_ID,
      p_key: "what_we_sell",
      p_value_text: "P2P car rental with door delivery",
      p_source: "staff_reviewed",
    });
  });

  it("routes domain to the one validated writer, never through project_tenant_fact", async () => {
    arrange();
    const { req, res } = makeReqRes(body);
    await staffCompanyProfilePublish(req, res);

    const dom = rpcCalls.find((c) => c.name === "set_tenant_company_domain_system");
    expect(dom).toBeDefined();
    expect(dom!.args).toMatchObject({ p_url: "https://www.upcar.ai", p_source: "staff_reviewed" });
    expect(rpcCalls.filter((c) => c.name === "project_tenant_fact" && c.args.p_key === "domain")).toHaveLength(0);
  });

  it("normalizes the projected domain to a bare origin, matching the human write path", async () => {
    arrange("https://www.upcar.ai/about?x=1");
    const { req, res } = makeReqRes({ ...body, profile: { ...body.profile, website: "https://www.upcar.ai/about?x=1" } });
    await staffCompanyProfilePublish(req, res);
    const dom = rpcCalls.find((c) => c.name === "set_tenant_company_domain_system")!;
    expect(dom.args.p_url).toBe("https://www.upcar.ai");
  });

  it("reports domain as attempted, NOT written — the RPC no-ops over a human fact", async () => {
    arrange();
    const { req, res } = makeReqRes(body);
    await staffCompanyProfilePublish(req, res);
    const payload = res.payload as { projected: { written: string[]; attempted: string[] } };
    expect(payload.projected.attempted).toContain("domain");
    expect(payload.projected.written).not.toContain("domain");
  });

  it("still returns 200 when a projection errors, and surfaces it in body + audit", async () => {
    arrange();
    rpcResults.byName["project_tenant_fact"] = { data: null, error: { message: "boom" } };
    const { req, res } = makeReqRes(body);
    await staffCompanyProfilePublish(req, res);

    expect(res.statusCode).toBe(200);
    const payload = res.payload as { projected: { errors: string[] } };
    expect(payload.projected.errors).toContainEqual(expect.stringContaining("boom"));
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ projected: expect.anything() }) }),
    );
  });

  it("records a refusal separately from an error", async () => {
    arrange();
    rpcResults.byName["project_tenant_fact"] = { data: false, error: null };
    const { req, res } = makeReqRes(body);
    await staffCompanyProfilePublish(req, res);
    const payload = res.payload as { projected: { refused: string[]; errors: string[] } };
    expect(payload.projected.refused).toContain("what_we_sell");
    expect(payload.projected.errors).toHaveLength(0);
  });
});

describe("staffCompanyProfilePublish — the company brief render", () => {
  it("renders exactly once for a publish that writes many facts", async () => {
    renderMock.mockClear();
    arrange();
    const { req, res } = makeReqRes(body);
    await staffCompanyProfilePublish(req, res);

    expect(res.statusCode).toBe(200);
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledWith(TENANT_ID);
  });

  it("still renders when the website is the only thing published", async () => {
    renderMock.mockClear();
    arrange();
    const { req, res } = makeReqRes({
      ...body,
      profile: {
        ...body.profile,
        category: "",
        industry: "",
        location: "",
        founded: "",
        social_profiles: [],
      },
    });
    await staffCompanyProfilePublish(req, res);

    expect(res.statusCode).toBe(200);
    expect(renderMock).toHaveBeenCalledTimes(1);
  });
});
