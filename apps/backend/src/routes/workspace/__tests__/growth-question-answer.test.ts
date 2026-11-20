import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

let role: string | null = "owner";
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ user_id: "u1", tenant_id: "tenant-a", access_token: "t" }),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: role ? { role } : null, error: null }) }) }) }) }),
  }),
  serverClientFromBearer: vi.fn(),
}));
const answerQuestion = vi.fn(async (a: { question_id: string }) => ({ question_id: a.question_id, outcome: "answered", ordinal: 1, ask: "x", answer: "yes", applied: null }));
vi.mock("@/services/growth/cgo-answers", () => ({
  answerQuestion: (a: { question_id: string }) => answerQuestion(a),
  deferredWake: () => ({ wake: async () => {}, run: async () => {} }),
}));

import { postGrowthQuestionAnswer } from "../head-of-growth";

const Q1 = "11111111-1111-4111-8111-111111111111";
function call(body: unknown) {
  const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  return postGrowthQuestionAnswer({ params: { id: Q1 }, body } as unknown as Request, res as unknown as Response).then(() => res);
}

beforeEach(() => {
  role = "owner";
  answerQuestion.mockClear();
});

describe("POST /api/workspace/growth/questions/:id/answer", () => {
  it("a member or admin is refused and nothing is answered", async () => {
    for (const r of ["member", "admin", null]) {
      role = r;
      const res = await call({ answer: "yes" });
      expect(res.statusCode).toBe(403);
    }
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("the owner's answer goes to the one writer for the session's tenant, via web", async () => {
    const res = await call({ answer: "no" });
    expect(res.statusCode).toBe(200);
    expect(answerQuestion).toHaveBeenCalledWith({ tenant_id: "tenant-a", question_id: Q1, answer: "no", via: "web", actor_user_id: "u1" });
  });

  it("anything but yes, no or {text} is refused", async () => {
    expect((await call({ answer: "maybe" })).statusCode).toBe(400);
    expect((await call({ answer: { text: "   " } })).statusCode).toBe(400);
    expect((await call({ answer: { text: "" } })).statusCode).toBe(400);
    expect((await call({ answer: { text: "x".repeat(501) } })).statusCode).toBe(400);
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("the owner's own words go to the one writer as {text}, trimmed", async () => {
    const res = await call({ answer: { text: "  Keep 150 for now.  " } });
    expect(res.statusCode).toBe(200);
    expect(answerQuestion).toHaveBeenCalledWith({ tenant_id: "tenant-a", question_id: Q1, answer: { text: "Keep 150 for now." }, via: "web", actor_user_id: "u1" });
  });

  it("a member cannot answer in their own words either", async () => {
    role = "member";
    expect((await call({ answer: { text: "Keep 150." } })).statusCode).toBe(403);
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});
