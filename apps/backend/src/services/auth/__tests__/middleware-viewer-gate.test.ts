
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  membershipMaybeSingle: vi.fn(),
  roleMaybeSingle: vi.fn(),
  getSessionTenant: vi.fn(),
  setSessionTenant: vi.fn(),
}));

vi.mock("@/services/tenants/disabled", () => ({
  readTenantDisabled: async () => false,
  TENANT_DISABLED_CODE: "tenant_disabled",
  TENANT_DISABLED_MESSAGE: "This workspace is disabled. Contact support@zaviagent.com.",
}));

vi.mock("../jwt", () => ({ verifyBearer: mocks.verifyBearer }));

vi.mock("@/services/tenants/session-tenant", () => ({
  getSessionTenant: mocks.getSessionTenant,
  setSessionTenant: mocks.setSessionTenant,
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: () => ({
      select: (cols: string) => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: cols === "role" ? mocks.roleMaybeSingle : mocks.membershipMaybeSingle,
          }),
        }),
      }),
    }),
  }),
}));

import { requireAuth } from "../middleware";
import { isConnectorAdminWrite, viewerMayCall } from "../viewer";
import { _clearTenantCacheForTests } from "../tenant-cache";

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function req(method: string, url: string) {
  return { method, originalUrl: url, headers: {} } as never;
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  _clearTenantCacheForTests();
  mocks.verifyBearer.mockResolvedValue({
    user_id: "u1",
    access_token: "tok",
    session_id: "s1",
    claim_tenant_id: null,
  });
  mocks.getSessionTenant.mockResolvedValue(TENANT);
  mocks.setSessionTenant.mockResolvedValue(undefined);
  mocks.membershipMaybeSingle.mockResolvedValue({ data: { tenant_id: TENANT }, error: null });
});

describe("requireAuth — viewer write gate", () => {
  it("a viewer's GET passes without a role query", async () => {
    mocks.roleMaybeSingle.mockResolvedValue({ data: { role: "viewer" }, error: null });
    const res = mockRes();
    const auth = await requireAuth(req("GET", "/api/agents"), res as never);
    expect(auth?.tenant_id).toBe(TENANT);
    expect(mocks.roleMaybeSingle).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/api/agents/operator/chat"],
    ["POST", "/api/approvals/abc/decide"],
    ["DELETE", "/api/v1/members/invites/xyz"],
    ["PATCH", "/api/tenant/me/settings?x=1"],
  ])("a viewer's %s %s is refused 403 viewer_read_only", async (method, url) => {
    mocks.roleMaybeSingle.mockResolvedValue({ data: { role: "viewer" }, error: null });
    const res = mockRes();
    const r = req(method, url);
    const auth = await requireAuth(r, res as never);
    expect(auth).toBeNull();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("viewer_read_only");
    expect((r as { auth?: unknown }).auth).toBeUndefined();
  });

  it.each([
    "/api/connectors/slack/start",
    "/api/connectors/github/install-url",
    "/api/connectors/composio/gmail/return",
    "/api/connectors/slack/start/",
    "/api/connectors/Slack/START",
    "/api/connectors/slack/%73tart",
    "/api/connectors/slack/start?x=1",
  ])("a viewer's GET %s (starts/finishes a connection) is refused", async (url) => {
    mocks.roleMaybeSingle.mockResolvedValue({ data: { role: "viewer" }, error: null });
    const res = mockRes();
    const auth = await requireAuth(req("GET", url), res as never);
    expect(auth).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  it.each([
    ["GET", "/api/connectors/slack/start"],
    ["GET", "/api/connectors/github/install-url"],
    ["POST", "/api/connectors/meta-ads/disconnect"],
    ["POST", "/api/connectors/composio/gmail/connect"],
    ["POST", "/api/connectors/operator-db"],
    ["DELETE", "/api/connectors/github/default-repo"],
    ["POST", "/api/connectors/Stripe/"],
  ])("a member's %s %s (changes the workspace's connections) is refused", async (method, url) => {
    mocks.roleMaybeSingle.mockResolvedValue({ data: { role: "member" }, error: null });
    const res = mockRes();
    const auth = await requireAuth(req(method, url), res as never);
    expect(auth).toBeNull();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("connector_admin_only");
  });

  it.each([
    ["POST", "/api/connectors/social"],
    ["POST", "/api/connectors/social/disconnect"],
    ["POST", "/api/connectors/composio/notion/request"],
  ])("a member's personal / request-only connector write %s %s passes", async (method, url) => {
    mocks.roleMaybeSingle.mockResolvedValue({ data: { role: "member" }, error: null });
    const res = mockRes();
    expect(await requireAuth(req(method, url), res as never)).not.toBeNull();
  });

  it.each(["owner", "admin"])("a %s may connect and disconnect accounts", async (role) => {
    mocks.roleMaybeSingle.mockResolvedValue({ data: { role }, error: null });
    for (const [method, url] of [["GET", "/api/connectors/slack/start"], ["POST", "/api/connectors/meta-ads/disconnect"]]) {
      const res = mockRes();
      expect(await requireAuth(req(method, url), res as never), `${role} ${url}`).not.toBeNull();
    }
  });

  it("a member's plain connector READ is untouched (no role query)", async () => {
    const res = mockRes();
    expect(await requireAuth(req("GET", "/api/connectors"), res as never)).not.toBeNull();
    expect(mocks.roleMaybeSingle).not.toHaveBeenCalled();
  });

  it("a viewer's read-style POST on the allowlist passes", async () => {
    mocks.roleMaybeSingle.mockResolvedValue({ data: { role: "viewer" }, error: null });
    const res = mockRes();
    const auth = await requireAuth(req("POST", "/api/memory/search"), res as never);
    expect(auth).not.toBeNull();
  });

  it.each(["owner", "admin", "member"])("a %s's write passes", async (role) => {
    mocks.roleMaybeSingle.mockResolvedValue({ data: { role }, error: null });
    const res = mockRes();
    const auth = await requireAuth(req("POST", "/api/agents/operator/chat"), res as never);
    expect(auth?.user_id).toBe("u1");
  });

  it("a role-read error refuses the write (fail-closed)", async () => {
    mocks.roleMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = mockRes();
    const auth = await requireAuth(req("POST", "/api/agents/operator/chat"), res as never);
    expect(auth).toBeNull();
    expect(res.statusCode).toBe(500);
  });

  it("a thrown role read refuses the write instead of hanging", async () => {
    mocks.roleMaybeSingle.mockRejectedValue(new Error("network"));
    const res = mockRes();
    const auth = await requireAuth(req("POST", "/api/agents/operator/chat"), res as never);
    expect(auth).toBeNull();
    expect(res.statusCode).toBe(500);
  });
});

describe("viewerMayCall", () => {
  it("treats the extension step claim GET as a write, so a viewer cannot pull a browser step", () => {
    expect(viewerMayCall("GET", "/api/extension/ops/next")).toBe(false);
    expect(viewerMayCall("GET", "/api/extension/ops/next/")).toBe(false);
    expect(viewerMayCall("GET", "/API/Extension/Ops/Next")).toBe(false);
  });

  it("lets a viewer act on their OWN team note (ownership is checked by the RPC)", () => {
    const id = "44444444-4444-4444-4444-444444444444";
    for (const action of ["shown", "send", "dismiss", "opened"]) {
      expect(viewerMayCall("POST", `/api/team-notes/${id}/${action}`)).toBe(true);
    }
    expect(viewerMayCall("PUT", "/api/team-notes/prefs")).toBe(true);
    expect(viewerMayCall("POST", `/api/team-notes/${id}/delete`)).toBe(false);
    expect(viewerMayCall("POST", "/api/team-notes/not-a-uuid/send")).toBe(false);
    expect(viewerMayCall("DELETE", "/api/team-notes/prefs")).toBe(false);
  });

  it("lets a viewer report opening the workspace (the idle check), and nothing beside it", () => {
    expect(viewerMayCall("POST", "/api/workspace/opened")).toBe(true);
    expect(viewerMayCall("POST", "/api/workspace/opened/")).toBe(true);
    expect(viewerMayCall("POST", "/api/workspace/opened/extra")).toBe(false);
    expect(viewerMayCall("POST", "/api/workspace/open")).toBe(false);
    });

  it("lets a viewer record a Growth card Copy press, and nothing else on that card", () => {
    const id = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";
    expect(viewerMayCall("POST", `/api/workspace/growth/cards/${id}/copied`)).toBe(true);
    expect(viewerMayCall("POST", `/api/workspace/growth/cards/${id.toUpperCase()}/copied`)).toBe(true);
    expect(viewerMayCall("POST", `/api/workspace/growth/cards/${id}/acted`)).toBe(false);
    expect(viewerMayCall("POST", "/api/workspace/growth/cards/not-a-uuid/copied")).toBe(false);
    expect(viewerMayCall("DELETE", `/api/workspace/growth/cards/${id}/copied`)).toBe(false);
  });

  it("lets a viewer record their own onboarding email visit, and only that", () => {
    expect(viewerMayCall("POST", "/api/onboarding-emails/visit")).toBe(true);
    expect(viewerMayCall("POST", "/api/onboarding-emails/unsubscribe")).toBe(false);
    expect(viewerMayCall("DELETE", "/api/onboarding-emails/visit")).toBe(false);
  });

  it("lets a viewer send product feedback and clear their own badge, and nothing nearby", () => {
    expect(viewerMayCall("POST", "/api/feedback/product")).toBe(true);
    expect(viewerMayCall("POST", "/api/feedback/product/seen")).toBe(true);
    expect(viewerMayCall("POST", "/api/feedback")).toBe(false);
    expect(viewerMayCall("DELETE", "/api/feedback/product")).toBe(false);
    expect(viewerMayCall("PATCH", "/api/feedback/product/seen")).toBe(false);
  });

  it("allows safe methods and only the listed read-style POSTs", () => {
    expect(viewerMayCall("GET", "/anything")).toBe(true);
    expect(viewerMayCall("GET", "/api/connectors")).toBe(true);
    expect(viewerMayCall("GET", "/api/connectors/slack/scope-status")).toBe(true);
    expect(viewerMayCall("GET", "/api/connectors/meta-ads/start")).toBe(false);
    expect(viewerMayCall("HEAD", "/anything")).toBe(true);
    expect(viewerMayCall("POST", "/api/workspace/thread-seen")).toBe(true);
    expect(viewerMayCall("POST", "/api/memory/search/extra")).toBe(false);
    expect(viewerMayCall("PUT", "/api/memory/search")).toBe(false);
    expect(viewerMayCall("POST", "/api/memory/notes")).toBe(false);
    expect(viewerMayCall("POST", "/api/memory/search/")).toBe(true);
    expect(viewerMayCall("GET", "/api/connectors/meta-ads/start//")).toBe(false);
  });
});

describe("isConnectorAdminWrite", () => {
  it("covers connector writes and connect-starting GETs, not reads or other routes", () => {
    expect(isConnectorAdminWrite("POST", "/api/connectors/figma")).toBe(true);
    expect(isConnectorAdminWrite("GET", "/api/connectors/meta-ads/start")).toBe(true);
    expect(isConnectorAdminWrite("GET", "/api/connectors/slack/scope-status")).toBe(false);
    expect(isConnectorAdminWrite("GET", "/api/connectors")).toBe(false);
    expect(isConnectorAdminWrite("POST", "/api/agents/operator/chat")).toBe(false);
    expect(isConnectorAdminWrite("POST", "/api/connectors/social")).toBe(false);
  });
});
