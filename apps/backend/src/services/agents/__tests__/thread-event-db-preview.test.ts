import { describe, it, expect, vi, beforeEach } from "vitest";

const inserted = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push(row);
        return { error: null };
      },
    }),
  }),
}));

import { emitThreadEvent } from "../thread-event";

beforeEach(() => {
  inserted.length = 0;
});

const emit = (tool_name: string) =>
  emitThreadEvent({
    agent_run_id: "00000000-0000-0000-0000-000000000001",
    agent_slug: "pm",
    tenant_id: "00000000-0000-0000-0000-000000000002",
    thread_id: null,
    kind: "tool_call",
    body: { tool_name, target: "", ms: 3, code: "ok", output_preview: '{"rows":[{"email":"a@b.c"}]}' },
  } as never);

describe("thread_event DB tool preview", () => {
  it.each(["operator_db__codeact", "mcp__operator_db__query", "mcp__server__operator_db__summary"])("%s preview is empty", async (name) => {
    await emit(name);
    const body = (inserted[0]?.body ?? {}) as { output_preview?: string };
    expect(body.output_preview).toBe("");
  });
  it("a GitHub tool keeps its preview", async () => {
    await emit("github__read_file");
    const body = (inserted[0]?.body ?? {}) as { output_preview?: string };
    expect(body.output_preview).toContain("rows");
  });
});
