import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/welcome-sequence-copy-card.json";

const h = vi.hoisted(() => ({
  card: null as Record<string, unknown> | null,
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  insert: 1,
  redone: true,
  emit: vi.fn(),
}));

vi.mock("@/services/channels/direct-run", () => ({ healChatRunStamp: async () => "email_marketing" }));
vi.mock("@/services/tenant-client", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const chain = (table: string) => {
    const rows = () => (table === "channel_actions" && h.card ? [h.card] : []);
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (k: string, v: unknown) => (k === "redo_of" ? { ...q, order: () => ({ limit: async () => ({ data: [], error: null }) }) } : (void v, q)),
      in: () => q,
      is: () => q,
      not: () => q,
      gte: () => q,
      lte: () => q,
      gt: () => q,
      lt: () => q,
      or: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => ok({ data: rows(), error: null, count: rows().length }),
    };
    return q;
  };
  return {
    ...real,
    tenantClient: () => ({ from: chain }),
    tenantRpc: async (_t: string, name: string, args: Record<string, unknown>) => {
      h.rpcs.push({ name, args });
      if (name === "record_channel_run_actions") return { data: { inserted: h.insert, ids: h.insert ? [{ id: "ca-new", position: 2 }] : [] }, error: null };
      if (name === "mark_channel_action_redone") return { data: { ok: h.redone }, error: null };
      return { data: 0, error: null };
    },
  };
});

import { dispatchers, postProcessors } from "@/agents/index";
import { reconcileSideEffectClaims } from "@/services/agents/side-effect-claim-reconciler";
import { cardContextNote, cardSummary, copyCardEmails } from "@/services/channels/card-context";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

const OLD = "680bbab2-a4d5-427e-b4da-e456c2b64cf5";
const stored = fixture.stored_body as unknown as { step: { title: string; body: string; evidence: string[]; deliverable: { label: string; content: string; parts: Array<{ label: string; content: string }> } } };
const row = (over: Record<string, unknown> = {}) => ({
  id: OLD,
  channel_slug: "email_marketing",
  title: stored.step.title,
  status: "pending",
  status_at: null,
  proposed_at: "2026-11-02T08:31:35Z",
  impact: null,
  impact_reason: null,
  note: null,
  exec_class: null,
  exec_status: null,
  exec_result: null,
  edited_body: null,
  position: 2,
  run_of: 2,
  body: structuredClone(stored),
  ...over,
});

const ctx = { tenant_id: "t1", runId: "r1", trigger: "chat", chat_turn_verdict: "action" } as unknown as AgentContext;
const SUBJECT_OLD = "Subject: You're in. Here's your first move";
const SUBJECT_NEW = "Subject: Welcome to Zavi";
const LIVE_REPLY = "Email 1's subject is now **Welcome to Zavi** (15 characters). The card you have open still shows \"You're in. Here's your first move\" (32 characters), so the updated card below replaces it. Emails 2 and 3 and the footers are unchanged.\n\nNothing is loaded or sent until you approve the card yourself.";
const turn = (step: unknown = fixture.model_step) =>
  ({ parse_ok: true, parsed: { rendered_markdown: LIVE_REPLY, steps: [step] }, output_text: LIVE_REPLY }) as unknown as DispatcherResult;
const payload = { channel_action_id: OLD };
const writes = () => h.rpcs.filter((r) => r.name === "record_channel_run_actions");
const writtenBody = () => {
  const a = writes()[0].args;
  return ((a.p_actions ?? a.actions) as Array<{ body: typeof stored }>)[0].body;
};

beforeEach(() => {
  h.card = row();
  h.rpcs = [];
  h.insert = 1;
  h.redone = true;
  h.emit.mockReset().mockImplementation(async (_c: unknown, r: unknown) => r);
  (dispatchers.email_marketing as unknown as { emitAfterRun: unknown }).emitAfterRun = h.emit;
});

describe("the stored welcome sequence card from the mirror", () => {
  it("gives the chat every email the card shows, word for word and unclipped", () => {
    const summary = cardSummary(row() as never);
    expect(summary.email_card).toEqual({ replaces: { rail: "channel_actions", id: OLD } });
    expect(summary.email_copy?.emails.map((e) => e.text)).toEqual(stored.step.deliverable.parts.map((p) => p.content));
    const note = cardContextNote({ matches: [summary], total: 1 }) as string;
    const parsed = JSON.parse(note.split("```json\n")[1].split("\n```")[0]);
    expect(parsed.email_copy.emails).toHaveLength(3);
    expect(parsed.email_copy.emails[0].text).toContain(SUBJECT_OLD);
    expect(parsed.email_copy.emails[2].text).toContain("What's the one number you want to move this quarter?");
  });

  it("MUST-CATCH: the live envelope reply goes through the redo writer, keeps every byte but the subject, and the server writes the reply", async () => {
    const result = turn();
    await postProcessors.email_marketing(ctx, result, payload);
    expect(h.emit).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
    const close = h.rpcs.find((r) => r.name === "mark_channel_action_redone");
    expect(close?.args.p_old_action_id).toBe(OLD);
    const b = writtenBody();
    const d = stored.step.deliverable;
    expect(b.step.deliverable.content).toBe(d.content.replace(SUBJECT_OLD, SUBJECT_NEW));
    expect(b.step.deliverable.parts[0]).toEqual({ ...d.parts[0], content: d.parts[0].content.replace(SUBJECT_OLD, SUBJECT_NEW) });
    expect(b.step.deliverable.parts.slice(1)).toEqual(d.parts.slice(1));
    expect(b.step.deliverable.label).toBe(d.label);
    expect(b.step.body).toBe(stored.step.body);
    expect(b.step.evidence).toEqual(stored.step.evidence);
    expect(result.output_text).toBe("Done. The new card in this channel's Actions list has the change to email 1, and the old one is closed. Nothing is loaded or sent.");
    expect(result.output_text).not.toMatch(/below/);
    expect(result.parsed).toMatchObject({ steps: [], rendered_markdown: result.output_text });
    const rec = reconcileSideEffectClaims({ agent_slug: "email_marketing", chat_turn: true, output_text: result.output_text, parsed: result.parsed, tool_calls: [], parse_ok: true } as never, "rewrite");
    expect(rec).toMatchObject({ corrected: false, text: result.output_text });
  });

  it("a step that repeats the card files nothing and says nothing changed", async () => {
    const result = turn(stored.step);
    await postProcessors.email_marketing(ctx, result, payload);
    expect(writes()).toHaveLength(0);
    expect(h.emit).not.toHaveBeenCalled();
    expect(result.output_text).toMatch(/^Nothing changed on the card/);
  });

  it.each([
    ["acted", { status: "acted" }],
    ["already running", { exec_status: "queued" }],
    ["edited by hand", { edited_body: { text: "mine" } }],
  ])("a card that is %s stays as it is and the live claim is gone", async (_n, over) => {
    h.card = row(over);
    const result = turn();
    await postProcessors.email_marketing(ctx, result, payload);
    expect(writes()).toHaveLength(0);
    expect(h.emit).not.toHaveBeenCalled();
    expect(result.output_text).toMatch(/^Nothing changed on the card/);
  });

  it("a writer that saves nothing keeps the old card and the reply does not claim a change", async () => {
    h.insert = 0;
    const result = turn();
    await postProcessors.email_marketing(ctx, result, payload);
    expect(h.rpcs.find((r) => r.name === "mark_channel_action_redone")).toBeUndefined();
    expect(result.output_text).toMatch(/^Nothing changed on the card/);
  });

  it("an old card that will not close is said out loud", async () => {
    h.redone = false;
    const result = turn();
    await postProcessors.email_marketing(ctx, result, payload);
    expect(writes()).toHaveLength(1);
    expect(result.output_text).toContain("could not be closed, so dismiss it");
  });

  it.each([
    ["no card on the turn", {}, () => fixture.model_step],
    ["a step with no email", payload, () => ({ title: "Add DMARC", body: "b", blocking: false, effort: "minutes", evidence: ["e"] })],
    ["a sequence of another length", payload, () => ({ ...fixture.model_step, deliverable: { ...fixture.model_step.deliverable, parts: fixture.model_step.deliverable.parts.slice(0, 2) } })],
  ])("%s files through the normal card path", async (_n, p, step) => {
    await postProcessors.email_marketing(ctx, turn(step()), p);
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(writes()).toHaveLength(0);
  });

  it("two steps on one turn are not squeezed into the card", async () => {
    const result = turn();
    (result.parsed as { steps: unknown[] }).steps.push(stored.step);
    await postProcessors.email_marketing(ctx, result, payload);
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(writes()).toHaveLength(0);
  });

  it("the card helper reads the fixture's model step as the same three emails", () => {
    expect(copyCardEmails("email_marketing", null, { step: fixture.model_step })).toHaveLength(3);
  });
});

describe("a reply that claims a change no write backs", () => {
  const check = (text: string) =>
    reconcileSideEffectClaims({ agent_slug: "email_marketing", chat_turn: true, output_text: text, parsed: null, tool_calls: [], parse_ok: true } as never, "rewrite");

  it("loses both live claims and keeps the rest", () => {
    const first = check("Email 1's subject is now \"Welcome to Zavi, start here\". I can't change it on the card itself.");
    expect(first.text).toBe("I can't change it on the card itself.");
    const second = check(LIVE_REPLY);
    expect(second.text).not.toMatch(/is now|replaces it/);
    expect(second.text).toContain("Nothing is loaded or sent");
  });

  it.each([
    ["curly apostrophe", "Email 1’s subject is now shorter than it was."],
    ["bare verb", "Changed the subject line to Welcome to Zavi."],
    ["shortened", "I've shortened the subject."],
    ["done lead", "Done, updated your subject."],
  ])("%s", (_n, text) => {
    expect(check(text).corrected).toBe(true);
  });

  it.each([["an offer", "I could change the subject line to Welcome."], ["a suggestion", "If you like it, I will update the subject."], ["a question about length", "The subject is now too long for mobile."]])("%s stays", (_n, text) => {
    expect(check(text).corrected).toBe(false);
  });
});
