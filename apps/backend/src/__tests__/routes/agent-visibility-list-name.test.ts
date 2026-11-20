import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn().mockResolvedValue({
    user_id: "user-1",
    tenant_id: "tenant-1",
    access_token: "tok",
  }),
}));

vi.mock("@/services/agents/registry", () => ({
  listAgents: vi.fn(() => [
    { slug: "company-founder", name: "Company Founder", metadata_praxis: {} },
    { slug: "alpha", name: "Alpha", metadata_praxis: {} },
  ]),
  getAgentDefaultState: vi.fn(() => "disabled"),
  listAlwaysOnSlugs: vi.fn(() => []),
  listDefaultDisabledSlugs: vi.fn(() => ["company-founder"]),
}));

const effectiveRows = [
  {
    slug: "company-founder",
    default_state: "disabled",
    effective_state: "hidden",
    effective_reason: "default_disabled",
    override_state: null,
    override_source: null,
    is_locked: false,
  },
  {
    slug: "mystery",
    default_state: "enabled",
    effective_state: "visible",
    effective_reason: "default_enabled",
    override_state: null,
    override_source: null,
    is_locked: false,
  },
];

vi.mock("@/services/agents/visibility", () => ({
  getAgentEffectiveStates: vi.fn(async () => effectiveRows),
}));

import { agentVisibilityList } from "../../routes/agents/visibility";

function mkRes(): { res: Response; status: () => number; body: () => unknown } {
  let _s = 200;
  let _b: unknown = null;
  const res = {
    status(c: number) { _s = c; return res; },
    json(b: unknown) { _b = b; return res; },
  } as unknown as Response;
  return { res, status: () => _s, body: () => _b };
}

describe("GET /api/agents/visibility — name enrichment", () => {
  it("attaches the registry display name per row, slug fallback when absent", async () => {
    const { res, status, body } = mkRes();
    await agentVisibilityList({} as Request, res);

    expect(status()).toBe(200);
    const out = body() as {
      tenant_id: string;
      agents: Array<Record<string, unknown>>;
    };
    expect(out.tenant_id).toBe("tenant-1");

    const cf = out.agents.find((a) => a.slug === "company-founder")!;
    expect(cf.name).toBe("Company Founder");
    expect(cf.effective_state).toBe("hidden");
    expect(cf.default_state).toBe("disabled");

    const mystery = out.agents.find((a) => a.slug === "mystery")!;
    expect(mystery.name).toBe("mystery");

    for (const a of out.agents) {
      expect(typeof a.name).toBe("string");
      expect(a.name).toBeTruthy();
    }
  });
});
