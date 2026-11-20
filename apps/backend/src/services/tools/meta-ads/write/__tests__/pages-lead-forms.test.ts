
import { describe, it, expect, vi, beforeEach } from "vitest";

const g = vi.hoisted(() => ({ fbGet: vi.fn(), fbPost: vi.fn(), creds: vi.fn(), debug: vi.fn() }));
vi.mock("../../_client", () => ({
  fbGet: (...a: unknown[]) => g.fbGet(...a),
  fbPost: (...a: unknown[]) => g.fbPost(...a),
  metaAdsCreds: (...a: unknown[]) => g.creds(...a),
}));
vi.mock("@/services/connectors/meta-ads/oauth", () => ({ debugToken: (...a: unknown[]) => g.debug(...a) }));
vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));

import { metaListLeadFormsTool, metaListPagesTool, pageAccessToken } from "../../pages";
import { _resetScopeCache } from "../../_scopes";
import { metaCreateLeadForm } from "../lead_form_writes";
import { createLeadFormBodySchema } from "../_decision-bodies";
import { metaProposeLeadFormTool } from "../propose_lead_form";
import { evaluateUnattended } from "@/services/growth/unattended-policy";
import type { ToolContext } from "@/services/tools/types";

const PAGES = { data: [{ id: "100100100", name: "Rides", category: "Car rental", tasks: ["ADVERTISE", "MANAGE"], access_token: "PAGE-SECRET" }] };
const ALL = ["ads_management", "pages_show_list", "pages_manage_ads", "leads_retrieval"];
const ctx = () => {
  const emit = vi.fn(async () => "d-1");
  return { c: { tenant_id: "t1", log: () => {}, emit_decision: emit, run_trigger: "scheduled" } as ToolContext, emit };
};
const form = {
  page_id: "100100100",
  name: "Quote request",
  questions: [{ type: "FULL_NAME" }, { type: "EMAIL" }, { type: "CUSTOM", key: "car_type", label: "Which car?" }],
  privacy_policy_url: "https://rides.example/privacy",
  follow_up_action_url: "https://rides.example",
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetScopeCache();
  g.creds.mockResolvedValue({ ad_account_id: "act_555", access_token: "USER-TOKEN" });
  g.debug.mockResolvedValue({ is_valid: true, scopes: ALL });
});

describe("pages", () => {
  it("lists Pages without their tokens", async () => {
    g.fbGet.mockResolvedValueOnce(PAGES);
    const r = await metaListPagesTool.execute(ctx().c, {});
    expect(JSON.stringify(r)).not.toContain("PAGE-SECRET");
    expect(r).toEqual({ pages: [{ id: "100100100", name: "Rides", category: "Car rental", tasks: ["ADVERTISE", "MANAGE"] }] });
  });

  it("a Page the user does not manage, or cannot advertise for, has no token", async () => {
    g.fbGet.mockResolvedValueOnce(PAGES);
    await expect(pageAccessToken("t1", "2002")).rejects.toMatchObject({ code: "meta_ads_page_not_managed" });
    g.fbGet.mockResolvedValueOnce({ data: [{ ...PAGES.data[0], tasks: ["ANALYZE"] }] });
    await expect(pageAccessToken("t1", "100100100")).rejects.toMatchObject({ code: "meta_ads_page_role_missing" });
  });

  it("a connection without the permission gets a reason, before any Page read", async () => {
    g.debug.mockResolvedValueOnce({ is_valid: true, scopes: ["ads_management"] });
    await expect(metaListLeadFormsTool.execute(ctx().c, { page_id: "100100100" })).rejects.toMatchObject({ code: "meta_ads_scope_missing" });
    expect(g.fbGet).not.toHaveBeenCalled();
  });

  it("lead forms are read with the Page token and never ask for leads", async () => {
    g.fbGet.mockResolvedValueOnce(PAGES).mockResolvedValueOnce({ data: [{ id: "f1", name: "Quote", leads_count: 12 }] });
    await metaListLeadFormsTool.execute(ctx().c, { page_id: "100100100" });
    const [, path, params, opts] = g.fbGet.mock.calls[1] as [string, string, { fields: string }, { page_access_token: string }];
    expect(path).toBe("100100100/leadgen_forms");
    expect(opts.page_access_token).toBe("PAGE-SECRET");
    expect(params.fields).not.toMatch(/\bleads\{|field_data/);
  });
});

describe("lead forms", () => {
  it("a form is created on the Page with the Page token and the tagged name", async () => {
    g.fbGet.mockResolvedValueOnce(PAGES).mockResolvedValueOnce({ data: [] });
    g.fbPost.mockResolvedValueOnce({ id: "form9" });
    const r = await metaCreateLeadForm("t1", { ...createLeadFormBodySchema.parse(form), tag: "zvabc1234567" });
    expect(r).toEqual({ id: "form9", name: "Quote request · zvabc1234567", reused: false });
    const [, path, params, opts] = g.fbPost.mock.calls[0] as [string, string, Record<string, string>, { page_access_token: string }];
    expect(path).toBe("100100100/leadgen_forms");
    expect(opts.page_access_token).toBe("PAGE-SECRET");
    expect(JSON.parse(params.privacy_policy)).toEqual({ url: "https://rides.example/privacy" });
  });

  it("a retry finds its form by the tag", async () => {
    g.fbGet.mockResolvedValueOnce(PAGES).mockResolvedValueOnce({ data: [{ id: "form9", name: "Quote request · zvabc1234567" }] });
    expect((await metaCreateLeadForm("t1", { ...createLeadFormBodySchema.parse(form), tag: "zvabc1234567" })).reused).toBe(true);
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("a form needs an https privacy policy; a custom question needs a key and label", () => {
    expect(createLeadFormBodySchema.safeParse({ ...form, privacy_policy_url: "http://rides.example/privacy" }).success).toBe(false);
    expect(createLeadFormBodySchema.safeParse({ ...form, questions: [{ type: "CUSTOM" }] }).success).toBe(false);
  });

  it("the tool files the class, and a lead form is never cgo's to approve", async () => {
    const a = ctx();
    await metaProposeLeadFormTool.execute(a.c, { ...form, rationale: "lead ads for quotes" });
    expect(a.emit).toHaveBeenCalledWith("meta_ads.create_lead_form", expect.objectContaining({ page_id: "100100100" }));
    const v = evaluateUnattended(
      { kind: "ad", exec_class: "meta_ads.create_lead_form", payload: form, source: { table: "channel_actions", id: "x", run_id: null } },
      { refsResolved: true, openAdvice: "clear" } as never,
    );
    expect(v.verdict).toBe("deny");
  });
});
