import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state: {
    channel: string | null;
    slackThrows: boolean;
    ownerDm: { slack_user_id: string; team_id: string } | null;
  } = { channel: "C_PRAXIS", slackThrows: false, ownerDm: null };

  const resolveZaviChannel = vi.fn(async (_t: string, _r: string) => state.channel);
  const slackFetch = vi.fn(async (_t: string, method: string, _body: Record<string, unknown>, _team?: string) => {
    if (method === "conversations.open") return { ok: true, channel: { id: "D_OWNER_DM" } };
    if (state.slackThrows) throw new Error("slack_api_error: channel_not_found");
    return { ts: "123.456" };
  });

  const isFn = vi.fn(async (): Promise<{ error: { message: string } | null }> => ({ error: null }));
  const eqFn = vi.fn(() => ({ is: isFn }));
  const updateFn = vi.fn(() => ({ eq: eqFn }));
  const clsState: { rows: Array<{ slug: string }> } = { rows: [] };
  const clsEqFn = vi.fn(async () => ({ data: clsState.rows, error: null }));
  const clsSelectFn = vi.fn(() => ({ eq: clsEqFn }));
  const arState: { rows: Array<{ id: string; trigger: string | null }> } = { rows: [] };
  const arInFn = vi.fn(async () => ({ data: arState.rows, error: null }));
  const arSelectFn = vi.fn(() => ({ in: arInFn }));
  const teState: { mode: "all" | "none" | "error" | "other_tenant" } = { mode: "all" };
  const teIn = vi.fn((_col: string, ids: string[]) => ({
    order: () => ({ range: async () => teResult(ids) }),
  }));
  const teResult = (ids: string[]) => (
      teState.mode === "error"
        ? { data: null, error: { message: "db down" } }
        : { data: teState.mode === "all" ? ids.map((id) => ({ tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204", thread_id: "th-1", decision_id: id })) : teState.mode === "other_tenant" ? ids.map((id) => ({ tenant_id: "99999999-0000-4000-8000-000000000000", thread_id: "th-1", decision_id: id })) : [], error: null });
  const meetingState: { rows: Array<{ tenant_id: string; recap_destination: string | null }>; error: boolean } = { rows: [], error: false };
  const fromFn = vi.fn((tbl: string) => {
    if (tbl === "tenant_meeting_settings") {
      return { select: () => ({ in: async () => (meetingState.error ? { data: null, error: { message: "db down" } } : { data: meetingState.rows, error: null }) }) };
    }
    if (tbl === "decision_classes") return { select: clsSelectFn };
    if (tbl === "agent_runs") return { select: arSelectFn };
    if (tbl === "thread_event") return { select: () => ({ eq: () => ({ in: teIn }) }) };
    return { update: updateFn };
  });
  const rpcFn = vi.fn(async (name: string) =>
    name === "resolve_slack_owner_dm"
      ? { data: state.ownerDm ? [state.ownerDm] : [], error: null }
      : { data: null, error: null },
  );
  const serviceClient = vi.fn(() => ({ from: fromFn, rpc: rpcFn }));
  const settingsState: { pushEnabled: boolean; throws: boolean } = { pushEnabled: true, throws: false };
  const getBoolSetting = vi.fn(async (_k: string, _t?: string | null) => {
    if (settingsState.throws) throw new Error('settings down');
    return settingsState.pushEnabled;
  });
  const getBoolSettingStrict = vi.fn(async (_k: string, _t: string) => {
    if (settingsState.throws) throw new Error('settings down');
    return settingsState.pushEnabled;
  });

  return { state, meetingState, resolveZaviChannel, slackFetch, isFn, eqFn, updateFn, fromFn, rpcFn, serviceClient, clsState, clsEqFn, clsSelectFn, arState, arInFn, arSelectFn, settingsState, getBoolSetting, getBoolSettingStrict, teState, teIn };
});

vi.mock("../client", () => ({
  inngest: { createFunction: (_cfg: unknown, _trig: unknown, _fn: unknown) => ({ id: "stub" }) },
}));
vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/slack/resolve-zavi-channel", () => ({ resolveZaviChannel: m.resolveZaviChannel }));
vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: m.slackFetch }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: m.getBoolSetting,
  getBoolSettingStrict: m.getBoolSettingStrict,
}));

import { postApprovalBubblesBatch } from "../approval-slack-notify";

const ROW = {
  id: "20000000-0000-0000-0000-000000000099",
  tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
  decision_class: "engineer.ship-pr",
  agent_run_id: "30000000-0000-0000-0000-000000000077",
  body: {
    decision_evidence: {
      reason_text: "Ship the fix now",
      evidence: ["tests pass"],
      alternatives_considered: [],
      reversibility: "reversible",
      blast_radius: "GREEN",
      confidence: 0.9,
    },
  },
};

beforeEach(() => {
  m.state.channel = "C_PRAXIS";
  m.state.slackThrows = false;
  m.state.ownerDm = null;
  m.clsState.rows = [];
  m.meetingState.rows = [];
  m.meetingState.error = false;
  m.arState.rows = [];
  m.teState.mode = "all";
  m.settingsState.pushEnabled = true;
  m.settingsState.throws = false;
  m.getBoolSetting.mockClear();
  m.getBoolSettingStrict.mockClear();
  m.arInFn.mockClear();
  m.arSelectFn.mockClear();
  m.resolveZaviChannel.mockClear();
  m.slackFetch.mockClear();
  m.isFn.mockClear();
  m.eqFn.mockClear();
  m.updateFn.mockClear();
  m.fromFn.mockClear();
  m.rpcFn.mockClear();
  m.clsEqFn.mockClear();
  m.clsSelectFn.mockClear();
});

describe("postApprovalBubblesBatch: a chat-origin card is web-only only when its chat card exists (bug #7)", () => {
  const CHAT_ROW = { ...ROW, decision_class: "google_ads.update_campaign_budget_review" };
  it("must-catch: a chat card that never landed, past the grace window, posts to Slack like any other approval", async () => {
    m.arState.rows = [{ id: ROW.agent_run_id, trigger: "chat" }];
    m.teState.mode = "none";
    const res = await postApprovalBubblesBatch([{ ...CHAT_ROW, emitted_at: new Date(Date.now() - 20 * 60_000).toISOString() }]);
    expect(res.posted).toBe(1);
    expect(res.skipped_web_chat).toBe(0);
  });
  it("a chat card still being delivered (inside the grace window) waits: no post and no marker", async () => {
    m.arState.rows = [{ id: ROW.agent_run_id, trigger: "chat" }];
    m.teState.mode = "none";
    const res = await postApprovalBubblesBatch([{ ...CHAT_ROW, emitted_at: new Date(Date.now() - 60_000).toISOString() }]);
    expect(res).toEqual({ posted: 0, skipped_no_channel: 0, skipped_web_chat: 0, skipped_opted_out: 0, failed: 0, dm_fallback: 0 });
    expect(m.updateFn).not.toHaveBeenCalled();
  });
  it("an unreadable card lookup decides nothing: the chat-origin row neither posts nor is stamped", async () => {
    m.arState.rows = [{ id: ROW.agent_run_id, trigger: "chat" }];
    m.teState.mode = "error";
    const res = await postApprovalBubblesBatch([{ ...CHAT_ROW, emitted_at: new Date(Date.now() - 60 * 60_000).toISOString() }]);
    expect(res.posted).toBe(0);
    expect(m.updateFn).not.toHaveBeenCalled();
  });
  it("a card event of ANOTHER tenant with the same id never counts as this card's chat card", async () => {
    m.arState.rows = [{ id: ROW.agent_run_id, trigger: "chat" }];
    m.teState.mode = "other_tenant";
    const res = await postApprovalBubblesBatch([{ ...CHAT_ROW, emitted_at: new Date(Date.now() - 20 * 60_000).toISOString() }]);
    expect(res.posted).toBe(1);
  });
  it("must-not-touch: a channel run's approval stays off Slack even with no chat card (it never writes one)", async () => {
    m.arState.rows = [{ id: ROW.agent_run_id, trigger: "channel_recipe" }];
    m.teState.mode = "none";
    const res = await postApprovalBubblesBatch([{ ...CHAT_ROW, emitted_at: new Date(Date.now() - 20 * 60_000).toISOString() }]);
    expect(res.skipped_web_chat).toBe(1);
    expect(m.slackFetch).not.toHaveBeenCalled();
  });
  it("must-not-touch: a chat card that is in the chat stays web-only (marker claimed, no post)", async () => {
    m.arState.rows = [{ id: ROW.agent_run_id, trigger: "chat" }];
    const res = await postApprovalBubblesBatch([{ ...CHAT_ROW, emitted_at: new Date(Date.now() - 60 * 60_000).toISOString() }]);
    expect(res.skipped_web_chat).toBe(1);
    expect(m.slackFetch).not.toHaveBeenCalled();
  });
});

describe("postApprovalBubblesBatch", () => {
  it("posts blocks (JSON-stringified) to the resolved #zavi channel + sets marker", async () => {
    const res = await postApprovalBubblesBatch([ROW]);
    expect(res).toEqual({ posted: 1, skipped_no_channel: 0, skipped_web_chat: 0, skipped_opted_out: 0, failed: 0, dm_fallback: 0 });

    expect(m.slackFetch).toHaveBeenCalledTimes(1);
    const [tenant, method, body] = m.slackFetch.mock.calls[0];
    expect(tenant).toBe(ROW.tenant_id);
    expect(method).toBe("chat.postMessage");
    expect(body.channel).toBe("C_PRAXIS");
    expect(typeof body.blocks).toBe("string");
    expect(JSON.parse(body.blocks as string).some((b: { type?: string }) => b.type === "actions")).toBe(true);

    expect(m.updateFn).toHaveBeenCalledTimes(1);
    expect(m.eqFn).toHaveBeenCalledWith("id", ROW.id);
    expect(m.isFn).toHaveBeenCalledWith("slack_approval_posted_at", null);
  });

  it("FALLBACK: no #zavi channel → DMs the tenant owner (conversations.open → post to DM) + sets marker", async () => {
    m.state.channel = null;
    m.state.ownerDm = { slack_user_id: "U_OWNER", team_id: "T_OWNER" };
    const res = await postApprovalBubblesBatch([ROW]);
    expect(res).toEqual({ posted: 1, skipped_no_channel: 0, skipped_web_chat: 0, skipped_opted_out: 0, failed: 0, dm_fallback: 1 });

    const open = m.slackFetch.mock.calls.find((c) => c[1] === "conversations.open");
    expect(open).toBeTruthy();
    expect((open![2] as { users?: string }).users).toBe("U_OWNER");
    expect(open![3]).toBe("T_OWNER");
    const post = m.slackFetch.mock.calls.find((c) => c[1] === "chat.postMessage");
    expect((post![2] as { channel?: string }).channel).toBe("D_OWNER_DM");
    expect(post![3]).toBe("T_OWNER");
    expect(m.updateFn).toHaveBeenCalledTimes(1);
  });

  it("LOUD skip (no silent no-op) when no #zavi channel AND owner has no Slack DM", async () => {
    m.state.channel = null;
    m.state.ownerDm = null;
    const res = await postApprovalBubblesBatch([ROW]);
    expect(res).toEqual({ posted: 0, skipped_no_channel: 1, skipped_web_chat: 0, skipped_opted_out: 0, failed: 0, dm_fallback: 0 });
    expect(m.slackFetch.mock.calls.find((c) => c[1] === "chat.postMessage")).toBeUndefined();
    expect(m.updateFn).not.toHaveBeenCalled();
  });

  it("swallows a per-row Slack failure + does not set marker (retried next cycle)", async () => {
    m.state.slackThrows = true;
    const res = await postApprovalBubblesBatch([ROW]);
    expect(res).toEqual({ posted: 0, skipped_no_channel: 0, skipped_web_chat: 0, skipped_opted_out: 0, failed: 1, dm_fallback: 0 });
    expect(m.updateFn).not.toHaveBeenCalled();
  });

  it("one row's failure does not block the others (tenant isolation)", async () => {
    const rowB = { ...ROW, id: "20000000-0000-0000-0000-0000000000aa", tenant_id: "e0fe9ea8-0000-0000-0000-000000000000" };
    let call = 0;
    m.slackFetch.mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error("slack_api_error");
      return { ts: "1" };
    });
    const res = await postApprovalBubblesBatch([ROW, rowB]);
    expect(res.posted).toBe(1);
    expect(res.failed).toBe(1);
  });

  it("SUPPRESSES the Slack mirror for a web-chat-origin approval (marker claimed, no post)", async () => {
    m.arState.rows = [{ id: ROW.agent_run_id, trigger: "chat" }];
    const res = await postApprovalBubblesBatch([ROW]);
    expect(res).toEqual({ posted: 0, skipped_no_channel: 0, skipped_web_chat: 1, skipped_opted_out: 0, failed: 0, dm_fallback: 0 });

    expect(m.slackFetch.mock.calls.find((c) => c[1] === "chat.postMessage")).toBeUndefined();
    expect(m.updateFn).toHaveBeenCalledTimes(1);
    expect(m.eqFn).toHaveBeenCalledWith("id", ROW.id);
    expect(m.isFn).toHaveBeenCalledWith("slack_approval_posted_at", null);
  });

  it("a web-chat suppression claim that RETURNS an error does not suppress: the card posts as before", async () => {
    m.arState.rows = [{ id: ROW.agent_run_id, trigger: "chat" }];
    m.isFn.mockImplementationOnce(async () => ({ error: { message: "db write failed" } }));
    const res = await postApprovalBubblesBatch([ROW]);
    expect(res.skipped_web_chat).toBe(0);
    expect(res.posted).toBe(1);
    expect(m.slackFetch.mock.calls.find((c) => c[1] === "chat.postMessage")).toBeTruthy();
  });

  it("SUPPRESSES the Slack mirror for a channel-recipe-origin approval", async () => {
    m.arState.rows = [{ id: ROW.agent_run_id, trigger: "channel_recipe" }];
    const res = await postApprovalBubblesBatch([ROW]);
    expect(res).toEqual({ posted: 0, skipped_no_channel: 0, skipped_web_chat: 1, skipped_opted_out: 0, failed: 0, dm_fallback: 0 });
    expect(m.slackFetch.mock.calls.find((c) => c[1] === "chat.postMessage")).toBeUndefined();
    expect(m.updateFn).toHaveBeenCalledTimes(1);
    expect(m.isFn).toHaveBeenCalledWith("slack_approval_posted_at", null);
  });

  it("SUPPRESSES a channel.recipe_step card on a NON-channel_recipe trigger (handoff)", async () => {
    const channelRow = { ...ROW, decision_class: "channel.recipe_step" };
    m.arState.rows = [{ id: channelRow.agent_run_id, trigger: "handoff" }];
    const res = await postApprovalBubblesBatch([channelRow]);
    expect(res).toEqual({ posted: 0, skipped_no_channel: 0, skipped_web_chat: 1, skipped_opted_out: 0, failed: 0, dm_fallback: 0 });
    expect(m.slackFetch.mock.calls.find((c) => c[1] === "chat.postMessage")).toBeUndefined();
  });

  it("SUPPRESSES a channel.recipe_step card when the run-trigger lookup finds no row", async () => {
    const channelRow = { ...ROW, decision_class: "channel.recipe_step" };
    m.arState.rows = [];
    const res = await postApprovalBubblesBatch([channelRow]);
    expect(res.posted).toBe(0);
    expect(res.skipped_web_chat).toBe(1);
    expect(m.slackFetch.mock.calls.find((c) => c[1] === "chat.postMessage")).toBeUndefined();
  });

  it("does NOT post when the tenant has Slack approval push OFF", async () => {
    m.settingsState.pushEnabled = false;
    const res = await postApprovalBubblesBatch([ROW]);
    expect(res.posted).toBe(0);
    expect(res.skipped_opted_out).toBe(1);
    expect(m.slackFetch.mock.calls.find((c) => c[1] === "chat.postMessage")).toBeUndefined();
  });

  it("stamps slack_push_suppressed_at, NOT slack_approval_posted_at, on an opt-out", async () => {
    m.settingsState.pushEnabled = false;
    await postApprovalBubblesBatch([ROW]);
    const cols = m.updateFn.mock.calls.flatMap((c) =>
      Object.keys((c as unknown as [Record<string, unknown>])[0] ?? {}),
    );
    expect(cols).toContain("slack_push_suppressed_at");
    expect(cols).not.toContain("slack_approval_posted_at");
  });

  it("on a preference-read error: no post, and NO marker written", async () => {
    m.settingsState.throws = true;
    const res = await postApprovalBubblesBatch([ROW]);
    expect(res.posted).toBe(0);
    expect(res.skipped_opted_out).toBe(0);
    expect(m.slackFetch.mock.calls.find((c) => c[1] === "chat.postMessage")).toBeUndefined();
    const cols = m.updateFn.mock.calls.flatMap((c) =>
      Object.keys((c as unknown as [Record<string, unknown>])[0] ?? {}),
    );
    expect(cols).not.toContain("slack_push_suppressed_at");
  });

  it("still posts an autopilot approval alongside a suppressed channel run", async () => {
    const channelRow = { ...ROW, id: "20000000-0000-0000-0000-0000000000dd", agent_run_id: "30000000-0000-0000-0000-0000000000d1" };
    const cronRow = { ...ROW, id: "20000000-0000-0000-0000-0000000000ee", agent_run_id: "30000000-0000-0000-0000-0000000000d2" };
    m.arState.rows = [
      { id: channelRow.agent_run_id, trigger: "channel_recipe" },
      { id: cronRow.agent_run_id, trigger: "cron" },
    ];
    const res = await postApprovalBubblesBatch([channelRow, cronRow]);
    expect(res.posted).toBe(1);
    expect(res.skipped_web_chat).toBe(1);
    expect(m.slackFetch.mock.calls.filter((c) => c[1] === "chat.postMessage")).toHaveLength(1);
  });

  it("still posts NON-web-chat origins in a mixed batch (autopilot posts, chat suppressed)", async () => {
    const chatRow = { ...ROW, id: "20000000-0000-0000-0000-0000000000bb", agent_run_id: "30000000-0000-0000-0000-0000000000c1" };
    const autopilotRow = { ...ROW, id: "20000000-0000-0000-0000-0000000000cc", agent_run_id: "30000000-0000-0000-0000-0000000000c2" };
    m.arState.rows = [
      { id: chatRow.agent_run_id, trigger: "chat" },
      { id: autopilotRow.agent_run_id, trigger: "cron" },
    ];
    const res = await postApprovalBubblesBatch([chatRow, autopilotRow]);
    expect(res.posted).toBe(1);
    expect(res.skipped_web_chat).toBe(1);

    const posts = m.slackFetch.mock.calls.filter((c) => c[1] === "chat.postMessage");
    expect(posts).toHaveLength(1);
  });

  it("does NOT suppress when the run-trigger lookup fails (safe fallback: posts as before)", async () => {
    m.arInFn.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    m.arState.rows = [{ id: ROW.agent_run_id, trigger: "chat" }];
    const res = await postApprovalBubblesBatch([ROW]);
    expect(res.posted).toBe(1);
    expect(res.skipped_web_chat).toBe(0);
    expect(m.slackFetch.mock.calls.find((c) => c[1] === "chat.postMessage")).toBeTruthy();
  });
});

describe("postApprovalBubblesBatch: meeting cards reach Slack only when the team chose Slack for meeting notes", () => {
  const MEETING_ROW = {
    ...ROW,
    decision_class: "notetaker.write_atoms",
    agent_run_id: null,
    body: {
      title: "Standup 2026-10-27: 1 durable fact(s) for the company brain",
      atoms: [{ atom_type: "decision", title: "Ship Friday", body: "Ship Friday", source_excerpt: "we ship the pricing page Friday" }],
    },
  };
  const posts = () => m.slackFetch.mock.calls.filter((c) => c[1] === "chat.postMessage");

  it("not chosen, email or off: never posted, stamped as the team's choice so it leaves the scan", async () => {
    for (const recap_destination of [null, "email", "off"]) {
      m.slackFetch.mockClear();
      m.updateFn.mockClear();
      m.meetingState.rows = recap_destination === null ? [] : [{ tenant_id: ROW.tenant_id, recap_destination }];
      const res = await postApprovalBubblesBatch([MEETING_ROW]);
      expect(res.posted).toBe(0);
      expect(posts()).toHaveLength(0);
      expect(m.updateFn).toHaveBeenCalledWith(expect.objectContaining({ slack_push_suppressed_at: expect.any(String) }));
    }
  });

  it("a settings read error withholds the card without stamping it (retried next cycle)", async () => {
    m.meetingState.error = true;
    const res = await postApprovalBubblesBatch([MEETING_ROW]);
    expect(res.posted).toBe(0);
    expect(posts()).toHaveLength(0);
    expect(m.updateFn).not.toHaveBeenCalledWith(expect.objectContaining({ slack_push_suppressed_at: expect.any(String) }));
  });

  it("destination slack: the card posts as before; other classes are untouched by the gate", async () => {
    m.meetingState.rows = [{ tenant_id: ROW.tenant_id, recap_destination: "slack" }];
    const res = await postApprovalBubblesBatch([MEETING_ROW]);
    expect(res.posted).toBe(1);
    m.slackFetch.mockClear();
    m.meetingState.rows = [];
    const other = await postApprovalBubblesBatch([ROW]);
    expect(other.posted).toBe(1);
  });
});
