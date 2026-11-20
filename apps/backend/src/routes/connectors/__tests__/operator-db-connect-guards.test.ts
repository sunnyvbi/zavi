import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  probeCtx: null as unknown,
  requireAuth: vi.fn(),
  probeConnectivity: vi.fn(),
  recordDbTransport: vi.fn(),
  markCatalogRediscovering: vi.fn(),
  probeWriteCapable: vi.fn(),
  send: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/tools/operator-db/discovery", () => ({
  markCatalogRediscovering: mocks.markCatalogRediscovering,
}));
vi.mock("@/services/data-gateway", async () => ({
  readOnlyCheckOf: (await vi.importActual<typeof import("@/services/data-gateway/read-only")>("@/services/data-gateway/read-only"))
    .readOnlyCheckOf,
  requireTlsByDefault: (await vi.importActual<typeof import("@/services/data-gateway/direct/tls")>("@/services/data-gateway/direct/tls"))
    .requireTlsByDefault,
  recordDbTransport: (...a: unknown[]) => mocks.recordDbTransport(...a),
  probeCandidate: async (ctx: { tenant_id: string; caller: unknown }, type: string, conn: string) => {
    mocks.probeCtx = ctx;
    const p = await mocks.probeConnectivity(type, conn);
    if (!p.ok) return { ok: false, error: p.error };
    return { ok: true, write_capable: await mocks.probeWriteCapable(type, conn) };
  },
}));
vi.mock("@/services/tools/operator-db/discovery/errors", () => ({
  sanitizeDiscoveryError: (e: string) => e,
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn().mockReturnValue({ rpc: mocks.rpc }),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: (...a: unknown[]) => mocks.send(...a) } }));

import { operatorDbConnect } from "../operator-db";

function makeReqRes(body: unknown) {
  const req = { headers: { authorization: "Bearer tok" }, body } as never;
  let jsonPayload: unknown;
  let statusCode = 200;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json(payload: unknown) { jsonPayload = payload; },
    get jsonPayload() { return jsonPayload; },
    get statusCode() { return statusCode; },
  };
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "t1", access_token: "tok" });
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.probeConnectivity.mockResolvedValue({ ok: true });
  mocks.probeWriteCapable.mockResolvedValue(false);
  mocks.markCatalogRediscovering.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
});

describe("scheme must match the declared engine", () => {
  it("REJECTS the exact shape that broke a real tenant: postgres + mysql:// URI", async () => {
    const { req, res } = makeReqRes({
      type: "postgres",
      connection_string: "mysql://user:@mysql-public.example.org:4497/Db",
    });
    await operatorDbConnect(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(((res as { jsonPayload: unknown }).jsonPayload as { error: { code: string } }).error.code).toBe(
      "operator_db_scheme_type_mismatch",
    );
    expect(mocks.probeConnectivity).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("names both the given scheme and the expected one (actionable message)", async () => {
    const { req, res } = makeReqRes({
      type: "mongodb",
      connection_string: "postgres://u:p@h:5432/db",
    });
    await operatorDbConnect(req, res as never);
    const msg = ((res as { jsonPayload: unknown }).jsonPayload as { error: { message: string } }).error.message;
    expect(msg).toContain("mongodb");
    expect(msg).toContain("postgres:");
    expect(msg).toContain("mongodb:");
  });

  it("rejects a connection string with no scheme at all", async () => {
    const { req, res } = makeReqRes({ type: "postgres", connection_string: "host:5432/db" });
    await operatorDbConnect(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(400);
  });

  it("ACCEPTS every legitimate scheme for each engine", async () => {
    const ok: [string, string][] = [
      ["postgres", "postgres://u:p@h:5432/db"],
      ["postgres", "postgresql://u:p@h:5432/db"],
      ["mysql", "mysql://u:p@h:3306/db"],
      ["mongodb", "mongodb://u:p@h:27017/db"],
      ["mongodb", "mongodb+srv://u:p@cluster.example.net/db"],
      ["dynamodb", "dynamodb://AKIA:secret@us-west-1"],
    ];
    for (const [type, connection_string] of ok) {
      vi.clearAllMocks();
      mocks.requireAuth.mockResolvedValue({ tenant_id: "t1", access_token: "tok" });
      mocks.rpc.mockResolvedValue({ error: null });
      mocks.probeConnectivity.mockResolvedValue({ ok: true });
      mocks.probeWriteCapable.mockResolvedValue(false);
      const { req, res } = makeReqRes({ type, connection_string });
      await operatorDbConnect(req, res as never);
      expect((res as { statusCode: number }).statusCode, `${type} / ${connection_string}`).not.toBe(400);
    }
  });
});

describe("a connection that cannot be reached is never stored", () => {
  it("probe failure => NO store, NO discovery enqueue", async () => {
    mocks.probeConnectivity.mockResolvedValue({ ok: false, error: "connect ECONNREFUSED" });
    const { req, res } = makeReqRes({
      type: "postgres",
      connection_string: "postgres://u:p@unreachable:5432/db",
    });
    await operatorDbConnect(req, res as never);
    expect(((res as { jsonPayload: unknown }).jsonPayload as { ok: boolean }).ok).toBe(false);
    const called = mocks.rpc.mock.calls.map((c) => c[0]);
    expect(called).not.toContain("set_operator_db_connection");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.markCatalogRediscovering).not.toHaveBeenCalled();
  });

  it("probe success => the connection IS stored", async () => {
    const { req, res } = makeReqRes({
      type: "postgres",
      connection_string: "postgres://u:p@h:5432/db",
    });
    await operatorDbConnect(req, res as never);
    expect(mocks.rpc.mock.calls.map((c) => c[0])).toContain("set_operator_db_connection");
  });

  it("probes only AFTER the admin gate passes (no arbitrary-host dial for non-admins)", async () => {
    mocks.rpc.mockResolvedValueOnce({ error: { code: "42501", message: "not a member" } });
    const { req, res } = makeReqRes({
      type: "postgres",
      connection_string: "postgres://u:p@attacker-controlled:5432/db",
    });
    await operatorDbConnect(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(403);
    expect(mocks.probeConnectivity).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.map((c) => c[0])).not.toContain("set_operator_db_connection");
  });
});
