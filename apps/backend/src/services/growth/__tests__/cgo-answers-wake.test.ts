import { describe, it, expect, vi, beforeEach } from "vitest";

type Q = { id: string; tenant_id: string; ask: string; status: string; answer: string | null; applied_line: string | null; answered_at: string | null; resolved_run_id: string | null };
const questions: Q[] = [];
const sent = vi.hoisted(() => ({ events: [] as unknown[] }));
const enqueue = vi.hoisted(() => vi.fn(async (_i: unknown) => ({ enqueued: true, run_id: "run-x" })));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  tenantClient: () => ({
    from: () => {
      const filters: Array<(r: Q) => boolean> = [];
      const q = {
        select: () => q,
        eq: (k: keyof Q, v: unknown) => (filters.push((r) => r[k] === v), q),
        in: (k: keyof Q, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
        is: (k: keyof Q, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
        gte: (k: keyof Q, v: string) => (filters.push((r) => String(r[k] ?? "") >= v), q),
        order: () => q,
        limit: async () => ({ data: questions.filter((r) => filters.every((f) => f(r))), error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("../goal-owner", () => ({ enqueueGoalOwnerRun: enqueue }));
vi.mock("@/../workers/client", () => ({ inngest: { send: async (e: unknown) => void sent.events.push(e) } }));

import { wakeCgoWithAnswers, wakeCgoForRecentAnswers } from "../cgo-answers";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-17T06:39:30Z");
const answered = (id: string, at: string, over: Partial<Q> = {}): Q => ({
  id,
  tenant_id: T,
  ask: `Question ${id}?`,
  status: "answered",
  answer: "yes",
  applied_line: null,
  answered_at: at,
  resolved_run_id: null,
  ...over,
});

beforeEach(() => {
  questions.length = 0;
  sent.events.length = 0;
  enqueue.mockClear();
});

describe("answers close together", () => {
  it("each answer only signals the debounced worker; it starts no review itself", async () => {
    await wakeCgoWithAnswers(T, "web", "ignored", "answer:q1,q2");
    expect(sent.events).toEqual([{ name: "cgo/answers.answered", data: { tenant_id: T, via: "web", question_ids: ["q1", "q2"] } }]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("2026-10-17 06:36-06:37: three answers become one review that reads all three", async () => {
    questions.push(
      answered("q1", "2026-10-17T06:36:51Z"),
      answered("q2", "2026-10-17T06:37:02Z", { answer: "no" }),
      answered("q3", "2026-10-17T06:37:18Z", { applied_line: "Goal set to 20 signups" }),
      answered("q-not-now", "2026-10-17T06:37:20Z", { answer: "not_now" }),
      answered("q-acted", "2026-10-17T06:30:00Z", { resolved_run_id: "earlier-run" }),
      answered("q-old", "2026-10-17T04:00:00Z"),
    );
    const r = await wakeCgoForRecentAnswers({ tenant_id: T, via: "web", question_ids: ["q3"] }, NOW);
    expect(r).toEqual({ enqueued: true, answers: 3 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const input = enqueue.mock.calls[0][0] as { founder_reply: { text: string; reply_run_id: string } };
    expect(input.founder_reply.reply_run_id).toBe("answer:q1,q2,q3");
    expect(input.founder_reply.text.split("\n")).toEqual([
      'Your question "Question q1?" was answered: Yes.',
      'Your question "Question q2?" was answered: No.',
      'Your question "Question q3?" was answered: Yes. Already applied: Goal set to 20 signups',
    ]);
  });

  it("an event naming another tenant's question does nothing (C8)", async () => {
    questions.push(answered("q1", "2026-10-17T06:36:51Z", { tenant_id: OTHER }));
    expect(await wakeCgoForRecentAnswers({ tenant_id: T, via: "web", question_ids: ["q1"] }, NOW)).toEqual({ enqueued: false, skipped: "tenant_mismatch" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("only Not now answers: no review", async () => {
    questions.push(answered("q1", "2026-10-17T06:36:51Z", { answer: "not_now" }));
    expect(await wakeCgoForRecentAnswers({ tenant_id: T, via: "web", question_ids: ["q1"] }, NOW)).toEqual({ enqueued: false, skipped: "nothing_to_act_on" });
  });
});
