import { describe, it, expect, vi } from "vitest";

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import { childSection } from "../handoff-batch-join";

const batch = { tenant_id: "t1", operator_thread_id: "th1" };
const row = {
  id: "c1",
  agent_slug: "meta_ads",
  status: "success",
  output_text: "40 clicks at $2 each.",
  raw_response_text: null,
  error: null,
  tool_calls: null,
  outcome: null,
  parsed: null,
};

describe("childSection with the real body composer", () => {
  it("heads a clean answer with the specialist's name and no status line", () => {
    expect(childSection(batch, row as never)).toBe("**Meta Ads**\n40 clicks at $2 each.");
  });

  it("a child with no customer-safe text keeps a status line under its name", () => {
    expect(childSection(batch, { ...row, output_text: "See the sandbox log." } as never)).toBe("**Meta Ads**\nFinished.");
  });

  it("a failed child still says it could not finish", () => {
    const section = childSection(batch, { ...row, status: "failed", error: "boom" } as never);
    expect(section).toMatch(/^\*\*Meta Ads\*\* couldn't finish\.\nThis didn't finish\./);
    expect(section).not.toContain("40 clicks");
  });
});
