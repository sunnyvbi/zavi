import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  verify: vi.fn(),
  exec: vi.fn(),
  owned: vi.fn(),
  safeFetch: vi.fn(),
  enqueue: vi.fn(),
  rpc: vi.fn(),
  info: vi.fn(),
  site: vi.fn(),
  target: vi.fn(),
  row: null as Record<string, unknown> | null,
  handler: null as null | ((ctx: unknown) => Promise<unknown>),
}));

vi.mock("@/services/channels/post-live", () => ({ closePostCardsForPublished: vi.fn(async () => 0) }));
vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_c: unknown, _t: unknown, h: (ctx: unknown) => Promise<unknown>) => {
      m.handler = h;
      return {};
    },
  },
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.row, error: null }) }) }) }),
    rpc: m.rpc,
    storage: { from: () => ({ createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://signed.example/${p}` }, error: null }) }) },
  }),
}));
vi.mock("@/services/connectors/social-publish-gate", () => ({ socialPublishGate: async () => ({ open: true, via: "config" }) }));
vi.mock("@/services/connectors/social-channels", () => ({
  IMAGE_PATH_RE: /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/,
  VIDEO_PATH_RE: /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4$/,
  resolveChannelAction: () => ({ media_prop: "file", destination_required: false }),
}));
vi.mock("@/services/connectors/social-publish-account", () => ({ verifySocialAccountAtPublish: m.verify }));
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: m.exec }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: m.owned }));
vi.mock("@/services/onboarding/enrichment/discover", () => ({ safeFetchText: m.safeFetch }));
vi.mock("@/services/start-card/seed/notice-store", () => ({ guardedFetch: vi.fn() }));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  tenantStorage: () => ({ from: () => ({ info: m.info }) }),
}));
vi.mock("@/services/tools/growth/seo/run", () => ({ resolveTenantSite: m.site }));
vi.mock("@/services/connectors/pipedream/api", () => ({
  runAction: vi.fn(() => { throw new Error("pipedream must never be called"); }),
}));
vi.mock("@/services/slack/outbox", () => ({ enqueueSlackOutbox: m.enqueue }));
vi.mock("@/services/slack/approval-post-target", () => ({ resolveApprovalPostTarget: m.target }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/analytics/action-events", () => ({ trackSocialPostPublished: vi.fn() }));

import "../social-publish";
import { PINTEREST_READINESS_TEXT } from "@/services/connectors/pinterest-composio/readiness";

const ROW_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const EVENT_TENANT = "11111111-1111-4111-8111-111111111111";
const RUN = "30000000-0000-4000-8000-000000000001";
const IMG = `${ROW_TENANT}/9f9f9f9f-0000-4000-8000-000000000000.jpg`;
const ACCOUNT = { tenant_id: ROW_TENANT, toolkit: "pinterest", connected_account_id: "ca_pin", auth_config_id: "ac" };
const SLACK_CARD_CHANNEL = "CAPPROVALS";

const step = { run: async (_n: string, fn: () => unknown) => fn(), sleepUntil: async () => {} };
const run = () => m.handler!({ event: { data: { post_id: "post-1", tenant_id: EVENT_TENANT } }, step });
const createPinCalls = () => m.exec.mock.calls.filter((c) => c[0].tool_slug === "PINTEREST_CREATE_PIN");
const notices = () => m.enqueue.mock.calls.map((c) => c[0] as Record<string, unknown>);

function boardsThen(boards: Array<Record<string, unknown>>, pinData: unknown) {
  m.exec.mockImplementation(async (a: { tool_slug: string }) =>
    a.tool_slug === "PINTEREST_LIST_BOARDS"
      ? { ok: true, status: 200, data: { items: boards, bookmark: null }, error: null, outcome_unknown: false }
      : { ok: true, status: 200, data: pinData, error: null, outcome_unknown: false },
  );
}

beforeEach(() => {
  for (const f of [m.verify, m.exec, m.owned, m.safeFetch, m.enqueue, m.rpc, m.info, m.site, m.target]) f.mockReset();
  m.info.mockResolvedValue({ data: { contentType: "image/jpeg", size: 300_000 }, error: null });
  m.site.mockResolvedValue("https://acme.com");
  m.rpc.mockImplementation(async (name: string) =>
    name === "social_publish_claim" || name === "social_publish_begin_send" ? { data: true, error: null } : { data: null, error: null },
  );
  m.enqueue.mockResolvedValue(1);
  m.verify.mockResolvedValue(ACCOUNT);
  m.owned.mockResolvedValue(ACCOUNT);
  m.safeFetch.mockResolvedValue("<html><head><title>Duvet</title></head></html>");
  m.target.mockImplementation(async (tenant: string, runId: string) =>
    tenant === ROW_TENANT && runId === RUN ? { channel: SLACK_CARD_CHANNEL, team_id: "TTEAMA" } : null,
  );
  m.row = {
    id: "post-1", tenant_id: ROW_TENANT, agent_run_id: RUN, channel: "pinterest_pin", pipedream_app_slug: "pinterest",
    pipedream_action_id: "a", account_id: "ca_pin", destination_id: null, snapshot_hash: "h",
    scheduled_at: null, status: "approved", idempotency_key: "k1", transport: "composio",
    configured_props: { file: IMG, title: "Linen duvet cover", text: "Stonewashed linen.", board_id: "222", link: "https://acme.com/p/duvet" },
  };
});

describe("social-publish worker: the Slack follow-up after a Slack-approved pin", () => {
  it("a published pin posts one 'Posted on Pinterest' line with the live pin URL to the card's Slack channel", async () => {
    boardsThen([{ id: "222", name: "Linen bedding", privacy: "PUBLIC" }], { data: { id: "987654321" } });
    const out = (await run()) as Record<string, unknown>;

    expect(createPinCalls()).toHaveLength(1);
    expect(out).toMatchObject({ status: "published", external_post_id: "987654321" });
    const fin = m.rpc.mock.calls.filter((c) => c[0] === "social_publish_finalize").map((c) => c[1]);
    expect(fin).toEqual([expect.objectContaining({ p_ok: true, p_external_url: "https://www.pinterest.com/pin/987654321/" })]);
    expect(m.target).toHaveBeenCalledWith(ROW_TENANT, RUN);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({
      tenant_id: ROW_TENANT,
      channel_id: SLACK_CARD_CHANNEL,
      kind: "social_publish_result",
      idempotency_key: "social_publish_result:post-1",
    });
    expect(notices()[0].body).toBe("✅ Posted on Pinterest — <https://www.pinterest.com/pin/987654321/|open it ↗>");
  });

  it("a board made secret after approval is refused before CREATE_PIN, and Slack gets the readiness reason, never 'posted'", async () => {
    boardsThen([{ id: "222", name: "Linen bedding", privacy: "SECRET" }], { data: { id: "987654321" } });
    const out = (await run()) as Record<string, unknown>;

    expect(createPinCalls()).toHaveLength(0);
    expect(out).toMatchObject({ status: "failed", error: "vendor_rejected" });
    const fin = m.rpc.mock.calls.filter((c) => c[0] === "social_publish_finalize").map((c) => c[1]);
    expect(fin).toEqual([
      expect.objectContaining({ p_ok: false, p_external_url: null, p_response: expect.objectContaining({ code: "pinterest_board_secret" }) }),
    ]);
    expect(notices()).toHaveLength(1);
    const body = String(notices()[0].body);
    expect(notices()[0]).toMatchObject({ channel_id: SLACK_CARD_CHANNEL, idempotency_key: "social_publish_result:post-1" });
    expect(body).toBe(`Couldn't publish the Pinterest post. ${PINTEREST_READINESS_TEXT.pinterest_board_secret}`);
    expect(body).not.toMatch(/posted/i);
    expect(body).not.toContain("pinterest.com/pin");
    expect(body).not.toContain("the platform rejected it");
  });
});
