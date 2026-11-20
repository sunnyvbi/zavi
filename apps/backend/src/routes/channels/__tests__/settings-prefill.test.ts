import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ username: vi.fn(), rpc: vi.fn(), budget: vi.fn(), soleTool: vi.fn() }));
vi.mock("@/services/connectors/email-campaign/account", () => ({ soleEmailTool: m.soleTool }));
vi.mock("@/services/connectors/pinterest-composio/readiness", () => ({ connectedPinterestUsername: m.username }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(async () => ({ tenant_id: TENANT, user_id: "u1" })) }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  tenantRpc: m.rpc,
  tenantClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: m.budget }) }) }) }),
}));

import { channelSettingsGet, settingsPrefill } from "../settings";

const TENANT = vi.hoisted(() => "7c70da58-091e-4ff5-8f77-343034d448d9");

beforeEach(() => {
  m.username.mockReset();
  m.rpc.mockReset();
  m.budget.mockReset().mockResolvedValue({ data: null, error: null });
});

async function get(slug: string) {
  const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  await channelSettingsGet({ params: { slug } } as never, res as never);
  return res;
}

describe("GET /api/channels/:slug/settings", () => {
  it("returns the saved fields and the connected username as an offer for the tenant's own account", async () => {
    m.rpc.mockResolvedValue({ data: { fields: {} }, error: null });
    m.username.mockResolvedValue("dudhat0633");
    const res = await get("pinterest_organic");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ fields: {}, prefill: { handle: [{ item: "dudhat0633" }] } });
    expect(m.rpc).toHaveBeenCalledWith(TENANT, "get_channel_settings", { p_channel_slug: "pinterest_organic" });
    expect(m.username).toHaveBeenCalledWith(TENANT);
  });

  it("still answers with the saved fields when the account lookup comes back empty", async () => {
    m.rpc.mockResolvedValue({ data: { fields: { audience: [{ item: "home cooks" }] } }, error: null });
    m.username.mockResolvedValue(null);
    const res = await get("pinterest_organic");
    expect(res.body).toEqual({ fields: { audience: [{ item: "home cooks" }] }, prefill: {} });
  });
});

describe("which email tool the Copy card is on", () => {
  beforeEach(() => {
    m.soleTool.mockReset();
    m.rpc.mockResolvedValue({ data: { fields: {} }, error: null });
  });

  it.each(["mailchimp", "klaviyo", "sendgrid"])("says %s when it is the one connected", async (tool) => {
    m.soleTool.mockResolvedValue(tool);
    const res = await get("email_marketing");
    expect(res.body).toMatchObject({ email_tool: tool });
    expect(m.soleTool).toHaveBeenCalledWith(TENANT);
  });

  it("adds no field when no single tool is connected", async () => {
    m.soleTool.mockResolvedValue(null);
    const res = await get("email_marketing");
    expect(res.body).not.toHaveProperty("email_tool");
  });

  it("a failed lookup still answers with the saved fields", async () => {
    m.soleTool.mockRejectedValue(new Error("composio down"));
    const res = await get("email_marketing");
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty("email_tool");
  });

  it("no other channel looks up an email tool", async () => {
    m.username.mockResolvedValue(null);
    await get("pinterest_organic");
    expect(m.soleTool).not.toHaveBeenCalled();
  });
});

describe("the monthly budget shows where it lives", () => {
  it("fills the read-only budget box from the channel's budget", async () => {
    m.rpc.mockResolvedValue({ data: { fields: {} }, error: null });
    m.budget.mockResolvedValue({ data: { monthly_budget_usd: "1500.00" }, error: null });
    const res = await get("google_ads");
    expect((res.body as { fields: Record<string, unknown> }).fields.budget).toEqual([{ item: "1500" }]);
  });

  it("leaves it unset when the channel has no budget", async () => {
    m.rpc.mockResolvedValue({ data: { fields: {} }, error: null });
    const res = await get("google_ads");
    expect((res.body as { fields: Record<string, unknown> }).fields.budget).toBeUndefined();
  });
});

describe("settingsPrefill", () => {
  it("offers the connected Pinterest username for an empty handle", async () => {
    m.username.mockResolvedValue("dudhat0633");
    expect(await settingsPrefill(TENANT, "pinterest_organic", {})).toEqual({ handle: [{ item: "dudhat0633" }] });
    expect(m.username).toHaveBeenCalledWith(TENANT);
  });

  it("treats an empty saved list as unset", async () => {
    m.username.mockResolvedValue("dudhat0633");
    expect(await settingsPrefill(TENANT, "pinterest_organic", { handle: [] })).toEqual({ handle: [{ item: "dudhat0633" }] });
  });

  it("makes no Pinterest call when the handle is already saved", async () => {
    m.username.mockResolvedValue("dudhat0633");
    expect(await settingsPrefill(TENANT, "pinterest_organic", { handle: [{ item: "cakelyofficial" }] })).toEqual({});
    expect(m.username).not.toHaveBeenCalled();
  });

  it("makes no Pinterest call for any other channel", async () => {
    expect(await settingsPrefill(TENANT, "reddit_organic", {})).toEqual({});
    expect(await settingsPrefill(TENANT, "instagram_organic", {})).toEqual({});
    expect(m.username).not.toHaveBeenCalled();
  });

  it("offers nothing when no account is connected", async () => {
    m.username.mockResolvedValue(null);
    expect(await settingsPrefill(TENANT, "pinterest_organic", {})).toEqual({});
  });
});
