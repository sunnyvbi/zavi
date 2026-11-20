
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  msg: null as Record<string, unknown> | null,
  root: null as Record<string, unknown> | null,
  first: null as Record<string, unknown> | null,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: async (_t: string, name: string) => {
    if (name === "is_tenant_member_email") return { data: true, error: null };
    if (name === "disabled_member_emails") return { data: [], error: null };
    return { data: null, error: null };
  },
  tenantClient: () => ({
    from: (table: string) => ({
      select: () => {
        const f: Record<string, unknown> = {};
        const q = {
          eq: (c: string, v: unknown) => ((f[c] = v), q),
          order: () => q,
          limit: () => q,
          maybeSingle: async () => {
            if (table === "email_threads") {
              return { data: { owner_agent_slug: "cgo", root_message_id: "root-1@inbox.zaviagent.com" } };
            }
            if (f.direction === "out") return { data: db.root };
            if (f.direction === "in") return { data: db.first, error: null };
            return { data: db.msg };
          },
        };
        return q;
      },
    }),
  }),
}));

const capReader = vi.hoisted(() =>
  vi.fn(async () => ({ cap: null as unknown, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 })),
);
const cutGuardSpy = vi.hoisted(() =>
  vi.fn<[unknown, { operatorDirected: boolean }], { block: boolean; reason: string; guidance: string }>(
    () => ({ block: false, reason: "", guidance: "" }),
  ),
);

vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));
vi.mock("../_user-initiated-flag-check", () => ({ isUserInitiatedSpendApplyEnabled: async () => true }));
vi.mock("../cap-reader", () => { const m = ({ readTenantCapAndToday: capReader }); return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday }; });
vi.mock("../_grounding-guard", async (orig) => ({
  ...(await orig<typeof import("../_grounding-guard")>()),
  readRunToolNamesFromEvents: vi.fn(async () => null),
}));
vi.mock("../_cut-guard", () => ({
  isCgoOriginatedRun: vi.fn(async () => false),
  evaluateCutGuard: (brief: unknown, opts: { operatorDirected: boolean }) => cutGuardSpy(brief, opts),
  briefForAdSet: vi.fn(async () => null),
  briefForCampaign: vi.fn(async () => null),
}));

import { isVerifiedMemberReplyRun } from "@/services/agents/email-reply-trust";
import { metaProposeBudgetChangeTool } from "../propose_budget_change";
import { metaProposeStatusChangeTool } from "../propose_status_change";
import type { ToolContext } from "@/services/tools/types";

const FOUNDER = "founder@acme.com";

async function ctxForStoredReply(): Promise<ToolContext> {
  const verified = await isVerifiedMemberReplyRun({
    tenant_id: "t1",
    agent_slug: "cgo",
    trigger: "email",
    payload: { email: { email_message_id: "m1" } },
  });
  return {
    tenant_id: "t1",
    log: () => {},
    emit_decision: vi.fn(async () => "decision-1"),
    run_trigger: "email",
    verified_member_email_reply: verified,
  };
}

const raise = {
  ad_set_id: "as1",
  current_daily_budget_usd: 40,
  proposed_daily_budget_usd: 50,
  rationale: "founder asked",
  match_confidence: "exact" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  capReader.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
  db.msg = {
    thread_id: "th1",
    direction: "in",
    sender_verified_member: true,
    from_address: FOUNDER,
    rfc_message_id: "reply-1@mail.gmail.com",
    attachments: [],
    body_text: "Raise it to $50 a day.\n\nOn Fri, Sep 26, 2026 Zavi <acme@inbox.zaviagent.com> wrote:\n> brief",
  };
  db.root = { id: "out1", to_addresses: [FOUNDER] };
  db.first = { id: "m1" };
});

describe("a founder's email reply and Meta budget changes", () => {
  it("the founder's own plain reply applies directly (the kept design)", async () => {
    const out = (await metaProposeBudgetChangeTool.execute(await ctxForStoredReply(), raise)) as {
      origin: string;
      decision_class: string;
    };
    expect(out.origin).toBe("user_chat");
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget");
  });

  it("the same reply with an attachment routes to review", async () => {
    db.msg = { ...db.msg!, attachments: [{ storage_path: "t1/x.pdf", filename: "plan.pdf" }] };
    const out = (await metaProposeBudgetChangeTool.execute(await ctxForStoredReply(), raise)) as {
      origin: string;
      decision_class: string;
    };
    expect(out.origin).toBe("agent");
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
  });

  it("another verified member replying on the founder's thread routes to review", async () => {
    db.msg = { ...db.msg!, from_address: "cofounder@acme.com" };
    const out = (await metaProposeBudgetChangeTool.execute(await ctxForStoredReply(), raise)) as {
      decision_class: string;
    };
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
  });

  it("a replayed copy of the founder's reply routes to review", async () => {
    db.first = { id: "m0-original" };
    const out = (await metaProposeBudgetChangeTool.execute(await ctxForStoredReply(), raise)) as {
      decision_class: string;
    };
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
  });
});

describe("a founder's email reply and Meta pause", () => {
  const pause = { object_id: "as1", level: "adset" as const, status: "PAUSED" as const, rationale: "founder asked" };

  it("the founder's plain reply is operator-directed and can pause directly under an enabled cap", async () => {
    capReader.mockResolvedValue({ cap: { enabled: true, daily_change_limit_usd: 500 }, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    const out = (await metaProposeStatusChangeTool.execute(await ctxForStoredReply(), pause)) as {
      decision_class: string;
    };
    expect(cutGuardSpy.mock.calls[0]![1]).toMatchObject({ operatorDirected: true });
    expect(out.decision_class).toBe("meta_ads.set_status");
  });

  it("an attachment-bearing reply is not operator-directed and its pause routes to review", async () => {
    capReader.mockResolvedValue({ cap: { enabled: true, daily_change_limit_usd: 500 }, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    db.msg = { ...db.msg!, attachments: [{ storage_path: "t1/x.pdf" }] };
    const out = (await metaProposeStatusChangeTool.execute(await ctxForStoredReply(), pause)) as {
      decision_class: string;
    };
    expect(cutGuardSpy.mock.calls[0]![1]).toMatchObject({ operatorDirected: false });
    expect(out.decision_class).toBe("meta_ads.set_status_review");
  });
});
