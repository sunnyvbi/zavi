import { describe, it, expect, vi, beforeEach } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/services/analytics/mixpanel", () => ({ track }));

const { requireAuth } = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth }));

const { loadAgentDefinition } = vi.hoisted(() => ({
  loadAgentDefinition: vi.fn(),
}));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition }));

const { builder } = vi.hoisted(() => ({ builder: vi.fn() }));
vi.mock("../dashboards/registry", () => ({
  DASHBOARD_BUILDERS: { engineer: builder },
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({}),
}));

import { agentDashboard } from "../dashboard";

const AUTH = { tenant_id: "t-1", user_id: "u-1", access_token: "tok" };

function reqRes(query: Record<string, string> = {}, slug = "engineer") {
  const res = {
    json: vi.fn(),
    status: vi.fn(() => res),
  } as unknown as Parameters<typeof agentDashboard>[1] & {
    json: ReturnType<typeof vi.fn>;
  };
  const req = { params: { slug }, query } as unknown as Parameters<
    typeof agentDashboard
  >[0];
  return { req, res };
}

beforeEach(() => {
  track.mockReset();
  requireAuth.mockReset().mockResolvedValue(AUTH);
  loadAgentDefinition.mockReset().mockResolvedValue({ slug: "engineer" });
  builder.mockReset().mockResolvedValue({ active_run: null, prs: [] });
});

describe("GET /api/agents/:slug/dashboard — surface-open counter", () => {
  it("counts a plain open as a roster reach-for", async () => {
    const { req, res } = reqRes();
    await agentDashboard(req, res);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("agent_surface_opened", {
      tenant_id: "t-1",
      user_id: "u-1",
      agent_slug: "engineer",
      source: "roster",
    });
  });

  it("counts the in-reply mount as a summon", async () => {
    const { req, res } = reqRes({ source: "summon" });
    await agentDashboard(req, res);
    expect(track).toHaveBeenCalledWith(
      "agent_surface_opened",
      expect.objectContaining({ source: "summon", agent_slug: "engineer" }),
    );
  });

  it("does not count a refresh, even one claiming a source", async () => {
    const { req, res } = reqRes({ refresh: "1", source: "summon" });
    await agentDashboard(req, res);
    expect(track).not.toHaveBeenCalled();
  });

  it("does not count an open of a slug that is not an agent", async () => {
    loadAgentDefinition.mockResolvedValue(null);
    const { req, res } = reqRes({}, "not-an-agent");
    await agentDashboard(req, res);
    expect(track).not.toHaveBeenCalled();
  });

  it("changes nothing about the response the client gets", async () => {
    const { req, res } = reqRes({ source: "summon" });
    await agentDashboard(req, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.agent_slug).toBe("engineer");
    expect(body.generic).toBe(false);
    expect(body.prs).toEqual([]);
    expect(Object.keys(body)).not.toContain("source");
  });

  it("still serves the dashboard when the analytics rail throws", async () => {
    track.mockImplementation(() => {
      throw new Error("mixpanel down");
    });
    const { req, res } = reqRes();
    await agentDashboard(req, res);
    expect(res.json).toHaveBeenCalled();
    expect(
      (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].generic,
    ).toBe(false);
  });
});
