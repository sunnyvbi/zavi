import { describe, it, expect, vi, beforeEach } from "vitest";

type Query = {
  filters: Array<[string, string, unknown]>;
  ordered: boolean;
  limit?: number;
};
const queries: Query[] = [];
let rows: Array<Record<string, unknown>> = [];

function builder() {
  const q: Query = { filters: [], ordered: false };
  queries.push(q);
  const b: Record<string, unknown> = {};
  const chain = (op: string) => (k: string, v: unknown) => {
    q.filters.push([op, k, v]);
    return b;
  };
  b.select = () => b;
  b.eq = chain("eq");
  b.in = chain("in");
  b.is = chain("is");
  b.order = () => {
    q.ordered = true;
    return b;
  };
  b.limit = (n: number) => {
    q.limit = n;
    return b;
  };
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
    let out = rows.filter((r) =>
      q.filters.every(([op, k, v]) =>
        op === "eq" ? r[k] === v : op === "in" ? (v as unknown[]).includes(r[k]) : r[k] == null,
      ),
    );
    if (q.ordered) out = [...out].sort((a, c) => String(c.created_at).localeCompare(String(a.created_at)));
    if (q.limit !== undefined) out = out.slice(0, q.limit);
    return Promise.resolve({ data: out, error: null }).then(res, rej);
  };
  return b;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => builder() }),
}));

const T = "11111111-1111-1111-1111-111111111111";
const OTHER_T = "99999999-9999-9999-9999-999999999999";

function note(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: T,
    agent_slug: "engineer",
    note_type: "agent_experience",
    superseded_by: null,
    archived_at: null,
    title: `note ${id}`,
    body_markdown: `body ${id}`,
    created_at: `2026-09-${id.padStart(2, "0")}T00:00:00Z`,
    ...over,
  };
}

beforeEach(() => {
  queries.length = 0;
  rows = Array.from({ length: 12 }, (_, i) => note(String(i + 1)));
});

describe("loadAgentEpisodicRelevant", () => {
  it("puts the most similar notes first and keeps k", async () => {
    const { loadAgentEpisodicRelevant } = await import("../loader");
    const search = vi.fn(async () => [
      { note_id: "3", note_type: "agent_experience", agent_slug: "engineer" },
      { note_id: "7", note_type: "agent_procedural", agent_slug: "engineer" },
    ]);
    const out = await loadAgentEpisodicRelevant(T, "engineer", "add a banner", { k: 5, search });
    expect(search).toHaveBeenCalledWith(T, "add a banner", 40, expect.objectContaining({ agent_slug: "engineer" }));
    const titles = [...out.matchAll(/### \d+\. (note \d+)/g)].map((m) => m[1]);
    expect(titles).toEqual(["note 3", "note 7", "note 12", "note 11", "note 10"]);
  });

  it("drops hits that are not this agent's own episodic notes in this tenant", async () => {
    rows.push(note("50", { tenant_id: OTHER_T }));
    rows.push(note("51", { agent_slug: "pm" }));
    rows.push(note("52", { note_type: "fact" }));
    rows.push(note("53", { archived_at: "2026-09-20" }));
    rows.push(note("54", { superseded_by: "x" }));
    const { loadAgentEpisodicRelevant } = await import("../loader");
    const search = vi.fn(async () => [
      { note_id: "50", note_type: "agent_experience", agent_slug: "engineer" },
      { note_id: "51", note_type: "agent_experience", agent_slug: "pm" },
      { note_id: "52", note_type: "fact", agent_slug: "engineer" },
      { note_id: "53", note_type: "agent_experience", agent_slug: "engineer" },
      { note_id: "54", note_type: "agent_experience", agent_slug: "engineer" },
    ]);
    const out = await loadAgentEpisodicRelevant(T, "engineer", "task", { k: 3, search });
    expect(out).not.toMatch(/note 5[0-4]/);
    const ranked = queries.find((q) => q.filters.some(([op, k]) => op === "in" && k === "id"));
    expect(ranked?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "tenant_id", T],
        ["eq", "agent_slug", "engineer"],
        ["is", "superseded_by", null],
        ["is", "archived_at", null],
      ]),
    );
    expect([...out.matchAll(/### \d+\./g)]).toHaveLength(3);
  });

  it("falls back to the most recent when the search throws", async () => {
    const { loadAgentEpisodicRelevant } = await import("../loader");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const search = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const out = await loadAgentEpisodicRelevant(T, "engineer", "task", { k: 5, search });
    const titles = [...out.matchAll(/### \d+\. (note \d+)/g)].map((m) => m[1]);
    expect(titles).toEqual(["note 12", "note 11", "note 10", "note 9", "note 8"]);
    warn.mockRestore();
  });

  it("skips the search when there is no task text", async () => {
    const { loadAgentEpisodicRelevant } = await import("../loader");
    const search = vi.fn(async () => []);
    const out = await loadAgentEpisodicRelevant(T, "engineer", "  ", { k: 2, search });
    expect(search).not.toHaveBeenCalled();
    expect([...out.matchAll(/### \d+\./g)]).toHaveLength(2);
  });

  it("returns '' when the agent has no notes", async () => {
    rows = [];
    const { loadAgentEpisodicRelevant } = await import("../loader");
    expect(await loadAgentEpisodicRelevant(T, "engineer", "x", { search: async () => [] })).toBe("");
  });
});
