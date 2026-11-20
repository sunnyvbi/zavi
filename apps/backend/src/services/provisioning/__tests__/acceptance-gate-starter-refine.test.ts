import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "select", "eq", "neq", "is"]) chain[m] = () => chain;
    chain.limit = async () => ({ data: [], error: null });
    return chain;
  },
}));
vi.mock("@/services/website/app-data", () => ({
  withGeneratedAppClient: vi.fn(async () => ({ rowCount: 0, rows: [] })),
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async (key: string) => {
    if (key === "build_smoke_gate" || key === "site_meta_and_404") return true;
    return false;
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "order"]) chain[m] = () => chain;
  chain.limit = async () => ({ data: [{ external_ref: { url: "https://fresh-cuts-1a2b.zaviagent.com" } }], error: null });
  chain.insert = async () => ({ error: { code: "23505", message: "duplicate key" } });
  return { serviceClient: () => chain };
});

import { acceptanceProbe } from "../acceptance-gate-driver";
import { STARTER_APP_DESCRIPTION } from "../acceptance-gate";
import type { ConductorNode } from "@/services/agents/conductor";

const HOME = `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>Fresh Cuts Barbers</title><meta name="description" content="${STARTER_APP_DESCRIPTION}"/></head><body><main><h1>Fresh cuts in Leeds</h1><p>Walk in or book a chair.</p></main></body></html>`;

const node = { id: "deploy", payload: { stage: "deploy" } } as unknown as ConductorNode;

describe("old-flow STARTER_DETAILS runs on first builds only (DEL-1323 review)", () => {
  const ORIG = process.env.BUILD_ACCEPTANCE_GATE_MODE;

  beforeEach(() => {
    delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url).pathname;
      const body = path === "/" ? HOME : "";
      return new Response(body, { status: path === "/" ? 200 : 404, headers: { "content-type": "text/html" } });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIG === undefined) delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
    else process.env.BUILD_ACCEPTANCE_GATE_MODE = ORIG;
  });

  it("a first build that kept the starter description is blocked by STARTER_DETAILS", async () => {
    const out = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-first", node });
    expect(out.mode).toBe("enforce");
    expect(out.pass).toBe(false);
    expect(out.signal).toMatch(/^STARTER_DETAILS: .*the starter description/);
  });

  it("a refine of a site that kept the starter description is not failed on it, whether flagged by the conductor or by pre_refine_sha", async () => {
    const flagged = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-refine", node, refine: true });
    expect(flagged.signal).not.toContain("STARTER_DETAILS");
    expect(flagged.pass).toBe(true);
    const bySha = await acceptanceProbe({
      tenant_id: "t1",
      conductor_run_id: "run-refine-2",
      node: { ...node, payload: { stage: "deploy", pre_refine_sha: "abc1234" } } as unknown as ConductorNode,
    });
    expect(bySha.signal).not.toContain("STARTER_DETAILS");
    expect(bySha.pass).toBe(true);
  });
});
