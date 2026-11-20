import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  writes: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "11111111-1111-4111-8111-111111111111", access_token: "t" })),
}));
vi.mock("@/services/memory", () => ({
  writeNote: vi.fn(async (_tenant: string, note: Record<string, unknown>) => {
    h.writes.push(note);
    h.metadata = note.metadata as Record<string, unknown>;
    return { id: "n1" };
  }),
}));
vi.mock("@/services/supabase", () => {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "order", "contains", "in", "not"]) self[m] = () => self;
    self.limit = async () =>
      table === "memory_note"
        ? { data: [{ id: "n1", title: "Plan", body_markdown: "Plan body", source: "agent", tags: ["t"], metadata: h.metadata }], error: null }
        : { data: [], error: null };
    self.maybeSingle = async () => ({ data: null, error: null });
    return self;
  };
  return { serverClientFromBearer: () => ({ from: chain }), serviceClient: () => ({ from: chain }) };
});

import { getGrowthInterview, postGrowthInterviewAnswer, postGrowthInterviewSkip } from "../growth-interview";

function call(handler: (req: Request, res: Response) => Promise<void>, body: unknown = {}) {
  let out: Record<string, unknown> = {};
  let code = 200;
  const res = {
    status(c: number) { code = c; return this; },
    json(j: Record<string, unknown>) { out = j; return this; },
  } as unknown as Response;
  return handler({ body, headers: {} } as Request, res).then(() => ({ code, out }));
}

beforeEach(() => {
  h.metadata = { strategy: { north_star: "x" }, accepted: true };
  h.writes = [];
});

describe("asking the setup questions later, once a plan exists", () => {
  it("a fresh owner is not skipped and has no customers answer", async () => {
    const { out } = await call(getGrowthInterview);
    expect(out.skipped).toBe(false);
    expect(out.customers_answered).toBe(false);
    expect(out.has_strategy).toBe(true);
  });

  it("an answer keeps the plan on the note and the customers answer is reported back", async () => {
    const { code, out } = await call(postGrowthInterviewAnswer, { key: "customers", answer: "1-5" });
    expect(code).toBe(200);
    expect(out.customers_answered).toBe(true);
    expect(h.writes[0]).toMatchObject({ id: "n1", body_markdown: "Plan body", title: "Plan" });
    expect((h.writes[0]!.metadata as { strategy: unknown }).strategy).toEqual({ north_star: "x" });
    expect((h.writes[0]!.metadata as { accepted: unknown }).accepted).toBe(true);
  });

  it("a skip is durable on the read, and leaves the plan and earlier answers alone", async () => {
    h.metadata = { ...h.metadata, interview: { answers: { metric: "More people finding us" } } };
    await call(postGrowthInterviewSkip);
    const { out } = await call(getGrowthInterview);
    expect(out.skipped).toBe(true);
    expect(h.writes[0]).toMatchObject({ body_markdown: "Plan body" });
    expect((h.metadata.interview as { answers: unknown }).answers).toEqual({ metric: "More people finding us" });
    expect(h.metadata.strategy).toEqual({ north_star: "x" });
  });
});
