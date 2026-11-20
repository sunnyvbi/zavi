import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  cards: [] as Array<Record<string, unknown>>,
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  insert: 1 as number,
  redone: true as boolean,
  writerThrows: false as boolean,
}));

vi.mock("@/services/channels/direct-run", () => ({ healChatRunStamp: async () => "email_marketing" }));
vi.mock("@/services/tenant-client", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const chain = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const rows = () => (table === "channel_actions" ? h.cards.filter((r) => filters.every((f) => f(r))) : []);
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        filters.push((r) => r[k] === v);
        return q;
      },
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
      then: (ok: (v: unknown) => unknown) => ok({ data: rows(), error: null }),
    };
    return q;
  };
  return {
    ...real,
    tenantClient: () => ({ from: chain }),
    tenantRpc: async (_t: string, name: string, args: Record<string, unknown>) => {
      h.rpcs.push({ name, args });
      if (name === "record_channel_run_actions") {
        if (h.writerThrows) return { data: null, error: { message: "boom" } };
        return { data: { inserted: h.insert, ids: h.insert ? [{ id: "ca-new", position: 2 }] : [] }, error: null };
      }
      if (name === "mark_channel_action_redone") return { data: { ok: h.redone }, error: null };
      return { data: 0, error: null };
    },
  };
});

import { applyCopyEdits, makeProposeCampaignTool } from "@/services/tools/email/propose_campaign";
import { ExpectedToolError } from "@/services/tools/types";

const FOOT = "\n\nZavi, 1 Main St  \n \n";
const EMAIL1 = `Send: immediately\nSubject: You're in. Here's your first move\nPreview: Start here\n\nHi {{first_name}},\n\nCosts $5 & up.${FOOT}`;
const EMAIL2 = `Send: day 3\nSubject: You're in. Here's your first move\n\nBody two\twith a tab.${FOOT}`;
const EMAIL3 = `Send: day 7\nSubject: Last one\n\nBody three.`;
const CONTENT = `Email 1: on account creation\n${EMAIL1}\n\nEmail 2: day 3\n${EMAIL2}\n\nEmail 3: day 7\n${EMAIL3}`;

const body = () => ({
  position: 2,
  of: 2,
  summary: { value: "412 signups", context: "A figure this chat turn never read" },
  step: {
    title: "Load the 3-email welcome sequence into SendGrid for new accounts",
    body: "Load this sequence. Stop when they activate.",
    target: { kind: "audience", ref: "new accounts" },
    evidence: ["412 signups in 30 days"],
    deliverable: {
      kind: "email",
      label: "Welcome sequence, 3 emails",
      content: CONTENT,
      parts: [
        { label: "Email 1: on account creation", content: EMAIL1 },
        { label: "Email 2: day 3", content: EMAIL2 },
        { label: "Email 3: day 7", content: EMAIL3 },
      ],
    },
  },
});

const OLD = "680bbab2-a4d5-427e-b4da-e456c2b64cf5";
const card = (over: Row = {}) => ({
  id: OLD,
  channel_slug: "email_marketing",
  status: "pending",
  exec_class: null,
  exec_status: null,
  edited_body: null,
  position: 2,
  run_of: 2,
  body: body(),
  redo_of: null,
  ...over,
});
const CHAT = { tenant_id: "t1", run_id: "r1", run_trigger: "chat", emit_decision: async () => ({ id: "x" }) };
const CALL = {
  replaces: { rail: "channel_actions", id: OLD },
  edits: [{ email: 1, find: "Subject: You're in. Here's your first move", replace: "Subject: Welcome to Zavi, start here" }],
};
const run = (input: unknown = CALL, ctx: Row = CHAT) =>
  makeProposeCampaignTool().execute(ctx as never, input as never) as Promise<Record<string, unknown>>;
const written = () => h.rpcs.find((r) => r.name === "record_channel_run_actions");
const writtenBody = () => {
  const a = written()!.args;
  const list = (a.p_actions ?? a.actions) as Array<{ body: ReturnType<typeof body> }>;
  return list[0].body;
};

beforeEach(() => {
  h.cards = [card()];
  h.rpcs = [];
  h.insert = 1;
  h.redone = true;
  h.writerThrows = false;
});

async function refused(p: Promise<unknown>, code: string) {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ExpectedToolError);
  expect((e as ExpectedToolError).code).toBe(code);
  expect((e as Error).message).toContain("do not tell the founder");
  expect(written()).toBeUndefined();
  expect(h.rpcs.find((r) => r.name === "mark_channel_action_redone")).toBeUndefined();
}

describe("redrafting a copy-and-send email card from chat", () => {
  it("MUST-CATCH: the mirror ask writes one card through the real redo writer with only the subject of Email 1 changed", async () => {
    const out = await run();
    expect(out).toMatchObject({ action_id: "ca-new", status: "draft_replaced", emails_changed: [1], replaced_previous: true });
    const before = body();
    const after = writtenBody();
    const wantEmail1 = EMAIL1.replace("Subject: You're in. Here's your first move", "Subject: Welcome to Zavi, start here");
    expect(after.step.deliverable.parts[0].content).toBe(wantEmail1);
    expect(after.step.deliverable.parts[1].content).toBe(EMAIL2);
    expect(after.step.deliverable.parts[2].content).toBe(EMAIL3);
    expect(after.step.deliverable.content).toBe(CONTENT.replace(EMAIL1, wantEmail1));
    expect(after.summary).toEqual(before.summary);
    expect(after.step.body).toBe(before.step.body);
    expect(after.step.title).toBe(before.step.title);
    expect(after.step.evidence).toEqual(before.step.evidence);
    const a = written()!.args as { p_actions?: Array<Row>; actions?: Array<Row> };
    const row = (a.p_actions ?? a.actions)![0];
    expect(row.position).toBe(2);
    expect(row.run_of).toBe(2);
    expect(row.redo_of ?? row.redo_of_action_id).toBe(OLD);
    expect(h.rpcs.find((r) => r.name === "mark_channel_action_redone")!.args).toMatchObject({ p_old_action_id: OLD, p_new_action_id: "ca-new" });
  });

  it("the second subject, identical to the first, stays when Email 1 alone is named", () => {
    const { body: next } = applyCopyEdits(body(), [{ email: 1, find: "first move", replace: "next step" }]);
    const d = (next as ReturnType<typeof body>).step.deliverable;
    expect(d.parts[0].content).toContain("next step");
    expect(d.parts[1].content).toBe(EMAIL2);
    expect(d.content.split("first move").length - 1).toBe(1);
  });

  it("two identical emails: the named one changes and the card is refused rather than guessed in content", () => {
    const b = body();
    b.step.deliverable.parts[1].content = EMAIL1;
    b.step.deliverable.content = `${EMAIL1}\n\n${EMAIL1}\n\n${EMAIL3}`;
    expect(() => applyCopyEdits(b, [{ email: 2, find: "Costs", replace: "Prices" }])).toThrow(/line up/);
  });

  it("a replacement holding $& and $' lands literally", () => {
    const { body: next } = applyCopyEdits(body(), [{ email: 1, find: "$5 & up", replace: "$& and $' and $1" }]);
    const d = (next as ReturnType<typeof body>).step.deliverable;
    expect(d.parts[0].content).toContain("Costs $& and $' and $1.");
    expect(d.content).toContain("Costs $& and $' and $1.");
  });

  it("does not mutate the stored card body", () => {
    const b = body();
    const copy = JSON.stringify(b);
    applyCopyEdits(b, [{ email: 3, find: "Last one", replace: "Final" }]);
    expect(JSON.stringify(b)).toBe(copy);
  });

  it("applies several edits across emails in one call", async () => {
    await run({
      ...CALL,
      edits: [
        { email: 1, find: "Preview: Start here", replace: "Preview: Begin" },
        { email: 3, find: "Body three.", replace: "Third body." },
      ],
    });
    const d = writtenBody().step.deliverable;
    expect(d.parts[0].content).toContain("Preview: Begin");
    expect(d.parts[1].content).toBe(EMAIL2);
    expect(d.parts[2].content).toBe("Send: day 7\nSubject: Last one\n\nThird body.");
    expect(d.content).toContain("Preview: Begin");
    expect(d.content).toContain("Third body.");
  });

  it("a card with one email and no parts edits its content without a number", async () => {
    const b = body();
    b.step.deliverable = { kind: "email", label: "One", content: "Subject: A\n\nBody" } as never;
    h.cards = [card({ body: b })];
    await run({ ...CALL, edits: [{ find: "Subject: A", replace: "Subject: B" }] });
    expect(writtenBody().step.deliverable.content).toBe("Subject: B\n\nBody");
    expect(writtenBody().step.deliverable.parts).toBeUndefined();
  });

  it("a follow-up in the same chat holds the closed id and redrafts the live card, never the closed one", async () => {
    const b = body();
    b.step.deliverable.parts[2].content = "Send: day 7\nSubject: Newer\n\nBody three.";
    b.step.deliverable.content = CONTENT.replace(EMAIL3, b.step.deliverable.parts[2].content);
    h.cards = [card({ status: "redone" }), card({ id: "ca-2", redo_of: OLD, body: b })];
    await run({ ...CALL, edits: [{ email: 3, find: "Subject: Newer", replace: "Subject: Newest" }] });
    expect(writtenBody().step.deliverable.parts[2].content).toContain("Subject: Newest");
    expect(h.rpcs.find((r) => r.name === "mark_channel_action_redone")!.args.p_old_action_id).toBe("ca-2");
  });

  it("two redrafts in a row: the second card's summary is the original's, never a sentence about the first change", async () => {
    await run();
    const first = writtenBody();
    first.step.body = `${first.step.body} Only Email 1's subject changed, to Welcome to Zavi.`;
    h.cards = [card({ status: "redone" }), card({ id: "ca-2", redo_of: OLD, body: first })];
    h.rpcs = [];
    await run({ replaces: { rail: "channel_actions", id: OLD }, edits: [{ email: 1, find: "Subject: Welcome to Zavi, start here", replace: "Subject: Your growth plan is ready" }] });
    const second = writtenBody();
    expect(second.step.deliverable.parts[0].content).toContain("Subject: Your growth plan is ready");
    expect(second.step.body).toBe(body().step.body);
    expect(JSON.stringify(second)).not.toContain("Only Email 1");
    expect(h.rpcs.find((r) => r.name === "mark_channel_action_redone")!.args.p_old_action_id).toBe("ca-2");
  });

  it("a third redraft walks back to the first card, not the one before", async () => {
    const mid = { ...body(), step: { ...body().step, body: "Email 1 now says Welcome." } };
    const last = { ...body(), step: { ...body().step, body: "Email 1 now says Welcome. Then Your growth plan." } };
    h.cards = [card({ status: "redone" }), card({ id: "ca-2", status: "redone", redo_of: OLD, body: mid }), card({ id: "ca-3", redo_of: "ca-2", body: last })];
    await run({ ...CALL, edits: [{ email: 3, find: "Subject: Last one", replace: "Subject: Final" }] });
    expect(writtenBody().step.body).toBe(body().step.body);
  });

  it("a card whose first version cannot be read is refused, not redrafted with the old summary", async () => {
    const mid = { ...body(), step: { ...body().step, body: "Email 1 now says Welcome." } };
    h.cards = [card({ id: "11111111-1111-4111-8111-111111111111", redo_of: "gone", body: mid })];
    await refused(run({ replaces: { rail: "channel_actions", id: "11111111-1111-4111-8111-111111111111" }, edits: [{ email: 3, find: "Subject: Last one", replace: "Subject: Final" }] }), "email_replaced_unreadable");
  });

  it("the writer inserting nothing is never reported as a change", async () => {
    h.insert = 0;
    const e = await run().catch((x: Error) => x);
    expect(e).toBeInstanceOf(ExpectedToolError);
    expect((e as ExpectedToolError).code).toBe("email_copy_not_saved");
    expect(h.rpcs.find((r) => r.name === "mark_channel_action_redone")).toBeUndefined();
  });

  it("the writer failing is never reported as a change", async () => {
    h.writerThrows = true;
    const e = await run().catch((x: Error) => x);
    expect((e as ExpectedToolError).code).toBe("email_copy_not_saved");
    expect(h.rpcs.find((r) => r.name === "mark_channel_action_redone")).toBeUndefined();
  });

  it("the old card failing to close says so instead of saying one card", async () => {
    h.redone = false;
    const out = await run();
    expect(out.replaced_previous).toBe(false);
    expect(String(out.note)).toMatch(/could not be closed/);
  });

  it.each([
    ["answer turn", { ...CHAT, chat_answer_turn: true }],
    ["shadow replay", { ...CHAT, writes_suppressed: true }],
    ["scheduled run", { ...CHAT, run_trigger: "cron" }],
    ["no run", { ...CHAT, run_id: undefined }],
  ])("refuses on a %s", async (_n, ctx) => {
    await refused(run(CALL, ctx), "email_copy_not_this_run");
  });

  it.each([
    ["no such text", [{ email: 1, find: "Nope", replace: "x" }], "email_copy_find_missing"],
    ["a word in the wrong email", [{ email: 3, find: "Costs", replace: "x" }], "email_copy_find_missing"],
    ["text twice", [{ email: 1, find: "Start", replace: "x" }, { email: 1, find: "\n", replace: "x" }], "email_copy_find_ambiguous"],
    ["no number on three emails", [{ find: "Costs", replace: "x" }], "email_copy_email_required"],
    ["email 4 of 3", [{ email: 4, find: "Costs", replace: "x" }], "email_copy_email_missing"],
    ["a no-op", [{ email: 1, find: "Costs", replace: "Costs" }], "email_copy_no_change"],
  ])("refuses %s and writes nothing", async (_n, edits, code) => {
    await refused(run({ ...CALL, edits }), code);
  });

  it.each([
    ["acted", { status: "acted" }, "email_copy_card_closed"],
    ["dismissed", { status: "dismissed" }, "email_copy_card_closed"],
    ["executing", { exec_status: "running" }, "email_copy_card_closed"],
    ["edited by hand", { edited_body: { text: "mine" } }, "email_copy_card_edited"],
    ["sealed", { exec_class: "email_campaign.create_and_send" }, "email_replaced_not_found"],
    ["another channel", { channel_slug: "sms" }, "email_replaced_not_found"],
  ])("refuses a card that is %s", async (_n, over, code) => {
    h.cards = [card(over)];
    await refused(run(), code);
  });

  it("refuses replaces on the decisions rail and a missing replaces", async () => {
    await refused(run({ ...CALL, replaces: { rail: "decisions", id: OLD } }), "email_copy_replaces_missing");
    await refused(run({ edits: CALL.edits }), "email_copy_replaces_missing");
  });

  it("a call with neither edits nor route is a readable refusal, and the campaign path still requires route", async () => {
    const e = await run({ replaces: CALL.replaces }).catch((x: Error) => x);
    expect((e as ExpectedToolError).code).toBe("email_route_required");
  });
});
