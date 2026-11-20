import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";
import { sendgridKeyDigest } from "@/services/connectors/email-campaign/credential";
import { BRIGHTLOOP_KEY, fakeSendgrid } from "@/services/connectors/email-campaign/__tests__/fake-sendgrid";
import { makeProposeCampaignTool, LIVE_PROPOSE_CAMPAIGN_DEPS, type ProposeCampaignDeps } from "@/services/tools/email/propose_campaign";

type Row = Record<string, unknown> & { id: string; tenant_id: string };

const db: { channel_actions: Row[]; channel_action_events: Row[]; decisions: Row[] } = { channel_actions: [], channel_action_events: [], decisions: [] };
const hooks: { afterReplaceRpc?: () => void; beforeReplaceRpc?: () => void } = {};
const rpcCalls: string[] = [];

function openCa(r: Row): boolean {
  return (r.status === "pending" || r.status === "snoozed") && r.exec_status == null && r.approved_by == null;
}

function replaceEmailCard(args: { p_tenant_id: string; p_rail: string; p_id: string; p_new_rail: string; p_new_id: string }) {
  const table = args.p_rail === "channel_actions" ? db.channel_actions : db.decisions;
  const c = table.find((r) => r.id === args.p_id && r.tenant_id === args.p_tenant_id);
  if (!c) return { ok: false, code: "not_found" };
  const ptr = { replaced_by: { rail: args.p_new_rail, id: args.p_new_id } };
  if (args.p_rail === "channel_actions") {
    if (!openCa(c)) return { ok: true, replaced: false, status: (c.exec_status as string | null) ?? c.status };
    Object.assign(c, { status: "rejected", note: "replaced_by_newer_draft", exec_payload: { ...(c.exec_payload as object), ...ptr } });
    return { ok: true, replaced: true };
  }
  if (!(c.status === "proposed" && c.approved_by == null)) return { ok: true, replaced: false, status: c.status };
  Object.assign(c, { status: "rejected", body: { ...(c.body as object), ...ptr } });
  return { ok: true, replaced: true };
}

function field(r: Row, k: string): unknown {
  const [col, key] = k.split("->>");
  return key === undefined ? r[col] : (r[col] as Record<string, unknown> | null | undefined)?.[key];
}

function query(table: keyof typeof db) {
  const filters: Array<(r: Row) => boolean> = [];
  const rows = () => db[table].filter((r) => filters.every((f) => f(r)));
  const q = {
    select: () => q,
    eq: (k: string, v: unknown) => {
      filters.push((r) => field(r, k) === v);
      return q;
    },
    in: (k: string, vs: unknown[]) => {
      filters.push((r) => vs.includes(field(r, k)));
      return q;
    },
    is: (k: string, v: null) => {
      filters.push((r) => (field(r, k) ?? null) === v);
      return q;
    },
    maybeSingle: async () => ({ data: rows()[0] ? { ...rows()[0] } : null, error: null }),
    limit: async (n: number) => ({ data: rows().slice(0, n), error: null }),
  };
  return q;
}

vi.mock("@/services/tenant-client", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    tenantRpc: async (tenantId: string, name: string, args: Record<string, string>) => {
      rpcCalls.push(name);
      if (name !== "replace_email_card") throw new Error(`unexpected rpc ${name}`);
      hooks.beforeReplaceRpc?.();
      const data = replaceEmailCard({ ...args, p_tenant_id: tenantId } as Parameters<typeof replaceEmailCard>[0]);
      hooks.afterReplaceRpc?.();
      return { data, error: null };
    },
    tenantClient: () => ({ from: (t: keyof typeof db) => query(t) }),
  };
});

type Deps = ProposeCampaignDeps;

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";
const DIGEST = sendgridKeyDigest(BRIGHTLOOP_KEY);
const SG_LIST = "6a1f0c2e-0000-4000-8000-00000000b001";
const TENANT = "tenant-brightloop";
const OLD = "520672b6-0000-4000-8000-000000000001";
const NEW = "9f1efc8f-0000-4000-8000-000000000002";
const OTHER = "77777777-0000-4000-8000-000000000003";

function deps(): Partial<Deps> {
  const sg = fakeSendgrid();
  return {
    resolveTool: (async () => ({ tool: "sendgrid", sendgrid: { api_key: BRIGHTLOOP_KEY, key_digest: DIGEST } })) as unknown as Deps["resolveTool"],
    callFor: () => sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch),
    template: async () => ({ logo_url: null, brand_color: "#1a73e8", button_color: "#0b8043", font_key: "system", sign_off: "Thanks", postal_address: "12 Harbor Way, Portland OR 97201", show_cards: false }),
    company: async () => ({ name: "Brightloop", website: "https://www.brightloop.test" }),
    testLists: async () => new Set<string>(),
    setting: async () => null,
    railOf: async () => "channel_actions",
    replaceCard: LIVE_PROPOSE_CAMPAIGN_DEPS.replaceCard,
    redraftPlan: async () => null,
    now: () => new Date("2026-10-11T12:00:00Z"),
    reserveCard: async () => ({ ok: true as const, id: "res-1" }),
    releaseCard: async () => {},
    settleCard: async () => {},
    learningsRead: async () => null,
  };
}

function oldCard(over: Partial<Row> = {}): Row {
  const r: Row = { id: OLD, tenant_id: TENANT, status: "pending", exec_status: null, approved_by: null, exec_payload: { list_id: SG_LIST }, ...over };
  db.channel_actions.push(r);
  return r;
}

function cardWriter(opts: { during?: () => void } = {}) {
  return vi.fn(async () => {
    const old = db.channel_actions.find((r) => r.id === OLD);
    db.channel_actions.push({ id: NEW, tenant_id: TENANT, status: "pending", exec_status: null, approved_by: null, exec_payload: {}, repeat_of: old && openCa(old) ? OLD : null });
    if (old && openCa(old)) {
      Object.assign(old, { status: "stale", note: "Replaced by a newer version: Spring sale" });
      db.channel_action_events.push({ id: `ev-${db.channel_action_events.length}`, tenant_id: TENANT, action_id: OLD, event: "stale_flagged", event_key: `replaced:${NEW}` });
    }
    opts.during?.();
    return NEW;
  });
}

const v = { subject: "S", preview_text: "P", title: "T", paragraphs: ["x"], button: { label: "Go", url: "https://brightloop.test/x" } };
const run = (emit: unknown) =>
  makeProposeCampaignTool(deps()).execute({ tenant_id: TENANT, log: () => {}, emit_decision: emit } as never, {
    route: "sendgrid",
    audience_id: SG_LIST,
    variants: [v],
    replaces: { rail: "channel_actions", id: OLD },
    changes: ["subject", "preview_text", "title", "paragraphs", "button"],
  }) as Promise<{ replaced_previous: boolean; note: string; action_id: string }>;

const DECIDED = /already decided/;

beforeEach(() => {
  db.channel_actions = [];
  db.channel_action_events = [];
  db.decisions = [];
  rpcCalls.length = 0;
  delete hooks.afterReplaceRpc;
  delete hooks.beforeReplaceRpc;
});

describe("redraft note after the card writer already staled the old card", () => {
  it("old card staled by this same write: no 'already decided' note, the founder is told the old draft is closed", async () => {
    oldCard();
    const out = await run(cardWriter());
    expect(rpcCalls).toEqual(["replace_email_card"]);
    expect(db.channel_actions.find((r) => r.id === OLD)).toMatchObject({ status: "stale" });
    expect(out.note).not.toMatch(DECIDED);
    expect(out.note).toMatch(/The previous draft is closed\./);
    expect(out.replaced_previous).toBe(true);
  });

  it("old card staled earlier by a different newer card: not called decided, and not claimed closed by this one", async () => {
    oldCard({ status: "stale", note: "Replaced by a newer version: x" });
    db.channel_action_events.push({ id: "ev-x", tenant_id: TENANT, action_id: OLD, event: "stale_flagged", event_key: `replaced:${OTHER}` });
    const out = await run(cardWriter());
    expect(out.note).not.toMatch(DECIDED);
    expect(out.note).not.toMatch(/The previous draft is closed\./);
    expect(out.note).toMatch(/already closed, and no other draft for this list is open/);
    expect(out.replaced_previous).toBe(false);
  });

  it("a replayed replace (old card already rejected pointing at this new card) is not called decided", async () => {
    oldCard({ status: "rejected", note: "replaced_by_newer_draft", exec_payload: { replaced_by: { rail: "channel_actions", id: NEW } } });
    const out = await run(cardWriter());
    expect(out.note).not.toMatch(DECIDED);
    expect(out.replaced_previous).toBe(true);
  });

  it("old card still open (writer did not stale it): replace closes it", async () => {
    oldCard();
    const out = await run(vi.fn(async () => {
      db.channel_actions.push({ id: NEW, tenant_id: TENANT, status: "pending", exec_status: null, approved_by: null, exec_payload: {} });
      return NEW;
    }));
    expect(db.channel_actions.find((r) => r.id === OLD)).toMatchObject({ status: "rejected", exec_payload: { replaced_by: { id: NEW } } });
    expect(out).toMatchObject({ replaced_previous: true });
    expect(out.note).not.toMatch(DECIDED);
  });
});

describe("a truly decided old card still gets the warning", () => {
  it.each([
    ["approved and queued", { status: "pending", exec_status: "queued", approved_by: "u-founder" }],
    ["sent", { status: "done", exec_status: "succeeded", approved_by: "u-founder" }],
    ["rejected by the founder", { status: "rejected", note: "not now" }],
  ])("%s", async (_label, state) => {
    oldCard(state as Partial<Row>);
    const out = await run(cardWriter());
    expect(db.channel_action_events.filter((e) => e.action_id === OLD)).toHaveLength(0);
    expect(out.note).toMatch(DECIDED);
    expect(out.replaced_previous).toBe(false);
  });

  it("decisions rail: an approved zavi-list card still warns", async () => {
    db.decisions.push({ id: OLD, tenant_id: TENANT, status: "approved", approved_by: "u-founder", body: {} });
    const d = deps();
    const out = (await makeProposeCampaignTool({ ...d, railOf: async () => "channel_actions" }).execute(
      { tenant_id: TENANT, log: () => {}, emit_decision: cardWriter() } as never,
      { route: "sendgrid", audience_id: SG_LIST, variants: [v], replaces: { rail: "decisions", id: OLD }, changes: ["subject", "preview_text", "title", "paragraphs", "button"] },
    )) as { note: string; replaced_previous: boolean };
    expect(out.note).toMatch(DECIDED);
    expect(out.replaced_previous).toBe(false);
  });

  it("race: the writer stales the old card, then an approval lands on it before replace runs: still warns", async () => {
    oldCard();
    hooks.beforeReplaceRpc = () => Object.assign(db.channel_actions.find((r) => r.id === OLD)!, { status: "pending", exec_status: "queued", approved_by: "u-founder" });
    const out = await run(cardWriter());
    expect(db.channel_action_events.some((e) => e.action_id === OLD && e.event_key === `replaced:${NEW}`)).toBe(true);
    expect(out.note).toMatch(DECIDED);
    expect(out.replaced_previous).toBe(false);
  });

  it("race: replace sees it stale, then an approval lands before the re-read: still warns", async () => {
    oldCard();
    hooks.afterReplaceRpc = () => Object.assign(db.channel_actions.find((r) => r.id === OLD)!, { status: "pending", exec_status: "queued", approved_by: "u-founder" });
    const out = await run(cardWriter());
    expect(out.note).toMatch(DECIDED);
    expect(out.replaced_previous).toBe(false);
  });
});

describe("a chat redo names a stale closed channel card while the open card for the same campaign sits on the decisions rail (81c0-82fb)", () => {
  const OPEN_DEC = "4eab95e7-0000-4000-8000-000000000004";
  const SECOND_DEC = "4eab95e7-0000-4000-8000-000000000005";
  const FRESH = "d91cf574-0000-4000-8000-000000000006";
  const target = { tool: "sendgrid", audience_id: SG_LIST };
  const FALSE_CLOSE = /closed by (another|a) newer version|was already closed, and no other draft/;

  function staleChannelRow() {
    db.channel_actions.push({
      id: OLD,
      tenant_id: TENANT,
      exec_class: "email_campaign.create_and_send",
      status: "stale",
      note: "Replaced by a newer version: Spring sale",
      exec_status: null,
      approved_by: null,
      exec_payload: { ...target },
    });
  }

  function decisionCard(id: string, over: Partial<Row> = {}): Row {
    const r: Row = { id, tenant_id: TENANT, decision_class: "email_campaign.create_and_send", status: "proposed", approved_by: null, body: { ...target }, ...over };
    db.decisions.push(r);
    return r;
  }

  const decisionWriter = () =>
    vi.fn(async (cls: string, body: Record<string, unknown>) => {
      db.decisions.push({ id: FRESH, tenant_id: TENANT, decision_class: cls, status: "proposed", approved_by: null, body });
      return FRESH;
    });

  const redo = (replaces: { rail: "channel_actions" | "decisions"; id: string }) =>
    makeProposeCampaignTool({ ...deps(), railOf: async () => "decisions" }).execute(
      { tenant_id: TENANT, log: () => {}, emit_decision: decisionWriter() } as never,
      { route: "sendgrid", audience_id: SG_LIST, variants: [v], replaces, changes: ["subject", "preview_text", "title", "paragraphs", "button"] },
    ) as Promise<{ replaced_previous: boolean; note: string; card: { rail: string; id: string } }>;

  const openForList = () =>
    db.decisions.filter((r) => r.status === "proposed" && r.approved_by == null && (r.body as { audience_id?: string }).audience_id === SG_LIST).map((r) => r.id);

  it("supersedes the open decision-rail card, leaves the stale row alone, and does not claim a false close", async () => {
    staleChannelRow();
    decisionCard(OPEN_DEC);
    const out = await redo({ rail: "channel_actions", id: OLD });
    expect(out.card).toEqual({ rail: "decisions", id: FRESH });
    expect(db.decisions.find((r) => r.id === OPEN_DEC)).toMatchObject({ status: "rejected", body: { replaced_by: { rail: "decisions", id: FRESH } } });
    expect(db.channel_actions.find((r) => r.id === OLD)).toMatchObject({ status: "stale" });
    expect(openForList()).toEqual([FRESH]);
    expect(out.replaced_previous).toBe(true);
    expect(out.note).not.toMatch(FALSE_CLOSE);
    expect(out.note).toMatch(/closed the draft for this list that was still open/);
    expect(rpcCalls).toEqual(["replace_email_card", "replace_email_card"]);
  });

  it("a ref with the wrong rail (decision id named as a channel card) still closes the open decision card", async () => {
    decisionCard(OPEN_DEC);
    const out = await redo({ rail: "channel_actions", id: OPEN_DEC });
    expect(db.decisions.find((r) => r.id === OPEN_DEC)).toMatchObject({ status: "rejected" });
    expect(openForList()).toEqual([FRESH]);
    expect(out.replaced_previous).toBe(true);
    expect(out.note).not.toMatch(/not found/);
  });

  it("two open cards for the list: closes neither and says so instead of claiming a close", async () => {
    staleChannelRow();
    decisionCard(OPEN_DEC);
    decisionCard(SECOND_DEC);
    const out = await redo({ rail: "channel_actions", id: OLD });
    expect(openForList().sort()).toEqual([OPEN_DEC, SECOND_DEC, FRESH].sort());
    expect(out.replaced_previous).toBe(false);
    expect(out.note).not.toMatch(FALSE_CLOSE);
    expect(out.note).toMatch(/2 other drafts for this list are still open, so none of them was closed/);
  });

  it.each([
    ["approved", { approved_by: "u-founder" }],
    ["planned", { body: { ...target, planned_send_id: "item-1" } }],
    ["for another list", { body: { tool: "sendgrid", audience_id: "other-list" } }],
    ["already sent", { status: "acted", approved_by: "u-founder" }],
  ])("an %s decision card is never closed by the fallback", async (_label, over) => {
    staleChannelRow();
    const kept = decisionCard(OPEN_DEC, over as Partial<Row>);
    const before = JSON.stringify(kept);
    const out = await redo({ rail: "channel_actions", id: OLD });
    expect(JSON.stringify(db.decisions.find((r) => r.id === OPEN_DEC))).toBe(before);
    expect(out.replaced_previous).toBe(false);
    expect(out.note).toMatch(/already closed, and no other draft for this list is open/);
  });

  it("the open card gets approved between the lookup and the replace: not closed, not claimed closed", async () => {
    staleChannelRow();
    const card = decisionCard(OPEN_DEC);
    let n = 0;
    hooks.beforeReplaceRpc = () => {
      if (++n === 2) Object.assign(card, { approved_by: "u-founder", status: "approved" });
    };
    const out = await redo({ rail: "channel_actions", id: OLD });
    expect(card).toMatchObject({ status: "approved", approved_by: "u-founder" });
    expect(out.replaced_previous).toBe(false);
    expect(out.note).not.toMatch(/The previous draft is closed|closed the draft for this list/);
  });
});
