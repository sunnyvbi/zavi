import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  verify: vi.fn(),
  liText: vi.fn(),
  liImage: vi.fn(),
  igComposio: vi.fn(),
  xText: vi.fn(),
  enqueue: vi.fn(),
  rpc: vi.fn(),
  row: null as Record<string, unknown> | null,
  handler: null as null | ((ctx: unknown) => Promise<unknown>),
}));

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
  resolveChannelAction: (ch: string) => (ch === "linkedin" || ch === "x" ? { destination_required: false } : { media_prop: "file", destination_required: false }),
}));
vi.mock("@/services/connectors/social-publish-account", () => ({ verifySocialAccountAtPublish: m.verify }));
vi.mock("@/services/connectors/linkedin-social/publish", () => ({
  publishLinkedInText: m.liText,
  publishLinkedInImage: m.liImage,
  publishLinkedInVideo: vi.fn(),
}));
vi.mock("@/services/connectors/x-social/publish", async (orig) => ({
  ...(await orig<typeof import("@/services/connectors/x-social/publish")>()),
  publishXText: m.xText,
}));
vi.mock("@/services/connectors/instagram-composio/publish", () => ({
  publishInstagramImageViaComposio: m.igComposio,
  publishInstagramVideoViaComposio: vi.fn(),
}));
vi.mock("@/services/connectors/pipedream/api", () => ({
  runAction: vi.fn(() => { throw new Error("pipedream must never be called"); }),
}));
vi.mock("@/services/slack/outbox", () => ({ enqueueSlackOutbox: m.enqueue }));
vi.mock("@/services/slack/approval-post-target", () => ({ resolveApprovalPostTarget: async () => ({ channel: "C1", team_id: "T" }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/analytics/action-events", () => ({ trackSocialPostPublished: vi.fn() }));

import "../social-publish";
import { resetTenantPlan } from "@/__tests__/helpers/tenant-plan";

const ROW_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function baseRow(over: Record<string, unknown>) {
  return {
    id: "post-1", tenant_id: ROW_TENANT, agent_run_id: "run-1", pipedream_app_slug: "linkedin",
    pipedream_action_id: "a", account_id: "native", destination_id: null, snapshot_hash: "h",
    scheduled_at: null, status: "approved", idempotency_key: "k1", ...over,
  };
}
const step = { run: async (_n: string, fn: () => unknown) => fn(), sleepUntil: async () => {} };
const run = () => m.handler!({ event: { data: { post_id: "post-1", tenant_id: ROW_TENANT } }, step });
const finalizeCalls = () => m.rpc.mock.calls.filter((c) => c[0] === "social_publish_finalize").map((c) => c[1]);
const slackText = () => JSON.stringify(m.enqueue.mock.calls);
const revokeCalls = () => m.rpc.mock.calls.filter((c) => c[0] === "refresh_connector_secrets").map((c) => c[1]);
const rpcOrder = () => m.rpc.mock.calls.map((c) => c[0]);

beforeEach(() => {
  resetTenantPlan();
  for (const f of [m.verify, m.liText, m.liImage, m.igComposio, m.xText, m.enqueue, m.rpc]) f.mockReset();
  m.rpc.mockImplementation(async (name: string) =>
    name === "social_publish_claim" || name === "social_publish_begin_send" ? { data: true, error: null } : { data: null, error: null },
  );
  m.enqueue.mockResolvedValue(1);
  m.verify.mockImplementation(async (a: { tenantId: string; accountId: string }) => ({ tenant_id: a.tenantId, connected_account_id: a.accountId }));
});

describe("social-publish worker — a revoked native LinkedIn token", () => {
  it("a 401 from LinkedIn text publish finalizes as disconnected and tells the founder to reconnect", async () => {
    m.row = baseRow({ channel: "linkedin", transport: "native", configured_props: { text: "hello" } });
    m.liText.mockResolvedValue({ ok: false, status: 401, raw: { serviceErrorCode: 65601, message: "The token used in the request has been revoked by the user" } });

    const r = await run();

    expect(m.liText).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "failed", error: "disconnected" });
    expect(finalizeCalls()).toEqual([expect.objectContaining({ p_post_id: "post-1", p_ok: false, p_error: "disconnected" })]);
    expect(slackText()).toMatch(/no longer connected/);
    expect(slackText()).not.toMatch(/rejected it/);
    expect(revokeCalls()).toHaveLength(1);
    const mark = revokeCalls()[0] as Record<string, unknown>;
    expect(mark).toEqual({ p_tenant_id: ROW_TENANT, p_slug: "linkedin_social", p_secrets: {}, p_expires_at: expect.any(String) });
    expect(Math.abs(Date.parse(String(mark.p_expires_at)) - Date.now())).toBeLessThan(60_000);
    expect(rpcOrder().indexOf("refresh_connector_secrets")).toBeGreaterThan(rpcOrder().indexOf("social_publish_finalize"));
  });

  it("a failed reconnect mark never loses the durable outcome or the founder's message", async () => {
    m.row = baseRow({ channel: "linkedin_video", transport: "native", configured_props: { text: "v", file: `${ROW_TENANT}/a.mp4` } });
    m.rpc.mockImplementation(async (name: string) =>
      name === "social_publish_claim" || name === "social_publish_begin_send"
        ? { data: true, error: null }
        : name === "refresh_connector_secrets"
          ? { data: null, error: { message: "connector linkedin_social is not connected" } }
          : { data: null, error: null },
    );
    const { publishLinkedInVideo } = await import("@/services/connectors/linkedin-social/publish");
    vi.mocked(publishLinkedInVideo).mockResolvedValue({ ok: false, status: 401, raw: { message: "revoked" } } as never);

    const r = await run();

    expect(r).toMatchObject({ status: "failed", error: "disconnected" });
    expect(finalizeCalls()).toEqual([expect.objectContaining({ p_error: "disconnected" })]);
    expect(revokeCalls()).toEqual([expect.objectContaining({ p_tenant_id: ROW_TENANT, p_slug: "linkedin_social" })]);
    expect(slackText()).toMatch(/no longer connected/);
  });

  it("a 401 from LinkedIn image upload finalizes as disconnected", async () => {
    m.row = baseRow({ channel: "linkedin_image", transport: "native", configured_props: { text: "cap", file: `${ROW_TENANT}/a.jpg` } });
    m.liImage.mockResolvedValue({ ok: false, status: 401, raw: { error: "linkedin registerUpload 401" } });

    const r = await run();

    expect(m.liImage).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "failed", error: "disconnected" });
    expect(revokeCalls()).toEqual([expect.objectContaining({ p_tenant_id: ROW_TENANT, p_slug: "linkedin_social", p_secrets: {} })]);
  });

  it("a 403 or 422 from LinkedIn is still a stable rejection, not a reconnect", async () => {
    m.row = baseRow({ channel: "linkedin", transport: "native", configured_props: { text: "hello" } });
    m.liText.mockResolvedValue({ ok: false, status: 403, raw: { message: "Not enough permissions" } });
    expect(await run()).toMatchObject({ status: "failed", error: "vendor_rejected" });
    m.liText.mockResolvedValue({ ok: false, status: 422, raw: { message: "Duplicate content" } });
    expect(await run()).toMatchObject({ status: "failed", error: "vendor_rejected" });
    expect(revokeCalls()).toEqual([]);
  });

  it("a 401 on the Composio transport keeps the vendor_rejected code", async () => {
    m.row = baseRow({ channel: "instagram_image", transport: "composio", account_id: "ca_ig", configured_props: { text: "x", file: `${ROW_TENANT}/a.jpg` } });
    m.verify.mockResolvedValue({ tenant_id: ROW_TENANT, toolkit: "instagram", connected_account_id: "ca_ig" });
    m.igComposio.mockResolvedValue({ ok: false, status: 401, raw: { error: "composio 401" } });
    expect(await run()).toMatchObject({ status: "failed", error: "vendor_rejected" });
    expect(revokeCalls()).toEqual([]);
  });

  it("a native 401 on another channel keeps vendor_rejected and never marks the LinkedIn connector", async () => {
    m.row = baseRow({ channel: "x", pipedream_app_slug: "twitter", transport: "native", configured_props: { text: "hello" } });
    m.xText.mockResolvedValue({ ok: false, status: 401, raw: { title: "Unauthorized" } });
    const r = await run();
    expect(m.xText).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "failed", error: "vendor_rejected" });
    expect(finalizeCalls()).toEqual([expect.objectContaining({ p_error: "vendor_rejected" })]);
    expect(revokeCalls()).toEqual([]);
  });
});
