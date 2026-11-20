import { editedSocialDraft } from "../social-draft-edit";
import { socialDraftVersion } from "../social-draft-version";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcCalls, state } = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  state: {
    row: null as Record<string, unknown> | null,
    editResult: { data: { changed: true, status: "approved" }, error: null } as { data: unknown; error: unknown },
  },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () => Promise.resolve({ data: state.row, error: null });
      return b;
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "approve_social_draft_as_actor") return Promise.resolve(state.editResult);
      return Promise.resolve({ data: { changed: true, status: "approved" }, error: null });
    },
  }),
}));

vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn() }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecision: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/growth/bind-action-outcome", () => ({ bindActionOutcome: vi.fn().mockResolvedValue(undefined) }));

import { decideOnDecision } from "../decide-service";

const FUTURE = "2099-01-02T09:00:00.000Z";
const base = () => ({ decision_id: "d-1", tenant_id: "t-1", action: "approve" as const, actor: { user_id: "u-1" } });

beforeEach(() => {
  rpcCalls.length = 0;
  state.editResult = { data: { changed: true, status: "approved" }, error: null };
  state.row = {
    id: "d-1",
    tenant_id: "t-1",
    status: "proposed",
    decision_class: "social.publish.v2",
    agent_run_id: null,
    body: { channel: "linkedin", payload: { text: "hi" }, scheduled_at: null, rationale: "r" },
  };
});

describe("decideOnDecision — scheduled_at on a social approve", () => {
  it("atomically approves the merged body against the loaded version", async () => {
    const r = await decideOnDecision({ ...base(), scheduled_at: FUTURE });
    expect(r.ok).toBe(true);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["approve_social_draft_as_actor"]);
    expect(rpcCalls[0].args).toMatchObject({
      p_decision_id: "d-1",
      p_tenant_id: "t-1",
      p_actor_user_id: "u-1",
      p_body: { channel: "linkedin", payload: { text: "hi" }, scheduled_at: FUTURE, rationale: "r" },
    });
  });

  it("null clears the proposal's time (publish now)", async () => {
    (state.row as Record<string, unknown>).body = { channel: "linkedin", payload: { text: "hi" }, scheduled_at: FUTURE };
    await decideOnDecision({ ...base(), scheduled_at: null });
    expect((rpcCalls[0].args.p_body as { scheduled_at: unknown }).scheduled_at).toBeNull();
    expect(rpcCalls.map((c) => c.fn)).toContain("approve_social_draft_as_actor");
  });

  it("a plain approve after a calendar move keeps the moved time", async () => {
    (state.row as Record<string, unknown>).body = { channel: "x", payload: { text: "hi" }, scheduled_at: "2099-03-04T17:00:00Z" };
    const r = await decideOnDecision(base());
    expect(r.ok).toBe(true);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["approve_social_draft_as_actor"]);
  });

  it("approving the card's loaded time after a move is refused schedule_changed, nothing written", async () => {
    const MOVED = "2099-03-04T17:00:00Z";
    (state.row as Record<string, unknown>).body = { channel: "x", payload: { text: "hi" }, scheduled_at: MOVED };
    const r = await decideOnDecision({ ...base(), scheduled_at: FUTURE, expected_scheduled_at: FUTURE });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("schedule_changed");
    expect(r.current_scheduled_at).toBe(MOVED);
    expect(rpcCalls).toEqual([]);
  });

  it("a matching expected time (same instant, other spelling) approves as before", async () => {
    (state.row as Record<string, unknown>).body = { channel: "x", payload: { text: "hi" }, scheduled_at: "2099-01-02T09:00:00Z" };
    const r = await decideOnDecision({ ...base(), scheduled_at: FUTURE, expected_scheduled_at: FUTURE });
    expect(r.ok).toBe(true);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["approve_social_draft_as_actor"]);
  });

  it("a time deliberately re-picked in the panel (no expected) still wins over a move", async () => {
    (state.row as Record<string, unknown>).body = { channel: "x", payload: { text: "hi" }, scheduled_at: "2099-03-04T17:00:00Z" };
    const r = await decideOnDecision({ ...base(), scheduled_at: FUTURE });
    expect(r.ok).toBe(true);
    expect((rpcCalls[0].args.p_body as { scheduled_at: unknown }).scheduled_at).toBe(FUTURE);
  });

  it("undefined approves the unchanged body atomically", async () => {
    await decideOnDecision(base());
    expect(rpcCalls.map((c) => c.fn)).toEqual(["approve_social_draft_as_actor"]);
  });

  it("a concurrent save refuses the approval with no flip", async () => {
    state.editResult = { data: null, error: { message: "stale_card" } };
    const r = await decideOnDecision({ ...base(), scheduled_at: FUTURE });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("stale_card");
    expect(rpcCalls.map((c) => c.fn)).toEqual(["approve_social_draft_as_actor"]);
  });

  it("an edit RPC error → rpc_error and NO flip", async () => {
    state.editResult = { data: null, error: { message: "boom" } };
    const r = await decideOnDecision({ ...base(), scheduled_at: FUTURE });
    expect(r.ok).toBe(false);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["approve_social_draft_as_actor"]);
  });

  it("is ignored for every other decision class", async () => {
    (state.row as Record<string, unknown>).decision_class = "support-lead.reply";
    await decideOnDecision({ ...base(), scheduled_at: FUTURE });
    expect(rpcCalls.map((c) => c.fn)).toEqual(["decide_decision_as_actor"]);
  });

  it("is ignored on reject", async () => {
    await decideOnDecision({ ...base(), action: "reject", scheduled_at: FUTURE });
    expect(rpcCalls.map((c) => c.fn)).not.toContain("edit_decision_body_if_proposed");
    expect(rpcCalls[0].fn).toBe("decide_decision_as_actor");
  });
});

describe("decideOnDecision — payload_edit on a social approve", () => {
  beforeEach(() => {
    state.row = {
      id: "d-1",
      tenant_id: "t-1",
      status: "proposed",
      decision_class: "social.publish.v2",
      agent_run_id: null,
      body: { channel: "x", payload: { text: "hi", thread: ["two"] }, scheduled_at: null, rationale: "r" },
    };
  });

  it("writes the edited text + thread through the strict schema, then flips", async () => {
    const original = structuredClone(state.row?.body);
    const r = await decideOnDecision({ ...base(), payload_edit: { text: "better", thread: ["two", "three"] } });
    expect(r.ok).toBe(true);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["approve_social_draft_as_actor"]);
    expect((rpcCalls[0].args.p_body as { payload: unknown }).payload).toEqual({ text: "better", thread: ["two", "three"] });
    expect((rpcCalls[0].args.p_body as { post_draft_original: unknown }).post_draft_original).toEqual(original);
  });

  it("keeps the first original when an earlier saved edit already recorded one", async () => {
    const original = { channel: "x", payload: { text: "first" }, scheduled_at: null };
    (state.row as Record<string, unknown>).body = {
      channel: "x",
      payload: { text: "saved edit" },
      scheduled_at: null,
      post_draft_original: original,
    };
    await decideOnDecision({ ...base(), payload_edit: { text: "approved edit" } });
    expect((rpcCalls[0].args.p_body as { post_draft_original: unknown }).post_draft_original).toEqual(original);
  });

  it("thread: null drops the tail", async () => {
    await decideOnDecision({ ...base(), payload_edit: { thread: null } });
    expect((rpcCalls[0].args.p_body as { payload: unknown }).payload).toEqual({ text: "hi" });
  });

  it("refuses an edit the channel schema rejects, and does NOT flip", async () => {
    const r = await decideOnDecision({ ...base(), payload_edit: { text: "x".repeat(281) } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("invalid_edit");
    expect(r.detail).toBeTruthy();
    expect(rpcCalls).toEqual([]);
  });

  it("ignores payload_edit on a non-social class", async () => {
    state.row = { ...(state.row as Record<string, unknown>), decision_class: "engineer.ship-pr" };
    const r = await decideOnDecision({ ...base(), payload_edit: { text: "nope" } });
    expect(r.ok).toBe(true);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["decide_decision_as_actor"]);
  });
});

describe("decideOnDecision — unfinished social copy is refused BEFORE the flip", () => {
  it("stored text with a blank: invalid_edit naming it, no flip, the card stays editable", async () => {
    (state.row as Record<string, unknown>).body = {
      channel: "linkedin",
      payload: { text: "Hi [First name], we launched" },
      scheduled_at: null,
    };
    const r = await decideOnDecision(base());
    expect(r.ok).toBe(false);
    expect(r.code).toBe("invalid_edit");
    expect(r.detail).toBe("Fill before publishing: [First name]");
    expect(r.status).toBe("proposed");
    expect(rpcCalls).toEqual([]);
  });

  it("an edit that still carries a test marker is refused before it is saved", async () => {
    const r = await decideOnDecision({ ...base(), payload_edit: { text: "Local test from the panel (Zavi dev)" } });
    expect(r.code).toBe("invalid_edit");
    expect(r.detail).toMatch(/test marker/);
    expect(rpcCalls).toEqual([]);
  });

  it("an edit that fills the blank approves", async () => {
    (state.row as Record<string, unknown>).body = { channel: "linkedin", payload: { text: "Hi [First name]" }, scheduled_at: null };
    const r = await decideOnDecision({ ...base(), payload_edit: { text: "Hi Maya" } });
    expect(r.ok).toBe(true);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["approve_social_draft_as_actor"]);
  });

  it("a replayed approve on an already-approved post is the idempotent no-op, not a refusal", async () => {
    (state.row as Record<string, unknown>).status = "approved";
    (state.row as Record<string, unknown>).body = { channel: "linkedin", payload: { text: "Hi [First name]" } };
    const r = await decideOnDecision(base());
    expect(r.code).not.toBe("invalid_edit");
    expect(rpcCalls.map((c) => c.fn)).toEqual(["approve_social_draft_as_actor"]);
  });

  it("reject is never gated", async () => {
    (state.row as Record<string, unknown>).body = { channel: "linkedin", payload: { text: "Hi [First name]" } };
    const r = await decideOnDecision({ ...base(), action: "reject" as never });
    expect(r.code).not.toBe("invalid_edit");
  });
});

describe("photo edits retain the social approval boundary", () => {
  const tenant = "11111111-1111-4111-8111-111111111111";
  const path = `${tenant}/22222222-2222-4222-8222-222222222222.jpg`;
  it("uses the matching image transport on the same platform", () => {
    const body = { channel: "linkedin", payload: { text: "Original" } };
    expect(editedSocialDraft(tenant, body, { text: "Saved caption", image_path: path })).toMatchObject({ channel: "linkedin_image", payload: { text: "Saved caption", image_path: path } });
    expect(body).toEqual({ channel: "linkedin", payload: { text: "Original" } });
  });
  it("refuses another tenant's media and media on incompatible schemas", () => {
    expect(() => editedSocialDraft("other-tenant", { channel: "x", payload: { text: "Copy" } }, { image_path: path })).toThrow("workspace");
    expect(() => editedSocialDraft(tenant, { channel: "x", payload: { text: "Copy", thread: ["Part two"] } }, { image_path: path })).toThrow();
  });
});

describe("social approval revision binding", () => {
  it("refuses an older card after another tab saved text or media", async () => {
    const revision = socialDraftVersion(state.row?.body);
    if (!state.row) throw new Error("Missing decision");
    state.row.body = { channel: "linkedin_image", payload: { text: "Saved elsewhere", image_path: "another-image.png" }, post_draft: { text: "Saved elsewhere", thread: null } };
    const result = await decideOnDecision({ ...base(), expected_post_revision: revision });
    expect(result).toMatchObject({ ok: false, code: "stale_card", changed: false });
    expect(rpcCalls).toEqual([]);
  });
  it("requires a displayed revision when a saved draft exists", async () => {
    if (!state.row) throw new Error("Missing decision");
    state.row.body = { channel: "linkedin", payload: { text: "Saved" }, post_draft: { text: "Saved", thread: null } };
    expect(await decideOnDecision(base())).toMatchObject({ ok: false, code: "stale_card" });
    expect(rpcCalls).toEqual([]);
  });
  it("approves the displayed saved revision with an atomic body comparison", async () => {
    const body = { channel: "linkedin", payload: { text: "Saved" }, post_draft: { text: "Saved", thread: null } };
    if (!state.row) throw new Error("Missing decision");
    state.row.body = body;
    expect(await decideOnDecision({ ...base(), expected_post_revision: socialDraftVersion(body) })).toMatchObject({ ok: true, changed: true });
    expect(rpcCalls).toEqual([{ fn: "approve_social_draft_as_actor", args: { p_decision_id: "d-1", p_tenant_id: "t-1", p_actor_user_id: "u-1", p_expected_body: body, p_body: body, p_source: null } }]);
  });
});
