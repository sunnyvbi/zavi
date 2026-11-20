import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  auth: { user_id: "user-1", tenant_id: "tenant-A", access_token: "jwt-1" } as Record<string, string> | null,
  role: "owner" as string,
  rpc: vi.fn(),
  tenantRpc: vi.fn(),
  config: null as Record<string, unknown> | null,
  catalog: null as unknown,
  setup: { connected: false } as unknown,
  visibility: null as unknown,
  checkStoredLogin: vi.fn(),
  claimed: true as boolean,
  retention: { raw_results_retention: "run", chat_retention: "forever" } as Record<string, unknown>,
  sends: [] as Array<[string, string]>,
  blob: {} as Record<string, unknown>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (!h.auth) {
      res.status(401).json({ error: { code: "unauthenticated" } });
      return null;
    }
    return h.auth;
  }),
}));
vi.mock("@/services/auth/members", () => ({
  isTenantAdminOrOwner: vi.fn(async () => h.role === "owner" || h.role === "admin"),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ rpc: h.rpc }),
}));
vi.mock("@/services/tenant-client", () => {
  const table = (name: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: name === "system_config" ? { blob: h.blob } : null, error: null });
    return b;
  };
  return {
    asTenantId: (t: string) => t,
    tenantClient: () => ({ from: table }),
    globalClient: () => ({ from: table }),
    tenantRpc: (...a: unknown[]) => h.tenantRpc(...a),
  };
});
vi.mock("@/services/tools/operator-db/catalog", () => ({ getCatalog: async () => h.catalog }));
vi.mock("@/services/data-gateway/resolve", () => ({ readDbConfig: async () => h.config }));
vi.mock("@/services/data-gateway", async () => {
  const settings = await vi.importActual<typeof import("@/services/data-gateway/settings")>("@/services/data-gateway/settings");
  return {
    checkVisibilityNames: settings.checkVisibilityNames,
    revokeCommandFor: settings.revokeCommandFor,
    readDbSetup: async () => h.setup,
    readDbRetention: async () => h.retention,
    readDbVisibility: async () => h.visibility,
    checkStoredLogin: (...a: unknown[]) => h.checkStoredLogin(...a),
  };
});
vi.mock("@/email/sendAuthEmail", () => ({
  resolveInviteSender: async () => ({ tenantName: "Acme", inviterLabel: "Priya", inviterEmail: "priya@acme.com" }),
  sgSend: async (to: string, subject: string) => {
    h.sends.push([to, subject]);
  },
}));
vi.mock("@/email/theme", async () => ({
  ...(await vi.importActual<object>("@/email/theme")),
  webOrigin: () => "https://www.zaviagent.com",
}));

import {
  databaseRequestAccess,
  operatorDbDisconnect,
  operatorDbPrivacyGet,
  operatorDbPrivacyPut,
  operatorDbSetup,
  operatorDbVisibilityGet,
  operatorDbVisibilityPut,
  DEFAULT_PROVIDER_LINE,
} from "../operator-db-settings";

function mockRes() {
  const res: { statusCode: number; body: any } & Record<string, unknown> = { statusCode: 200, body: null };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res as unknown as Response & { statusCode: number; body: any };
}
const req = (body: unknown = {}, query: Record<string, string> = {}) =>
  ({ body, query, headers: { authorization: "Bearer jwt-1" } }) as unknown as Request;

const CATALOG = {
  dialect: "postgres",
  catalog: { tables: [{ name: "users", columns: [{ name: "id" }, { name: "email" }], rowEstimate: 10 }, { name: "audit", columns: [{ name: "id" }], rowEstimate: 3 }] },
  hints: {},
  catalog_hash: "h1",
  coverage: null,
  discovery_error: null,
  updated_at: null,
};

beforeEach(() => {
  h.auth = { user_id: "user-1", tenant_id: "tenant-A", access_token: "jwt-1" };
  h.role = "owner";
  h.rpc.mockReset().mockResolvedValue({ error: null });
  h.tenantRpc.mockReset().mockImplementation(async (_t: string, name: string) =>
    name === "claim_db_access_request" ? { data: h.claimed, error: null } : { data: ["owner@acme.com", "admin@acme.com"], error: null },
  );
  h.config = { type: "postgres" };
  h.retention = { raw_results_retention: "run", chat_retention: "forever" };
  h.catalog = CATALOG;
  h.setup = { connected: true, mode: "direct", dialect: "postgres", legacy: false, managed_by: null, discovery: "ready", settings_confirmed: true };
  h.visibility = { dialect: "postgres", discovery: "ready", tables: [], sensitive: [], removed_by_view: [], hidden_fields: [], settings_confirmed: true };
  h.checkStoredLogin.mockReset().mockResolvedValue("verified");
  h.claimed = true;
  h.sends = [];
  h.blob = {};
});

describe("member gating", () => {
  it.each(["member", "viewer"])("%s: visibility, privacy and disconnect are 403 and nothing is written", async (role) => {
    h.role = role;
    for (const fn of [operatorDbVisibilityGet, operatorDbVisibilityPut, operatorDbPrivacyGet, operatorDbPrivacyPut, operatorDbDisconnect]) {
      const res = mockRes();
      await fn(req({ catalog_hash: "h1", disabled_tables: [], hidden_fields: [], unhidden_fields: [], raw_results_retention: "7", chat_retention: "30" }), res);
      expect(res.statusCode).toBe(403);
      expect(res.body.error.code).toBe("not_admin");
    }
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.checkStoredLogin).not.toHaveBeenCalled();
  });

  it("member can read setup status, which carries no policy, retention or secret fields", async () => {
    h.role = "member";
    const res = mockRes();
    await operatorDbSetup(req(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.connected).toBe(true);
    const keys = Object.keys(res.body);
    for (const k of ["hidden_fields", "unhidden_fields", "disabled_tables", "raw_results_retention", "chat_retention", "connection_secret_key"]) {
      expect(keys).not.toContain(k);
    }
  });

  it("unauthenticated -> 401", async () => {
    h.auth = null;
    const res = mockRes();
    await operatorDbSetup(req(), res);
    expect(res.statusCode).toBe(401);
  });
});

describe("visibility", () => {
  it("re-checks the stored login only when asked, as the auth person", async () => {
    let res = mockRes();
    await operatorDbVisibilityGet(req(), res);
    expect(res.body.read_only).toBeNull();
    expect(h.checkStoredLogin).not.toHaveBeenCalled();
    res = mockRes();
    await operatorDbVisibilityGet(req({}, { check: "1" }), res);
    expect(res.body.read_only).toBe("verified");
    expect(h.checkStoredLogin).toHaveBeenCalledWith({ tenant_id: "tenant-A", caller: { kind: "person", user_id: "user-1", feature: "Connection test" } });
  });

  it("PUT with an unknown table -> 400 and no RPC", async () => {
    const res = mockRes();
    await operatorDbVisibilityPut(req({ catalog_hash: "h1", disabled_tables: ["payments"], hidden_fields: [], unhidden_fields: [] }), res);
    expect(res.statusCode).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("PUT with an unknown field -> 400 and no RPC", async () => {
    const res = mockRes();
    await operatorDbVisibilityPut(req({ catalog_hash: "h1", disabled_tables: [], hidden_fields: [], unhidden_fields: ["users.phone"] }), res);
    expect(res.statusCode).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("PUT before discovery -> 409", async () => {
    h.catalog = null;
    const res = mockRes();
    await operatorDbVisibilityPut(req({ catalog_hash: "h1", disabled_tables: [], hidden_fields: [], unhidden_fields: [] }), res);
    expect(res.statusCode).toBe(409);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("PUT valid -> set_db_visibility on the auth tenant", async () => {
    const res = mockRes();
    await operatorDbVisibilityPut(req({ catalog_hash: "h1", disabled_tables: ["audit"], hidden_fields: [], unhidden_fields: ["users.email"], tenant_id: "tenant-B" }), res);
    expect(res.statusCode).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("set_db_visibility", {
      p_tenant_id: "tenant-A",
      p_catalog_hash: "h1",
      p_disabled_tables: ["audit"],
      p_hidden_fields: [],
      p_unhidden_fields: ["users.email"],
    });
  });

  it("PUT with a stale catalog hash -> 409 'Your database changed', no RPC", async () => {
    const res = mockRes();
    await operatorDbVisibilityPut(req({ catalog_hash: "old", disabled_tables: [], hidden_fields: [], unhidden_fields: [] }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.message).toBe("Your database changed, review again.");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("PUT without a catalog hash -> 400", async () => {
    const res = mockRes();
    await operatorDbVisibilityPut(req({ disabled_tables: [], hidden_fields: [], unhidden_fields: [] }), res);
    expect(res.statusCode).toBe(400);
  });

  it("the catalog changing between the check and the write (RPC ZD409) is 409", async () => {
    h.rpc.mockResolvedValueOnce({ error: { code: "ZD409" } });
    const res = mockRes();
    await operatorDbVisibilityPut(req({ catalog_hash: "h1", disabled_tables: [], hidden_fields: [], unhidden_fields: [] }), res);
    expect(res.statusCode).toBe(409);
  });

  it("an RPC gate refusal (42501) is 403", async () => {
    h.rpc.mockResolvedValueOnce({ error: { code: "42501" } });
    const res = mockRes();
    await operatorDbVisibilityPut(req({ catalog_hash: "h1", disabled_tables: [], hidden_fields: [], unhidden_fields: [] }), res);
    expect(res.statusCode).toBe(403);
  });
});

describe("privacy", () => {
  it("rejects a retention outside the allowed values", async () => {
    const res = mockRes();
    await operatorDbPrivacyPut(req({ raw_results_retention: "14", chat_retention: "forever" }), res);
    expect(res.statusCode).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("saves through set_db_privacy", async () => {
    const res = mockRes();
    await operatorDbPrivacyPut(req({ raw_results_retention: "7", chat_retention: "90" }), res);
    expect(h.rpc).toHaveBeenCalledWith("set_db_privacy", { p_tenant_id: "tenant-A", p_raw_results_retention: "7", p_chat_retention: "90" });
  });

  it("provider lines default when config is unset, and follow config when set", async () => {
    let res = mockRes();
    await operatorDbPrivacyGet(req(), res);
    expect(res.body.providers).toEqual([
      { name: "Anthropic", line: DEFAULT_PROVIDER_LINE },
      { name: "OpenAI", line: DEFAULT_PROVIDER_LINE },
    ]);
    h.blob = { ai_provider_policy: { Anthropic: "Never used for training · Zero retention" } };
    res = mockRes();
    await operatorDbPrivacyGet(req(), res);
    expect(res.body.providers[0]).toEqual({ name: "Anthropic", line: "Never used for training · Zero retention" });
    expect(res.body.providers[1].line).toBe(DEFAULT_PROVIDER_LINE);
  });
});

describe("disconnect", () => {
  it("returns the dialect's revoke command, from what the RPC disconnected", async () => {
    h.rpc.mockResolvedValueOnce({ data: { dialect: "mysql", managed_by: null }, error: null });
    const res = mockRes();
    await operatorDbDisconnect(req(), res);
    expect(h.rpc).toHaveBeenCalledWith("disconnect_operator_db", { p_tenant_id: "tenant-A" });
    expect(res.body.revoke_command).toContain("DROP USER");
  });
});

describe("disconnect of a Zavi-made database", () => {
  it("revokes Zavi's own read-only login", async () => {
    h.rpc.mockResolvedValueOnce({ data: { dialect: "postgres", managed_by: "zavi" }, error: null });
    const res = mockRes();
    await operatorDbDisconnect(req(), res);
    expect(res.body.revoke_command).toContain("DROP ROLE zavi_readonly;");
    expect(res.body.revoke_command).not.toContain("zavi_reader");
  });
});

describe("privacy for an old connection", () => {
  it("reports null retention (today's behaviour), not a default", async () => {
    h.retention = { raw_results_retention: null, chat_retention: null };
    const res = mockRes();
    await operatorDbPrivacyGet(req(), res);
    expect(res.body).toMatchObject({ raw_results_retention: null, chat_retention: null });
  });
});

describe("request access", () => {
  it("owner -> 400, no email", async () => {
    const res = mockRes();
    await databaseRequestAccess(req(), res);
    expect(res.statusCode).toBe(400);
    expect(h.sends).toEqual([]);
  });

  it("member: emails every owner/admin once and records the request", async () => {
    h.role = "member";
    const res = mockRes();
    await databaseRequestAccess(req(), res);
    expect(res.body).toMatchObject({ ok: true, sent: true });
    expect(h.sends.map((s) => s[0])).toEqual(["owner@acme.com", "admin@acme.com"]);
    expect(h.sends[0][1]).toBe("Priya asked to connect your database to Zavi");
    expect(h.tenantRpc).toHaveBeenCalledWith("tenant-A", "claim_db_access_request", { p_user_id: "user-1" });
    expect(h.tenantRpc).toHaveBeenCalledWith("tenant-A", "tenant_admin_emails", {});
  });

  it("member: when the atomic claim is not won (sent in the last 24h), nothing is emailed", async () => {
    h.role = "member";
    h.claimed = false;
    const res = mockRes();
    await databaseRequestAccess(req(), res);
    expect(res.body).toMatchObject({ ok: true, sent: false, already_requested: true });
    expect(h.sends).toEqual([]);
  });

  it("member: two concurrent requests email once (only the claim winner sends)", async () => {
    h.role = "member";
    let first = true;
    h.tenantRpc.mockImplementation(async (_t: string, name: string) => {
      if (name !== "claim_db_access_request") return { data: ["owner@acme.com"], error: null };
      const won = first;
      first = false;
      return { data: won, error: null };
    });
    const [a, b] = [mockRes(), mockRes()];
    await Promise.all([databaseRequestAccess(req(), a), databaseRequestAccess(req(), b)]);
    expect(h.sends).toHaveLength(1);
  });
});
