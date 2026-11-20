import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeKlaviyo, fakeMailchimp, type FakeTool } from "@/services/connectors/email-campaign/__tests__/fake-tools";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), exec: vi.fn(), record: vi.fn(), switched: vi.fn(), sendgrid: vi.fn(), rpc: vi.fn(), sent: [] as unknown[] }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: mocks.resolve }));
vi.mock("@/services/connectors/email-campaign/sendgrid-account", () => ({ resolveSendgridAccount: mocks.sendgrid }));
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: mocks.exec }));
vi.mock("@/services/channels/exec-actions", () => ({ recordChannelExecAction: mocks.record }));
vi.mock("@/services/channels/channel-actions", () => ({ switchedChannelForRun: mocks.switched }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: mocks.rpc,
  tenantClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const k of ["select", "eq", "order"]) q[k] = () => q;
      q.limit = async () => ({ data: mocks.sent, error: null });
      return q;
    },
  }),
}));

import { emailCampaignListAudiencesTool } from "../list_audiences";
import { emailCampaignProposeSendTool } from "../propose_send";
import { buildEmailSendCardBody, resolveEmailCampaignEmit } from "../_exec-action";
import { emailSendBodySchema } from "@/services/connectors/email-campaign/execute-send";
import { resolveEmailTool, soleEmailTool } from "@/services/connectors/email-campaign/account";
import { ExpectedToolError } from "@/services/tools/types";

let mc: FakeTool;
let kv: FakeTool;
let connected: Record<string, { tenant_id: string; toolkit: string; connected_account_id: string; auth_config_id: string } | null>;
const acct = (tenant: string, tool: string) => ({ tenant_id: tenant, toolkit: tool, connected_account_id: `ca-${tenant}-${tool}`, auth_config_id: `ac-${tool}` });
const input = (over: Record<string, unknown> = {}) => ({ audience_id: "L1", subject: "Spring offer", body_text: "Hello", ...over });
const code = async (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof ExpectedToolError ? e.code : `threw:${(e as Error).message}`));

beforeEach(() => {
  for (const m of [mocks.resolve, mocks.exec, mocks.record, mocks.switched]) m.mockReset();
  mocks.sendgrid.mockReset().mockResolvedValue(null);
  mocks.rpc.mockReset().mockResolvedValue({ data: { fields: {} }, error: null });
  mocks.sent = [];
  mc = fakeMailchimp();
  kv = fakeKlaviyo();
  connected = { mailchimp: acct("t1", "mailchimp"), klaviyo: null };
  mocks.resolve.mockImplementation(async (tenant: string, tool: string) => (tenant === "t1" ? connected[tool] ?? null : null));
  mocks.exec.mockImplementation(async (c: Parameters<FakeTool["exec"]>[0]) => (c.tool_slug.startsWith("MAILCHIMP_") ? mc : kv).exec(c));
  mocks.record.mockResolvedValue({ id: "card-1", replayed: false });
});

describe("email_campaign_list_audiences", () => {
  it("lists the connected tool's lists with their sizes", async () => {
    const out = await emailCampaignListAudiencesTool.execute({ tenant_id: "t1" } as never, {});
    expect(out).toMatchObject({ tool: "mailchimp", audiences: [{ id: "L1", name: "Newsletter", member_count: 412, marked_test: false }] });
  });

  it("no tool connected: the agent is told to write a draft", async () => {
    connected = { mailchimp: null, klaviyo: null };
    await expect(emailCampaignListAudiencesTool.execute({ tenant_id: "t1" } as never, {})).rejects.toMatchObject({ code: "email_tool_not_connected", message: expect.stringContaining("draft") });
    expect(mocks.exec).not.toHaveBeenCalled();
  });
});

describe("email_campaign_list_audiences reads every page", () => {
  const listPage = (ids: string[], next: string | null) => ({
    ok: true, status: 200, error: null, outcome_unknown: false,
    data: { data: ids.map((id) => ({ type: "list", id, attributes: { name: `List ${id}` } })), links: { next: next ? `https://a.klaviyo.com/api/lists?page%5Bcursor%5D=${next}` : null } },
  });

  it("Klaviyo: follows links.next to the last page", async () => {
    connected = { mailchimp: null, klaviyo: acct("t1", "klaviyo") };
    const cursors: unknown[] = [];
    mocks.exec.mockImplementation(async (c: { tool_slug: string; arguments: Record<string, unknown> }) => {
      if (c.tool_slug !== "KLAVIYO_GET_LISTS") return kv.exec(c as never);
      cursors.push(c.arguments.page_cursor ?? null);
      return c.arguments.page_cursor === "B" ? listPage(["L3"], null) : listPage(["L1", "L2"], "B");
    });
    const out = (await emailCampaignListAudiencesTool.execute({ tenant_id: "t1" } as never, { tool: "klaviyo" })) as { audiences: Array<{ id: string }>; note?: string };
    expect(out.audiences.map((a) => a.id)).toEqual(["L1", "L2", "L3"]);
    expect(cursors).toEqual([null, "B"]);
    expect(out.note).toBeUndefined();
  });

  it("a tool that answers the same page again: stops, and says the list may be incomplete", async () => {
    connected = { mailchimp: null, klaviyo: acct("t1", "klaviyo") };
    let n = 0;
    const slugs: string[] = [];
    mocks.exec.mockImplementation(async (c: { tool_slug: string; arguments: Record<string, unknown> }) => {
      slugs.push(c.tool_slug);
      n += 1;
      return listPage([`L${n}`], "SAME");
    });
    const out = (await emailCampaignListAudiencesTool.execute({ tenant_id: "t1" } as never, { tool: "klaviyo" })) as { audiences: unknown[]; note?: string };
    expect(n).toBe(2);
    expect(slugs).toEqual(["KLAVIYO_GET_LISTS", "KLAVIYO_GET_LISTS"]);
    expect(out.audiences).toHaveLength(2);
    expect(out.note).toMatch(/same page/);
  });

  it("the description names SendGrid and Zavi's own lists", () => {
    expect(emailCampaignListAudiencesTool.description).toMatch(/SendGrid/);
    expect(emailCampaignListAudiencesTool.description).toMatch(/outbound__list_email_lists/);
  });
});

describe("email_campaign_propose_send", () => {
  it("seals the tool, the connection, the list and the content the founder approves", async () => {
    const emit = vi.fn(async () => "act-1");
    const out = await emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input({ preview_text: "Two weeks only" }));
    expect(out).toMatchObject({ action_id: "act-1", status: "waiting_for_founder", tool: "mailchimp" });
    const [cls, body] = emit.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(cls).toBe("email_campaign.create_and_send");
    expect(body).toMatchObject({
      tool: "mailchimp",
      connected_account_id: "ca-t1-mailchimp",
      auth_config_id: "ac-mailchimp",
      audience_id: "L1",
      audience_name: "Newsletter",
      audience_count: 412,
      subject: "Spring offer",
      preview_text: "Two weeks only",
    });
    expect(emailSendBodySchema.safeParse(body).success).toBe(true);
    expect(mc.count("MAILCHIMP_ADD_CAMPAIGN")).toBe(0);
  });

  it("a rationale within the limit is stored as written; an over-long one is cut at a word; a blank one is none", async () => {
    const run = async (rationale: string) => {
      const emit = vi.fn(async () => "act-1");
      const args = emailCampaignProposeSendTool.input_schema.parse(input({ rationale }));
      await emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, args);
      return ((emit.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]).rationale;
    };
    expect(await run(" Why now:\n  the list asked for it. ")).toBe(" Why now:\n  the list asked for it. ");
    const cut = (await run("word ".repeat(200))) as string;
    expect(cut.length).toBeLessThanOrEqual(500);
    expect(cut.endsWith("…")).toBe(true);
    expect(await run("   ")).toBeNull();
  });

  it("has no recipient field: an address in the input is refused by the schema", () => {
    const parsed = emailCampaignProposeSendTool.input_schema.safeParse(input({ to: "someone@example.com", recipients: ["a@b.c"] }));
    expect(parsed.success && Object.keys(parsed.data as object)).not.toContain("to");
    expect(parsed.success && Object.keys(parsed.data as object)).not.toContain("recipients");
  });

  it("both tools connected and none named: refused, naming both, nothing proposed", async () => {
    connected.klaviyo = acct("t1", "klaviyo");
    const emit = vi.fn(async () => "x");
    const p = emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input());
    await expect(p).rejects.toMatchObject({ code: "email_tool_ambiguous", message: expect.stringMatching(/Mailchimp and Klaviyo/) });
    expect(emit).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("both connected, the same list id in each: naming Klaviyo seals Klaviyo's connection and its list", async () => {
    connected.klaviyo = acct("t1", "klaviyo");
    const emit = vi.fn(async () => "act-2");
    await emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input({ tool: "klaviyo" }));
    expect((emit.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]).toMatchObject({ tool: "klaviyo", connected_account_id: "ca-t1-klaviyo", audience_name: "Customers" });
    expect(mc.calls).toEqual([]);
  });

  it("the named tool is not connected: refused by name", async () => {
    const emit = vi.fn(async () => "x");
    await expect(emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input({ tool: "klaviyo" }))).rejects.toMatchObject({
      code: "email_tool_not_connected",
      message: expect.stringContaining("Klaviyo"),
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("a list that is not in the tenant's own account is refused", async () => {
    const emit = vi.fn(async () => "x");
    expect(await code(emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input({ audience_id: "someone-elses" })))).toBe("email_audience_missing");
    expect(emit).not.toHaveBeenCalled();
  });

  it("Klaviyo: the account's default sender name and address are sealed and shown", async () => {
    connected.klaviyo = acct("t1", "klaviyo");
    const emit = vi.fn(async () => "act-k");
    await emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input({ tool: "klaviyo" }));
    expect((emit.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]).toMatchObject({ from_name: "Acme Shop", from_email: "hello@acme.test" });
  });

  it("no default sender address: nothing is proposed until the agent names one", async () => {
    connected = { mailchimp: null, klaviyo: acct("t1", "klaviyo") };
    kv.noDefaultSender = true;
    const emit = vi.fn(async () => "act-k");
    expect(await code(emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input()))).toBe("email_sender_unknown");
    expect(await code(emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input({ from_name: "Ana" })))).toBe("email_sender_unknown");
    expect(await code(emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input({ from_name: "Ana", from_email: "not an address" })))).toBe("email_sender_unknown");
    expect(emit).not.toHaveBeenCalled();
    await emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input({ from_name: "Ana", from_email: "Ana@Acme.test" }));
    expect((emit.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]).toMatchObject({ from_name: "Ana", from_email: "ana@acme.test" });
  });

  it("an empty list is refused: there is nobody to send to", async () => {
    mc.lists[0].members = 0;
    expect(await code(emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: vi.fn() } as never, input()))).toBe("email_audience_empty");
  });

  it("another tenant's workspace has no connection, so it can propose nothing against this one's lists", async () => {
    const emit = vi.fn(async () => "x");
    expect(await code(emailCampaignProposeSendTool.execute({ tenant_id: "t2", emit_decision: emit } as never, input()))).toBe("email_tool_not_connected");
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.resolve.mock.calls.every(([tenant]) => tenant === "t2")).toBe(true);
  });
});

describe("where the proposal lands", () => {
  it("on an Email campaigns channel run it becomes an executable card with the email's own rows", async () => {
    mocks.switched.mockResolvedValue("email_marketing");
    const legacy = vi.fn(async () => "decision-1");
    const emit = await resolveEmailCampaignEmit({ tenant_id: "t1", run_id: "run-1", emit_decision: legacy });
    const action = await emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input({ rationale: "Launch week." }));
    expect(action).toMatchObject({ action_id: "card-1" });
    expect(legacy).not.toHaveBeenCalled();
    const arg = mocks.record.mock.calls[0][0] as { execClass: string; execPayload: Record<string, unknown>; actionType: string; channelSlug: string; body: { exact_change: { rows: Array<{ item: string; after: string }> } } };
    expect(arg).toMatchObject({ execClass: "email_campaign.create_and_send", actionType: "send_message", channelSlug: "email_marketing" });
    expect(arg.execPayload).not.toHaveProperty("rationale");
    expect(emailSendBodySchema.safeParse(arg.execPayload).success).toBe(true);
    expect(arg.body.exact_change.rows.map((r) => [r.item, r.after])).toEqual([
      ["Subject", "Spring offer"],
      ["From", "Acme <hi@acme.test>"],
      ["Sending with", "Mailchimp"],
      ["List", "Newsletter"],
    ]);
  });

  it("the card and the executor read the SAME sealed payload: every field the executor uses is on the card", async () => {
    mocks.switched.mockResolvedValue("email_marketing");
    const emit = await resolveEmailCampaignEmit({ tenant_id: "t1", run_id: "run-1", emit_decision: vi.fn() });
    await emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input({ preview_text: "Two weeks only", from_name: "The Team" }));
    const arg = mocks.record.mock.calls[0][0] as { execPayload: Record<string, unknown>; body: { exact_change: { rows: Array<{ item: string; after: string }> }; step: { deliverable: { content: string; label: string } } } };
    const p = arg.execPayload;
    const shown = Object.fromEntries(arg.body.exact_change.rows.map((r) => [r.item, r.after]));
    expect(p).toMatchObject({ from_name: "The Team", from_email: "hi@acme.test", reply_to: null });
    expect(shown).toEqual({ Subject: p.subject, Preview: p.preview_text, From: `${p.from_name} <${p.from_email}>`, "Sending with": "Mailchimp", List: p.audience_name });
    expect(arg.body.step.deliverable.content).toBe(p.body_text);
    expect(Object.keys(p).sort()).toEqual(["audience_count", "audience_id", "audience_name", "auth_config_id", "body_text", "connected_account_id", "from_email", "from_name", "preview_text", "reply_to", "subject", "tool"]);
  });

  it("a proposal carrying a field the card would not show is not filed", async () => {
    mocks.switched.mockResolvedValue("email_marketing");
    const emit = await resolveEmailCampaignEmit({ tenant_id: "t1", run_id: "run-1", emit_decision: vi.fn() });
    const sealed = {
      tool: "mailchimp", connected_account_id: "ca", auth_config_id: "ac", audience_id: "L1", audience_name: "Newsletter", audience_count: 412,
      subject: "Hi", preview_text: null, body_text: "x", from_name: "Acme", from_email: "hi@acme.test", reply_to: null,
    };
    await expect(emit?.("email_campaign.create_and_send", { ...sealed, body_html: "<a href='https://evil.example'>x</a>" })).rejects.toMatchObject({ code: "email_campaign_body_invalid" });
    await expect(emit?.("email_campaign.create_and_send", { ...sealed, segment_id: 7 })).rejects.toMatchObject({ code: "email_campaign_body_invalid" });
    await expect(emit?.("email_campaign.create_and_send", { ...sealed, audience_count: "412" })).rejects.toMatchObject({ code: "email_campaign_body_invalid" });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("must catch: a card carrying what the draft read (\"What we learned\") is filed on a channel run, for every read status", async () => {
    mocks.switched.mockResolvedValue("email_marketing");
    const sealed = {
      tool: "mailchimp", connected_account_id: "ca", auth_config_id: "ac", audience_id: "L1", audience_name: "Newsletter", audience_count: 412,
      subject: "Hi", preview_text: null, body_text: "x", from_name: "Acme", from_email: "hi@acme.test", reply_to: null,
    };
    for (const learnings_read of [
      { status: "ok", items: [{ id: "l1", text: "Emails with a number in the subject got more clicks." }] },
      { status: "empty", items: [] },
      { status: "read_failed", items: [] },
      { status: "snapshot_failed", items: [] },
    ]) {
      mocks.record.mockClear();
      const emit = await resolveEmailCampaignEmit({ tenant_id: "t1", run_id: "run-1", emit_decision: vi.fn() });
      await expect(emit?.("email_campaign.create_and_send", { ...sealed, learnings_read })).resolves.toBe("card-1");
      const arg = mocks.record.mock.calls[0][0] as { execPayload: Record<string, unknown> };
      expect(arg.execPayload.learnings_read).toEqual(learnings_read);
    }
    mocks.record.mockClear();
    const emit = await resolveEmailCampaignEmit({ tenant_id: "t1", run_id: "run-1", emit_decision: vi.fn() });
    await expect(emit?.("email_campaign.create_and_send", { ...sealed, learnings_read: { status: "made_up", items: [] } })).rejects.toMatchObject({ code: "email_campaign_body_invalid" });
    await expect(emit?.("email_campaign.create_and_send", { ...sealed, learnings_read: { status: "ok", items: [{ id: "a", text: "b", html: "<b>" }] } })).rejects.toMatchObject({ code: "email_campaign_body_invalid" });
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `l${i}`, text: "x" }));
    await expect(emit?.("email_campaign.create_and_send", { ...sealed, learnings_read: { status: "ok", items: many } })).rejects.toMatchObject({ code: "email_campaign_body_invalid" });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("the tool has no HTML input: HTML passed to it is dropped before anything is sealed", async () => {
    const emit = vi.fn(async () => "act-9");
    const args = emailCampaignProposeSendTool.input_schema.parse(input({ body_html: "<a href='https://evil.example'>x</a>" }));
    await emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, args);
    expect(JSON.stringify(emit.mock.calls)).not.toContain("evil.example");
  });

  it("in a chat it stays an ordinary decision of the same class", async () => {
    const legacy = vi.fn(async () => "decision-1");
    const emit = await resolveEmailCampaignEmit({ tenant_id: "t1", emit_decision: legacy });
    expect(emit).toBe(legacy);
  });

  it("a shadow or redo run of the channel files nothing", async () => {
    mocks.switched.mockResolvedValue("email_marketing");
    const shadow = await resolveEmailCampaignEmit({ tenant_id: "t1", run_id: "r", writes_suppressed: true, emit_decision: vi.fn() });
    expect(await shadow?.("email_campaign.create_and_send", {})).toBe("channel_action_suppressed");
    const redo = await resolveEmailCampaignEmit({ tenant_id: "t1", run_id: "r", redo: true, emit_decision: vi.fn() });
    await expect(redo?.("email_campaign.create_and_send", {})).rejects.toMatchObject({ code: "redo_scope" });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("the card shows the preview line when there is one, and the email itself", () => {
    const body = emailSendBodySchema.parse({
      tool: "klaviyo", connected_account_id: "ca", auth_config_id: "ac", audience_id: "L1", audience_name: "Customers", audience_count: 1,
      subject: "Hi", preview_text: "A note", body_text: "x", from_name: "Acme", from_email: "hi@acme.test", reply_to: null,
    });
    const { title, card } = buildEmailSendCardBody(body, null);
    expect(title).toBe('Send "Hi" to Customers');
    const c = card as { exact_change: { rows: Array<{ item: string; after: string }> }; step: { deliverable: { content: string }; body: string } };
    expect(c.exact_change.rows.map((r) => [r.item, r.after])).toEqual([["Subject", "Hi"], ["Preview", "A note"], ["From", "Acme <hi@acme.test>"], ["Sending with", "Klaviyo"], ["List", "Customers"]]);
    expect(c.step.deliverable.content).toBe("x");
    expect(c.step.body).not.toMatch(/\d+ (?:person|people)/);
  });
});

describe("SendGrid on the same tools", () => {
  it("proposing seals the key DIGEST (never the key) and files the one email send class", async () => {
    const { fakeSendgrid, BRIGHTLOOP_KEY } = await import("@/services/connectors/email-campaign/__tests__/fake-sendgrid");
    const sg = fakeSendgrid();
    vi.stubGlobal("fetch", sg.fetch);
    try {
      connected = { mailchimp: null, klaviyo: null };
      mocks.sendgrid.mockResolvedValue({ api_key: BRIGHTLOOP_KEY, key_digest: "a".repeat(64) });
      const emit = vi.fn(async () => "act-sg");
      const out = await emailCampaignProposeSendTool.execute(
        { tenant_id: "t1", emit_decision: emit } as never,
        { audience_id: "6a1f0c2e-0000-4000-8000-00000000b001", subject: "New studio hours", body_text: "Hello from Brightloop" },
      );
      expect(out).toMatchObject({ action_id: "act-sg", tool: "sendgrid" });
      const [cls, body] = emit.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(cls).toBe("email_campaign.create_and_send");
      expect(body).toMatchObject({ tool: "sendgrid", credential: { kind: "sendgrid_key", key_digest: "a".repeat(64) }, audience_count: 238, from_email: "hello@brightloop.test", sendgrid_sender_id: "41", sendgrid_suppression_group_id: "7" });
      expect(body).not.toHaveProperty("connected_account_id");
      expect(JSON.stringify(body)).not.toContain("brightloopSecret");
      const { rationale: _r, ...rest } = body;
      expect(emailSendBodySchema.strict().safeParse(rest).success).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("SendGrid and Mailchimp both connected, none named: the send path is refused, naming both", async () => {
    mocks.sendgrid.mockResolvedValue({ api_key: "SG.x.y", key_digest: "b".repeat(64) });
    const emit = vi.fn(async () => "x");
    await expect(emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input())).rejects.toMatchObject({
      code: "email_tool_ambiguous",
      message: expect.stringContaining("SendGrid"),
    });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("email_campaign_list_audiences with several tools connected and none named", () => {
  type Row = { tool: string; id: string; name: string; member_count: number | null };
  type Multi = { tool?: string; audiences: Row[]; unreadable: Array<{ tool: string; message: string }>; notes: Array<{ tool: string; note: string }> };
  const listAll = async (args: Record<string, unknown> = {}) => (await emailCampaignListAudiencesTool.execute({ tenant_id: "t1" } as never, args)) as Multi;
  const slugs = () => mocks.exec.mock.calls.map(([c]) => (c as { tool_slug: string }).tool_slug);

  beforeEach(() => {
    connected.klaviyo = acct("t1", "klaviyo");
    mc.lists = [{ id: "mc1", name: "Newsletter", members: 412 }];
    kv.lists = [{ id: "kv1", name: "Customers", members: 90 }];
  });

  async function withSendgrid(fn: (sg: Awaited<ReturnType<typeof fakeSg>>) => Promise<void>) {
    const sg = await fakeSg();
    vi.stubGlobal("fetch", sg.fetch);
    mocks.sendgrid.mockResolvedValue({ api_key: sg.key, key_digest: "a".repeat(64) });
    try {
      await fn(sg);
    } finally {
      vi.unstubAllGlobals();
    }
  }
  const fakeSg = async () => (await import("@/services/connectors/email-campaign/__tests__/fake-sendgrid")).fakeSendgrid();

  it("returns every tool's lists, each labelled with its tool", async () => {
    const out = await listAll();
    expect(out.tool).toBeUndefined();
    expect(out.unreadable).toEqual([]);
    expect(out.audiences).toEqual([
      expect.objectContaining({ tool: "mailchimp", id: "mc1", name: "Newsletter" }),
      expect.objectContaining({ tool: "klaviyo", id: "kv1", name: "Customers" }),
    ]);
  });

  it("the regression from run 5278c1b6: three connected, every list comes back and none is refused", async () => {
    await withSendgrid(async (sg) => {
      const out = await listAll();
      expect(new Set(out.audiences.map((a) => a.tool))).toEqual(new Set(["mailchimp", "klaviyo", "sendgrid"]));
      expect(out.audiences.filter((a) => a.tool === "sendgrid").map((a) => a.id)).toEqual(sg.lists.map((l) => l.id));
    });
  });

  it.each([
    ["mailchimp", "MAILCHIMP_GET_LISTS_INFO", "kv1", "klaviyo", "Mailchimp"],
    ["klaviyo", "KLAVIYO_GET_LISTS", "mc1", "mailchimp", "Klaviyo"],
  ])("%s's read failing: the other tool's lists still come back and %s is named unreadable", async (bad, slug, goodId, good, label) => {
    (bad === "mailchimp" ? mc : kv).refuse.set(slug, "upstream on fire");
    const out = await listAll();
    expect(out.audiences).toEqual([expect.objectContaining({ tool: good, id: goodId })]);
    expect(out.unreadable).toEqual([{ tool: bad, message: expect.stringMatching(new RegExp(`^${label} could not be read: .*upstream on fire`)) }]);
    expect(JSON.stringify(out.audiences)).not.toContain(bad);
  });

  it("a real SendGrid 500 does not lose Mailchimp and Klaviyo", async () => {
    await withSendgrid(async (sg) => {
      sg.failOnce.set("GET /v3/marketing/lists", 500);
      const out = await listAll();
      expect(out.audiences.map((a) => a.id)).toEqual(["mc1", "kv1"]);
      expect(out.unreadable.map((u) => u.tool)).toEqual(["sendgrid"]);
    });
  });

  it("a failure on a LATER page: that tool is unreadable, not a short list", async () => {
    mocks.exec.mockImplementation(async (c: { tool_slug: string; arguments: Record<string, unknown> }) => {
      if (c.tool_slug === "KLAVIYO_GET_LISTS") {
        if (c.arguments.page_cursor) return { ok: false, status: 503, data: null, error: "page two died", outcome_unknown: false };
        return { ok: true, status: 200, error: null, outcome_unknown: false, data: { data: [{ type: "list", id: "kv1", attributes: { name: "Customers" } }], links: { next: "https://a.klaviyo.com/api/lists?page%5Bcursor%5D=B" } } };
      }
      return mc.exec(c as never);
    });
    const out = await listAll();
    expect(out.audiences.map((a) => a.id)).toEqual(["mc1"]);
    expect(out.unreadable[0]).toMatchObject({ tool: "klaviyo", message: expect.stringContaining("page two died") });
  });

  it("an unexpected throw inside one provider call does not lose the other, and its text stays out of the result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.exec.mockImplementation(async (c: { tool_slug: string }) => {
      if (c.tool_slug.startsWith("KLAVIYO_")) throw new TypeError("internal secret detail");
      return mc.exec(c as never);
    });
    const out = await listAll();
    warn.mockRestore();
    expect(out.audiences.map((a) => a.id)).toEqual(["mc1"]);
    expect(out.unreadable).toEqual([{ tool: "klaviyo", message: "Klaviyo could not be read just now." }]);
  });

  it("a slow tool that fails later does not lose a fast one, and the list order stays fixed", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    mc.refuse.set("MAILCHIMP_GET_LISTS_INFO", "slow death");
    mocks.exec.mockImplementation(async (c: { tool_slug: string }) => {
      if (c.tool_slug.startsWith("MAILCHIMP_")) {
        await gate;
        return mc.exec(c as never);
      }
      const r = await kv.exec(c as never);
      release();
      return r;
    });
    const out = await listAll();
    expect(out.audiences.map((a) => a.id)).toEqual(["kv1"]);
    expect(out.unreadable.map((u) => u.tool)).toEqual(["mailchimp"]);
  });

  it("the connection lookup of one tool throwing does not lose the others, even with one left", async () => {
    mocks.sendgrid.mockRejectedValue(new Error("sendgrid connection read failed: db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    connected.klaviyo = null;
    const out = await listAll();
    warn.mockRestore();
    expect(out.tool).toBeUndefined();
    expect(out.audiences).toEqual([expect.objectContaining({ tool: "mailchimp", id: "mc1" })]);
    expect(out.unreadable).toEqual([{ tool: "sendgrid", message: "SendGrid could not be read just now." }]);
  });

  it("every tool failing is a read failure, never an empty success that reads as no lists", async () => {
    mc.refuse.set("MAILCHIMP_GET_LISTS_INFO", "down one");
    kv.refuse.set("KLAVIYO_GET_LISTS", "down two");
    await expect(listAll()).rejects.toMatchObject({
      code: "email_tool_read_failed",
      message: expect.stringMatching(/Mailchimp could not be read: .*down one.*Klaviyo could not be read: .*down two/s),
    });
  });

  it("one tool empty beside one with lists: the empty one is noted against that tool", async () => {
    kv.lists = [];
    const out = await listAll();
    expect(out.audiences.map((a) => a.id)).toEqual(["mc1"]);
    expect(out.notes).toEqual([{ tool: "klaviyo", note: "Klaviyo has no lists yet, so there is nobody to send to." }]);
    expect(out.unreadable).toEqual([]);
  });

  it("one tool connected and none named keeps the one-tool shape and its read failure", async () => {
    connected.klaviyo = null;
    expect(await listAll()).toEqual({ tool: "mailchimp", audiences: [{ id: "mc1", name: "Newsletter", member_count: 412, marked_test: false }] });
    mc.refuse.set("MAILCHIMP_GET_LISTS_INFO", "down");
    await expect(listAll()).rejects.toMatchObject({ code: "email_tool_read_failed" });
  });

  it("an explicit tool keeps today's behaviour: only that tool is read, in the one-tool shape", async () => {
    const out = await listAll({ tool: "klaviyo" });
    expect(out).toEqual({ tool: "klaviyo", audiences: [{ id: "kv1", name: "Customers", member_count: null, marked_test: false }], note: undefined });
    expect(slugs().some((s) => s.startsWith("MAILCHIMP_"))).toBe(false);
  });

  it("an explicit tool that fails still throws, and never falls back to the other tool", async () => {
    mc.refuse.set("MAILCHIMP_GET_LISTS_INFO", "down");
    await expect(listAll({ tool: "mailchimp" })).rejects.toMatchObject({ code: "email_tool_read_failed", message: expect.stringContaining("Mailchimp could not be read") });
    expect(slugs().some((s) => s.startsWith("KLAVIYO_"))).toBe(false);
  });

  it("an explicit tool not connected is still refused while another is", async () => {
    connected.klaviyo = null;
    await expect(listAll({ tool: "klaviyo" })).rejects.toMatchObject({ code: "email_tool_not_connected" });
  });

  it("the row's tool and id carry through to a proposal on that tool", async () => {
    const out = await listAll();
    const row = out.audiences.find((a) => a.tool === "klaviyo") as Row;
    const emit = vi.fn(async () => "act-1");
    const sent = await emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input({ tool: row.tool, audience_id: row.id }));
    expect(sent).toMatchObject({ tool: "klaviyo" });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("listing across every tool loosens nothing: send paths still refuse, and the sole-tool helper still answers null", async () => {
    await listAll();
    const emit = vi.fn(async () => "x");
    await expect(emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input({ audience_id: "mc1" }))).rejects.toMatchObject({ code: "email_tool_ambiguous" });
    await expect(resolveEmailTool("t1", undefined)).rejects.toMatchObject({ code: "email_tool_ambiguous", message: expect.stringMatching(/Mailchimp and Klaviyo/) });
    await expect(soleEmailTool("t1")).resolves.toBeNull();
    expect(emit).not.toHaveBeenCalled();
    expect(slugs().filter((s) => /CREATE|SEND|SCHEDULE/.test(s))).toEqual([]);
  });

  it("a lookup failure stays a throw for send paths, never a guess at the tool left standing", async () => {
    mocks.sendgrid.mockRejectedValue(new Error("sendgrid connection read failed: db down"));
    connected.klaviyo = null;
    const emit = vi.fn(async () => "x");
    await expect(emailCampaignProposeSendTool.execute({ tenant_id: "t1", emit_decision: emit } as never, input({ audience_id: "mc1" }))).rejects.toThrow(/db down/);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("email_campaign_list_audiences carries the founder's test marks", () => {
  type Row = { tool?: string; id: string; marked_test?: unknown };
  const SHARED = "SHARED1";
  const list = async (args: Record<string, unknown> = {}) => (await emailCampaignListAudiencesTool.execute({ tenant_id: "t1" } as never, args)) as { audiences: Row[]; unreadable?: unknown[] };
  const mark = (items: Array<{ item: string; status?: string }>) => mocks.rpc.mockResolvedValue({ data: { fields: { email_test_lists: items } }, error: null });
  const marked = (rows: Row[]) => rows.map((r) => [r.tool, r.id, r.marked_test]);

  beforeEach(() => {
    connected.klaviyo = acct("t1", "klaviyo");
    mc.lists = [{ id: SHARED, name: "Seeds", members: 900 }, { id: "mc2", name: "Real", members: 3 }];
    kv.lists = [{ id: SHARED, name: "Customers", members: 3 }];
  });

  it("every tool: a mark lands on its own route only, not on the same id elsewhere, and size never marks", async () => {
    mark([{ item: `mailchimp:${SHARED}` }]);
    const out = await list();
    expect(marked(out.audiences)).toEqual([["mailchimp", SHARED, true], ["mailchimp", "mc2", false], ["klaviyo", SHARED, false]]);
    expect(mocks.rpc).toHaveBeenCalledWith("t1", "get_channel_settings", { p_channel_slug: "email_marketing" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("the mirror case: the mark on Klaviyo leaves Mailchimp's same id unmarked", async () => {
    mark([{ item: `klaviyo:${SHARED}` }]);
    expect(marked((await list()).audiences)).toEqual([["mailchimp", SHARED, false], ["mailchimp", "mc2", false], ["klaviyo", SHARED, true]]);
  });

  it("SendGrid's lists are matched on the sendgrid route", async () => {
    const { fakeSendgrid } = await import("@/services/connectors/email-campaign/__tests__/fake-sendgrid");
    const sg = fakeSendgrid();
    vi.stubGlobal("fetch", sg.fetch);
    try {
      mocks.sendgrid.mockResolvedValue({ api_key: sg.key, key_digest: "a".repeat(64) });
      const id = sg.lists[0].id;
      mark([{ item: `sendgrid:${id}` }, { item: `mailchimp:${id}` }]);
      const rows = (await list()).audiences;
      expect(rows.find((r) => r.tool === "sendgrid" && r.id === id)?.marked_test).toBe(true);
      expect(rows.filter((r) => r.marked_test === true)).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a dismissed mark is no mark; a paused one still is", async () => {
    mark([{ item: `mailchimp:${SHARED}`, status: "dismissed" }, { item: "mailchimp:mc2", status: "paused" }]);
    expect(marked((await list()).audiences).slice(0, 2)).toEqual([["mailchimp", SHARED, false], ["mailchimp", "mc2", true]]);
  });

  it("an explicit tool and a sole connected tool carry the mark on their own route", async () => {
    mark([{ item: `klaviyo:${SHARED}` }]);
    expect((await list({ tool: "klaviyo" })).audiences).toEqual([expect.objectContaining({ id: SHARED, marked_test: true })]);
    expect((await list({ tool: "mailchimp" })).audiences.map((r) => r.marked_test)).toEqual([false, false]);
    connected.klaviyo = null;
    expect((await list()).audiences.map((r) => r.marked_test)).toEqual([false, false]);
  });

  it.each([
    ["the settings read answers an error", () => mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } })],
    ["the settings read throws", () => mocks.rpc.mockRejectedValue(new Error("network down"))],
  ])("%s: refused on every path, never a false that reads as not a test list", async (_label, breakIt) => {
    breakIt();
    const refused = { code: "email_test_lists_unreadable", message: expect.stringMatching(/could not check/) };
    await expect(list()).rejects.toMatchObject(refused);
    await expect(list({ tool: "mailchimp" })).rejects.toMatchObject(refused);
    connected.klaviyo = null;
    await expect(list()).rejects.toMatchObject(refused);
  });

  it("a failed marks read outranks a partial result: one tool down does not smuggle out unmarked rows", async () => {
    kv.refuse.set("KLAVIYO_GET_LISTS", "down");
    mocks.rpc.mockRejectedValue(new Error("network down"));
    await expect(list()).rejects.toMatchObject({ code: "email_test_lists_unreadable" });
  });

  it("no tool connected stays not connected, whatever the marks read does", async () => {
    connected = { mailchimp: null, klaviyo: null };
    mocks.rpc.mockRejectedValue(new Error("network down"));
    await expect(list()).rejects.toMatchObject({ code: "email_tool_not_connected" });
  });

  it("a marked row with nobody on it still reads as an empty list to the retry check", async () => {
    mc.lists = [{ id: SHARED, name: "Seeds", members: 0 }];
    mark([{ item: `mailchimp:${SHARED}` }]);
    const text = JSON.stringify(await list());
    expect(text).toMatch(new RegExp(`"id":"${SHARED}"[^{}]*"member_count":0,"marked_test":true`));
  });
});
