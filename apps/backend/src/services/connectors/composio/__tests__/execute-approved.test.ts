import { describe, it, expect, vi, beforeEach } from "vitest";
const m = vi.hoisted(() => ({ owned: vi.fn(), exec: vi.fn(), shopifyExec: vi.fn(), log: vi.fn(async () => {}), role: vi.fn() }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: m.role }));
vi.mock("../account", () => ({ resolveOwnedComposioAccount: m.owned }));
vi.mock("../api", () => ({ composioExecuteTool: m.exec }));
vi.mock("@/services/connectors/shopify/execute-approved", () => ({ executeApprovedShopifyProductUpdate: m.shopifyExec }));
vi.mock("../catalog", () => ({
  listToolkitToolSlugs: async (k: string) => new Set(k === "square" ? ["SQUARE_CREATE_REFUND"] : k === "gmail" ? ["GMAIL_SEND_EMAIL"] : k === "shopify" ? ["SHOPIFY_GRAPH_QL_PRODUCTS", "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS"] : []),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));
import { buildResumeTurn } from "@/services/agents/approve-resume";
import { executeApprovedComposioWrite } from "../execute-approved";
import { composioWriteFingerprint } from "../fingerprint";

const base = {
  kind: "composio_write", server_id: "composio", tool_slug: "SQUARE_CREATE_REFUND", toolkit: "square",
  app_name: "Square", action: "Create refund", arguments: { charge: "ch_1", amount: 500 }, classification: { destructive: false },
  labels: ["moves_money"], governed_by: "chokepoint", connected_account_id: "ca_A", auth_config_id: "ac_A",
};
const seal = (b: any, cls = "composio.moves_money") => ({ ...b, fingerprint: composioWriteFingerprint({ ...b, decision_class: cls }) });
const body = seal(base);
const acct = { tenant_id: "TENANT_A", toolkit: "square", connected_account_id: "ca_A", auth_config_id: "ac_A" };

beforeEach(() => { m.owned.mockReset(); m.exec.mockReset(); m.shopifyExec.mockReset(); m.log.mockClear(); m.role.mockReset(); });

describe("executeApprovedComposioWrite approver role", () => {
  const run = (extra: Record<string, unknown>) => executeApprovedComposioWrite({ id: "d", tenant_id: "TENANT_A", decision_class: "composio.moves_money", body, ...extra });
  beforeEach(() => { m.owned.mockResolvedValue(acct); m.exec.mockResolvedValue({ ok: true, status: 200, data: {}, error: null }); });
  it.each(["member", "viewer", null])("refuses a money write when the approver is now %s", async (role) => {
    m.role.mockResolvedValue(role);
    const r = await run({ approved_by: "u_admin", approved_by_source: "web" });
    expect(r.ok).toBe(false);
    expect(m.role).toHaveBeenCalledWith("u_admin", "TENANT_A");
    expect(m.exec).not.toHaveBeenCalled();
  });
  it("fails closed when the approver's role cannot be read", async () => {
    m.role.mockRejectedValue(new Error("db down"));
    expect(await run({ approved_by: "u_admin" })).toEqual({ ok: false, error: "composio_approver_role_unavailable" });
    expect(m.exec).not.toHaveBeenCalled();
  });
  it.each(["owner", "admin"])("runs when the approver is still %s", async (role) => {
    m.role.mockResolvedValue(role);
    expect((await run({ approved_by: "u_admin" })).ok).toBe(true);
    expect(m.exec).toHaveBeenCalledTimes(1);
  });
  it("leaves a tenant-configured automatic run on its own path", async () => {
    expect((await run({ approved_by: null })).ok).toBe(true);
    expect(m.role).not.toHaveBeenCalled();
  });
});

describe("executeApprovedComposioWrite shopify", () => {
  const shop = { tenant_id: "TENANT_A", toolkit: "shopify", connected_account_id: "ca_S", auth_config_id: "ac_S" };
  const shopBody = (tool_slug: string, args: Record<string, unknown>, action = "x") =>
    seal({ ...base, tool_slug, toolkit: "shopify", app_name: "Shopify", action, arguments: args, connected_account_id: "ca_S", auth_config_id: "ac_S" }, "composio.shopify_write");
  beforeEach(() => {
    m.owned.mockResolvedValue(shop);
    m.exec.mockResolvedValue({ ok: true, status: 200, data: {}, error: null });
    m.shopifyExec.mockResolvedValue({ ok: true, status: 200, data: {}, error: null, outcome_unknown: false });
  });
  it("runs an approved product update with Zavi's fixed mutation and leaves discount creation on the generated action", async () => {
    const update = { operation: "update_product", variables: { input: { id: "gid://shopify/Product/9", status: "ACTIVE" } } };
    expect((await executeApprovedComposioWrite({ id: "d", tenant_id: "TENANT_A", decision_class: "composio.shopify_write", body: shopBody("SHOPIFY_GRAPH_QL_PRODUCTS", update) })).ok).toBe(true);
    expect(m.shopifyExec).toHaveBeenCalledWith({ account: shop, arguments: update });
    expect(m.exec).not.toHaveBeenCalled();
    const discount = { operation: "discountCodeBasicCreate", variables: { basicCodeDiscount: { title: "Spring", code: "SPRING10" } } };
    expect((await executeApprovedComposioWrite({ id: "d", tenant_id: "TENANT_A", decision_class: "composio.shopify_write", body: shopBody("SHOPIFY_GRAPH_QL_WRITE_OPERATIONS", discount) })).ok).toBe(true);
    expect(m.exec).toHaveBeenCalledTimes(1);
    expect(m.exec).toHaveBeenLastCalledWith(expect.objectContaining({ tool_slug: "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS", arguments: discount }));
  });
  it("refuses a Shopify card sealed under the generic money class", async () => {
    const update = { operation: "update_product", variables: { input: { id: "gid://shopify/Product/9", status: "ACTIVE" } } };
    const body = seal({ ...base, tool_slug: "SHOPIFY_GRAPH_QL_PRODUCTS", toolkit: "shopify", app_name: "Shopify", arguments: update, connected_account_id: "ca_S", auth_config_id: "ac_S" });
    expect(await executeApprovedComposioWrite({ id: "d", tenant_id: "TENANT_A", decision_class: "composio.moves_money", body })).toEqual({ ok: false, error: "composio_class_mismatch" });
    expect(m.exec).not.toHaveBeenCalled();
  });
  it("refuses a sealed card whose Shopify operation is not an allowed write", async () => {
    const r = await executeApprovedComposioWrite({ id: "d", tenant_id: "TENANT_A", decision_class: "composio.shopify_write", body: shopBody("SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "delete_product", variables: { input: { id: "gid://shopify/Product/9" } } }) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^shopify_write_not_allowed/);
    expect(m.exec).not.toHaveBeenCalled();
    expect(m.shopifyExec).not.toHaveBeenCalled();
  });
});

describe("executeApprovedComposioWrite", () => {
  it("runs EXACTLY the frozen tool + args for decision.tenant_id's verified account, logging composio_write_started first", async () => {
    m.owned.mockResolvedValue(acct);
    m.exec.mockImplementation(async () => {
      expect(m.log).toHaveBeenCalledWith(expect.objectContaining({ code: "composio_write_started", tenant_id: "TENANT_A" }));
      return { ok: true, status: 200, data: { id: "re_1" }, error: null };
    });
    const r = await executeApprovedComposioWrite({ id: "dec_1", tenant_id: "TENANT_A", decision_class: "composio.moves_money", body });
    expect(m.owned).toHaveBeenCalledWith("TENANT_A", "square");
    expect(m.exec).toHaveBeenCalledWith({ tool_slug: "SQUARE_CREATE_REFUND", user_id: "TENANT_A", connected_account_id: "ca_A", arguments: { charge: "ch_1", amount: 500 } });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(m.log.mock.calls)).not.toContain("ch_1");
    expect(r.notice).toBe("Done in Square.");
    expect(r.agent_outcome).toMatch(/^Square returned: <untrusted_tool_composio>\n/);
    expect(r.agent_outcome).toContain('{"id":"re_1"}');
    expect(r.agent_outcome).toMatch(/<\/untrusted_tool_composio>$/);
  });
  it("an escaping-heavy result still closes its untrusted block inside the resume turn", async () => {
    m.owned.mockResolvedValue(acct);
    m.exec.mockResolvedValue({ ok: true, status: 200, data: { html: "<a>x</a>".repeat(400) }, error: null });
    const r = await executeApprovedComposioWrite({ id: "d", tenant_id: "TENANT_A", decision_class: "composio.moves_money", body });
    const turn = buildResumeTurn({ toolName: "composio.execute_tool", outcome: r.agent_outcome, approved: true });
    expect(turn).toContain("</untrusted_tool_composio> Continue the task");
  });
  it("ignores any tenant/user/account smuggled into the body", async () => {
    m.owned.mockResolvedValue(acct);
    m.exec.mockResolvedValue({ ok: true, status: 200, data: {}, error: null });
    await executeApprovedComposioWrite({ id: "d", tenant_id: "TENANT_A", decision_class: "composio.moves_money", body: { ...body, tenant_id: "TENANT_B", user_id: "TENANT_B", entity_id: "TENANT_B" } });
    expect(m.owned).toHaveBeenCalledWith("TENANT_A", "square");
    expect(m.exec.mock.calls[0][0].user_id).toBe("TENANT_A");
    expect(m.exec.mock.calls[0][0].connected_account_id).toBe("ca_A");
  });
  it("refuses a tool that is not in the frozen toolkit's catalog list", async () => {
    const r = await executeApprovedComposioWrite({ id: "d", tenant_id: "T", decision_class: "composio.moves_money", body: seal({ ...base, tool_slug: "GMAIL_SEND_EMAIL" }) });
    expect(r).toEqual({ ok: false, error: "composio_tool_toolkit_mismatch" });
    expect(m.exec).not.toHaveBeenCalled();
  });
  it("refuses unless class AND label set EXACTLY equal a fresh classification from the frozen inputs", async () => {
    for (const bad of [
      { decision_class: "composio.write", body: seal(base, "composio.write") },
      { decision_class: "composio.moves_money", body: seal({ ...base, labels: [] }) },
      { decision_class: "composio.deletes_data", body: seal({ ...base, labels: ["moves_money"] }, "composio.deletes_data") },
      { decision_class: "composio.moves_money", body: seal({ ...base, labels: ["moves_money", "deletes_data"] }) },
      { decision_class: "composio.moves_money", body: seal({ ...base, labels: ["moves_money", "moves_money"] }) },
    ]) {
      expect(await executeApprovedComposioWrite({ id: "d", tenant_id: "T", ...bad })).toEqual({ ok: false, error: "composio_class_mismatch" });
    }
    expect(m.exec).not.toHaveBeenCalled();
  });
  it("a destructive-by-hint tool re-proves its delete label from the frozen classification input", async () => {
    m.owned.mockResolvedValue({ ...acct, toolkit: "gmail" }); m.exec.mockResolvedValue({ ok: true, status: 200, data: {}, error: null });
    const g = { ...base, tool_slug: "GMAIL_SEND_EMAIL", toolkit: "gmail", app_name: "Gmail", classification: { destructive: true }, labels: ["deletes_data"] };
    expect((await executeApprovedComposioWrite({ id: "d", tenant_id: "T", decision_class: "composio.deletes_data", body: seal(g, "composio.deletes_data") })).ok).toBe(true);
    const tampered = seal({ ...g, classification: { destructive: false }, labels: [] }, "composio.write");
    expect((await executeApprovedComposioWrite({ id: "d", tenant_id: "T", decision_class: "composio.deletes_data", body: tampered })).ok).toBe(false);
  });
  it("refuses when the body no longer matches its fingerprint (edited after emit)", async () => {
    const r = await executeApprovedComposioWrite({ id: "d", tenant_id: "T", decision_class: "composio.moves_money", body: { ...body, arguments: { charge: "ch_1", amount: 50000 } } });
    expect(r).toEqual({ ok: false, error: "composio_fingerprint_mismatch" });
    expect(m.exec).not.toHaveBeenCalled();
  });
  it("app disconnected or not owned since approval → fails, no call", async () => {
    m.owned.mockResolvedValue(null);
    const r = await executeApprovedComposioWrite({ id: "d", tenant_id: "T", decision_class: "composio.moves_money", body });
    expect(r).toEqual({ ok: false, error: "Reconnect Square, then approve again." });
    expect(m.exec).not.toHaveBeenCalled();
  });
  it("ownership check error → fails closed, no call", async () => {
    m.owned.mockRejectedValue(new Error("connector_metadata read failed: boom"));
    const r = await executeApprovedComposioWrite({ id: "d", tenant_id: "T", decision_class: "composio.moves_money", body });
    expect(r).toEqual({ ok: false, error: "composio_account_check_failed" });
    expect(m.exec).not.toHaveBeenCalled();
  });
  it("malformed body → fails closed", async () => {
    expect((await executeApprovedComposioWrite({ id: "d", tenant_id: "T", decision_class: "composio.write", body: { tool_slug: "X" } })).ok).toBe(false);
    expect((await executeApprovedComposioWrite({ id: "d", tenant_id: "T", decision_class: "composio.write", body: null })).ok).toBe(false);
    expect(m.exec).not.toHaveBeenCalled();
  });
  it("vendor refusal → ok:false with the vendor message", async () => {
    m.owned.mockResolvedValue(acct);
    m.exec.mockResolvedValue({ ok: false, status: 400, data: null, error: { message: "No such charge" } });
    expect(await executeApprovedComposioWrite({ id: "d", tenant_id: "T", decision_class: "composio.moves_money", body })).toEqual({ ok: false, error: "Square refused: No such charge" });
  });
  it("an UNKNOWN outcome (transport drop / unreadable reply) is not a failure: it is reported as outcome_unknown", async () => {
    m.owned.mockResolvedValue(acct);
    m.exec.mockResolvedValue({ ok: false, status: 0, data: null, error: "composio_transport_error", outcome_unknown: true });
    expect(await executeApprovedComposioWrite({ id: "d", tenant_id: "T", decision_class: "composio.moves_money", body }))
      .toEqual({ ok: false, outcome_unknown: true, error: "composio_outcome_unknown" });
  });
  it("the connected account changed since the card was approved → refused, no call", async () => {
    for (const now of [{ ...acct, connected_account_id: "ca_NEW" }, { ...acct, auth_config_id: "ac_NEW" }]) {
      m.owned.mockResolvedValue(now);
      expect(await executeApprovedComposioWrite({ id: "d", tenant_id: "TENANT_A", decision_class: "composio.moves_money", body }))
        .toEqual({ ok: false, error: "The connected Square account changed. Ask again so you can approve it for the new account." });
    }
    expect(m.exec).not.toHaveBeenCalled();
  });
  it("a body with no frozen account (emitted before accounts were frozen) → fails closed", async () => {
    const { connected_account_id: _c, auth_config_id: _a, ...old } = base;
    const r = await executeApprovedComposioWrite({ id: "d", tenant_id: "T", decision_class: "composio.moves_money", body: seal(old) });
    expect(r.ok).toBe(false);
    expect(m.exec).not.toHaveBeenCalled();
  });
});

describe("a raw email send approved before the chokepoint refused it", () => {
  for (const [slug, toolkit] of [["MAILCHIMP_SEND_CAMPAIGN", "mailchimp"], ["KLAVIYO_SUBSCRIBE_PROFILES", "klaviyo"], ["SEND_CAMPAIGN", "mailchimp"]] as const) {
    it(`${slug} (${toolkit}) is refused at execution, before any provider call`, async () => {
      const b = seal({ ...base, tool_slug: slug, toolkit, app_name: "Mailchimp", labels: [] }, "composio.write");
      const r = await executeApprovedComposioWrite({ id: "d1", tenant_id: "TENANT_A", decision_class: "composio.write", body: b });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/^use_email_campaign_tool: /);
      expect(m.owned).not.toHaveBeenCalled();
      expect(m.exec).not.toHaveBeenCalled();
    });
  }
});

describe("a raw Pinterest write approved before the chokepoint refused it", () => {
  for (const slug of ["PINTEREST_CREATE_PIN", "PINTEREST_DELETE_BOARD"]) {
    it(`${slug} is refused at execution, before any provider call`, async () => {
      const b = seal({ ...base, tool_slug: slug, toolkit: "pinterest", app_name: "Pinterest", labels: [] }, "composio.write");
      const r = await executeApprovedComposioWrite({ id: "d1", tenant_id: "TENANT_A", decision_class: "composio.write", body: b });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/^use_social_propose_post: /);
      expect(m.owned).not.toHaveBeenCalled();
      expect(m.exec).not.toHaveBeenCalled();
    });
  }
});

describe("a raw TikTok spend write approved before the chokepoint refused it", () => {
  for (const [slug, toolkit] of [["TIKTOK_ADS_UPDATE_CAMPAIGN_BUDGET", "tiktok_ads"], ["TIKTOK_ADS_UPDATE_CAMPAIGN_STATUS", "tiktok_ads"], ["TIKTOK_ADS_CREATE_SMART_PLUS_CAMPAIGN", "tiktok_ads"]] as const) {
    it(`${slug} is refused at execution, before any provider call`, async () => {
      const b = seal({ ...base, tool_slug: slug, toolkit, app_name: "TikTok Ads", labels: [] }, "composio.write");
      const r = await executeApprovedComposioWrite({ id: "d1", tenant_id: "TENANT_A", decision_class: "composio.write", body: b });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/^use_tiktok_ads_propose_tool: /);
      expect(m.owned).not.toHaveBeenCalled();
      expect(m.exec).not.toHaveBeenCalled();
    });
  }
});
