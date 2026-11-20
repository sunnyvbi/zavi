
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

function scoped(tid: string, table: string) {
  const filters: Array<(r: Row) => boolean> = [(r) => r.tenant_id === tid];
  let patch: Row | null = null;
  const rows = () => (m.tables[table] ??= []);
  const run = () => rows().filter((r) => filters.every((f) => f(r)));
  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
    gt: (c: string, v: string) => (filters.push((r) => String(r[c]) > v), b),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    update: (v: Row) => ((patch = v), b),
    insert: async (v: Row) => {
      rows().push({ id: `id-${rows().length + 1}`, consumed_at: null, ...v, tenant_id: tid });
      return { error: null };
    },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      const hit = run();
      if (patch) for (const r of hit) Object.assign(r, patch);
      return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null }).then(res, rej);
    },
  };
  return b;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({ from: (t: string) => scoped(tid, t) }),
  tenantRpc: vi.fn(),
}));

import {
  matchCustomAgentMention,
  resolveCustomAgentMention,
  loadMentionableAgents,
  issueCustomAgentConfirm,
  consumeCustomAgentConfirm,
  applyCustomAgentConfirm,
  whatsappOwnerUserId,
  parseConfirmText,
  parseWhatsAppConfirmButton,
  customAgentDraftHash,
  planRefusalText,
  draftSummaryText,
  runCustomAgentConfirm,
  NAME_TAKEN_REPLY,
  CONFIRM_RELEASE_FAILED_REPLY,
  buildSlackConfirmBlocks,
  type ApplyConfirmSeams,
} from "../custom-agent-chat";
import type { CustomAgentDraft } from "../custom-agents";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const seedDraftTrigger = (agent_id: string, over: Row = {}) =>
  (m.tables.custom_agent_triggers ??= []).push({
    tenant_id: A,
    agent_id,
    kind: "schedule",
    cron: "0 9 * * 1-5",
    tz: "America/Los_Angeles",
    interval_minutes: null,
    condition: null,
    ...over,
  });

const draft: CustomAgentDraft = {
  name: "Standup bot",
  role: "",
  instructions: "Summarize what Zavi did yesterday.",
  tools: [],
  triggers: [{ kind: "schedule", cron: "0 9 * * 1-5", tz: "America/Los_Angeles" }],
  deliver: { kind: "slack_channel", channel_id: "C1" } as never,
};

beforeEach(() => {
  m.tables = {
    custom_agents: [
      { tenant_id: A, id: "ag-a", slug: "c-aaaaaaaa01", name: "Standup Bot", status: "active" },
      { tenant_id: A, id: "ag-p", slug: "c-aaaaaaaa02", name: "Pricing Watch", status: "paused" },
      { tenant_id: A, id: "ag-d", slug: "c-aaaaaaaa03", name: "Draft One", status: "draft" },
      { tenant_id: B, id: "ag-b", slug: "c-bbbbbbbb01", name: "Competitor", status: "active" },
    ],
    custom_agent_confirm_tokens: [],
    whatsapp_threads: [],
    tenant_users: [],
  };
});

describe("@name matcher", () => {
  const agents = [{ name: "Standup Bot" }, { name: "Standup" }];
  it("matches the longest name after the bot mention and returns the task", () => {
    expect(matchCustomAgentMention("<@U0BOT> @standup-bot: what shipped?", agents)).toEqual({
      agent: { name: "Standup Bot" },
      task: "what shipped?",
    });
    expect(matchCustomAgentMention("@Standup today", agents)?.agent.name).toBe("Standup");
  });
  it("does not match without a leading @ or an unknown name", () => {
    expect(matchCustomAgentMention("hey @Standup", agents)).toBeNull();
    expect(matchCustomAgentMention("@Nobody do it", agents)).toBeNull();
  });
});

describe("resolveCustomAgentMention (tenant scoped)", () => {
  it("routes an active agent of THIS tenant only", async () => {
    expect(await resolveCustomAgentMention(A, "@Standup Bot go")).toMatchObject({ kind: "run", agent: { slug: "c-aaaaaaaa01" }, task: "go" });
    expect(await resolveCustomAgentMention(B, "@Standup Bot go")).toBeNull();
    expect(await resolveCustomAgentMention(A, "@Competitor check")).toBeNull();
  });
  it("paused => paused, draft => no match, non-@ => no DB read", async () => {
    expect(await resolveCustomAgentMention(A, "@Pricing Watch now")).toMatchObject({ kind: "paused" });
    expect(await resolveCustomAgentMention(A, "@Draft One now")).toBeNull();
    const load = vi.fn(loadMentionableAgents);
    expect(await resolveCustomAgentMention(A, "what shipped today?", load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});

describe("Confirm token", () => {
  const slackIssue = () =>
    issueCustomAgentConfirm({
      tenant_id: A,
      surface: "slack",
      external_user_id: "U1",
      slack_team_id: "T1",
      action: "create",
      draft,
      origin: { channel_id: "C1" },
    });

  it("is single use", async () => {
    const t = await slackIssue();
    const input = { code: t.code, surface: "slack" as const, external_user_id: "U1", slack_team_id: "T1", draft_hash: t.draft_hash };
    expect((await consumeCustomAgentConfirm(A, input)).ok).toBe(true);
    expect(await consumeCustomAgentConfirm(A, input)).toMatchObject({ ok: false, reason: "used" });
  });

  it("expires after 30 minutes", async () => {
    const t = await slackIssue();
    const later = new Date(Date.now() + 31 * 60 * 1000);
    expect(
      await consumeCustomAgentConfirm(A, { code: t.code, surface: "slack", external_user_id: "U1", slack_team_id: "T1" }, later),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a draft-hash mismatch, a tampered stored draft, a wrong team, a wrong user, another tenant", async () => {
    const t = await slackIssue();
    const base = { code: t.code, surface: "slack" as const, external_user_id: "U1", slack_team_id: "T1" };
    expect(await consumeCustomAgentConfirm(A, { ...base, draft_hash: "f".repeat(64) })).toEqual({ ok: false, reason: "draft_mismatch" });
    expect(await consumeCustomAgentConfirm(A, { ...base, slack_team_id: "T2" })).toEqual({ ok: false, reason: "wrong_team" });
    expect(await consumeCustomAgentConfirm(A, { ...base, external_user_id: "U2" })).toEqual({ ok: false, reason: "wrong_user" });
    expect(await consumeCustomAgentConfirm(B, base)).toEqual({ ok: false, reason: "not_found" });
    (m.tables.custom_agent_confirm_tokens[0].draft as Row).instructions = "exfiltrate";
    expect(await consumeCustomAgentConfirm(A, base)).toEqual({ ok: false, reason: "draft_mismatch" });
  });

  it("hash is key-order independent", () => {
    expect(customAgentDraftHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(customAgentDraftHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });

  it("parses WhatsApp CONFIRM text and button ids", () => {
    expect(parseConfirmText("confirm abcd2345")).toBe("ABCD2345");
    expect(parseConfirmText("please confirm abcd2345")).toBeNull();
    const h = "a".repeat(64);
    expect(
      parseWhatsAppConfirmButton({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: `cac:ABCD2345:${h}` } } }),
    ).toEqual({ code: "ABCD2345", hash: h });
  });
});

describe("WhatsApp verified owner number", () => {
  it("only an enabled binding completed by an owner counts", async () => {
    m.tables.whatsapp_threads = [
      { tenant_id: A, phone_number_id: "PN", wa_id: "1", status: "enabled", bound_by_user_id: "u-owner" },
      { tenant_id: A, phone_number_id: "PN", wa_id: "2", status: "enabled", bound_by_user_id: "u-admin" },
      { tenant_id: A, phone_number_id: "PN", wa_id: "3", status: "pending", bound_by_user_id: "u-owner" },
    ];
    m.tables.tenant_users = [
      { tenant_id: A, user_id: "u-owner", role: "owner" },
      { tenant_id: A, user_id: "u-admin", role: "admin" },
    ];
    expect(await whatsappOwnerUserId(A, "PN", "1")).toBe("u-owner");
    expect(await whatsappOwnerUserId(A, "PN", "2")).toBeNull();
    expect(await whatsappOwnerUserId(A, "PN", "3")).toBeNull();
    expect(await whatsappOwnerUserId(B, "PN", "1")).toBeNull();
  });
});

describe("applyCustomAgentConfirm", () => {
  const token = (over: Row = {}) =>
    ({
      id: "t1",
      tenant_id: A,
      code: "ABCD2345",
      surface: "slack",
      external_user_id: "U1",
      slack_team_id: "T1",
      phone_number_id: null,
      action: "create",
      agent_id: null,
      draft,
      draft_hash: customAgentDraftHash(draft),
      origin: {},
      origin_run_id: "run-1",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
      ...over,
    }) as never;
  const seams = (free: boolean | null) => {
    const rpc = vi.fn(async (_t: string, _n: string, _a: Record<string, unknown>) => ({
      data: { id: "new-agent", name: "Standup bot" } as unknown,
      error: null as { message?: string | null } | null,
    }));
    const s: ApplyConfirmSeams = { isFree: async () => free, reservedNames: async () => ["operator"], rpc };
    return Object.assign(s, { rpc });
  };

  it("Free is refused with the typed refusal and nothing is created", async () => {
    const s = seams(true);
    const r = await applyCustomAgentConfirm(token(), { created_by: null, slack_user_id: "U1" }, s);
    expect(r).toEqual({ ok: false, text: planRefusalText() });
    expect(r.text.startsWith("Custom agents are available on paid plans.")).toBe(true);
    expect(s.rpc).not.toHaveBeenCalled();
  });

  it("create: service-role RPC with created_by null + the Slack user, reply links the agent page", async () => {
    const s = seams(false);
    const r = await applyCustomAgentConfirm(token(), { created_by: null, slack_user_id: "U1" }, s);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Agent created\. Open it in Agent Builder: .*\/workspace\?tab=agent-builder&agent=new-agent$/);
    expect(s.rpc).toHaveBeenCalledWith(A, "create_custom_agent", expect.objectContaining({
      p_created_by: null,
      p_slack_user_id: "U1",
      p_status: "active",
      p_origin_run_id: "run-1",
    }));
  });

  it("update: edits the named agent and keeps its destination", async () => {
    const s = seams(false);
    const r = await applyCustomAgentConfirm(token({ action: "update", agent_id: "ag-a" }), { created_by: "u-owner", slack_user_id: null }, s);
    expect(r.text.startsWith("Agent updated.")).toBe(true);
    expect(s.rpc).toHaveBeenCalledWith(A, "update_custom_agent", expect.objectContaining({ p_agent_id: "ag-a", p_default_deliver: null, p_clear_deliver: false }));
  });

  it("plan unreadable => refused, not created", async () => {
    const s = seams(null);
    expect((await applyCustomAgentConfirm(token(), { created_by: null, slack_user_id: "U1" }, s)).ok).toBe(false);
    expect(s.rpc).not.toHaveBeenCalled();
  });
});

describe("card schedule line", () => {
  it("says the schedule in plain words, like the web card", () => {
    expect(draftSummaryText(draft, "create")).toContain("When it runs: Weekdays at 9:00 AM (PT)");
    const blocks = JSON.stringify(buildSlackConfirmBlocks(draft, "create", "ABCD2345", "a".repeat(64)));
    expect(blocks).toContain("When it runs: Weekdays at 9:00 AM (PT)");
    expect(blocks).not.toContain("0 9 * * 1-5");
  });
});

describe("runCustomAgentConfirm: retry-safe and idempotent", () => {
  const issue = () =>
    issueCustomAgentConfirm({
      tenant_id: A,
      surface: "whatsapp",
      external_user_id: "1408",
      phone_number_id: "PN",
      action: "create",
      draft,
      origin: {},
      origin_run_id: "run-9",
    });
  const input = (code: string) => ({ code, surface: "whatsapp" as const, external_user_id: "1408", phone_number_id: "PN" });
  const creator = { created_by: "u-owner", slack_user_id: null };
  const liveRow = (id: string, over: Row = {}) => ({
    tenant_id: A,
    id,
    name: "standup-bot",
    role: "",
    instructions: draft.instructions,
    tools: [],
    default_deliver: { kind: "slack_channel", channel_id: "C1" },
    status: "active",
    origin_run_id: "run-9",
    ...over,
  });
  const created = (id: string) => {
    m.tables.custom_agents.push({ ...liveRow(id), slug: "c-aaaaaaaa09" });
    seedDraftTrigger(id);
    return { ok: true as const, agent_id: id, name: "Standup bot", action: "create" as const, text: `Agent created. Open it in Agent Builder: /x/${id}` };
  };

  it("a failed apply releases the token, so the same Confirm then succeeds", async () => {
    const t = await issue();
    const apply = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, text: "Something went wrong creating the agent. Please try again." })
      .mockImplementationOnce(async () => created("ag-new"));
    const first = await runCustomAgentConfirm(A, input(t.code), creator, { apply });
    expect(first).toEqual({ ok: false, text: "Something went wrong creating the agent. Please try again." });
    expect(m.tables.custom_agent_confirm_tokens[0].consumed_at).toBeNull();
    const second = await runCustomAgentConfirm(A, input(t.code), creator, { apply });
    expect(second.ok).toBe(true);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("a thrown apply also releases the token", async () => {
    const t = await issue();
    const r = await runCustomAgentConfirm(A, input(t.code), creator, { apply: vi.fn(async () => { throw new Error("rpc"); }) });
    expect(r.ok).toBe(false);
    expect(m.tables.custom_agent_confirm_tokens[0].consumed_at).toBeNull();
  });

  it("double delivery shows the success link both times, and creates once", async () => {
    const t = await issue();
    const apply = vi.fn(async () => created("ag-new"));
    const a = await runCustomAgentConfirm(A, input(t.code), creator, { apply });
    const b = await runCustomAgentConfirm(A, input(t.code), creator, { apply });
    expect(a.ok && b.ok).toBe(true);
    expect(b.text).toMatch(/^Agent created\. Open it in Agent Builder: .*agent=ag-new$/);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("the RPC's already-created guard is the success only when the live row is THIS draft", async () => {
    const t = await issue();
    m.tables.custom_agents.push({ ...liveRow("ag-old"), slug: "c-aaaaaaaa08" });
    seedDraftTrigger("ag-old");
    const r = await runCustomAgentConfirm(A, input(t.code), creator, {
      apply: vi.fn(async () => ({ ok: false as const, text: "This agent was already created." })),
    });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/agent=ag-old$/);
  });

  it.each([
    ["a different schedule", { trigger: { cron: "0 8 * * 1-5" } }],
    ["different tools", { row: { tools: ["email__send"] } }],
    ["a different destination", { row: { default_deliver: { kind: "slack_channel", channel_id: "C9" } } }],
    ["no stored trigger", { noTrigger: true }],
  ] as Array<[string, { trigger?: Row; row?: Row; noTrigger?: boolean }]>)(
    "same run + same text but %s: not reported created, token released",
    async (_label, v) => {
      const t = await issue();
      m.tables.custom_agents.push({ ...liveRow("ag-sib", v.row ?? {}), slug: "c-aaaaaaaa06" });
      if (!v.noTrigger) seedDraftTrigger("ag-sib", v.trigger ?? {});
      const r = await runCustomAgentConfirm(A, input(t.code), creator, {
        apply: vi.fn(async () => ({ ok: false as const, text: "This agent was already created." })),
      });
      expect(r.ok).toBe(false);
      expect(m.tables.custom_agent_confirm_tokens[0].consumed_at).toBeNull();
    },
  );

  it("a second card in the same run whose create fails is not reported created, and is released", async () => {
    const t = await issue();
    m.tables.custom_agents.push({ ...liveRow("ag-first", { name: "Competitor watch", instructions: "Watch rivals." }), slug: "c-aaaaaaaa07" });
    const r = await runCustomAgentConfirm(A, input(t.code), creator, {
      apply: vi.fn(async () => ({ ok: false as const, text: "This agent was already created." })),
    });
    expect(r).toEqual({ ok: false, text: "This agent was already created." });
    expect(m.tables.custom_agent_confirm_tokens[0].consumed_at).toBeNull();
  });

  it("a used token with no agent still says already confirmed", async () => {
    const t = await issue();
    m.tables.custom_agent_confirm_tokens[0].consumed_at = new Date().toISOString();
    expect(await runCustomAgentConfirm(A, input(t.code), creator)).toEqual({ ok: false, text: "This was already confirmed." });
  });
});

describe("runCustomAgentConfirm: edits", () => {
  const issueEdit = () =>
    issueCustomAgentConfirm({
      tenant_id: A,
      surface: "slack",
      external_user_id: "U1",
      slack_team_id: "T1",
      action: "update",
      agent_id: "ag-a",
      draft,
      origin: {},
      origin_run_id: "run-7",
    });
  const input = (code: string) => ({ code, surface: "slack" as const, external_user_id: "U1", slack_team_id: "T1" });
  const creator = { created_by: null, slack_user_id: "U1" };

  it("a failed edit is not reported as success (the target exists): real reason, token released", async () => {
    const t = await issueEdit();
    const r = await runCustomAgentConfirm(A, input(t.code), creator, {
      apply: vi.fn(async () => ({ ok: false as const, text: NAME_TAKEN_REPLY })),
    });
    expect(r).toEqual({ ok: false, text: NAME_TAKEN_REPLY });
    expect(m.tables.custom_agent_confirm_tokens[0].consumed_at).toBeNull();
  });

  it("a lost claim on an edit is the used rejection, not a replayed success", async () => {
    const t = await issueEdit();
    const row = m.tables.custom_agent_confirm_tokens[0];
    const r = await runCustomAgentConfirm(A, input(t.code), creator, {
      consume: vi.fn(async () => ({ ok: false as const, reason: "used" as const, token: { ...(row as Record<string, unknown>), consumed_at: null } as never })),
    });
    expect(r).toEqual({ ok: false, text: "This was already confirmed." });
  });

  it("a release error answers the failed reply, not the retry-able refusal", async () => {
    const t = await issueEdit();
    const r = await runCustomAgentConfirm(A, input(t.code), creator, {
      apply: vi.fn(async () => ({ ok: false as const, text: NAME_TAKEN_REPLY })),
      release: vi.fn(async () => {
        throw new Error("custom agent confirm release failed: boom");
      }),
    });
    expect(r).toEqual({ ok: false, text: "Something went wrong. Ask Zavi to draft the agent again." });
    expect(CONFIRM_RELEASE_FAILED_REPLY).toBe("Something went wrong. Ask Zavi to draft the agent again.");
  });
});

describe("runCustomAgentConfirm: used edit token", () => {
  it("replays success only when the live agent matches the draft; otherwise the used reply", async () => {
    const t = await issueCustomAgentConfirm({
      tenant_id: A,
      surface: "slack",
      external_user_id: "U1",
      slack_team_id: "T1",
      action: "update",
      agent_id: "ag-a",
      draft,
      origin: {},
    });
    m.tables.custom_agent_confirm_tokens[0].consumed_at = new Date().toISOString();
    const input = { code: t.code, surface: "slack" as const, external_user_id: "U1", slack_team_id: "T1" };
    expect(await runCustomAgentConfirm(A, input, { created_by: null, slack_user_id: "U1" })).toEqual({
      ok: false,
      text: "This was already confirmed.",
    });
    Object.assign(m.tables.custom_agents[0], { name: "Standup bot", role: "", instructions: draft.instructions, tools: ["email__send"] });
    seedDraftTrigger("ag-a", { cron: "0 7 * * *" });
    expect(await runCustomAgentConfirm(A, input, { created_by: null, slack_user_id: "U1" })).toEqual({
      ok: false,
      text: "This was already confirmed.",
    });
    Object.assign(m.tables.custom_agents[0], { tools: [], default_deliver: { kind: "email" } });
    m.tables.custom_agent_triggers = [];
    seedDraftTrigger("ag-a");
    const r = await runCustomAgentConfirm(A, input, { created_by: null, slack_user_id: "U1" });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Agent updated\..*agent=ag-a$/);
  });
});
