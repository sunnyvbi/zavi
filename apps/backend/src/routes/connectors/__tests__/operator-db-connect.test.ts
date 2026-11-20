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
  } as never & { jsonPayload: unknown; statusCode: number };
  return { req, res };
}

const goodBody = { type: "postgres", connection_string: "postgresql://user:pass@host/db" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "t1", access_token: "tok" });
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.probeWriteCapable.mockResolvedValue(false);
  mocks.send.mockResolvedValue(undefined);
  mocks.markCatalogRediscovering.mockResolvedValue(undefined);
});

describe("operatorDbConnect — background discovery", () => {
  it("probe OK → returns discovery:pending + enqueues the discover job AND booking-mapping detect", async () => {
    mocks.probeConnectivity.mockResolvedValueOnce({ ok: true });
    const { req, res } = makeReqRes(goodBody);
    await operatorDbConnect(req, res as never);

    const payload = (res as { jsonPayload: unknown }).jsonPayload as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.discovery).toBe("pending");
    expect(payload.write_capable).toBe(false);
    expect(payload).not.toHaveProperty("tables_found");
    expect(mocks.send).toHaveBeenCalledTimes(2);
    const events = mocks.send.mock.calls.map(
      (c) => c[0] as { name: string; data: { tenant_id: string } },
    );
    expect(events[0].name).toBe("operator-db.discover.requested");
    expect(events[0].data.tenant_id).toBe("t1");
    expect(events[1].name).toBe("booking-mapping.detect.requested");
    expect(events[1].data.tenant_id).toBe("t1");
  });

  it("probe FAILS (bad creds) → ok:false with sanitized error, does NOT enqueue", async () => {
    mocks.probeConnectivity.mockResolvedValueOnce({ ok: false, error: "auth failed" });
    const { req, res } = makeReqRes(goodBody);
    await operatorDbConnect(req, res as never);

    const payload = (res as { jsonPayload: unknown }).jsonPayload as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.discovery_error).toBe("auth failed");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.probeWriteCapable).not.toHaveBeenCalled();
  });

  it("enqueue failure is swallowed AND invalidates the catalog (self-heal re-arms)", async () => {
    mocks.probeConnectivity.mockResolvedValueOnce({ ok: true });
    mocks.send.mockRejectedValueOnce(new Error("inngest down"));
    const { req, res } = makeReqRes(goodBody);
    await operatorDbConnect(req, res as never);

    const payload = (res as { jsonPayload: unknown }).jsonPayload as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.discovery).toBe("pending");
    expect(mocks.markCatalogRediscovering).toHaveBeenCalledWith("t1", "postgres");
  });

  it("enqueue SUCCESS does NOT invalidate the catalog (common case stays fast)", async () => {
    mocks.probeConnectivity.mockResolvedValueOnce({ ok: true });
    const { req, res } = makeReqRes(goodBody);
    await operatorDbConnect(req, res as never);
    expect(mocks.markCatalogRediscovering).not.toHaveBeenCalled();
  });

  it("store RPC error → 500, after the gate and probe have passed", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { code: "42501", message: "denied" } });
    mocks.probeConnectivity.mockResolvedValueOnce({ ok: true });
    const { req, res } = makeReqRes(goodBody);
    await operatorDbConnect(req, res as never);

    expect((res as { statusCode: number }).statusCode).toBe(500);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("admin gate failure → 403, never probes or stores", async () => {
    mocks.rpc.mockResolvedValueOnce({ error: { code: "42501", message: "not a member" } });
    const { req, res } = makeReqRes(goodBody);
    await operatorDbConnect(req, res as never);

    expect((res as { statusCode: number }).statusCode).toBe(403);
    expect(mocks.probeConnectivity).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("dynamodb connect reaches the store RPC with p_type dynamodb (enum value added 20261102090000)", async () => {
    mocks.probeConnectivity.mockResolvedValueOnce({ ok: true });
    const { req, res } = makeReqRes({ type: "dynamodb", connection_string: "dynamodb://AKIAX:secret@us-west-1" });
    await operatorDbConnect(req, res as never);

    const payload = (res as { jsonPayload: unknown }).jsonPayload as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    const store = mocks.rpc.mock.calls.find((c) => c[0] === "set_operator_db_connection");
    expect(store?.[1]).toMatchObject({ p_tenant_id: "t1", p_type: "dynamodb" });
  });

  it("dynamodb with a non-AWS endpoint → 400 before the admin gate or probe (SSRF)", async () => {
    const { req, res } = makeReqRes({
      type: "dynamodb",
      connection_string: "dynamodb://AKIAX:secret@us-west-1?endpoint=" + encodeURIComponent("http://169.254.169.254"),
    });
    await operatorDbConnect(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(((res as { jsonPayload: unknown }).jsonPayload as { error: { code: string } }).error.code).toBe(
      "operator_db_endpoint_not_allowed",
    );
    expect(mocks.probeConnectivity).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("the connect-time probe runs as a gateway Connection test for the session tenant", async () => {
    mocks.probeConnectivity.mockResolvedValueOnce({ ok: true });
    const { req, res } = makeReqRes(goodBody);
    await operatorDbConnect(req, res as never);
    expect(mocks.probeCtx).toEqual({ tenant_id: "t1", caller: { kind: "background", feature: "Connection test" } });
  });

  it.each([
    ["postgres", "postgresql://u:p@h/db", "false", "verified"],
    ["postgres", "postgresql://u:p@h/db", "true", "can_write"],
    ["mysql", "mysql://u:p@h/db", "unknown", "unknown"],
    ["mongodb", "mongodb://u:p@h/db", "false", "unknown"],
  ])("%s login with write_capable=%s -> read_only_check %s", async (type, conn, write, expected) => {
    mocks.probeConnectivity.mockResolvedValueOnce({ ok: true });
    mocks.probeWriteCapable.mockResolvedValueOnce(write);
    const { req, res } = makeReqRes({ type, connection_string: conn });
    await operatorDbConnect(req, res as never);
    const payload = (res as { jsonPayload: unknown }).jsonPayload as Record<string, unknown>;
    expect(payload.read_only_check).toBe(expected);
  });
});

describe("operatorDbConnect: a new login requires an encrypted connection", () => {
  it("MySQL without an ssl option is probed and stored with TLS, and its transport recorded", async () => {
    mocks.probeConnectivity.mockResolvedValueOnce({ ok: true });
    const { req, res } = makeReqRes({ type: "mysql", connection_string: "mysql://u:p@db.example.com/shop" });
    await operatorDbConnect(req, res as never);
    const tls = "mysql://u:p@db.example.com/shop?ssl=%7B%22rejectUnauthorized%22%3Afalse%7D";
    expect(mocks.probeConnectivity).toHaveBeenCalledWith("mysql", tls);
    const store = mocks.rpc.mock.calls.find((c) => c[0] === "set_operator_db_connection");
    expect((store![1] as { p_connection_string: string }).p_connection_string).toBe(tls);
    expect(mocks.recordDbTransport).toHaveBeenCalledWith("t1", "mysql", tls);
  });

  it("an explicit opt-out is kept as typed", async () => {
    mocks.probeConnectivity.mockResolvedValueOnce({ ok: true });
    const { req, res } = makeReqRes({ type: "mysql", connection_string: "mysql://u:p@10.0.0.4/shop?ssl=false" });
    await operatorDbConnect(req, res as never);
    expect(mocks.probeConnectivity).toHaveBeenCalledWith("mysql", "mysql://u:p@10.0.0.4/shop?ssl=false");
  });
});
