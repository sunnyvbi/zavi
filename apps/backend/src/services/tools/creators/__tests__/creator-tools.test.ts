import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  switchedChannelForRun: vi.fn(),
  loadBookableCreator: vi.fn(),
  latestCreatorCaps: vi.fn(),
  ensureCreatorThread: vi.fn(),
  postCreatorThreadMessage: vi.fn(),
  createCreatorOffer: vi.fn(),
  openAgentOfferExists: vi.fn(),
  quoteCreatorBooking: vi.fn(),
  startCreatorCheckout: vi.fn(),
  fileCreatorHireCard: vi.fn(),
  declineCreatorHire: vi.fn(),
  systemConfig: vi.fn(),
  runOffer: vi.fn(),
  offerReads: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  outreachRows: [] as Array<Record<string, unknown>>,
  countError: null as null | { message: string },
}));

vi.mock("@zavi/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zavi/shared")>();
  return { ...actual, CREATOR_MARKETPLACE_ENABLED: true };
});

function countQuery(table: string, tid: string) {
  const preds: Array<(r: Record<string, unknown>) => boolean> = [(r) => r.table === table && r.tenant_id === tid];
  const q = {
    eq: (col: string, v: unknown) => (preds.push((r) => r[col] === v), q),
    is: (col: string, v: unknown) => (preds.push((r) => (v === null ? r[col] == null : r[col] === v)), q),
    not: (col: string, op: string, v: unknown) => {
      if (op !== "is" || v !== null) throw new Error(`unsupported not(${col}, ${op})`);
      preds.push((r) => r[col] != null);
      return q;
    },
    gte: (col: string, v: string) => (preds.push((r) => String(r[col]) >= v), q),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(
        m.countError ? { count: null, error: m.countError } : { count: m.outreachRows.filter((r) => preds.every((p) => p(r))).length, error: null },
      ).then(res, rej),
  };
  return q;
}

vi.mock("@/services/tenant-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/tenant-client")>();
  return {
    ...real,
    globalClient: () => ({
      from: (table: string) => {
        if (table !== "system_config") throw new Error(`unexpected global table ${table}`);
        const q = { select: () => q, eq: () => q, maybeSingle: () => m.systemConfig() };
        return q;
      },
    }),
    tenantClient: (tid: string) => ({
      from: (table: string) => {
        const read = { table, filters: [["tenant", tid]] as Array<[string, unknown]> };
        const q = {
          select: (_cols?: string, opts?: { head?: boolean }) => {
            if (opts?.head) return countQuery(table, tid);
            m.offerReads.push(read);
            return q;
          },
          eq: (col: string, v: unknown) => {
            read.filters.push([col, v]);
            return q;
          },
          limit: () => q,
          maybeSingle: () => m.runOffer(),
        };
        return q;
      },
    }),
  };
});

vi.mock("@/services/channels/channel-actions", () => ({ switchedChannelForRun: m.switchedChannelForRun }));
vi.mock("@/services/creators/booking-db", () => ({ loadBookableCreator: m.loadBookableCreator }));
vi.mock("@/services/decisions/creator-hire-budget", () => ({ latestCreatorCaps: m.latestCreatorCaps }));
vi.mock("@/services/creators/thread", () => ({
  MAX_CREATOR_MESSAGE_LEN: 4000,
  ensureCreatorThread: m.ensureCreatorThread,
  postCreatorThreadMessage: m.postCreatorThreadMessage,
}));
vi.mock("@/services/creators/offers", () => ({ createCreatorOffer: m.createCreatorOffer, openAgentOfferExists: m.openAgentOfferExists }));
vi.mock("@/services/creators/booking", () => ({
  quoteCreatorBooking: m.quoteCreatorBooking,
  startCreatorCheckout: m.startCreatorCheckout,
  bookingBriefSnapshot: (i: { title?: string | null; brief?: string | null }) => (i.brief ? { title: i.title, brief: i.brief } : null),
}));
vi.mock("@/services/creators/hire-card", () => ({
  fileCreatorHireCard: m.fileCreatorHireCard,
  declineCreatorHire: m.declineCreatorHire,
}));

import { creatorMessageTool } from "../creator_message";
import { creatorOfferTool } from "../creator_offer";
import { creatorBookPackageTool } from "../creator_book_package";
import { callCreatorTool, listCreatorTools } from "../facade";
import { byName } from "@/services/tools/registry";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const RUN = "22222222-2222-2222-2222-222222222222";
const MEMBER = "3b9d6f4e-8a1c-4f2e-9d3a-5c7e1b2a4f60";
const PACKAGE = "6e2a9c1d-4b7f-4a3e-8c5d-2f1b9e7a3c84";

const ctx = (extra: Record<string, unknown> = {}) => ({ tenant_id: TENANT, run_id: RUN, log: () => {}, ...extra }) as never;

const approved = { id: MEMBER, display_name: "Maya", slug: "maya", city: null, country_code: "US", vetting_state: "approved" };

const quote = {
  blocked: null,
  creator: { human_member_id: MEMBER, display_name: "Maya", payout_supported: true },
  job: { title: "1 UGC video" },
  money: { currency: "usd", price_cents: 5000, business_fee_cents: 500, business_total_cents: 5500 },
};

const messageInput = { human_member_id: MEMBER, body: "Hi Maya, can you film a 30s demo?" };
const offerInput = {
  human_member_id: MEMBER,
  kind: "ugc_video",
  title: "1 demo video",
  description: "30s vertical demo, 90 days ad rights",
  price_usd: 50,
  delivery_days: 7,
};
const bookInput = { package_id: PACKAGE, brief: "Show the import screen." };

const writeMocks = () => [
  m.ensureCreatorThread,
  m.postCreatorThreadMessage,
  m.createCreatorOffer,
  m.startCreatorCheckout,
  m.fileCreatorHireCard,
  m.declineCreatorHire,
];

function expectNothingWritten() {
  for (const fn of writeMocks()) expect(fn).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  m.offerReads.length = 0;
  m.outreachRows.length = 0;
  m.countError = null;
  m.systemConfig.mockResolvedValue({ data: { blob: { creator_hires_enabled: true } }, error: null });
  m.runOffer.mockResolvedValue({ data: null, error: null });
  m.switchedChannelForRun.mockResolvedValue("ugc");
  m.loadBookableCreator.mockResolvedValue(approved);
  m.latestCreatorCaps.mockResolvedValue({ id: "caps-1", per_hire_usd: 55, per_week_usd: 200 });
  m.ensureCreatorThread.mockResolvedValue({ id: "thread-1", tenant_id: TENANT, human_member_id: MEMBER });
  m.postCreatorThreadMessage.mockResolvedValue({ id: "msg-1", sender_kind: "tenant", body: "x", created_at: "now" });
  m.createCreatorOffer.mockResolvedValue({ id: "offer-1" });
  m.openAgentOfferExists.mockResolvedValue(false);
  m.quoteCreatorBooking.mockResolvedValue(quote);
  m.startCreatorCheckout.mockResolvedValue({ order_id: "order-1", checkout_url: null, checkout_session_id: null, quote, reused_existing: false });
  m.fileCreatorHireCard.mockResolvedValue({ ok: true, card_id: "card-1" });
  m.declineCreatorHire.mockResolvedValue(undefined);
});

const TOOLS = [
  ["creator_message", creatorMessageTool, messageInput],
  ["creator_offer", creatorOfferTool, offerInput],
  ["creator_book_package", creatorBookPackageTool, bookInput],
] as const;

describe("creator hire tools: which runs may use them", () => {
  it.each(TOOLS)("%s refuses on a run stamped to another channel and writes nothing", async (_n, tool, input) => {
    m.switchedChannelForRun.mockResolvedValue("seo");
    await expect(tool.execute(ctx(), input)).rejects.toMatchObject({ code: expect.stringMatching(/_wrong_run$/) });
    expectNothingWritten();
    expect(m.latestCreatorCaps).not.toHaveBeenCalled();
  });

  it.each(TOOLS)("%s refuses on an unstamped run (a chat turn) and writes nothing", async (_n, tool, input) => {
    m.switchedChannelForRun.mockResolvedValue(null);
    await expect(tool.execute(ctx(), input)).rejects.toMatchObject({ code: expect.stringMatching(/_wrong_run$/) });
    expectNothingWritten();
  });

  it.each(TOOLS)("%s refuses with no run id at all", async (_n, tool, input) => {
    await expect(tool.execute(ctx({ run_id: undefined }), input)).rejects.toMatchObject({ code: expect.stringMatching(/_wrong_run$/) });
    expectNothingWritten();
  });

  it.each(TOOLS)("%s on a draft run (writes_suppressed) returns without reading caps or writing", async (_n, tool, input) => {
    const out = (await tool.execute(ctx({ writes_suppressed: true }), input)) as { note: string };
    expect(out.note).toMatch(/Draft run/);
    expectNothingWritten();
    expect(m.latestCreatorCaps).not.toHaveBeenCalled();
    expect(m.loadBookableCreator).not.toHaveBeenCalled();
    expect(m.quoteCreatorBooking).not.toHaveBeenCalled();
  });

  it.each(TOOLS)("%s on a redo run proposes nothing", async (_n, tool, input) => {
    await expect(tool.execute(ctx({ redo: true }), input)).rejects.toMatchObject({ code: "redo_scope" });
    expectNothingWritten();
  });

  it.each(TOOLS)("%s never takes the tenant from model input", async (_n, tool, input) => {
    const shape = (tool.input_schema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).not.toContain("tenant_id");
    await tool.execute(ctx(), { ...input, tenant_id: OTHER_TENANT });
    const tenants = [
      ...m.ensureCreatorThread.mock.calls.map((c) => c[0].tenant_id),
      ...m.postCreatorThreadMessage.mock.calls.map((c) => c[0].access.tenant_id),
      ...m.createCreatorOffer.mock.calls.map((c) => c[0].tenant_id),
      ...m.latestCreatorCaps.mock.calls.map((c) => c[0]),
      ...m.quoteCreatorBooking.mock.calls.map((c) => c[0].tenant_id),
      ...m.startCreatorCheckout.mock.calls.map((c) => c[0].tenant_id),
      ...m.fileCreatorHireCard.mock.calls.map((c) => c[0].tenant_id),
    ];
    expect(tenants.length).toBeGreaterThan(0);
    expect(new Set(tenants)).toEqual(new Set([TENANT]));
    expect(m.switchedChannelForRun).toHaveBeenCalledWith(TENANT, RUN);
  });

  it("refuses a run from the removed Influencers channel", async () => {
    m.switchedChannelForRun.mockResolvedValue("influencer");
    await expect(creatorMessageTool.execute(ctx(), messageInput)).rejects.toMatchObject({ code: expect.stringMatching(/_wrong_run$/) });
    expect(m.postCreatorThreadMessage).not.toHaveBeenCalled();
  });
});

describe("creator hire tools: the creator-hire kill switch", () => {
  const offs = [
    ["switched off", () => m.systemConfig.mockResolvedValue({ data: { blob: { creator_hires_enabled: false } }, error: null })],
    ["never switched on", () => m.systemConfig.mockResolvedValue({ data: { blob: {} }, error: null })],
    ["config row missing", () => m.systemConfig.mockResolvedValue({ data: null, error: null })],
    ["config read errors", () => m.systemConfig.mockResolvedValue({ data: null, error: { message: "timeout" } })],
    ["config read throws", () => m.systemConfig.mockRejectedValue(new Error("socket hang up"))],
  ] as const;
  const cases = TOOLS.flatMap(([n, tool, input]) => offs.map(([label, set]) => [n, label, tool, input, set] as const));

  it.each(cases)("%s refuses when creator hiring is %s, before any read or write", async (_n, _label, tool, input, set) => {
    set();
    await expect(tool.execute(ctx(), input)).rejects.toMatchObject({ code: "creator_hires_off" });
    expectNothingWritten();
    expect(m.switchedChannelForRun).not.toHaveBeenCalled();
    expect(m.loadBookableCreator).not.toHaveBeenCalled();
    expect(m.latestCreatorCaps).not.toHaveBeenCalled();
    expect(m.quoteCreatorBooking).not.toHaveBeenCalled();
    expect(m.openAgentOfferExists).not.toHaveBeenCalled();
    expect(m.offerReads).toEqual([]);
  });

  it.each(TOOLS)("%s refuses on a draft run too when switched off", async (_n, tool, input) => {
    m.systemConfig.mockResolvedValue({ data: { blob: { creator_hires_enabled: false } }, error: null });
    await expect(tool.execute(ctx({ writes_suppressed: true }), input)).rejects.toMatchObject({ code: "creator_hires_off" });
    expectNothingWritten();
  });

  it("the facade reports the switch as a tool error and books nothing", async () => {
    m.systemConfig.mockResolvedValue({ data: null, error: { message: "timeout" } });
    const out = await callCreatorTool({ tenant_id: TENANT, run_id: RUN }, "book_package", bookInput);
    expect(out.is_error).toBe(true);
    expect(JSON.parse(out.content).error).toBe("creator_hires_off");
    expect(m.startCreatorCheckout).not.toHaveBeenCalled();
    expect(m.fileCreatorHireCard).not.toHaveBeenCalled();
  });
});

describe("creator_message", () => {
  it("posts as the business with a null sender user in the server-resolved thread", async () => {
    const out = (await creatorMessageTool.execute(ctx(), messageInput)) as { sent: boolean };
    expect(out.sent).toBe(true);
    expect(m.ensureCreatorThread).toHaveBeenCalledWith({ tenant_id: TENANT, human_member_id: MEMBER, started_by: "tenant", started_by_user_id: null });
    expect(m.postCreatorThreadMessage).toHaveBeenCalledWith({
      access: { tenant_id: TENANT, thread_id: "thread-1", human_member_id: MEMBER, sender_kind: "tenant" },
      sender_user_id: null,
      body: messageInput.body,
    });
  });

  it.each([
    ["unknown", null],
    ["pending", { ...approved, vetting_state: "pending" }],
    ["removed", { ...approved, vetting_state: "removed" }],
    ["unpayable country", { ...approved, country_code: "KP" }],
  ])("refuses a %s creator before any thread or message exists", async (_label, row) => {
    m.loadBookableCreator.mockResolvedValue(row);
    await expect(creatorMessageTool.execute(ctx(), messageInput)).rejects.toMatchObject({ code: "creator_not_hireable" });
    expect(m.ensureCreatorThread).not.toHaveBeenCalled();
    expect(m.postCreatorThreadMessage).not.toHaveBeenCalled();
  });
});

describe("creator_offer", () => {
  it("a retried run returns the offer it already sent to that creator, in any status, and sends nothing new", async () => {
    m.runOffer.mockResolvedValue({ data: { id: "offer-earlier", price_cents: 4000 }, error: null });
    m.openAgentOfferExists.mockResolvedValue(true);
    const out = (await creatorOfferTool.execute(ctx(), offerInput)) as { offered: boolean; offer_id: string; already_sent: boolean; note: string };
    expect(out).toMatchObject({ offered: true, offer_id: "offer-earlier", already_sent: true });
    expect(out.note).toContain("$44.00");
    expect(out.note).toContain("Nothing new was sent");
    expect(m.createCreatorOffer).not.toHaveBeenCalled();
    expect(m.ensureCreatorThread).not.toHaveBeenCalled();
    expect(m.openAgentOfferExists).not.toHaveBeenCalled();
    expect(m.offerReads).toEqual([
      { table: "creator_offers", filters: [["tenant", TENANT], ["agent_run_id", RUN], ["human_member_id", MEMBER]] },
    ]);
  });

  it("looks up this run's offer under the server tenant and run, never the model's", async () => {
    await creatorOfferTool.execute(ctx(), { ...offerInput, tenant_id: OTHER_TENANT, run_id: "44444444-4444-4444-4444-444444444444" });
    expect(m.offerReads).toEqual([
      { table: "creator_offers", filters: [["tenant", TENANT], ["agent_run_id", RUN], ["human_member_id", MEMBER]] },
    ]);
    expect(m.createCreatorOffer).toHaveBeenCalledTimes(1);
  });

  it("refuses when this run's earlier offer cannot be read, and sends nothing", async () => {
    m.runOffer.mockResolvedValue({ data: null, error: { message: "timeout" } });
    await expect(creatorOfferTool.execute(ctx(), offerInput)).rejects.toThrow(/creator_offers read failed/);
    expect(m.createCreatorOffer).not.toHaveBeenCalled();
  });

  it("a concurrent duplicate that hits the run+creator unique index returns the offer that won, once", async () => {
    m.runOffer
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { id: "offer-winner", price_cents: 5000 }, error: null });
    m.createCreatorOffer.mockRejectedValue(
      new Error('creator_offers insert failed: duplicate key value violates unique constraint "creator_offers_agent_run_member_key"'),
    );
    const out = (await creatorOfferTool.execute(ctx(), offerInput)) as { offer_id: string; already_sent: boolean };
    expect(out).toMatchObject({ offer_id: "offer-winner", already_sent: true });
    expect(m.createCreatorOffer).toHaveBeenCalledTimes(1);
  });

  it("a unique violation on some other key is not swallowed", async () => {
    m.createCreatorOffer.mockRejectedValue(new Error('creator_offers insert failed: duplicate key value violates unique constraint "creator_offers_pkey"'));
    await expect(creatorOfferTool.execute(ctx(), offerInput)).rejects.toThrow(/creator_offers_pkey/);
    expect(m.runOffer).toHaveBeenCalledTimes(1);
  });

  it("a run+creator violation whose winning row cannot be found rethrows instead of claiming it was sent", async () => {
    m.createCreatorOffer.mockRejectedValue(new Error('duplicate key value violates unique constraint "creator_offers_agent_run_member_key"'));
    await expect(creatorOfferTool.execute(ctx(), offerInput)).rejects.toThrow(/creator_offers_agent_run_member_key/);
  });

  it("refuses a second offer while an earlier agent offer to the same creator is still open, and sends nothing", async () => {
    m.openAgentOfferExists.mockResolvedValue(true);
    await expect(creatorOfferTool.execute(ctx() as never, offerInput)).rejects.toMatchObject({ code: "creator_offer_already_open" });
    expect(m.openAgentOfferExists).toHaveBeenCalledWith(TENANT, MEMBER);
    expect(m.createCreatorOffer).not.toHaveBeenCalled();
  });

  it("refuses with no caps before any offer is created", async () => {
    m.latestCreatorCaps.mockResolvedValue(null);
    await expect(creatorOfferTool.execute(ctx(), offerInput)).rejects.toMatchObject({ code: "creator_no_caps" });
    expect(m.createCreatorOffer).not.toHaveBeenCalled();
    expect(m.ensureCreatorThread).not.toHaveBeenCalled();
  });

  it("refuses when price plus the Zavi fee is over the per-hire cap, even by a cent", async () => {
    m.latestCreatorCaps.mockResolvedValue({ id: "caps-1", per_hire_usd: 54.99, per_week_usd: 200 });
    await expect(creatorOfferTool.execute(ctx(), offerInput)).rejects.toMatchObject({
      code: "creator_over_hire_cap",
      message: expect.stringContaining("$55.00"),
    });
    expect(m.createCreatorOffer).not.toHaveBeenCalled();
  });

  it("refuses an unapproved creator before reading caps or creating an offer", async () => {
    m.loadBookableCreator.mockResolvedValue({ ...approved, vetting_state: "rejected" });
    await expect(creatorOfferTool.execute(ctx(), offerInput)).rejects.toMatchObject({ code: "creator_not_hireable" });
    expect(m.createCreatorOffer).not.toHaveBeenCalled();
  });

  it("at exactly the cap, sends an agent offer tied to this run with no user", async () => {
    const out = (await creatorOfferTool.execute(ctx(), offerInput)) as { offered: boolean; note: string };
    expect(out.offered).toBe(true);
    expect(out.note).toContain("$55.00");
    expect(m.createCreatorOffer).toHaveBeenCalledWith({
      tenant_id: TENANT,
      human_member_id: MEMBER,
      proposed_by: "tenant",
      proposed_by_user_id: null,
      agent_run_id: RUN,
      kind: "ugc_video",
      terms: { title: offerInput.title, description: offerInput.description },
      price_cents: 5000,
      delivery_days: 7,
      product_needed: false,
    });
  });
});

describe("agent creator outreach daily cap (20 messages + offers per workspace per UTC day)", () => {
  const todayStart = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  const today = new Date(todayStart.getTime() + 1000).toISOString();
  const yesterday = new Date(todayStart.getTime() - 60_000).toISOString();
  const agentMsg = (tenant_id = TENANT, created_at = today) => ({
    table: "creator_thread_messages",
    tenant_id,
    sender_kind: "tenant",
    sender_user_id: null,
    created_at,
  });
  const agentOffer = (tenant_id = TENANT, created_at = today) => ({
    table: "creator_offers",
    tenant_id,
    agent_run_id: RUN,
    created_at,
  });
  const seed = (rows: Array<Record<string, unknown>>) => m.outreachRows.push(...rows);
  const many = <T>(n: number, f: () => T) => Array.from({ length: n }, f);

  it.each([
    ["creator_message", creatorMessageTool, messageInput],
    ["creator_offer", creatorOfferTool, offerInput],
  ] as const)("%s: the 20th of the day is sent", async (_n, tool, input) => {
    seed([...many(12, () => agentMsg()), ...many(7, () => agentOffer())]);
    await expect(tool.execute(ctx(), input)).resolves.toBeTruthy();
    expect(m.postCreatorThreadMessage.mock.calls.length + m.createCreatorOffer.mock.calls.length).toBe(1);
  });

  it.each([
    ["creator_message", creatorMessageTool, messageInput],
    ["creator_offer", creatorOfferTool, offerInput],
  ] as const)("%s: the 21st is refused with a plain message and nothing is sent", async (_n, tool, input) => {
    seed([...many(13, () => agentMsg()), ...many(7, () => agentOffer())]);
    await expect(tool.execute(ctx(), input)).rejects.toMatchObject({
      code: "creator_outreach_daily_cap",
      message: "Daily limit of 20 creator messages and offers reached; try again tomorrow. Nothing was sent.",
    });
    expectNothingWritten();
  });

  it("the facade relays the refusal as a tool error", async () => {
    seed(many(20, () => agentMsg()));
    const out = await callCreatorTool({ tenant_id: TENANT, run_id: RUN }, "message", messageInput);
    expect(out.is_error).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: "creator_outreach_daily_cap" });
    expect(m.postCreatorThreadMessage).not.toHaveBeenCalled();
  });

  it("does not count the founder's own messages, creator replies, founder offers, yesterday, or another workspace", async () => {
    seed([
      ...many(19, () => agentMsg()),
      ...many(10, () => ({ ...agentMsg(), sender_user_id: "55555555-5555-5555-5555-555555555555" })),
      ...many(10, () => ({ ...agentMsg(), sender_kind: "creator" })),
      ...many(10, () => ({ ...agentOffer(), agent_run_id: null })),
      ...many(10, () => agentMsg(TENANT, yesterday)),
      ...many(10, () => agentOffer(TENANT, yesterday)),
      ...many(30, () => agentMsg(OTHER_TENANT)),
      ...many(30, () => agentOffer(OTHER_TENANT)),
    ]);
    await creatorMessageTool.execute(ctx(), messageInput);
    expect(m.postCreatorThreadMessage).toHaveBeenCalledTimes(1);
  });

  it("refuses rather than sends when the count cannot be read", async () => {
    m.countError = { message: "timeout" };
    await expect(creatorMessageTool.execute(ctx(), messageInput)).rejects.toThrow(/count failed/);
    expectNothingWritten();
  });

  it("refuses rather than falls back to 20 when the cap override cannot be read", async () => {
    m.systemConfig
      .mockResolvedValueOnce({ data: { blob: { creator_hires_enabled: true } }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "timeout" } });
    await expect(creatorMessageTool.execute(ctx(), messageInput)).rejects.toThrow(/system_config read failed/);
    expectNothingWritten();
  });

  it("staff can lower the cap with system_config.blob.creator_outreach_daily_cap", async () => {
    m.systemConfig.mockResolvedValue({ data: { blob: { creator_hires_enabled: true, creator_outreach_daily_cap: 2 } }, error: null });
    seed(many(2, () => agentOffer()));
    await expect(creatorMessageTool.execute(ctx(), messageInput)).rejects.toMatchObject({
      code: "creator_outreach_daily_cap",
      message: expect.stringContaining("Daily limit of 2 "),
    });
  });

  it("a retried offer from the same run is still returned at the cap, since nothing new is sent", async () => {
    seed(many(20, () => agentOffer()));
    m.runOffer.mockResolvedValue({ data: { id: "offer-earlier", price_cents: 4000 }, error: null });
    const out = (await creatorOfferTool.execute(ctx(), offerInput)) as { already_sent: boolean };
    expect(out.already_sent).toBe(true);
    expect(m.createCreatorOffer).not.toHaveBeenCalled();
  });
});

describe("creator_book_package", () => {
  it("refuses with no caps before any order or card is created", async () => {
    m.latestCreatorCaps.mockResolvedValue(null);
    await expect(creatorBookPackageTool.execute(ctx(), bookInput)).rejects.toMatchObject({ code: "creator_no_caps" });
    expect(m.startCreatorCheckout).not.toHaveBeenCalled();
    expect(m.fileCreatorHireCard).not.toHaveBeenCalled();
  });

  it("refuses over the per-hire cap before any order or card is created", async () => {
    m.latestCreatorCaps.mockResolvedValue({ id: "caps-1", per_hire_usd: 54.99, per_week_usd: 200 });
    await expect(creatorBookPackageTool.execute(ctx(), bookInput)).rejects.toMatchObject({ code: "creator_over_hire_cap" });
    expect(m.startCreatorCheckout).not.toHaveBeenCalled();
    expect(m.fileCreatorHireCard).not.toHaveBeenCalled();
  });

  it("refuses a blocked package before reading caps", async () => {
    m.quoteCreatorBooking.mockResolvedValue({ ...quote, blocked: { code: "package_inactive", message: "That package is no longer offered." } });
    await expect(creatorBookPackageTool.execute(ctx(), bookInput)).rejects.toMatchObject({ code: "package_inactive" });
    expect(m.startCreatorCheckout).not.toHaveBeenCalled();
  });

  it("places an agent order with no checkout session, then files the hire card for the order's own numbers", async () => {
    const out = (await creatorBookPackageTool.execute(ctx(), bookInput)) as { filed: boolean; action_id: string; note: string };
    expect(m.startCreatorCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT,
        user_id: null,
        initiator: "agent",
        agent_run_id: RUN,
        target: { source: "booking", package_id: PACKAGE },
      }),
    );
    const args = m.startCreatorCheckout.mock.calls[0][0];
    expect(args.success_url).toBeUndefined();
    expect(args.large_amount_confirmed).toBeUndefined();
    expect(m.fileCreatorHireCard).toHaveBeenCalledWith({
      tenant_id: TENANT,
      run_id: RUN,
      order_id: "order-1",
      creator_name: "Maya",
      package_title: "1 UGC video",
      business_total_cents: 5500,
      price_cents: 5000,
      fee_cents: 500,
    });
    expect(m.declineCreatorHire).not.toHaveBeenCalled();
    expect(out).toMatchObject({ filed: true, action_id: "card-1" });
    expect(out.note).toBe("Filed a hire card for $55.00 ($50.00 + $5.00 Zavi fee) to book Maya; the founder approves it. Nothing is charged until then.");
  });

  it("declines the order when the card is refused", async () => {
    m.fileCreatorHireCard.mockResolvedValue({ ok: false, refusal: "over_hire_cap", message: "Over the $50.00 per-hire cap." });
    await expect(creatorBookPackageTool.execute(ctx(), bookInput)).rejects.toMatchObject({ code: "creator_over_hire_cap" });
    expect(m.declineCreatorHire).toHaveBeenCalledWith({ tenant_id: TENANT, order_id: "order-1", reason: "Over the $50.00 per-hire cap." });
  });

  it("declines the order when filing the card throws, and does not swallow the error", async () => {
    m.fileCreatorHireCard.mockRejectedValue(new Error("db down"));
    await expect(creatorBookPackageTool.execute(ctx(), bookInput)).rejects.toThrow("db down");
    expect(m.declineCreatorHire).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, order_id: "order-1" }));
  });
});

describe("wiring", () => {
  it("registers the three tools and advertises them as creator__message / creator__offer / creator__book_package", () => {
    expect(byName("creator_message")).toBe(creatorMessageTool);
    expect(byName("creator_offer")).toBe(creatorOfferTool);
    expect(byName("creator_book_package")).toBe(creatorBookPackageTool);
    expect(listCreatorTools().map((t) => `${t.server_id}__${t.tool_name}`)).toEqual([
      "creator__message",
      "creator__offer",
      "creator__book_package",
    ]);
  });

  it("the facade turns a refusal into a tool error the model can read, with the tenant from context", async () => {
    m.latestCreatorCaps.mockResolvedValue(null);
    const out = await callCreatorTool({ tenant_id: TENANT, run_id: RUN }, "book_package", { ...bookInput, tenant_id: OTHER_TENANT });
    expect(out.is_error).toBe(true);
    expect(JSON.parse(out.content).error).toBe("creator_no_caps");
    expect(m.quoteCreatorBooking).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT }));
    expect(m.startCreatorCheckout).not.toHaveBeenCalled();
  });
});
