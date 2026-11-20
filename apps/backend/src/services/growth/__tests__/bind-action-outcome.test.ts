
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/growth/action-outcomes", () => ({
  recordActionOutcome: vi.fn(),
  enrichBaseline: vi.fn(),
  readMetaSnapshot: vi.fn(),
  readGoogleSnapshot: vi.fn(),
}));

import { bindActionOutcome } from "../bind-action-outcome";
import {
  recordActionOutcome,
  enrichBaseline,
  readMetaSnapshot,
} from "@/services/growth/action-outcomes";

const record = vi.mocked(recordActionOutcome);
const enrich = vi.mocked(enrichBaseline);
const metaRead = vi.mocked(readMetaSnapshot);

const DEC = "11111111-1111-1111-1111-111111111111";
const TEN = "22222222-2222-2222-2222-222222222222";

const bind = (
  decisionClass: string,
  body: unknown,
  decisionOutcome: "approved" | "rejected" = "approved",
) =>
  bindActionOutcome({
    decisionId: DEC,
    tenantId: TEN,
    decisionClass,
    decisionOutcome,
    body,
  });

beforeEach(() => {
  vi.clearAllMocks();
  record.mockResolvedValue(42);
  enrich.mockResolvedValue(true);
  metaRead.mockResolvedValue({
    spend: 10,
    roas: 2,
    conversions: 1,
    purchase_value: 20,
    impressions: 100,
  });
});

describe("bindActionOutcome — delivery tier: engineer.ship-pr", () => {
  const prBody = {
    repo: "acme/webapp",
    head_branch: "engineer/fix-login",
    base_branch: "main",
    title: "Fix login",
    files: [],
  };

  it("binds an approved ship-pr as subject 'pr', tier 'delivery', 7d window", async () => {
    await bind("engineer.ship-pr", prBody);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      decisionId: DEC,
      actionClass: "engineer.ship-pr",
      decisionOutcome: "approved",
      subjectType: "pr",
      subjectId: "acme/webapp#engineer/fix-login",
      targetMetric: "pr_state",
      measurementWindowDays: 7,
      outcomeTier: "delivery",
    });
    expect(enrich).toHaveBeenCalledWith({ id: 42, status: "no_data" });
    expect(metaRead).not.toHaveBeenCalled();
  });

  it("does NOT bind a rejected ship-pr (nothing was dispatched → nothing delivered)", async () => {
    await bind("engineer.ship-pr", prBody, "rejected");
    expect(record).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed body (no repo) — skip, never guess", async () => {
    await bind("engineer.ship-pr", { head_branch: "engineer/x" });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("bindActionOutcome — delivery tier: email sends", () => {
  it.each(["outbound.send", "email.send", "gmail.send"])(
    "binds an approved %s as subject 'email' keyed by decision_id (no PII copy), 1d window",
    async (cls) => {
      await bind(cls, { channel: "email", to: "x@y.com", subject: "hi", body_text: "b" });
      expect(record).toHaveBeenCalledWith({
        decisionId: DEC,
        actionClass: cls,
        decisionOutcome: "approved",
        subjectType: "email",
        subjectId: DEC,
        targetMetric: "delivered",
        measurementWindowDays: 1,
        outcomeTier: "delivery",
      });
      expect(enrich).toHaveBeenCalledWith({ id: 42, status: "no_data" });
      expect(metaRead).not.toHaveBeenCalled();
    },
  );

  it("does NOT bind a rejected email send", async () => {
    await bind("outbound.send", { to: "x@y.com" }, "rejected");
    expect(record).not.toHaveBeenCalled();
  });

  it("does NOT bind non-allowlisted send classes (bulk / fundraising)", async () => {
    await bind("bulk_outbound.send", { to: "x@y.com" });
    await bind("fundraising.outbound.send", { to: "x@y.com" });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("bindActionOutcome — CONTRACT: meta behavior unchanged", () => {
  it("meta_ads.set_status (campaign) binds exactly as before, tier 'business', 14d", async () => {
    await bind("meta_ads.set_status_review", {
      level: "campaign",
      object_id: "camp-1",
      status: "PAUSED",
      rationale: "",
      over_cap: true,
    });
    expect(record).toHaveBeenCalledWith({
      decisionId: DEC,
      actionClass: "meta_ads.set_status",
      decisionOutcome: "approved",
      subjectType: "campaign",
      subjectId: "camp-1",
      targetMetric: "spend",
      measurementWindowDays: 14,
      outcomeTier: "business",
    });
    expect(metaRead).toHaveBeenCalledWith(TEN, "camp-1", expect.any(String), expect.any(String));
    expect(enrich).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42, status: "enriched" }),
    );
  });

  it("meta_ads.update_ad_set_budget binds the adset subject as before", async () => {
    await bind("meta_ads.update_ad_set_budget", {
      ad_set_id: "as-9",
      daily_budget_usd: 50,
      expected_current_daily_budget_usd: 40,
      rationale: "",
      over_cap: false,
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "adset",
        subjectId: "as-9",
        outcomeTier: "business",
        measurementWindowDays: 14,
      }),
    );
  });

  it("rejected META decisions STILL bind (what-happened-after-no is a business question)", async () => {
    await bind(
      "meta_ads.set_status",
      { level: "campaign", object_id: "c1", status: "PAUSED", rationale: "", over_cap: true },
      "rejected",
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ decisionOutcome: "rejected", outcomeTier: "business" }),
    );
  });

  it("unknown classes stay a no-op", async () => {
    await bind("slack.post_message", { channel: "#x" });
    expect(record).not.toHaveBeenCalled();
  });

  it("stops after the pending insert when the RPC returns null", async () => {
    record.mockResolvedValue(null);
    await bind("engineer.ship-pr", { repo: "a/b", head_branch: "engineer/x" });
    expect(enrich).not.toHaveBeenCalled();
  });
});
