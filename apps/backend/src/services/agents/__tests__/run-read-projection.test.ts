import { describe, it, expect, vi, beforeEach } from "vitest";

const ROW = {
  id: "run-1",
  agent_slug: "operator",
  tenant_id: "t-1",
  trigger: "chat",
  enqueued_at: "2026-05-26T00:00:00Z",
  started_at: "2026-05-26T00:00:01Z",
  finished_at: "2026-05-26T00:00:09Z",
  status: "success",
  payload: {},
  prompt_snapshot: "--- system ---\nYou are the operator. SECRET PROMPT TEXT.",
  raw_response_text: "raw model output that may echo the prompt",
  parsed: { rendered_markdown: "hi" },
  parse_ok: true,
  output_text: "hi",
  cost_tokens: 10,
  cost_usd: 0.01,
};

const maybeSingle = vi.fn();
let listRows: Record<string, unknown>[] = [];
function makeBuilder() {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.order = vi.fn(() => builder);
  builder.maybeSingle = maybeSingle;
  builder.limit = vi.fn(() => Promise.resolve({ data: listRows, error: null }));
  return builder;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => makeBuilder() }),
}));

import { getAgentRunById, listAgentRuns } from "../runner";
import { asTenantId } from "@/services/tenant-client";

describe("P0-A: agent_runs read projection blanks staff-only raw fields by default", () => {
  beforeEach(() => {
    maybeSingle.mockResolvedValue({ data: { ...ROW }, error: null });
    listRows = [{ ...ROW }];
  });

  it("getAgentRunById blanks prompt_snapshot + raw_response_text by DEFAULT (customer path)", async () => {
    const run = await getAgentRunById(asTenantId("t-1"), "run-1");
    expect(run).not.toBeNull();
    expect(run!.prompt_snapshot).toBe("");
    expect(run!.raw_response_text).toBe("");
    expect(run!.output_text).toBe("hi");
    expect(run!.status).toBe("success");
  });

  it("getAgentRunById returns raw fields ONLY when staff opts in", async () => {
    const run = await getAgentRunById(asTenantId("t-1"), "run-1", { includeRawArtifacts: true });
    expect(run!.prompt_snapshot).toContain("SECRET PROMPT TEXT");
    expect(run!.raw_response_text).toContain("raw model output");
  });

  it("listAgentRuns blanks both raw fields by DEFAULT", async () => {
    const runs = await listAgentRuns({ tenant_id: "t-1" });
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt_snapshot).toBe("");
    expect(runs[0].raw_response_text).toBe("");
  });

  it("listAgentRuns returns raw fields ONLY when staff opts in", async () => {
    const runs = await listAgentRuns({ tenant_id: "t-1", includeRawArtifacts: true });
    expect(runs[0].prompt_snapshot).toContain("SECRET PROMPT TEXT");
    expect(runs[0].raw_response_text).toContain("raw model output");
  });
});
