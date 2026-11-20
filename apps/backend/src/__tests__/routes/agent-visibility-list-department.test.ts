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
    { slug: "operator", name: "operator", metadata_praxis: { department: "leadership" } },
    { slug: "engineer", name: "engineer", metadata_praxis: { department: "product" } },
    { slug: "legacy-fork", name: "Legacy Fork", metadata_praxis: {} },
  ]),
  getAgentDefaultState: vi.fn(() => "enabled"),
  listAlwaysOnSlugs: vi.fn(() => []),
  listDefaultDisabledSlugs: vi.fn(() => []),
}));

const effectiveRows = [
  {
    slug: "operator",
    default_state: "always_on",
    effective_state: "visible",
    effective_reason: "always_on",
    override_state: null,
    override_source: null,
    is_locked: true,
  },
  {
    slug: "engineer",
    default_state: "always_on",
    effective_state: "visible",
    effective_reason: "always_on",
    override_state: null,
    override_source: null,
    is_locked: true,
  },
  {
    slug: "legacy-fork",
    default_state: "enabled",
    effective_state: "visible",
    effective_reason: "default_enabled",
    override_state: null,
    override_source: null,
    is_locked: false,
  },
  {
    slug: "ghost",
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

describe("GET /api/agents/visibility — department enrichment", () => {
  it("attaches the registry department per row, 'others' fallback when absent", async () => {
    const { res, status, body } = mkRes();
    await agentVisibilityList({} as Request, res);

    expect(status()).toBe(200);
    const out = body() as { agents: Array<Record<string, unknown>> };
    const bySlug = new Map(out.agents.map((a) => [a.slug, a]));

    expect(bySlug.get("operator")!.department).toBe("leadership");
    expect(bySlug.get("engineer")!.department).toBe("product");
    expect(bySlug.get("legacy-fork")!.department).toBe("others");
    expect(bySlug.get("ghost")!.department).toBe("others");

    for (const a of out.agents) {
      expect(typeof a.department).toBe("string");
      expect(a.department).toBeTruthy();
    }
  });
});
