import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient must not be reached: the claim is injected");
  },
}));
vi.mock("../../client", () => ({
  inngest: { createFunction: () => ({ id: "dispatch-channel-action" }), send: vi.fn() },
}));
vi.mock("@/services/growth/preview-plan", () => ({
  channelPlanLock: vi.fn(async () => null),
  planIncludesChannel: vi.fn(async () => true),
}));

const boom = vi.hoisted(() => ({ error: null as unknown }));
vi.mock("@/services/email-cards/variants", async (orig) => {
  const real = await orig<typeof import("@/services/email-cards/variants")>();
  return {
    ...real,
    chosenVersion: (...a: Parameters<typeof real.chosenVersion>) => {
      if (boom.error) throw boom.error;
      return real.chosenVersion(...a);
    },
  };
});

import { runChannelActionMutation, type ExecDeps } from "../dispatch-channel-action";
import { executeEmailCampaignSendAndTell, type EmailSendDeps } from "@/services/connectors/email-campaign/execute-send";
import { fakeMailchimp, type FakeTool } from "@/services/connectors/email-campaign/__tests__/fake-tools";
import { shaOf } from "@/services/email-cards/variants";
import { cardSendState, SEND_FAILED_FALLBACK, type ViewState } from "@/services/email-cards/cards";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTION = "99999999-9999-4999-8999-999999999999";

const TYPE_ERROR = new TypeError("Cannot read properties of undefined (reading 'id')");
const PG_ERROR = Object.assign(new Error('duplicate key value violates unique constraint "channel_actions_pkey"'), {
  code: "23505",
  details: "Key (id)=(99999999) already exists.",
});

const RENDERER = "r1";
const HTML = "<html><body><p>Hello</p></body></html>";
const TEXT = "Hello";
const body = {
  tool: "mailchimp",
  connected_account_id: "ca-mailchimp",
  auth_config_id: "ac-mailchimp",
  audience_id: "L1",
  audience_name: "Newsletter",
  audience_count: 412,
  variants: [
    {
      content: { subject: "Spring offer", preview_text: "Two weeks only", title: "Spring", paragraphs: ["Hello"], button: { label: "Shop", url: "https://acme.test" } },
      html: HTML,
      text: TEXT,
      render_sha: shaOf(RENDERER, HTML, TEXT),
    },
  ],
  template_snapshot: {
    logo_url: null,
    brand_color: "#000000",
    button_color: "#000000",
    font_key: "system",
    sign_off: "Acme",
    postal_address: null,
    show_cards: false,
    company_name: "Acme",
    own_host: null,
    campaign_slug: "spring-offer-20261026",
  },
  renderer_version: RENDERER,
  chosen_variant: 1,
  approved_count: 412,
  from_name: "Acme",
  from_email: "hi@acme.test",
  reply_to: null,
};

function sendDeps(mc: FakeTool): EmailSendDeps {
  return {
    resolveAccount: (async () => ({ tenant_id: TENANT, toolkit: "mailchimp", connected_account_id: "ca-mailchimp", auth_config_id: "ac-mailchimp" })) as unknown as EmailSendDeps["resolveAccount"],
    exec: ((c: Parameters<FakeTool["exec"]>[0]) => mc.exec(c)) as unknown as EmailSendDeps["exec"],
    readProgress: async () => null,
    recordProgress: async () => true,
    scheduleReconcile: async () => undefined,
    authorizeCgo: async () => ({ verdict: "allow", reasons: [] }),
    notifyAutopilotSend: (async () => true) as unknown as EmailSendDeps["notifyAutopilotSend"],
    sleep: async () => undefined,
    recordSendRef: async () => true,
    paused: async () => false,
    testListKeys: async () => new Set<string>(),
  } as EmailSendDeps;
}

function execDeps(mc: FakeTool, tell: unknown, settled: Array<{ ok: boolean; error?: string | null; result?: unknown }>): Partial<ExecDeps> {
  return {
    claim: (async () => ({
      ok: true as const,
      row: {
        claim_id: "claim-1",
        tenant_id: TENANT,
        channel_slug: "email_campaigns",
        exec_class: "email_campaign.create_and_send",
        exec_payload: body,
        approved_by: "founder",
        approved_by_source: null,
        agent_run_id: null,
      },
    })) as unknown as ExecDeps["claim"],
    settle: (async (_t: string, a: { ok: boolean; error?: string | null; result?: unknown }) => {
      settled.push(a);
      return { ok: true, replayed: false };
    }) as unknown as ExecDeps["settle"],
    loadHandler: async () => async (d) =>
      executeEmailCampaignSendAndTell(
        { id: d.id, tenant_id: d.tenant_id, body: d.body, approved_by_source: d.approved_by_source, exec_source: d.exec_source, claim_id: d.claim_id },
        sendDeps(mc),
        tell as never,
      ),
    writeEnabled: async () => true,
    tenantDisabled: async () => false,
    releaseClaim: async () => true,
    execClassOf: async () => "email_campaign.create_and_send",
    retimeFlight: async (r) => r.exec_payload,
    tellOutcome: async () => "not_a_direct_ask" as never,
    envelopeSwitchedOff: async () => false,
    testStopPause: async () => null,
  };
}

const view: ViewState = { ok: true, class: "email_campaign.create_and_send", body, open: false, status: "failed", role: "founder", versions: 1, tests: [] };

const RAW = /TypeError|Cannot read properties|reading 'id'|duplicate key|unique constraint|channel_actions_pkey|23505/;

let warn: { mockRestore: () => void; mock: { calls: unknown[][] } };
beforeEach(() => {
  boom.error = null;
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe("a send that throws never shows the founder the raw exception", () => {
  for (const [name, thrown, rawText] of [
    ["a TypeError", TYPE_ERROR, "Cannot read properties of undefined (reading 'id')"],
    ["a Postgres error", PG_ERROR, 'duplicate key value violates unique constraint "channel_actions_pkey"'],
  ] as const) {
    it(`${name}: the stored card error is a plain sentence, the raw text only reaches the log`, async () => {
      boom.error = thrown;
      const mc = fakeMailchimp();
      const tell = vi.fn(async () => undefined);
      const settled: Array<{ ok: boolean; error?: string | null; result?: unknown }> = [];

      const mutation = await runChannelActionMutation(ACTION, execDeps(mc, tell, settled));

      expect(mutation.settle?.ok).toBe(false);
      const stored = mutation.settle?.error ?? "";
      const storedResult = mutation.settle?.result as { error?: string | null; code?: string };
      expect(stored).not.toMatch(RAW);
      expect(storedResult.error ?? "").not.toMatch(RAW);
      expect(stored).toBe(SEND_FAILED_FALLBACK);
      expect(storedResult.error).toBe(SEND_FAILED_FALLBACK);

      const channelCard = cardSendState("channel_actions", view, {
        card: { status: "pending", exec_status: "failed", approved: true, code: storedResult.code ?? null, error: storedResult.error ?? null },
        bulk: null,
        results: null,
      } as never);
      expect(channelCard.status).toBe("failed");
      expect(channelCard.failure_reason).toBe(SEND_FAILED_FALLBACK);
      expect(channelCard.failure_reason ?? "").not.toMatch(RAW);

      const decisionCard = cardSendState("decisions", view, {
        card: { status: "dispatch_failed", approved: true, error: stored },
        bulk: null,
        results: null,
      } as never);
      expect(decisionCard.failure_reason).toBe(SEND_FAILED_FALLBACK);

      expect(mc.calls).toHaveLength(0);
      expect(tell).not.toHaveBeenCalled();
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(rawText);
    });
  }

  it("without a throw the same send still goes out, exactly once", async () => {
    const mc = fakeMailchimp();
    const settled: Array<{ ok: boolean; error?: string | null; result?: unknown }> = [];
    const mutation = await runChannelActionMutation(ACTION, execDeps(mc, vi.fn(async () => undefined), settled));
    expect(mutation.settle?.ok).toBe(true);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
  });
});
