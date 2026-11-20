import { describe, it, expect, beforeEach, vi } from "vitest";

import type { ProgressMeta } from "@/services/agents/types";

const captured = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (_table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        captured.rows.push(row);
        return { error: null };
      },
    }),
  }),
}));

import { makeEmitProgress } from "@/services/agents/progress";

beforeEach(() => {
  captured.rows = [];
});

describe("makeEmitProgress — C14 meta whitelist at emit time", () => {
  it("drops forbidden meta fields, keeping ONLY {tool_name, ms, code, iter}", async () => {
    const emit = makeEmitProgress("run-1", "tenant-1");
    const dirtyMeta = {
      tool_name: "zavi_search",
      ms: 123,
      code: "ok",
      iter: 2,
      output: "SECRET MODEL OUTPUT",
      prompt: "the full system prompt",
      raw: { anything: true },
      input: "user PII",
      text: "raw text leak",
      body: "more leak",
    } as unknown as ProgressMeta;
    await emit("tool_use_completed", dirtyMeta);

    expect(captured.rows.length).toBe(1);
    const row = captured.rows[0];
    const meta = row.meta as Record<string, unknown>;

    expect(Object.keys(meta).sort()).toEqual(["code", "iter", "ms", "tool_name"]);
    expect(meta.tool_name).toBe("zavi_search");
    expect(meta.ms).toBe(123);
    expect(meta.code).toBe("ok");
    expect(meta.iter).toBe(2);

    const serialized = JSON.stringify(row);
    for (const leak of ["SECRET MODEL OUTPUT", "the full system prompt", "user PII", "raw text leak", "more leak"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("inserts ONLY the {agent_run_id, tenant_id, stage, meta} columns", async () => {
    const emit = makeEmitProgress("run-2", "tenant-2");
    await emit("claimed", { tool_name: "x" });
    const row = captured.rows[0];
    expect(Object.keys(row).sort()).toEqual(["agent_run_id", "meta", "stage", "tenant_id"]);
    expect(row.agent_run_id).toBe("run-2");
    expect(row.tenant_id).toBe("tenant-2");
    expect(row.stage).toBe("claimed");
  });

  it("emits an empty meta object when no meta is provided (no undefined leakage)", async () => {
    const emit = makeEmitProgress("run-3", "tenant-3");
    await emit("completed");
    expect(captured.rows[0].meta).toEqual({});
  });

  it("coerces/clamps numeric meta (ms/iter floored, non-negative) and truncates strings", async () => {
    const emit = makeEmitProgress("run-4", "tenant-4");
    await emit("tool_use_completed", {
      tool_name: "a".repeat(200),
      ms: -5.9,
      code: "c".repeat(200),
      iter: 3.7,
    });
    const meta = captured.rows[0].meta as Record<string, unknown>;
    expect((meta.tool_name as string).length).toBe(64);
    expect((meta.code as string).length).toBe(64);
    expect(meta.ms).toBe(0);
    expect(meta.iter).toBe(3);
  });

  it("ignores non-string tool_name and non-finite numbers (drops them)", async () => {
    const emit = makeEmitProgress("run-5", "tenant-5");
    const malformed = { tool_name: 42, ms: Number.NaN, code: { obj: 1 }, iter: Infinity } as unknown as ProgressMeta;
    await emit("tool_use_completed", malformed);
    expect(captured.rows[0].meta).toEqual({});
  });
});
