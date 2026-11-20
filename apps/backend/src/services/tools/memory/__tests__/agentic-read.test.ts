import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getBoolSetting: vi.fn(),
  listNotes: vi.fn(),
  searchMemory: vi.fn(),
  writeNote: vi.fn(),
  serviceClient: vi.fn(),
}));

vi.mock("@/services/settings", () => ({
  getBoolSetting: mocks.getBoolSetting,
}));

vi.mock("@/services/memory", () => ({
  listNotes: mocks.listNotes,
  searchMemory: mocks.searchMemory,
  writeNote: mocks.writeNote,
  PRIVATE_NOTE_TYPE_SET: new Set(["agent_experience", "agent_procedural"]),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClient,
}));

import {
  memoryListTopicsTool,
  memoryReadTool,
  isAgenticReadEnabledForTenant,
} from "../agentic-read";
import { callMemoryTool } from "@/services/mcp/internal/memory";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const ctx = { tenant_id: TENANT, log: () => {} };

const ID_ANCHOR = "11111111-1111-4111-8111-111111111111";
const ID_OLD = "22222222-2222-4222-8222-222222222222";
const ID_RECENT_A = "33333333-3333-4333-8333-333333333333";
const ID_RECENT_B = "44444444-4444-4444-8444-444444444444";
const ID_SUPERSEDED = "55555555-5555-4555-8555-555555555555";
const ID_FOREIGN = "66666666-6666-4666-8666-666666666666";

function makeSb(byTable: Record<string, { data: unknown[]; error: unknown }>) {
  return {
    from(table: string) {
      const result = byTable[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {};
      const passthrough = () => chain;
      for (const m of ["select", "eq", "neq", "in", "is", "contains", "order", "limit"]) {
        chain[m] = passthrough;
      }
      chain.maybeSingle = () =>
        Promise.resolve({
          data: Array.isArray(result.data) ? result.data[0] ?? null : result.data,
          error: result.error,
        });
      chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
      return chain;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("flag gate (isAgenticReadEnabledForTenant)", () => {
  it("delegates to getBoolSetting with the flag key", async () => {
    mocks.getBoolSetting.mockResolvedValue(true);
    await expect(isAgenticReadEnabledForTenant(TENANT)).resolves.toBe(true);
    expect(mocks.getBoolSetting).toHaveBeenCalledWith("memory_agentic_read_enabled", TENANT);
  });
});

describe("callMemoryTool flag gating (defense-in-depth)", () => {
  it("flag OFF → list_topics + read return tool_unknown; search still resolves", async () => {
    mocks.getBoolSetting.mockResolvedValue(false);
    mocks.searchMemory.mockResolvedValue([]);

    const lt = await callMemoryTool(TENANT, "list_topics", {});
    expect(lt.is_error).toBe(true);
    expect(JSON.parse(lt.content as string).error).toBe("tool_unknown");

    const rd = await callMemoryTool(TENANT, "read", { note_ids: [ID_RECENT_A] });
    expect(rd.is_error).toBe(true);
    expect(JSON.parse(rd.content as string).error).toBe("tool_unknown");

    const s = await callMemoryTool(TENANT, "search", { query: "hello", k: 3 });
    expect(s.is_error).toBe(false);
  });

  it("flag ON → list_topics is callable", async () => {
    mocks.getBoolSetting.mockResolvedValue(true);
    mocks.listNotes.mockResolvedValue([]);
    mocks.serviceClient.mockReturnValue(
      makeSb({ memory_note: { data: [], error: null }, takes: { data: [], error: null }, memory_relation: { data: [], error: null } }),
    );

    const lt = await callMemoryTool(TENANT, "list_topics", {});
    expect(lt.is_error).toBe(false);
    expect(JSON.parse(lt.content as string)).toHaveProperty("topics");
  });
});

describe("memory_list_topics — non-recency-biased blend", () => {
  it("surfaces a high-salience OLD note that recency-only would have dropped", async () => {
    mocks.listNotes.mockResolvedValue([
      { id: ID_RECENT_A, title: "Recent A", created_at: "2026-06-26", note_type: "tenant_project", tags: ["growth"], slug: null },
      { id: ID_RECENT_B, title: "Recent B", created_at: "2026-06-25", note_type: "tenant_project", tags: ["growth"], slug: null },
    ]);

    mocks.serviceClient.mockReturnValue(
      makeSb({
        takes: {
          data: [
            { source_note_id: ID_OLD },
            { source_note_id: ID_OLD },
            { source_note_id: ID_OLD },
          ],
          error: null,
        },
        memory_relation: { data: [{ source_note_id: ID_OLD }], error: null },
        memory_note: {
          data: [
            { id: ID_ANCHOR, title: "Company", created_at: "2026-01-01", note_type: "anchor", tags: [], slug: "company", superseded_by: null },
            { id: ID_OLD, title: "Foundational policy (old, important)", created_at: "2026-02-01", note_type: "tenant_reference", tags: ["policy"], slug: null, superseded_by: null },
          ],
          error: null,
        },
      }),
    );

    const out = (await memoryListTopicsTool.execute(ctx, { limit: 2 })) as {
      topics: Array<{ topic: string; notes: Array<{ note_id: string }> }>;
    };
    const allIds = out.topics.flatMap((t) => t.notes.map((n) => n.note_id));

    expect(allIds).toContain(ID_OLD);
    expect(allIds).toContain(ID_ANCHOR);
    expect(allIds).toContain(ID_RECENT_A);
  });

  it("excludes superseded notes (listNotes already filters; anchors/by-id JS-guard)", async () => {
    mocks.listNotes.mockResolvedValue([]);
    mocks.serviceClient.mockReturnValue(
      makeSb({
        takes: { data: [{ source_note_id: ID_SUPERSEDED }], error: null },
        memory_relation: { data: [], error: null },
        memory_note: {
          data: [
            { id: ID_SUPERSEDED, title: "Stale", created_at: "2026-02-01", note_type: "tenant_reference", tags: ["x"], slug: null, superseded_by: ID_RECENT_A },
          ],
          error: null,
        },
      }),
    );

    const out = (await memoryListTopicsTool.execute(ctx, {})) as {
      topics: Array<{ notes: Array<{ note_id: string }> }>;
    };
    const allIds = out.topics.flatMap((t) => t.notes.map((n) => n.note_id));
    expect(allIds).not.toContain(ID_SUPERSEDED);
  });

  it("titles + ids only — never bodies", async () => {
    mocks.listNotes.mockResolvedValue([
      { id: ID_RECENT_A, title: "Recent A", created_at: "2026-06-26", note_type: "tenant_project", tags: ["growth"], slug: null },
    ]);
    mocks.serviceClient.mockReturnValue(
      makeSb({ takes: { data: [], error: null }, memory_relation: { data: [], error: null }, memory_note: { data: [], error: null } }),
    );
    const out = (await memoryListTopicsTool.execute(ctx, {})) as {
      topics: Array<{ notes: Array<Record<string, unknown>> }>;
    };
    const entry = out.topics[0].notes[0];
    expect(entry).toHaveProperty("title");
    expect(entry).toHaveProperty("note_id");
    expect(entry).not.toHaveProperty("body");
    expect(entry).not.toHaveProperty("body_markdown");
  });
});

describe("memory_read", () => {
  it("tenant-scoped: a foreign-tenant id lands in not_found", async () => {
    mocks.serviceClient.mockReturnValue(
      makeSb({
        memory_note: {
          data: [
            { id: ID_RECENT_A, title: "Mine", body_markdown: "secret body", note_type: "tenant_project", created_at: "2026-06-26", superseded_by: null },
          ],
          error: null,
        },
      }),
    );

    const out = (await memoryReadTool.execute(ctx, { note_ids: [ID_RECENT_A, ID_FOREIGN] })) as {
      notes: Array<{ note_id: string; body_markdown: string }>;
      not_found: string[];
      superseded: Array<{ note_id: string }>;
    };
    expect(out.notes.map((n) => n.note_id)).toEqual([ID_RECENT_A]);
    expect(out.notes[0].body_markdown).toBe("secret body");
    expect(out.not_found).toContain(ID_FOREIGN);
  });

  it("superseded id → superseded list, not notes", async () => {
    mocks.serviceClient.mockReturnValue(
      makeSb({
        memory_note: {
          data: [
            { id: ID_SUPERSEDED, title: "Stale", body_markdown: "old", note_type: "tenant_reference", created_at: "2026-02-01", superseded_by: ID_RECENT_A },
          ],
          error: null,
        },
      }),
    );
    const out = (await memoryReadTool.execute(ctx, { note_ids: [ID_SUPERSEDED] })) as {
      notes: unknown[];
      superseded: Array<{ note_id: string; reason: string }>;
    };
    expect(out.notes).toHaveLength(0);
    expect(out.superseded).toEqual([{ note_id: ID_SUPERSEDED, reason: "superseded" }]);
  });

  it("returns bodies for valid ids", async () => {
    mocks.serviceClient.mockReturnValue(
      makeSb({
        memory_note: {
          data: [
            { id: ID_RECENT_A, title: "A", body_markdown: "body A", note_type: "tenant_project", created_at: "2026-06-26", superseded_by: null },
            { id: ID_RECENT_B, title: "B", body_markdown: "body B", note_type: "tenant_project", created_at: "2026-06-25", superseded_by: null },
          ],
          error: null,
        },
      }),
    );
    const out = (await memoryReadTool.execute(ctx, { note_ids: [ID_RECENT_A, ID_RECENT_B] })) as {
      notes: Array<{ note_id: string; body_markdown: string }>;
    };
    expect(out.notes).toHaveLength(2);
    expect(out.notes.map((n) => n.body_markdown)).toEqual(["body A", "body B"]);
  });

  it("rejects > 20 ids (cap enforced at input validation)", async () => {
    const ids = Array.from({ length: 21 }, (_, i) =>
      `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
    );
    await expect(memoryReadTool.execute(ctx, { note_ids: ids })).rejects.toThrow();
  });

  it("body cap: a too-long body is truncated with a marker, within the per-note cap", async () => {
    const huge = "x".repeat(25_000);
    mocks.serviceClient.mockReturnValue(
      makeSb({
        memory_note: {
          data: [
            { id: ID_RECENT_A, title: "Big", body_markdown: huge, note_type: "tenant_project", created_at: "2026-06-26", agent_slug: null, superseded_by: null },
          ],
          error: null,
        },
      }),
    );
    const out = (await memoryReadTool.execute(ctx, { note_ids: [ID_RECENT_A] })) as {
      notes: Array<{ body_markdown: string }>;
    };
    expect(out.notes[0].body_markdown.length).toBeLessThanOrEqual(20_000);
    expect(out.notes[0].body_markdown.endsWith("…[truncated]")).toBe(true);
  });

  it("total-body budget: 20 max-size notes → summed bodies never exceed MAX_TOTAL_BODY_CHARS", async () => {
    const ids = Array.from({ length: 20 }, (_, i) =>
      `0000000a-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
    );
    const big = "y".repeat(20_000);
    mocks.serviceClient.mockReturnValue(
      makeSb({
        memory_note: {
          data: ids.map((id) => ({
            id,
            title: "N",
            body_markdown: big,
            note_type: "tenant_project",
            created_at: "2026-06-26",
            agent_slug: null,
            superseded_by: null,
          })),
          error: null,
        },
      }),
    );
    const out = (await memoryReadTool.execute(ctx, { note_ids: ids })) as {
      notes: Array<{ body_markdown: string }>;
    };
    const totalBody = out.notes.reduce((sum, n) => sum + n.body_markdown.length, 0);
    expect(totalBody).toBeLessThanOrEqual(120_000);
    expect(out.notes).toHaveLength(20);
    expect(out.notes.every((n) => n.body_markdown === big || n.body_markdown === "")).toBe(true);
  });
});

const ID_B_EPISODIC = "77777777-7777-4777-8777-777777777777";

describe("agent-scoped episodic isolation (cross-agent)", () => {
  it("list_topics: agent A cannot see agent B's agent_experience note; agent B can", async () => {
    mocks.listNotes.mockResolvedValue([]);
    mocks.serviceClient.mockReturnValue(
      makeSb({
        takes: { data: [{ source_note_id: ID_B_EPISODIC }, { source_note_id: ID_B_EPISODIC }], error: null },
        memory_relation: { data: [], error: null },
        memory_note: {
          data: [
            { id: ID_B_EPISODIC, title: "B's private experience", created_at: "2026-02-01", note_type: "agent_experience", tags: ["exp"], slug: null, agent_slug: "agent-b", superseded_by: null, body_markdown: "B secret" },
          ],
          error: null,
        },
      }),
    );

    const idsFor = async (agent_slug: string | undefined) => {
      const out = (await memoryListTopicsTool.execute(
        { tenant_id: TENANT, log: () => {}, agent_slug },
        {},
      )) as { topics: Array<{ notes: Array<{ note_id: string }> }> };
      return out.topics.flatMap((t) => t.notes.map((n) => n.note_id));
    };

    expect(await idsFor("agent-a")).not.toContain(ID_B_EPISODIC);
    expect(await idsFor("agent-b")).toContain(ID_B_EPISODIC);
    expect(await idsFor(undefined)).not.toContain(ID_B_EPISODIC);
  });

  it("memory_read: agent A gets not_found for B's episodic note; agent B reads it", async () => {
    mocks.serviceClient.mockReturnValue(
      makeSb({
        memory_note: {
          data: [
            { id: ID_B_EPISODIC, title: "B's private experience", body_markdown: "B secret", note_type: "agent_experience", created_at: "2026-02-01", agent_slug: "agent-b", superseded_by: null },
          ],
          error: null,
        },
      }),
    );

    const aOut = (await memoryReadTool.execute(
      { tenant_id: TENANT, log: () => {}, agent_slug: "agent-a" },
      { note_ids: [ID_B_EPISODIC] },
    )) as { notes: unknown[]; not_found: string[] };
    expect(aOut.notes).toHaveLength(0);
    expect(aOut.not_found).toContain(ID_B_EPISODIC);

    const bOut = (await memoryReadTool.execute(
      { tenant_id: TENANT, log: () => {}, agent_slug: "agent-b" },
      { note_ids: [ID_B_EPISODIC] },
    )) as { notes: Array<{ note_id: string; body_markdown: string }>; not_found: string[] };
    expect(bOut.notes.map((n) => n.note_id)).toEqual([ID_B_EPISODIC]);
    expect(bOut.notes[0].body_markdown).toBe("B secret");
  });
});

describe("topic cap retention", () => {
  it(">60 topics + a high-salience OLD note under a rare tag → still present", async () => {
    mocks.listNotes.mockResolvedValue(
      Array.from({ length: 61 }, (_, i) => ({
        id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
        title: `Recent ${i}`,
        created_at: "2026-06-26",
        note_type: "tenant_project",
        tags: [`r${i}`],
        slug: null,
      })),
    );
    mocks.serviceClient.mockReturnValue(
      makeSb({
        takes: { data: [{ source_note_id: ID_OLD }, { source_note_id: ID_OLD }, { source_note_id: ID_OLD }], error: null },
        memory_relation: { data: [], error: null },
        memory_note: {
          data: [
            { id: ID_OLD, title: "Rare but load-bearing", created_at: "2026-01-01", note_type: "tenant_reference", tags: ["rare-policy"], slug: null, agent_slug: null, superseded_by: null },
          ],
          error: null,
        },
      }),
    );

    const out = (await memoryListTopicsTool.execute(ctx, {})) as {
      topics: Array<{ topic: string; notes: Array<{ note_id: string }> }>;
    };
    const allIds = out.topics.flatMap((t) => t.notes.map((n) => n.note_id));
    expect(allIds).toContain(ID_OLD);
    expect(out.topics.find((t) => t.topic === "rare-policy")).toBeDefined();
  });
});
