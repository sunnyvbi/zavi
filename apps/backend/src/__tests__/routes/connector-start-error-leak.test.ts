
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const TENANT_A = "11111111-aaaa-aaaa-aaaa-111111111111";
const USER_A = "22222222-bbbb-bbbb-bbbb-222222222222";

const SECRET_MESSAGE =
  "LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must be set (Linear OAuth application).";

vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRole: vi.fn(async () => "owner") }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
let sbImpl: () => unknown = () => ({});
vi.mock("@/services/supabase", () => ({ serviceClient: () => sbImpl() }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: vi.fn() }));
vi.mock("@/services/connectors/core/registry", () => ({
  isKnownConnector: (slug: string) => slug === "linear",
  getConnector: () => ({
    slug: "linear",
    authorizeUrl: () => {
      throw new Error(SECRET_MESSAGE);
    },
  }),
}));

import { requireAuth } from "@/services/auth/middleware";
import { connectorStart } from "@/routes/connectors/connector";

function mkRes(): Response & { _status: number; _body: unknown } {
  const r: Partial<Response> & { _status: number; _body: unknown } = {
    _status: 200,
    _body: undefined,
    status(code: number) {
      r._status = code;
      return r as Response;
    },
    json(body: unknown) {
      r._body = body;
      return r as Response;
    },
    redirect() {
      return r as unknown as void;
    },
  };
  return r as Response & { _status: number; _body: unknown };
}

const mkReq = () =>
  ({
    params: { connector: "linear" },
    headers: { accept: "application/json" },
  }) as unknown as Request;

beforeEach(() => {
  process.env.BACKEND_PUBLIC_URL = "https://api.example.test";
  (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    user_id: USER_A,
    tenant_id: TENANT_A,
    access_token: "fake",
  });
  sbImpl = () => ({
    rpc: vi.fn().mockResolvedValue({ error: null }),
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("connectorStart — misconfigured connector", () => {
  it("never returns the env var names to the client", async () => {
    const res = mkRes();
    await connectorStart(mkReq(), res);

    const body = JSON.stringify(res._body);
    expect(body).not.toContain("LINEAR_CLIENT_ID");
    expect(body).not.toContain("CLIENT_SECRET");
    expect(body).not.toContain(SECRET_MESSAGE);
  });

  it("returns an actionable message + 503, not a bare 500", async () => {
    const res = mkRes();
    await connectorStart(mkReq(), res);

    expect(res._status).toBe(503);
    const message = (res._body as { error: { message: string } }).error.message;
    expect(message).toMatch(/isn’t available yet/);
    expect(message).toMatch(/support@zaviagent\.com/);
  });

  it("keeps the real reason server-side, in the log line", async () => {
    const spy = console.error as unknown as ReturnType<typeof vi.fn>;
    await connectorStart(mkReq(), mkRes());

    expect(spy).toHaveBeenCalledWith(
      "connector_start_misconfigured",
      expect.objectContaining({ slug: "linear", detail: SECRET_MESSAGE }),
    );
  });
});
