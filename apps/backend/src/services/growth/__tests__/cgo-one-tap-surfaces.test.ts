import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { oneTapMailto, oneTapRef, refFromSubject, rootPrefixForRef } from "@/email/one-tap";
import { renderCgoNoteEmail } from "@/email/templates/cgo-note";
import { renderCgoNoteSlackMessage, parseCgoQuestionAction } from "../cgo-note-slack";
import { handleCgoQuestionClick, redraw } from "@/services/slack/cgo-question-click";
import { isYesNoAsk } from "../cgo-questions";
import { planGoalChanges, type GoalRow } from "../goal-owner";

const Q1 = "11111111-1111-4111-8111-111111111111";

describe("email: mailto answers that come back to the note's thread", () => {
  const mid = "<zavi-3f2a9c1b-77de-4a1b-9c3d-0123456789ab@inbox.zaviagent.com>";

  it("the ref names the note's Message-ID and round-trips through the reply subject", () => {
    const ref = oneTapRef(mid)!;
    expect(ref).toBe("3f2a9c1b77de");
    const href = oneTapMailto({ to: "acme@inbox.zaviagent.com", subject: "Acme: 1 question", ref, body: "1 yes" });
    expect(href.startsWith("mailto:acme@inbox.zaviagent.com?")).toBe(true);
    const subject = decodeURIComponent(/subject=([^&]+)/.exec(href)![1]);
    expect(subject).toBe("Re: Acme: 1 question [ref 3f2a9c1b77de]");
    expect(decodeURIComponent(/body=([^&]+)/.exec(href)![1])).toBe("1 yes");
    expect(refFromSubject(subject)).toBe(ref);
    expect(`zavi-3f2a9c1b-77de-4a1b-9c3d-0123456789ab@inbox.zaviagent.com`.startsWith(rootPrefixForRef(ref))).toBe(true);
  });

  it("a Message-ID we did not mint has no ref", () => {
    expect(oneTapRef("<abc@gmail.com>")).toBeNull();
    expect(refFromSubject("Re: hello")).toBeNull();
  });

  it("the note shows each question numbered with its recommendation, why, Yes/No mailto buttons and the reply hint", () => {
    const yes = oneTapMailto({ to: "a@inbox.zaviagent.com", subject: "S", ref: "3f2a9c1b77de", body: "1 yes" });
    const r = renderCgoNoteEmail({
      companyName: "Acme",
      autopilot: true,
      saw: [],
      changed: [],
      need: [],
      growthUrl: "https://www.zaviagent.com/workspace",
      questions: [{ ordinal: 1, ask: "Should I plan for 24 new renters a week instead of 150?", recommended: "yes", why: "Today it's ~16 a week.", yesHref: yes, noHref: yes.replace("yes", "no") }],
    });
    expect(r.subject).toBe("Acme: Should I plan for 24 new renters a week instead of 150?");
    expect(r.html).toContain("1. Should I plan for 24 new renters a week instead of 150?");
    expect(r.html).toContain("I recommend: Yes.");
    expect(r.html).toMatch(/Today it(&#39;|&#x27;|')s ~16 a week\./);
    expect(r.html).toContain('href="mailto:');
    expect(r.html).not.toMatch(/href="https?:[^"]*answer/);
    expect(r.text).toContain("Or reply with `1 yes`.");
  });

  it("a question that is not a yes/no gets no buttons", () => {
    const r = renderCgoNoteEmail({
      companyName: "Acme",
      autopilot: true,
      saw: [],
      changed: [],
      need: [],
      growthUrl: "https://x",
      questions: [{ ordinal: 1, ask: "Which goal should this track?", recommended: null, why: null, yesHref: null, noHref: null }],
      canReply: true,
    });
    expect(r.html).toContain("Reply in your own words.");
    expect(r.html.replace(/mailto:support@zaviagent\.com/g, "")).not.toContain("mailto:");
  });
});

describe("yes/no framing", () => {
  it.each([
    ["Should I plan for 24 a week instead of 150?", true],
    ["Today it's 16 a week. Should I lower it?", true],
    ["I didn't change it: it shows 16. Is that number right?", true],
    ["Which should this goal track?", false],
    ["Tell me your budget.", false],
  ])("%s", (ask, want) => expect(isYesNoAsk(ask)).toBe(want));
});

describe("Slack: buttons, and who may press them", () => {
  const question = { id: Q1, ordinal: 1, ask: "Should I pause Reddit?", recommended: "yes" as const, why: "No signups in 3 weeks.", yesNo: true, noteLine: "Should I pause Reddit?" };

  it("each yes/no question gets Yes/No buttons keyed to its id; the plain line is not repeated", () => {
    const m = renderCgoNoteSlackMessage({ companyName: "Acme", changed: ["Paused X."], need: ["Should I pause Reddit?"], growthUrl: "https://x", questions: [question] });
    const actions = m.blocks.find((b) => (b as { type: string }).type === "actions") as { block_id: string; elements: Array<{ action_id: string; style?: string }> };
    expect(actions.block_id).toBe(`cgo_q:${Q1}`);
    expect(actions.elements.map((e) => e.action_id)).toEqual([`cgo_q:${Q1}:yes`, `cgo_q:${Q1}:no`]);
    expect(actions.elements[0].style).toBe("primary");
    expect(parseCgoQuestionAction(`cgo_q:${Q1}:yes`)).toEqual({ question_id: Q1, answer: "yes" });
    expect(parseCgoQuestionAction("cgo_q:not-a-uuid:yes")).toBeNull();
    expect(m.text).toContain("1. Should I pause Reddit?");
  });

  const deps = (over: Partial<Parameters<typeof handleCgoQuestionClick>[1]> = {}) => ({
    tenantForTeam: async (t: string) => (t === "T1" ? "tenant-a" : null),
    ownerSlackUser: async () => "U_OWNER",
    ownerUserId: async () => "user-owner",
    answer: vi.fn(async (a: { question_id: string }) => ({ question_id: a.question_id, outcome: "answered" as const, ordinal: 1, ask: "x", answer: "yes", applied: null })),
    now: () => new Date("2026-09-28T21:02:00Z"),
    ...over,
  });

  it("a click from a non-owner in the same workspace answers nothing", async () => {
    const d = deps();
    const r = await handleCgoQuestionClick({ team_id: "T1", slack_user_id: "U_TEAMMATE", question_id: Q1, answer: "yes" }, d);
    expect(r).toEqual({ ok: false, code: "not_owner" });
    expect(d.answer).not.toHaveBeenCalled();
  });

  it("a click from an unknown workspace answers nothing", async () => {
    const d = deps();
    expect(await handleCgoQuestionClick({ team_id: "T9", slack_user_id: "U_OWNER", question_id: Q1, answer: "yes" }, d)).toEqual({ ok: false, code: "unknown_team" });
    expect(d.answer).not.toHaveBeenCalled();
  });

  it("the owner's click answers for the workspace's own tenant only, and the buttons become 'Answered'", async () => {
    const d = deps();
    const blocks = [{ type: "section" }, { type: "actions", block_id: `cgo_q:${Q1}`, elements: [] }];
    const r = await handleCgoQuestionClick({ team_id: "T1", slack_user_id: "U_OWNER", question_id: Q1, answer: "yes", message_blocks: blocks }, d);
    expect(d.answer).toHaveBeenCalledWith({ tenant_id: "tenant-a", question_id: Q1, answer: "yes", actor_user_id: "user-owner" });
    expect(r.ok && (r.blocks![1] as { type: string; elements: Array<{ text: string }> }).elements[0].text).toMatch(/^Answered: \*Yes\* · via Slack · <!date\^/);
  });

  it("another tenant's question id is 'no longer open' (the writer filters on the tenant)", async () => {
    const d = deps({ answer: vi.fn(async (a: { question_id: string }) => ({ question_id: a.question_id, outcome: "not_found" as const })) });
    const r = await handleCgoQuestionClick({ team_id: "T1", slack_user_id: "U_OWNER", question_id: Q1, answer: "yes", message_blocks: [] }, d);
    expect(r.ok && r.ephemeral).toBe("That question is no longer open.");
  });

  it("redraw leaves every other block alone", () => {
    const other = { type: "actions", block_id: "cgo_q:other", elements: [] };
    const out = redraw([other], Q1, "x");
    expect(out[0]).toBe(other);
  });
});

describe("a goal change cgo may not make becomes a yes/no whose yes is exactly that change", () => {
  const g: GoalRow = {
    id: "g1",
    objective: "New renters a week",
    target_metric: "new_renters",
    target_value: 150,
    current_value: 16,
    due_date: null,
    status: "active",
    measurement_mode: "manual_reported",
    current_value_at: "2026-09-28T00:00:00Z",
  } as unknown as GoalRow;

  it("held with recommended yes, the why, and on_yes; approved, it is written", () => {
    const args = {
      changes: [{ goal_id: "g1", target_value: 24, why: "Today it's ~16 a week; 24 is +50%." }],
      goals: [g],
      today: "2026-09-28",
      now: new Date("2026-09-28T12:00:00Z"),
      run_id: "run-1",
      acts: true,
    };
    const held = planGoalChanges(args);
    expect(held.writes).toHaveLength(0);
    expect(held.held[0]).toMatchObject({ recommended: "yes", why: "Today it's ~16 a week; 24 is +50%.", on_yes: { kind: "goal_change", goal_id: "g1", change: { target_value: 24 } } });
    expect(isYesNoAsk(held.held[0].ask)).toBe(true);
    const stale = planGoalChanges({ ...args, goals: [{ ...g, current_value_at: null } as GoalRow] });
    expect(stale.held[0]).toMatchObject({ on_yes: { goal_id: "g1", change: { target_value: 24 } } });
    const approved = planGoalChanges({ ...args, approved: true });
    expect(approved.writes).toHaveLength(1);
    expect(approved.writes[0].patch).toMatchObject({ target_value: 24 });
  });
});

describe("no HTTP GET answers a question", () => {
  it("answerQuestion(s) is called only from the POST route, the Slack click, and the email reply", () => {
    const root = join(__dirname, "..", "..", "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) {
          if (f !== "__tests__" && f !== "node_modules") walk(p);
        } else if (/\.ts$/.test(f) && /\banswerQuestions?\(/.test(readFileSync(p, "utf8"))) hits.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(
      ["routes/webhooks/slack-interactions.ts", "routes/workspace/head-of-growth.ts", "services/growth/cgo-answers.ts"].sort(),
    );
    const idx = readFileSync(join(root, "routes", "index.ts"), "utf8");
    expect(idx).toMatch(/app\.post\("\/api\/workspace\/growth\/questions\/:id\/answer", postGrowthQuestionAnswer\)/);
    expect(idx).not.toMatch(/app\.get\([^)]*postGrowthQuestionAnswer/);
  });
});
