
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const STAFF_USER_ID = "11111111-1111-1111-1111-111111111111";
const STAFF_EMAIL = "ravi@zaviagent.com";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockTable = Record<string, any> & {
  _resolve: { data: unknown; error: unknown };
};

function newMockTable(): MockTable {
  const t = {} as MockTable;
  t._resolve = { data: null, error: null };
  t.select = vi.fn(() => t);
  t.eq = vi.fn(() => t);
  t.order = vi.fn(() => t);
  t.upsert = vi.fn(() => Promise.resolve(t._resolve));
  t.insert = vi.fn(() => Promise.resolve(t._resolve));
  t.maybeSingle = vi.fn(() => Promise.resolve(t._resolve));
  t.limit = vi.fn(() => Promise.resolve(t._resolve));
  t.then = (resolve: (v: { data: unknown; error: unknown }) => void) =>
    resolve(t._resolve);
  return t;
}

const tables: Record<string, MockTable> = {};

function table(name: string): MockTable {
  if (!tables[name]) tables[name] = newMockTable();
  return tables[name];
}

function resetCache(): void {
}

vi.mock("@/services/supabase", () => {
  return {
    serviceClient: vi.fn(() => ({
      from: vi.fn((name: string) => table(name)),
    })),
  };
});

vi.mock("@/services/auth/staff-middleware", () => {
  return {
    assertStaff: vi.fn(() => ({
      user_id: STAFF_USER_ID,
      email: STAFF_EMAIL,
    })),
  };
});

vi.mock("@/services/agents/registry", () => {
  return {
    listAgents: vi.fn(() => [
      { slug: "alpha", name: "Alpha", description: "A", content_hash: "h1", metadata_praxis: {} },
      { slug: "beta", name: "Beta", description: "B", content_hash: "h2", metadata_praxis: {} },
      { slug: "gamma", name: "Gamma", description: "C", content_hash: "h3", metadata_praxis: {} },
    ]),
    LISTED_AGENT_SLUGS: ["alpha", "beta", "gamma"],
    listAlwaysOnSlugs: vi.fn(() => []),
    listDefaultDisabledSlugs: vi.fn(() => []),
    getAgentDefaultState: vi.fn(() => "enabled"),
    isChannelOnlyAgent: vi.fn(() => false),
  };
});

vi.mock("@/services/agents/runner", () => {
  return {
    listAgentRuns: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/services/auth/middleware", () => {
  return {
    requireAuth: vi.fn().mockResolvedValue({
      user_id: "user-1",
      tenant_id: "tenant-1",
      access_token: "tok",
    }),
  };
});

vi.mock("@/services/auth/members", () => {
  return {
    canUserAccessAgent: vi.fn().mockResolvedValue(true),
    tenantRoleOf: vi.fn().mockResolvedValue("owner"),
  };
});

import { assertStaff } from "@/services/auth/staff-middleware";
import {
  staffAgentVisibilityGet,
  staffAgentVisibilityPost,
} from "../../routes/admin/agent-visibility";
import { agentsList } from "../../routes/agents/list";
import { listAgents } from "@/services/agents/registry";

function mkRes(): {
  res: Response;
  getStatus: () => number;
  getJson: () => unknown;
} {
  let status = 200;
  let body: unknown = undefined;
  const res = {
    status: vi.fn((c: number) => {
      status = c;
      return res;
    }),
    json: vi.fn((b: unknown) => {
      body = b;
      return res;
    }),
  } as unknown as Response;
  return { res, getStatus: () => status, getJson: () => body };
}

function mkReq(body?: unknown): Request {
  return { body, params: {}, query: {} } as unknown as Request;
}

describe("staff/agent-visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
    for (const k of Object.keys(tables)) delete tables[k];
    (assertStaff as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      user_id: STAFF_USER_ID,
      email: STAFF_EMAIL,
    }));
  });

  describe("GET /api/admin/agent-visibility", () => {
    it("happy: returns all 3 slugs, none hidden when blob empty", async () => {
      const cfg = table("system_config");
      cfg.maybeSingle
        .mockResolvedValueOnce({ data: { blob: {} }, error: null })
        .mockResolvedValueOnce({
          data: { updated_at: null, updated_by: null },
          error: null,
        });

      const { res, getStatus, getJson } = mkRes();
      await staffAgentVisibilityGet(mkReq(), res);
      expect(getStatus()).toBe(200);
      const json = getJson() as { slugs: Array<{ slug: string; hidden: boolean }> };
      expect(json.slugs.length).toBe(3);
      expect(json.slugs.every((s) => s.hidden === false)).toBe(true);
    });

    it("happy: marks 2 slugs hidden when blob has them", async () => {
      const cfg = table("system_config");
      cfg.maybeSingle
        .mockResolvedValueOnce({
          data: { blob: { disabled_agent_slugs: ["alpha", "gamma"] } },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { updated_at: "2026-05-11T00:00:00Z", updated_by: "u1" },
          error: null,
        });

      const { res, getJson } = mkRes();
      await staffAgentVisibilityGet(mkReq(), res);
      const json = getJson() as { slugs: Array<{ slug: string; hidden: boolean }> };
      const map = new Map(json.slugs.map((s) => [s.slug, s.hidden]));
      expect(map.get("alpha")).toBe(true);
      expect(map.get("beta")).toBe(false);
      expect(map.get("gamma")).toBe(true);
    });

    it("missing system_config row → 200, all hidden:false", async () => {
      const cfg = table("system_config");
      cfg.maybeSingle
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: null, error: null });

      const { res, getStatus, getJson } = mkRes();
      await staffAgentVisibilityGet(mkReq(), res);
      expect(getStatus()).toBe(200);
      const json = getJson() as { slugs: Array<{ hidden: boolean }> };
      expect(json.slugs.every((s) => s.hidden === false)).toBe(true);
    });

    it("Postgres read error → 500 config_query_failed (fail-closed)", async () => {
      const cfg = table("system_config");
      cfg.maybeSingle.mockResolvedValueOnce({
        data: null,
        error: { message: "boom" },
      });

      const { res, getStatus, getJson } = mkRes();
      await staffAgentVisibilityGet(mkReq(), res);
      expect(getStatus()).toBe(500);
      expect((getJson() as { error: { code: string } }).error.code).toBe(
        "config_query_failed",
      );
    });
  });

  describe("POST /api/admin/agent-visibility", () => {
    it("happy: writes blob, writes audit row, returns deduped list", async () => {
      const cfg = table("system_config");
      cfg.maybeSingle.mockResolvedValueOnce({
        data: { blob: {} },
        error: null,
      });
      cfg._resolve = { data: null, error: null };

      const audit = table("staff_audit_log");
      audit._resolve = { data: null, error: null };

      const { res, getStatus, getJson } = mkRes();
      await staffAgentVisibilityPost(
        mkReq({ disabled_agent_slugs: ["alpha", "alpha", "beta"] }),
        res,
      );
      expect(getStatus()).toBe(200);
      const json = getJson() as { ok: boolean; disabled_agent_slugs: string[] };
      expect(json.ok).toBe(true);
      expect(json.disabled_agent_slugs.sort()).toEqual(["alpha", "beta"]);
      expect(cfg.upsert).toHaveBeenCalledTimes(1);
      const upsertArg = cfg.upsert.mock.calls[0][0] as {
        blob: { disabled_agent_slugs: string[] };
      };
      expect(upsertArg.blob.disabled_agent_slugs.sort()).toEqual(["alpha", "beta"]);
      expect(audit.insert).toHaveBeenCalledTimes(1);
      const auditArg = audit.insert.mock.calls[0][0] as { action: string };
      expect(auditArg.action).toBe("agent_visibility.update");
    });

    it("unknown slug → 400 unknown_slug, no write", async () => {
      const cfg = table("system_config");
      const { res, getStatus, getJson } = mkRes();
      await staffAgentVisibilityPost(
        mkReq({ disabled_agent_slugs: ["alpha", "does-not-exist"] }),
        res,
      );
      expect(getStatus()).toBe(400);
      expect((getJson() as { error: { code: string } }).error.code).toBe(
        "unknown_slug",
      );
      expect(cfg.upsert).not.toHaveBeenCalled();
    });

    it("non-staff session → 401 (assertStaff throws)", async () => {
      (assertStaff as ReturnType<typeof vi.fn>).mockImplementation(() => {
        const err = new Error("not staff") as Error & { status?: number };
        err.status = 401;
        throw err;
      });
      const { res } = mkRes();
      await expect(
        staffAgentVisibilityPost(mkReq({ disabled_agent_slugs: [] }), res),
      ).rejects.toThrow("not staff");
    });
  });

  describe("filter integration", () => {
    it("GET /api/agents excludes disabled slugs after POST writes them", async () => {
      const cfg = table("system_config");
      cfg.maybeSingle.mockResolvedValueOnce({
        data: { blob: {} },
        error: null,
      });
      cfg._resolve = { data: null, error: null };
      table("staff_audit_log")._resolve = { data: null, error: null };

      const { res: postRes } = mkRes();
      await staffAgentVisibilityPost(
        mkReq({ disabled_agent_slugs: ["beta"] }),
        postRes,
      );

      cfg.maybeSingle.mockResolvedValueOnce({
        data: { blob: { disabled_agent_slugs: ["beta"] } },
        error: null,
      });
      table("agent_drafts")._resolve = { data: [], error: null };

      const { res: listRes, getStatus, getJson } = mkRes();
      await agentsList(mkReq(), listRes);
      expect(getStatus()).toBe(200);
      const json = getJson() as { agents: Array<{ slug: string }> };
      const slugs = json.agents.map((a) => a.slug);
      expect(slugs).toContain("alpha");
      expect(slugs).not.toContain("beta");
      expect(slugs).toContain("gamma");
    });

    it("GET /api/agents lists only LISTED_AGENT_SLUGS built-ins", async () => {
      (listAgents as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { slug: "alpha", name: "Alpha", description: "A", content_hash: "h1", metadata_praxis: {} },
        { slug: "delta", name: "Delta", description: "D", content_hash: "h4", metadata_praxis: {} },
      ]);
      table("system_config").maybeSingle.mockResolvedValueOnce({ data: { blob: {} }, error: null });
      table("agent_drafts")._resolve = { data: [], error: null };

      const { res, getStatus, getJson } = mkRes();
      await agentsList(mkReq(), res);
      expect(getStatus()).toBe(200);
      const slugs = (getJson() as { agents: Array<{ slug: string }> }).agents.map((a) => a.slug);
      expect(slugs).toContain("alpha");
      expect(slugs).not.toContain("delta");
    });
  });
});
