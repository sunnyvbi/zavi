import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  verify: vi.fn(),
  exec: vi.fn(),
  owned: vi.fn(),
  safeFetch: vi.fn(),
  enqueue: vi.fn(),
  rpc: vi.fn(),
  tiktok: vi.fn(),
  info: vi.fn(),
  site: vi.fn(),
  row: null as Record<string, unknown> | null,
  signedBase: "https://signed.example/",
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
    storage: { from: () => ({ createSignedUrl: async (p: string) => ({ data: { signedUrl: `${m.signedBase}${p}` }, error: null }) }) },
  }),
}));
vi.mock("@/services/connectors/social-publish-gate", () => ({ socialPublishGate: async () => ({ open: true, via: "config" }) }));
vi.mock("@/services/connectors/social-channels", async (orig) => ({
  ...(await orig<typeof import("@/services/connectors/social-channels")>()),
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
vi.mock("@/services/connectors/tiktok/api", async (orig) => ({
  ...(await orig<typeof import("@/services/connectors/tiktok/api")>()),
  publishTikTokVideo: m.tiktok,
}));
vi.mock("@/services/slack/outbox", () => ({ enqueueSlackOutbox: m.enqueue }));
vi.mock("@/services/slack/approval-post-target", () => ({ resolveApprovalPostTarget: async () => ({ channel: "C1", team_id: "T" }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/analytics/action-events", () => ({ trackSocialPostPublished: vi.fn() }));

import "../social-publish";

const ROW_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const EVENT_TENANT = "11111111-1111-4111-8111-111111111111";
const IMG = `${ROW_TENANT}/9f9f9f9f-0000-4000-8000-000000000000.jpg`;
const ACCOUNT = { tenant_id: ROW_TENANT, toolkit: "pinterest", connected_account_id: "ca_pin", auth_config_id: "ac" };

function pinRow() {
  return {
    id: "post-1", tenant_id: ROW_TENANT, agent_run_id: "run-1", channel: "pinterest_pin", pipedream_app_slug: "pinterest",
    pipedream_action_id: "a", account_id: "ca_pin", destination_id: null, snapshot_hash: "h",
    scheduled_at: null, status: "approved", idempotency_key: "k1", transport: "composio",
    configured_props: { file: IMG, title: "Linen duvet cover", text: "Stonewashed linen.", board_id: "222", link: "https://acme.com/p/duvet" },
  };
}
const step = { run: async (_n: string, fn: () => unknown) => fn(), sleepUntil: async () => {} };
const run = () => m.handler!({ event: { data: { post_id: "post-1", tenant_id: EVENT_TENANT } }, step });
const finalizeCalls = () => m.rpc.mock.calls.filter((c) => c[0] === "social_publish_finalize").map((c) => c[1]);
const createPinCalls = () => m.exec.mock.calls.filter((c) => c[0].tool_slug === "PINTEREST_CREATE_PIN");
const boards = (items: Array<Record<string, unknown>>, bookmark: string | null = null) => ({ ok: true, status: 200, data: { items, bookmark }, error: null, outcome_unknown: false });

beforeEach(() => {
  for (const f of [m.verify, m.exec, m.owned, m.safeFetch, m.enqueue, m.rpc, m.tiktok, m.info, m.site]) f.mockReset();
  m.info.mockResolvedValue({ data: { contentType: "image/jpeg", size: 300_000 }, error: null });
  m.site.mockResolvedValue("https://acme.com");
  m.rpc.mockImplementation(async (name: string) =>
    name === "social_publish_claim" || name === "social_publish_begin_send"
      ? { data: true, error: null }
      : { data: null, error: null },
  );
  m.enqueue.mockResolvedValue(1);
  m.verify.mockResolvedValue(ACCOUNT);
  m.owned.mockResolvedValue(ACCOUNT);
  m.safeFetch.mockResolvedValue("<html><head><title>Duvet</title></head></html>");
  m.row = pinRow();
  m.signedBase = "https://signed.example/";
});

function listThen(list: unknown) {
  m.exec.mockImplementation(async (a: { tool_slug: string }) =>
    a.tool_slug === "PINTEREST_LIST_BOARDS" ? list : { ok: true, status: 200, data: { id: "pin-9" }, error: null, outcome_unknown: false },
  );
}

describe("social-publish worker — Pinterest re-checks board and link right before PINTEREST_CREATE_PIN", () => {
  it("an image link that is not public https is refused by Zavi, says nothing was sent, and never calls Pinterest", async () => {
    m.signedBase = "http://127.0.0.1:54321/storage/v1/object/sign/agent-chat-images/";
    listThen(boards([{ id: "222", name: "Linen", privacy: "PUBLIC" }]));
    const out = (await run()) as Record<string, unknown>;
    expect(m.exec).not.toHaveBeenCalled();
    expect(out).toMatchObject({ status: "failed", error: "vendor_rejected" });
    expect(finalizeCalls()).toEqual([expect.objectContaining({ p_ok: false, p_response: expect.objectContaining({ code: "media_link_not_public" }) })]);
    expect(m.enqueue.mock.calls[0][0].body).toContain("nothing was sent to the platform");
    expect(m.enqueue.mock.calls[0][0].body).not.toContain("the platform rejected it");
  });

  it("an account re-check that throws after the claim says nothing was posted and never calls Pinterest", async () => {
    m.verify.mockReset();
    m.verify.mockResolvedValueOnce(ACCOUNT).mockRejectedValueOnce(new Error("composio list HTTP 502"));
    listThen(boards([{ id: "222", name: "Linen", privacy: "PUBLIC" }]));
    const out = (await run()) as Record<string, unknown>;
    expect(createPinCalls()).toHaveLength(0);
    expect(out).toMatchObject({ status: "failed" });
    expect(finalizeCalls()).toEqual([expect.objectContaining({ p_ok: false, p_response: expect.objectContaining({ code: "account_check_failed" }) })]);
    expect(m.enqueue.mock.calls[0][0].body).toContain("nothing was posted");
    expect(m.enqueue.mock.calls[0][0].body).not.toContain("could not confirm whether it posted");
  });

  it("a CREATE_PIN success with no pin id is told as unconfirmed, never as a rejection", async () => {
    m.exec.mockImplementation(async (a: { tool_slug: string }) =>
      a.tool_slug === "PINTEREST_LIST_BOARDS"
        ? boards([{ id: "222", name: "Linen", privacy: "PUBLIC" }])
        : { ok: true, status: 200, data: { message: "ok" }, error: null, outcome_unknown: false },
    );
    const out = (await run()) as Record<string, unknown>;
    expect(createPinCalls()).toHaveLength(1);
    expect(out).toMatchObject({ status: "failed", error: "transient_exhausted" });
  });

  it("a board deleted after approval never reaches PINTEREST_CREATE_PIN and the founder is told why", async () => {
    listThen(boards([{ id: "111", name: "Other", privacy: "PUBLIC" }]));
    const out = (await run()) as Record<string, unknown>;
    expect(m.exec.mock.calls.some((c) => c[0].tool_slug === "PINTEREST_LIST_BOARDS" && c[0].user_id === ROW_TENANT)).toBe(true);
    expect(createPinCalls()).toHaveLength(0);
    expect(out).toMatchObject({ status: "failed", error: "vendor_rejected" });
    expect(finalizeCalls()).toEqual([expect.objectContaining({ p_ok: false, p_error: "vendor_rejected", p_response: expect.objectContaining({ code: "pinterest_board_missing" }) })]);
    expect(m.enqueue).toHaveBeenCalledTimes(1);
    expect(m.enqueue.mock.calls[0][0].body).toContain("That board is not on your connected Pinterest account any more");
  });

  it("an unclear Composio 200 on PINTEREST_CREATE_PIN is never told to the founder as a rejection", async () => {
    m.exec.mockImplementation(async (a: { tool_slug: string }) =>
      a.tool_slug === "PINTEREST_LIST_BOARDS"
        ? boards([{ id: "222", name: "Linen", privacy: "PUBLIC" }])
        : { ok: false, status: 200, data: { successful: false }, error: "composio_ambiguous_response", outcome_unknown: true },
    );
    const out = (await run()) as Record<string, unknown>;
    expect(createPinCalls()).toHaveLength(1);
    expect(out).toMatchObject({ status: "failed", error: "transient_exhausted" });
    expect(finalizeCalls()).toEqual([expect.objectContaining({ p_ok: false, p_error: "transient_exhausted" })]);
    expect(m.enqueue.mock.calls[0][0].body).toContain("could not confirm whether it posted");
    expect(m.enqueue.mock.calls[0][0].body).not.toContain("rejected");
  });

  it("a definite Composio refusal on PINTEREST_CREATE_PIN stays a rejection", async () => {
    m.exec.mockImplementation(async (a: { tool_slug: string }) =>
      a.tool_slug === "PINTEREST_LIST_BOARDS"
        ? boards([{ id: "222", name: "Linen", privacy: "PUBLIC" }])
        : { ok: false, status: 200, data: { successful: false }, error: "Trial access cannot create pins", outcome_unknown: false },
    );
    const out = (await run()) as Record<string, unknown>;
    expect(out).toMatchObject({ status: "failed", error: "vendor_rejected" });
  });

  it("a board on page 2 of the list still publishes, once", async () => {
    let calls = 0;
    m.exec.mockImplementation(async (a: { tool_slug: string }) => {
      if (a.tool_slug !== "PINTEREST_LIST_BOARDS") return { ok: true, status: 200, data: { id: "pin-9" }, error: null, outcome_unknown: false };
      calls += 1;
      return calls === 1 ? boards([{ id: "111", name: "A" }], "bm") : boards([{ id: "222", name: "Linen", privacy: "PUBLIC" }]);
    });
    const out = (await run()) as Record<string, unknown>;
    expect(createPinCalls()).toHaveLength(1);
    expect(createPinCalls()[0][0].arguments).toMatchObject({ board_id: "222", link: "https://acme.com/p/duvet", media_source: { url: `https://signed.example/${IMG}` } });
    expect(out).toMatchObject({ status: "published" });
  });

  it("a link page that turned nopin is refused before the vendor call", async () => {
    listThen(boards([{ id: "222", name: "Linen", privacy: "PUBLIC" }]));
    m.safeFetch.mockResolvedValue(`<meta name="pinterest" content="nopin">`);
    const out = (await run()) as Record<string, unknown>;
    expect(createPinCalls()).toHaveLength(0);
    expect(out).toMatchObject({ status: "failed", error: "vendor_rejected" });
    expect(m.enqueue.mock.calls[0][0].body).toContain("tells Pinterest not to allow pins");
  });

  it("an approved pin whose page Zavi cannot open still publishes: a bot block or outage never fails it for good", async () => {
    listThen(boards([{ id: "222", name: "Linen", privacy: "PUBLIC" }]));
    m.safeFetch.mockResolvedValue(null);
    const out = (await run()) as Record<string, unknown>;
    expect(createPinCalls()).toHaveLength(1);
    expect(out).toMatchObject({ status: "published" });
  });

  it("an image that was deleted after approval never reaches PINTEREST_CREATE_PIN and the founder is told why", async () => {
    listThen(boards([{ id: "222", name: "Linen", privacy: "PUBLIC" }]));
    m.info.mockResolvedValue({ data: null, error: { message: "Object not found" } });
    const out = (await run()) as Record<string, unknown>;
    expect(m.info).toHaveBeenCalledWith(IMG);
    expect(createPinCalls()).toHaveLength(0);
    expect(out).toMatchObject({ status: "failed", error: "vendor_rejected" });
    expect(finalizeCalls()).toEqual([expect.objectContaining({ p_ok: false, p_error: "vendor_rejected", p_response: expect.objectContaining({ code: "pinterest_media_invalid" }) })]);
    expect(m.enqueue.mock.calls[0][0].body).toContain("The pin image is missing or not one Pinterest accepts");
  });

  it("an image that is now over 20 MB or not PNG/JPEG/WebP is refused before the vendor call", async () => {
    listThen(boards([{ id: "222", name: "Linen", privacy: "PUBLIC" }]));
    m.info.mockResolvedValue({ data: { contentType: "image/gif", size: 300_000 }, error: null });
    await run();
    expect(createPinCalls()).toHaveLength(0);
    m.info.mockResolvedValue({ data: { contentType: "image/png", size: 20 * 1024 * 1024 + 1 }, error: null });
    await run();
    expect(createPinCalls()).toHaveLength(0);
  });

  it("a link that is no longer on the company's own site is refused before the vendor call", async () => {
    listThen(boards([{ id: "222", name: "Linen", privacy: "PUBLIC" }]));
    m.site.mockResolvedValue("https://other-company.com");
    const out = (await run()) as Record<string, unknown>;
    expect(m.site).toHaveBeenCalledWith(ROW_TENANT);
    expect(createPinCalls()).toHaveLength(0);
    expect(out).toMatchObject({ status: "failed", error: "vendor_rejected" });
    expect(finalizeCalls()).toEqual([expect.objectContaining({ p_ok: false, p_response: expect.objectContaining({ code: "pinterest_identity_mismatch" }) })]);
  });

  it("an image or site that cannot be checked does not block publishing", async () => {
    listThen(boards([{ id: "222", name: "Linen", privacy: "PUBLIC" }]));
    m.info.mockImplementation(() => new Promise(() => {}));
    m.site.mockResolvedValue(null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = run();
      await vi.advanceTimersByTimeAsync(61_000);
      const out = (await pending) as Record<string, unknown>;
      expect(m.info).toHaveBeenCalledWith(IMG);
      expect(m.site).toHaveBeenCalledWith(ROW_TENANT);
      expect(createPinCalls()).toHaveLength(1);
      expect(out).toMatchObject({ status: "published" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a board list that cannot be read does not block: Pinterest stays the final gate", async () => {
    listThen({ ok: false, status: 503, data: null, error: "down", outcome_unknown: false });
    await run();
    expect(createPinCalls()).toHaveLength(1);
  });
});

describe("social-publish worker — TikTok private-only refusal", () => {
  it("a TikTok refusal for a public account is a rejection that tells the founder to set the account private", async () => {
    const { TIKTOK_PRIVATE_ONLY, TIKTOK_PRIVATE_ONLY_MESSAGE } = await import("@/services/connectors/tiktok/api");
    m.row = {
      ...pinRow(), channel: "tiktok_video", pipedream_app_slug: "tiktok", transport: "native", account_id: null,
      configured_props: { file: `${ROW_TENANT}/9f9f9f9f-0000-4000-8000-000000000000.mp4`, text: "Linen, stonewashed.", privacy: "PUBLIC_TO_EVERYONE" },
    };
    m.tiktok.mockResolvedValue({ ok: false, status: 400, raw: { code: TIKTOK_PRIVATE_ONLY, error: TIKTOK_PRIVATE_ONLY, message: TIKTOK_PRIVATE_ONLY_MESSAGE } });
    const out = (await run()) as Record<string, unknown>;
    expect(m.tiktok).toHaveBeenCalledTimes(1);
    expect(m.tiktok.mock.calls[0][2]).toMatch(/^https:\/\/signed\.example\/.+\.mp4$/);
    expect(out).toMatchObject({ status: "failed", error: "vendor_rejected" });
    expect(finalizeCalls()).toEqual([expect.objectContaining({ p_ok: false, p_error: "vendor_rejected", p_response: expect.objectContaining({ code: TIKTOK_PRIVATE_ONLY }) })]);
    expect(m.enqueue).toHaveBeenCalledTimes(1);
    expect(m.enqueue.mock.calls[0][0].body).toContain("Set your TikTok account to private until Zavi's TikTok review clears, then post again");
    expect(m.enqueue.mock.calls[0][0].body).not.toContain("could not confirm whether it posted");
  });
});
