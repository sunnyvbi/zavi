import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));

import { z } from "zod";
import { plainValidationMessage, PublishOnBody, StepsBody } from "../actions";

const msg = (schema: z.ZodTypeAny, body: unknown) => {
  const r = schema.safeParse(body);
  if (r.success) throw new Error("expected a validation error");
  return plainValidationMessage(r.error);
};

describe("plainValidationMessage", () => {
  it("never says characters for a list or a number", () => {
    const tooMany = msg(StepsBody, { steps_done: Array.from({ length: 30 }, (_, i) => i) });
    const outOfRange = msg(StepsBody, { steps_done: [99] });
    expect(tooMany).not.toMatch(/characters/);
    expect(outOfRange).not.toMatch(/characters/);
    expect(tooMany).not.toMatch(/✖|→/);
  });

  it("keeps a refine's own sentence", () => {
    expect(msg(StepsBody, { steps_done: [1, 1] })).toMatch(/distinct/i);
    expect(msg(PublishOnBody, { publish_on: "next tuesday" })).toMatch(/YYYY-MM-DD/);
  });

  it("names the character limit for text", () => {
    expect(msg(z.object({ note: z.string().max(5) }), { note: "toolongnote" })).toBe("The note is too long. Keep it to 5 characters or fewer.");
  });
});
