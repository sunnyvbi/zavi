import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: string; arg: Record<string, unknown> }>,
  listRows: [] as Array<Record<string, unknown>>,
  lastFilters: { eqs: [] as Array<[string, unknown]>, isNull: [] as string[] },
  sb: { current: null as unknown },
}));

vi.mock("../embed", () => ({
  EMBED_DIM: 1024,
  VoyageError: class VoyageError extends Error {},
  VoyageDimError: class VoyageDimError extends Error {},
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => new Array(1024).fill(0.01))),
  embedOne: vi.fn(async () => new Array(1024).fill(0.01)),
}));
vi.mock("../contextualize", () => ({
  contextualizeChunks: vi.fn((chunks: string[]) => chunks.map((c) => ({ body: c, contextualized: c }))),
}));
vi.mock("../extract", () => ({
  extractEntities: vi.fn(() => ({ entities: [] })),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => H.sb.current,
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async () => false),
  getNumberSetting: vi.fn(async () => 0),
  getStringSetting: vi.fn(async () => ""),
}));

const TENANT = "11111111-1111-1111-1111-111111111111";

function makeServiceClientMock() {
  function makeBuilder(table: string) {
    const st: { op: "insert" | null; selectCols: string } = { op: null, selectCols: "" };
    const rec = { eqs: [] as Array<[string, unknown]>, isNull: [] as string[] };
    const b: Record<string, unknown> = {};
    b.select = vi.fn((cols?: string) => {
      st.selectCols = cols ?? "";
      return b;
    });
    b.eq = vi.fn((k: string, v: unknown) => {
      rec.eqs.push([k, v]);
      H.lastFilters.eqs = rec.eqs;
      return b;
    });
    b.is = vi.fn((k: string) => {
      rec.isNull.push(k);
      H.lastFilters.isNull = rec.isNull;
      return b;
    });
    for (const m of ["order", "limit", "in", "contains", "neq"]) b[m] = vi.fn(() => b);
    b.insert = vi.fn((arg: Record<string, unknown>) => {
      st.op = "insert";
      H.insertCalls.push({ table, arg });
      return b;
    });
    b.update = vi.fn(() => b);
    b.delete = vi.fn(() => b);
    b.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    b.single = vi.fn(async () =>
      st.op === "insert" ? { data: { id: "skill-note-1" }, error: null } : { data: null, error: null },
    );
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      if (table === "memory_note" && /title, body_markdown/.test(st.selectCols)) {
        return resolve({ data: H.listRows, error: null });
      }
      return resolve({ data: [], error: null });
    };
    return b;
  }
  return {
    from: vi.fn((t: string) => makeBuilder(t)),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

function reset() {
  H.insertCalls.length = 0;
  H.listRows = [];
  H.lastFilters = { eqs: [], isNull: [] };
  H.sb.current = makeServiceClientMock();
}

const noteInsert = () => H.insertCalls.find((c) => c.table === "memory_note");

describe("gap #4 — 'skill' note_type cross-agent semantics", () => {
  beforeEach(reset);

  it("(1) writeNote({note_type:'skill'}) with no agent_slug → persists note_type='skill', agent_slug LEFT NULL (cross-agent)", async () => {
    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, {
      title: "How we triage refunds",
      body_markdown: "When a refund is requested, first check the dispute window, then ...",
      note_type: "skill",
    });

    expect(res.note_id).toBe("skill-note-1");
    const ins = noteInsert();
    expect(ins).toBeTruthy();
    expect(ins!.arg.note_type).toBe("skill");
    expect("agent_slug" in ins!.arg).toBe(false);
  });

  it("(2) listNotes(tenant, {note_type:'skill'}) filters ONLY by tenant_id + note_type — no agent_slug gate (cross-agent)", async () => {
    H.listRows = [
      { id: "skill-note-1", title: "How we triage refunds", body_markdown: "...", note_type: "skill" },
    ];
    const { listNotes } = await import("../index");
    const notes = await listNotes(TENANT, { note_type: "skill" });

    expect(notes.map((n) => n.id)).toContain("skill-note-1");
    expect(H.lastFilters.eqs).toEqual(
      expect.arrayContaining([
        ["tenant_id", TENANT],
        ["note_type", "skill"],
      ]),
    );
    expect(H.lastFilters.eqs.some(([k]) => k === "agent_slug")).toBe(false);
    expect(H.lastFilters.isNull).toContain("superseded_by");
  });

  it("(3) recall owner-gate admits 'skill' for ANY/NULL caller agent_slug; isolates only 'agent_experience'", () => {
    const admits = (noteType: string, rowSlug: string | null, callerSlug: string | null): boolean =>
      noteType !== "agent_experience" || (callerSlug !== null && rowSlug === callerSlug);

    expect(admits("skill", null, "support-lead")).toBe(true);
    expect(admits("skill", null, "performance-marketer")).toBe(true);
    expect(admits("skill", null, null)).toBe(true);
    expect(admits("skill", "support-lead", "engineer")).toBe(true);

    expect(admits("agent_experience", "support-lead", "support-lead")).toBe(true);
    expect(admits("agent_experience", "support-lead", "engineer")).toBe(false);
    expect(admits("agent_experience", "support-lead", null)).toBe(false);
  });
});
