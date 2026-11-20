
import { describe, it, expect, vi, beforeEach } from "vitest";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: vi.fn(async () => {}) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => {}) } }));

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock("@/services/staff/capture-admin-correction", () => ({
  captureAdminCorrection: captureMock,
}));

const { serviceClientMock, S, C, reset } = vi.hoisted(() => {
  const state: {
    row: Record<string, unknown> | null;
    updateRows: Array<{ id: string }>;
  } = {
    row: { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: "support-lead.reply" },
    updateRows: [{ id: "d-1" }],
  };
  const client = {
    updateCalls: 0,
    lastUpdate: null as Record<string, unknown> | null,
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () => Promise.resolve({ data: state.row, error: null });
      b.update = (payload: Record<string, unknown>) => {
        client.updateCalls += 1;
        client.lastUpdate = payload;
        const u: Record<string, unknown> = {};
        u.eq = () => u;
        u.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r);
        u.select = () => Promise.resolve({ data: state.updateRows, error: null });
        return u;
      };
      return b;
    },
  };
  return {
    serviceClientMock: vi.fn(() => client),
    S: state,
    C: client,
    reset: () => {
      state.row = { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: "support-lead.reply" };
      state.updateRows = [{ id: "d-1" }];
      client.updateCalls = 0;
      client.lastUpdate = null;
    },
  };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import { staffTrainerDecisionApprove } from "../trainer-queue";
import { chatgptApproverRefusal } from "@/services/connectors/chatgpt-ads/approver-role";
import { metaApproverRefusal } from "@/services/tools/meta-ads/write/_approver-role";

function makeReqRes(body: unknown) {
  const req = { params: { id: "d-1" }, body } as unknown as Parameters<typeof staffTrainerDecisionApprove>[0];
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(p: unknown) {
      this.payload = p;
      return this;
    },
  };
  return { req, res: res as unknown as Parameters<typeof staffTrainerDecisionApprove>[1] & typeof res };
}

beforeEach(() => reset());

describe("staffTrainerDecisionApprove — Composio refusal", () => {
  it("403s a composio.* decision before touching the row", async () => {
    S.row = { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: "composio.gmail.send_email" };
    const { req, res } = makeReqRes({});
    await staffTrainerDecisionApprove(req, res);
    expect(res.statusCode).toBe(403);
    expect((res.payload as { error: { code: string } }).error.code).toBe("not_authorized");
    expect(C.updateCalls).toBe(0);
  });

  it("403s a TikTok Ads chat edit (a pause too) before touching the row", async () => {
    for (const cls of ["tiktok_ads.set_status", "tiktok_ads.update_budget"]) {
      S.row = { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: cls };
      const { req, res } = makeReqRes({});
      await staffTrainerDecisionApprove(req, res);
      expect(res.statusCode).toBe(403);
      expect(C.updateCalls).toBe(0);
    }
  });
});

describe("staffTrainerDecisionApprove: stamped as a staff approval", () => {
  it("stamps approved_by_source 'staff', so the ad executors' owner/admin re-check leaves it alone", async () => {
    S.row = { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: "chatgpt_ads.update_campaign_budget" };
    const { req, res } = makeReqRes({});
    await staffTrainerDecisionApprove(req, res);
    expect(res.statusCode).toBe(200);
    expect(C.lastUpdate).toMatchObject({ status: "approved", approved_by: "u-staff", approved_by_source: "staff" });
    const noRole = vi.fn(async () => null);
    const body = { daily_budget_usd: 90, expected_current_daily_budget_usd: 60 };
    const stamped = { tenant_id: "t-1", body, ...(C.lastUpdate as { approved_by: string; approved_by_source: string }) };
    expect(await chatgptApproverRefusal({ ...stamped, decision_class: "chatgpt_ads.update_campaign_budget" }, noRole)).toBeNull();
    expect(await metaApproverRefusal({ ...stamped, decision_class: "meta_ads.update_campaign_budget" }, noRole)).toBeNull();
    expect(noRole).not.toHaveBeenCalled();
  });
});
