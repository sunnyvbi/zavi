import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  auth: { user_id: "user-1", tenant_id: "tenant-A", access_token: "jwt-1" } as Record<string, string> | null,
  role: "owner",
  rpc: vi.fn(),
  connector: null as Record<string, unknown> | null,
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
vi.mock("@/services/auth/members", () => ({ isTenantAdminOrOwner: vi.fn(async () => h.role === "owner" || h.role === "admin") }));
vi.mock("@/services/supabase", () => ({ serverClientFromBearer: () => ({ rpc: h.rpc }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/data-gateway/connector/wakeup", () => ({ publishRevoke: async () => undefined, onRevoke: () => () => undefined }));
vi.mock("@/services/data-gateway/connector/status", async (orig) => ({
  ...(await orig<typeof import("@/services/data-gateway/connector/status")>()),
  readActiveConnector: async () => h.connector,
}));

import { connectorPairCode, connectorRemove, connectorStatus } from "../operator-db-connector";

function res() {
  const r = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  const out = {
    setHeader(k: string, v: string) {
      r.headers[k.toLowerCase()] = v;
    },
    status(c: number) {
      r.statusCode = c;
      return out;
    },
    json(b: unknown) {
      r.body = b;
      return out;
    },
  };
  return { r, res: out as unknown as Response };
}
const req = (body: unknown = {}) => ({ body, query: { tenant_id: "tenant-B" }, headers: {} }) as unknown as Request;

const rules = { allowed_tables: ["bookings"], blocked_fields: ["users.email"], what_can_leave: "totals_and_counts_only", max_rows: 200 };

beforeEach(() => {
  h.auth = { user_id: "user-1", tenant_id: "tenant-A", access_token: "jwt-1" };
  h.role = "owner";
  h.rpc.mockReset();
  h.connector = {
    id: "conn-1",
    machine_name: "mac-1",
    version: "1.0.3",
    dialect: "postgres",
    rules,
    last_seen_at: new Date(Date.now() - 5000).toISOString(),
    last_skipped_feature: null,
    last_skipped_at: null,
    created_at: new Date().toISOString(),
    offline_notified_at: null,
    pair_code_id: "code-1",
  };
});

describe("pair-code", () => {
  it("member -> 403, nothing minted", async () => {
    h.role = "member";
    const { r, res: out } = res();
    await connectorPairCode(req(), out);
    expect(r.statusCode).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("owner -> code, expiry and the docker command, for the auth tenant", async () => {
    h.rpc.mockResolvedValue({ data: [{ code_id: "code-1", issued_at: "2026-10-12T10:00:00Z", expires_at: "2026-10-12T10:30:00Z" }], error: null });
    const { r, res: out } = res();
    await connectorPairCode(req({ tenant_id: "tenant-B" }), out);
    expect(r.statusCode).toBe(200);
    const body = r.body as { code: string; expires_at: string; command: string; pairing_id: string; expires_in_seconds: number };
    expect(body.code).toMatch(/^zpair_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.expires_at).toBe("2026-10-12T10:30:00Z");
    expect(body.pairing_id).toBe("code-1");
    expect(body.expires_in_seconds).toBe(1800);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(body.command).toContain("-p 127.0.0.1:7801:7801");
    expect(h.rpc.mock.calls[0]![1]).toMatchObject({ p_tenant_id: "tenant-A" });
  });
  it("the database's own admin gate (42501) -> 403", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    const { r, res: out } = res();
    await connectorPairCode(req(), out);
    expect(r.statusCode).toBe(403);
  });
});

describe("status", () => {
  it("member: status only, no rules, no skipped job", async () => {
    h.role = "member";
    const { r, res: out } = res();
    await connectorStatus(req(), out);
    expect(r.body).toMatchObject({ paired: true, online: true, machine: "mac-1", version: "1.0.3", last_seen_age: "5s" });
    expect(r.body).not.toHaveProperty("rules");
    expect(r.body).not.toHaveProperty("skipped");
  });
  it("owner: the rules as the connector reports them", async () => {
    const { r, res: out } = res();
    await connectorStatus(req(), out);
    expect(r.body).toMatchObject({ paired: true, rules, skipped: null, pairing_id: "code-1" });
  });
  it("offline with a skipped job this outage -> the banner data", async () => {
    const seen = new Date(Date.now() - 7_200_000).toISOString();
    const skipped = new Date(Date.now() - 3_600_000).toISOString();
    h.connector = { ...h.connector!, last_seen_at: seen, last_skipped_feature: "Booking metrics", last_skipped_at: skipped };
    const { r, res: out } = res();
    await connectorStatus(req(), out);
    expect(r.body).toMatchObject({ online: false, last_seen_age: "2 hours", skipped: { feature: "Booking metrics", at: skipped, emailed: false } });
  });
  it("not paired", async () => {
    h.connector = null;
    const { r, res: out } = res();
    await connectorStatus(req(), out);
    expect(r.body).toEqual({ paired: false });
  });
  it("anonymous -> 401", async () => {
    h.auth = null;
    const { r, res: out } = res();
    await connectorStatus(req(), out);
    expect(r.statusCode).toBe(401);
  });
});

describe("remove", () => {
  it("member -> 403", async () => {
    h.role = "member";
    const { r, res: out } = res();
    await connectorRemove(req(), out);
    expect(r.statusCode).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("owner -> revoked, returns the local removal command", async () => {
    h.rpc.mockResolvedValue({ data: { removed: true, machine: "mac-1" }, error: null });
    const { r, res: out } = res();
    await connectorRemove(req(), out);
    expect(h.rpc).toHaveBeenCalledWith("remove_db_connector", { p_tenant_id: "tenant-A" });
    expect(r.body).toEqual({ ok: true, removed: true, machine: "mac-1", removal_command: "docker rm -f zavi-connector && docker volume rm zavi-connector" });
  });
});
