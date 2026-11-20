
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MorningBriefResponse } from "../../../src/services/workspace/morning-brief-assembler";

const mocks = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  getUserById: vi.fn(),
  recordDigestSendAudit: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClient,
}));
vi.mock("../../../src/services/workspace/digest-send-audit", () => ({
  recordDigestSendAudit: mocks.recordDigestSendAudit,
}));
vi.mock("../../../src/services/logging/logEvent", () => ({
  logEvent: mocks.logEvent,
}));
vi.mock("@sendgrid/mail", () => ({
  default: { setApiKey: vi.fn(), send: vi.fn(async () => undefined) },
}));

import { briefHasSignal, briefIsSetupOnly } from "../digest-signal";
import { sendMorningDigestEmail } from "../../../src/email/sendAuthEmail";

function emptyBrief(): MorningBriefResponse {
  return {
    yesterday: { builds_started: 0, builds_done: 0, builds_failed: 0, spend_usd: 0, pr_count: null },
    today: { proposed_plans: 0, pending_suggestions: 0, pending_approvals: 0 },
    goals: [],
    recent_activity: [],
  };
}

describe("briefHasSignal (slice 6 — real terminal signal only)", () => {
  it("is FALSE for a totally empty brief", () => {
    expect(briefHasSignal(emptyBrief())).toBe(false);
  });

  it("is FALSE when builds only STARTED (no done/failed)", () => {
    const b = emptyBrief();
    b.yesterday.builds_started = 3;
    expect(briefHasSignal(b)).toBe(false);
  });

  it("is FALSE for proposed plans alone", () => {
    const b = emptyBrief();
    b.today.proposed_plans = 2;
    expect(briefHasSignal(b)).toBe(false);
  });

  it("is FALSE for a value-less goal row", () => {
    const b = emptyBrief();
    b.goals = [
      { objective: "Grow", target_metric: "mrr", current_value: null, target_value: null, status: "active" },
    ];
    expect(briefHasSignal(b)).toBe(false);
  });

  it("is TRUE when a goal has a real (non-null) value", () => {
    const b = emptyBrief();
    b.goals = [
      { objective: "Grow", target_metric: "mrr", current_value: 50, target_value: null, status: "active" },
    ];
    expect(briefHasSignal(b)).toBe(true);
  });

  it("is TRUE on a terminal build outcome (done or failed)", () => {
    const b = emptyBrief();
    b.yesterday.builds_done = 1;
    expect(briefHasSignal(b)).toBe(true);
  });

  it("is TRUE on pending approvals, spend, suggestions, or recent activity", () => {
    const approvals = emptyBrief();
    approvals.today.pending_approvals = 1;
    expect(briefHasSignal(approvals)).toBe(true);

    const spend = emptyBrief();
    spend.yesterday.spend_usd = 0.5;
    expect(briefHasSignal(spend)).toBe(true);
  });
});

describe("briefIsSetupOnly (slice 6 — unconfigured tenant nudge)", () => {
  it("is TRUE for an unconfigured tenant: value-less goal + dup proposed plans, no terminal work", () => {
    const b = emptyBrief();
    b.goals = [
      { objective: "Set me up", target_metric: "x", current_value: null, target_value: null, status: "active" },
    ];
    b.today.proposed_plans = 2;
    expect(briefHasSignal(b)).toBe(false);
    expect(briefIsSetupOnly(b)).toBe(true);
  });

  it("is TRUE when only builds started (setup-in-progress)", () => {
    const b = emptyBrief();
    b.yesterday.builds_started = 1;
    expect(briefIsSetupOnly(b)).toBe(true);
  });

  it("is FALSE for a totally empty brief (stay silent, no nudge spam)", () => {
    expect(briefIsSetupOnly(emptyBrief())).toBe(false);
  });

  it("is FALSE when the brief has real signal (gets the real brief, not a nudge)", () => {
    const b = emptyBrief();
    b.yesterday.builds_done = 1;
    expect(briefIsSetupOnly(b)).toBe(false);
  });
});

describe("sendMorningDigestEmail fail-closed guard (slice 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SYSTEM_SENDGRID_API_KEY = "SG.test";
    process.env.ZAVI_EMAIL_FROM = "hello@zaviagent.com";
    mocks.serviceClient.mockReturnValue({
      auth: { admin: { getUserById: mocks.getUserById } },
    });
    mocks.getUserById.mockResolvedValue({
      data: { user: { email: "owner@example.com" } },
      error: null,
    });
    mocks.recordDigestSendAudit.mockResolvedValue(undefined);
    mocks.logEvent.mockResolvedValue(undefined);
  });

  function cleanBrief(): MorningBriefResponse {
    return {
      yesterday: { builds_started: 0, builds_done: 1, builds_failed: 0, spend_usd: 1, pr_count: null },
      today: { proposed_plans: 0, pending_suggestions: 0, pending_approvals: 0 },
      goals: [
        { objective: "Hit 200 signups", target_metric: "signups", current_value: 120, target_value: 200, status: "active" },
      ],
      recent_activity: [
        { kind: "build_done", label: "Build done: landing page", at: "2026-06-07T00:00:00Z", link: null },
      ],
    };
  }

  it("BLOCKS the send (no sgSend, no throw) when rendered content carries a banned pattern", async () => {
    const dirty = cleanBrief();
    dirty.recent_activity = [
      { kind: "build_done", label: "Build done: QA test fixture", at: "2026-06-07T00:00:00Z", link: null },
    ];

    const result = await sendMorningDigestEmail({
      owner_user_id: "owner-1",
      tenant_id: "tenant-1",
      brief: dirty,
      workspaceUrl: "https://www.zaviagent.com/workspace",
      approvalsUrl: "https://www.zaviagent.com/workspace",
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("blocked_content");
    expect(result.violations).toContain("qa_test_string");
    expect(mocks.recordDigestSendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "blocked_content" }),
    );
    expect(mocks.logEvent).toHaveBeenCalled();
  });

  it("SENDS a clean brief and records a sent audit row", async () => {
    const result = await sendMorningDigestEmail({
      owner_user_id: "owner-1",
      tenant_id: "tenant-1",
      brief: cleanBrief(),
      workspaceUrl: "https://www.zaviagent.com/workspace",
      approvalsUrl: "https://www.zaviagent.com/workspace",
    });
    expect(result.sent).toBe(true);
    expect(mocks.recordDigestSendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "sent", violations: [] }),
    );
  });

  it("finding 1: a SENT row carries the PRE-SEND scrub violation codes when input was scrubbed", async () => {
    const brief = {
      ...cleanBrief(),
      _sanitize_violations: ["qa_test_string", "residual_praxis"],
    };
    const result = await sendMorningDigestEmail({
      owner_user_id: "owner-1",
      tenant_id: "tenant-1",
      brief,
      workspaceUrl: "https://www.zaviagent.com/workspace",
      approvalsUrl: "https://www.zaviagent.com/workspace",
    });
    expect(result.sent).toBe(true);
    expect(mocks.recordDigestSendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        verdict: "sent",
        violations: ["qa_test_string", "residual_praxis"],
      }),
    );
  });
});
