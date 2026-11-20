import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  stopValue: false as unknown,
  row: null as null | Record<string, unknown>,
  decisionsUpdates: [] as Array<Record<string, unknown>>,
  releases: [] as Array<[string, string]>,
  told: [] as unknown[],
  fanoutEvents: [] as unknown[],
  deps: null as unknown,
}));

vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn() }));
vi.mock("@/services/agents/visibility", () => ({ getVisibleAgentSlugs: vi.fn() }));
vi.mock("../../client", () => ({
  inngest: {
    createFunction: () => ({}),
    send: async (e: unknown) => {
      h.fanoutEvents.push(e);
      return {};
    },
  },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "decisions") {
        return {
          update: (payload: Record<string, unknown>) => {
            h.decisionsUpdates.push(payload);
            if (h.row && typeof payload.status === "string") h.row.status = payload.status;
            return { eq: () => Promise.resolve({ data: null, error: null }) };
          },
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    },
  }),
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: vi.fn(),
  tenantRpc: vi.fn(),
  globalClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === "app_setting" ? { data: { value: h.stopValue }, error: null } : { data: { blob: {} }, error: null },
        }),
      }),
    }),
  }),
}));

vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({ isMetaAdsWriteEnabled: async () => true }));
vi.mock("@/services/tools/google-ads/write/_flag-check", () => ({ isGoogleAdsWriteEnabled: async () => true }));
vi.mock("@/services/fundraising/send-provider", () => ({ sendFundraisingEmail: vi.fn() }));
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: async () => false, isChannelLockedStrict: async () => false }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({
  claimDecision: async (id: string) => {
    if (!h.row || h.row.id !== id || !["approved", "proposed"].includes(String(h.row.status))) return null;
    h.row.status = "dispatching";
    return { ...h.row };
  },
  releaseClaim: async (id: string, why: string) => {
    h.releases.push([id, why]);
    if (h.row && h.row.id === id && h.row.status === "dispatching") {
      h.row.status = "proposed";
      h.row.dispatch_error = why;
    }
  },
  markDispatched: async (id: string) => {
    if (h.row && h.row.id === id && h.row.status === "dispatching") h.row.status = "acted";
  },
}));
vi.mock("@/services/tenants/disabled", () => ({ readTenantDisabled: async () => false }));
vi.mock("@/services/email-cards/pause", () => ({ emailSendPaused: async () => false }));
vi.mock("@/services/email-cards/outcome-tell", () => ({
  tellEmailSendOutcomeOrQueue: async (o: unknown) => {
    h.told.push(o);
  },
}));
vi.mock("@/services/email-cards/variants", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readTestListKeys: async () => new Set<string>(),
}));
vi.mock("@/services/comms/bulk-outbound/fanout", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  defaultFanoutDeps: async () => h.deps,
}));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}), LOG_META_KEYS: [] }));
vi.mock("@/services/tools/meta-ads/write/_decision-bodies", () => ({
  updateAdSetBudgetBodySchema: {},
  setStatusBodySchema: { safeParse: (b: unknown) => ({ success: true as const, data: b }) },
  createAdSetBodySchema: {},
}));
vi.mock("@/services/tools/meta-ads/write/update_ad_set_budget", () => ({ metaUpdateAdSetBudget: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/create_ad_set", () => ({ metaCreateAdSet: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: vi.fn(), getAdAccountCurrency: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_helpers", () => ({ toBudgetMinorUnits: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_drift-guard", () => ({ assertNoBudgetDrift: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_cap-evaluator", async (importOriginal) => ({ ...(await importOriginal<object>()), evaluateBudgetCap: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: vi.fn() }));
vi.mock("@/services/tools/email/_client", () => ({ emailSend: vi.fn() }));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(() => null),
  postDispatchNotice: vi.fn(),
  HANDLER_LABELS: {},
}));

import { __testOnly_executeDispatch as executeDispatch } from "../dispatch-decision";
import { harness, DECISION, LIST, TENANT, VERSION, sentTo } from "@/services/comms/bulk-outbound/__tests__/harness";
import { readGlobalBulkStop } from "@/services/comms/bulk-outbound/config";
import { BULK_REFUSAL_SENTENCES } from "@/services/comms/bulk-outbound/readiness";
import { sealVariants } from "@/services/email-cards/variants";

const FROM = "news@yopmail.com";
const REPLY = "founder@yopmail.com";
const PEOPLE = ["ana@yopmail.com", "ben@yopmail.com", "cy@yopmail.com"];
const TEMPLATE = { logo_url: null, brand_color: "#1f6feb", button_color: "#1f6feb", font_key: "system", sign_off: "The Brightloop team", postal_address: "1 Example Way, Springfield", show_cards: false };
const CONTENT = { subject: "Shared workspaces are here", preview_text: "", title: "Work together", paragraphs: ["Invite your team."], button: { label: "Try it", url: "https://brightloop.test/workspaces" } };

function setup() {
  const b = harness({ emails: PEOPLE });
  b.state.from = FROM;
  b.state.replyTo = REPLY;
  const fakeReady = b.deps.checkReady;
  b.deps.checkReady = async (tenantId, listId, versionId) => {
    if ((await readGlobalBulkStop()) !== "running") return { ok: false, code: "bulk_sending_paused", sentence: BULK_REFUSAL_SENTENCES.bulk_sending_paused };
    return fakeReady(tenantId, listId, versionId);
  };
  h.deps = b.deps;
  const sealed = sealVariants(TEMPLATE as never, [CONTENT as never], { route: "zavi_list", companyName: "Brightloop", ownHost: "brightloop.test" });
  h.row = {
    id: DECISION,
    tenant_id: TENANT,
    agent_run_id: null,
    decision_class: "bulk_outbound.send",
    handler: "bulk_outbound.send",
    status: "approved",
    approved_by: "owner-1",
    approved_by_source: null,
    body: { list_id: LIST, list_version_id: VERSION, list_name: "Newsletter", from_address: FROM, reply_to: REPLY, ...sealed, chosen_variant: 1 },
  };
  return b;
}

const sweep = () => {
  if (h.row && h.row.status === "proposed" && h.row.approved_by) h.row.status = "approved";
};

beforeEach(() => {
  process.env.BULK_SENDGRID_API_KEY = "bulk-key";
  h.stopValue = false;
  h.row = null;
  h.decisionsUpdates.length = 0;
  h.releases.length = 0;
  h.told.length = 0;
  h.fanoutEvents.length = 0;
});

describe("Zavi's own sender is stopped for everyone when an approved Zavi-list email is dispatched", () => {
  it("holds the approved send (never dispatch_failed, nobody emailed, no send row), then sends it exactly once after the stop lifts", async () => {
    const b = setup();

    for (let i = 0; i < 3; i += 1) {
      expect(await executeDispatch(DECISION)).toEqual({ ok: false, error: "bulk_sending_paused" });
      expect(h.row).toMatchObject({ status: "proposed", approved_by: "owner-1", dispatch_error: "bulk_sending_paused" });
      sweep();
    }
    expect(h.decisionsUpdates.some((u) => u.status === "dispatch_failed")).toBe(false);
    expect(b.wire).not.toHaveBeenCalled();
    expect(b.ledger.sends.size).toBe(0);
    expect(h.fanoutEvents).toHaveLength(0);
    expect(h.told).toHaveLength(0);

    h.stopValue = true;
    const [first, second] = await Promise.all([executeDispatch(DECISION), executeDispatch(DECISION)]);
    expect([first, second].filter((r) => r.ok === true)).toHaveLength(2);
    sweep();
    await executeDispatch(DECISION);

    expect(b.ledger.sends.size).toBe(1);
    expect(sentTo(b.wire).sort()).toEqual([...PEOPLE].sort());
    expect(b.wire).toHaveBeenCalledTimes(PEOPLE.length);
    expect(h.decisionsUpdates.some((u) => u.status === "dispatch_failed")).toBe(false);
    expect(h.row?.status).not.toBe("dispatch_failed");
  });

  it("a freeze that fails before a send row exists releases the card for the sweep, and the retry sends once", async () => {
    const b = setup();
    vi.spyOn(b.ledger, "freeze").mockRejectedValueOnce(new Error("email_bulk_freeze_send failed"));
    h.stopValue = true;
    expect(await executeDispatch(DECISION)).toEqual({ ok: false, error: "bulk_send_not_started" });
    expect(h.row).toMatchObject({ status: "proposed", approved_by: "owner-1", dispatch_error: "bulk_send_not_started" });
    expect(h.decisionsUpdates.some((u) => u.status === "dispatch_failed")).toBe(false);
    sweep();
    await executeDispatch(DECISION);
    expect(sentTo(b.wire).sort()).toEqual([...PEOPLE].sort());
  });

  it("an unreadable stop value is held the same way, never failed", async () => {
    const b = setup();
    h.stopValue = { weird: true };
    expect(await executeDispatch(DECISION)).toEqual({ ok: false, error: "bulk_sending_paused" });
    expect(h.row).toMatchObject({ status: "proposed", dispatch_error: "bulk_sending_paused" });
    expect(b.wire).not.toHaveBeenCalled();
    expect(b.ledger.sends.size).toBe(0);
  });
});
