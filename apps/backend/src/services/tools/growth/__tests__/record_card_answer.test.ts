import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@/services/tools/types";
import { runRecordCardAnswer, type AnswerCard, type RecordCardAnswerDeps } from "../record_card_answer";
const T = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const CARD = "44444444-4444-4444-8444-444444444444";
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  tenant_id: T, run_id: RUN, agent_slug: "cgo", run_trigger: "chat", founder_chat_order: true,
  actor: { actor_user_id: USER, actor_source: "chat", resolved_tenant_member: true, provenance_label: "signed-in user" },
  log: () => {}, ...over,
});
const card = (over: Partial<AnswerCard> = {}): AnswerCard => ({
  id: CARD, status: "pending", card_kind: "task", exec_class: null, exec_status: null, approved_by: null,
  title: "Confirm which social account is yours, or tell us you have none",
  body: { intent: "fix_setup", step: { title: "Confirm which social account is yours, or tell us you have none", body: "Tell us your handle, or say you have none." } },
  ...over,
});
let deps: RecordCardAnswerDeps;
let write: ReturnType<typeof vi.fn> & RecordCardAnswerDeps["write"];
beforeEach(() => {
  write = vi.fn().mockResolvedValue({ ok: true, replayed: false, status: "acted" }) as typeof write;
  deps = { role: vi.fn().mockResolvedValue("owner"), founderWords: vi.fn().mockResolvedValue("I do not have that account."), card: vi.fn().mockResolvedValue(card()), write };
});
const run = (c = ctx(), input: unknown = { card_id: CARD }) => runRecordCardAnswer(c, input, deps);
describe("record_card_answer", () => {
  it("records the founder's own words on a legacy setup question without starting work", async () => {
    const result = await run();
    expect(result).toMatchObject({ status: "recorded", card_id: CARD });
    expect(result.say).toMatch(/no channel work/i);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(T, { card_id: CARD, user_id: USER, note: "I do not have that account.", event_key: `chat-answer:${RUN}:${CARD}` });
    expect(deps.founderWords).toHaveBeenCalledWith(T, RUN, USER);
  });
  it.each(["answer", "review"])("accepts %s questions using existing presentation semantics", async (intent) => {
    deps.card = vi.fn().mockResolvedValue(card({ body: { intent, step: { title: "Tell us your handle" } } }));
    expect((await run()).status).toBe("recorded");
  });
  it("accepts a legacy question with no stored card kind", async () => {
    deps.card = vi.fn().mockResolvedValue(card({ card_kind: null }));
    expect((await run()).status).toBe("recorded");
  });
  it("preserves non-English answers verbatim", async () => {
    deps.founderWords = vi.fn().mockResolvedValue("no tengo esa cuenta"); await run();
    expect(write.mock.calls[0][1].note).toBe("no tengo esa cuenta");
  });
  it("reuses the same event key on retries, including after the card closed", async () => {
    await run(); deps.card = vi.fn().mockResolvedValue(card({ status: "acted" }));
    write.mockResolvedValue({ ok: true, replayed: true, status: "acted" });
    expect((await run()).status).toBe("already_recorded");
    expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
  });
  it.each([
    { card_kind: "executes" }, { card_kind: "ad_manual" }, { card_kind: "plan" }, { card_kind: "copy_to_site" },
    { body: { intent: "review", step: { title: "Confirm whether this campaign is ready", deliverable: { presentation: { type: "campaign_draft" } } } } },
    { body: { intent: "answer", step: { title: "Tell us if this plan is approved", deliverable: { kind: "plan" } } } },
    { body: { intent: "answer", step: { title: "Tell us whether to use this", deliverable: { content: { title: "A structured ad draft" } } } } },
    { exec_class: "social.publish.v1" }, { exec_status: "queued" }, { exec_status: "executed" }, { approved_by: USER },
    { body: { intent: "review", step: { title: "Publish this post", deliverable: { content: "A post" } } } },
    { body: { intent: "fix_setup", step: { title: "Connect the social account" } }, title: "Connect the social account" },
  ])("refuses a non-question or executable card %j", async (over) => {
    deps.card = vi.fn().mockResolvedValue(card(over));
    await expect(run()).rejects.toMatchObject({ code: "card_answer_not_question" }); expect(write).not.toHaveBeenCalled();
  });
  it.each([
    { agent_slug: "operator" }, { run_trigger: "cron" }, { founder_chat_order: false }, { founder_order_unverified: true },
    { untrusted_context: true }, { captured_page_context: true }, { writes_suppressed: true }, { run_id: undefined }, { actor: undefined },
  ])("refuses an unverified or non-founder chat context %j", async (over) => {
    await expect(run(ctx(over))).rejects.toMatchObject({ code: "card_answer_unavailable" }); expect(write).not.toHaveBeenCalled();
  });
  it.each(["member", "viewer", null])("refuses current role %s even if the older founder marker was true", async (role) => {
    deps.role = vi.fn().mockResolvedValue(role);
    await expect(run()).rejects.toMatchObject({ code: "card_answer_unavailable" }); expect(write).not.toHaveBeenCalled();
  });
  it("does not guess a card from a title or accept a model-written answer", async () => {
    await expect(run(ctx(), { card_id: "the Instagram one" })).rejects.toThrow();
    await expect(run(ctx(), { card_id: CARD, answer: "invented" })).rejects.toThrow(); expect(write).not.toHaveBeenCalled();
  });
  it("refuses missing/wrong-tenant cards and unreadable founder words", async () => {
    deps.card = vi.fn().mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ code: "card_answer_not_found" });
    deps.card = vi.fn().mockResolvedValue(card()); deps.founderWords = vi.fn().mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ code: "card_answer_unavailable" }); expect(write).not.toHaveBeenCalled();
  });
  it("refuses an unrelated closed card and preserves the previous answer", async () => {
    deps.card = vi.fn().mockResolvedValue(card({ status: "acted" }));
    write.mockResolvedValue({ ok: false, code: "illegal_transition" });
    await expect(run()).rejects.toMatchObject({ code: "card_answer_not_saved" });
  });
  it.each(["role", "card", "founderWords"] as const)("does not write on a failed %s read", async (name) => {
    deps[name] = vi.fn().mockRejectedValue(new Error("unavailable")) as never;
    await expect(run()).rejects.toThrow("unavailable");
    expect(write).not.toHaveBeenCalled();
  });
  it("does not silently truncate an answer at the existing RPC note limit", async () => {
    deps.founderWords = vi.fn().mockResolvedValue("a".repeat(1001));
    await expect(run()).rejects.toMatchObject({ code: "card_answer_too_long" });
    expect(write).not.toHaveBeenCalled();
  });
  it("does not report success when the locked RPC refuses the transition", async () => {
    write.mockResolvedValue({ ok: false, code: "exec_in_flight" });
    await expect(run()).rejects.toMatchObject({ code: "card_answer_not_saved" });
  });
});
