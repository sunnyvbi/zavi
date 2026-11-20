import { describe, it, expect, vi, beforeEach } from "vitest";

type Neighbor = {
  note_id: string;
  title: string;
  body_markdown: string;
  note_type: string;
  cosine: number;
  created_at: string;
};

const H = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  insertCalls: [] as Array<{ table: string; arg: Record<string, unknown> }>,
  updateCalls: [] as Array<{ table: string; arg: Record<string, unknown>; eqs: Array<[string, unknown]>; isNull: string[] }>,
  sb: { current: null as unknown },
  neighbors: [] as Neighbor[],
  tierRows: [] as Array<{ id: string; trust_tier: number | null }>,
  flagOn: true,
  extractFrom: null as string | null,
  extractTo: null as string | null,
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
  getBoolSetting: vi.fn(async () => H.flagOn),
  getNumberSetting: vi.fn(async () => 0),
  getStringSetting: vi.fn(async () => ""),
}));
vi.mock("@/services/anthropic", () => ({
  DEFAULT_FAST_MODEL: "fast-model",
  getAnthropic: vi.fn(() => ({
    messages: {
      create: vi.fn(async (req: { system?: string }) => {
        if ((req.system ?? "").includes("WHEN THE FACT WAS TRUE IN THE REAL WORLD")) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ valid_from: H.extractFrom, valid_to: H.extractTo }),
              },
            ],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify({ relation: "supersede" }) }] };
      }),
    },
  })),
}));

const TENANT = "11111111-1111-1111-1111-111111111111";

function neighbor(over: Partial<Neighbor> = {}): Neighbor {
  return {
    note_id: "stale-1",
    title: "Upcar coverage",
    body_markdown: "Upcar operates in 5 states.",
    note_type: "untyped",
    cosine: 0.93,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function makeServiceClientMock() {
  function makeBuilder(table: string) {
    const st: { op: "insert" | "update" | null; selectCols: string } = { op: null, selectCols: "" };
    const rec = { table, arg: {} as Record<string, unknown>, eqs: [] as Array<[string, unknown]>, isNull: [] as string[] };
    const b: Record<string, unknown> = {};
    b.select = vi.fn((cols?: string) => {
      st.selectCols = cols ?? "";
      return b;
    });
    b.eq = vi.fn((k: string, v: unknown) => {
      rec.eqs.push([k, v]);
      return b;
    });
    b.is = vi.fn((k: string) => {
      rec.isNull.push(k);
      return b;
    });
    for (const m of ["order", "limit", "in"]) b[m] = vi.fn(() => b);
    b.insert = vi.fn((arg: Record<string, unknown>) => {
      st.op = "insert";
      rec.arg = arg;
      H.insertCalls.push({ table, arg });
      return b;
    });
    b.update = vi.fn((arg: Record<string, unknown>) => {
      st.op = "update";
      rec.arg = arg;
      H.updateCalls.push({ table, arg, eqs: rec.eqs, isNull: rec.isNull });
      return b;
    });
    b.delete = vi.fn(() => b);
    b.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    b.single = vi.fn(async () =>
      st.op === "insert" ? { data: { id: "new-note-1" }, error: null } : { data: null, error: null },
    );
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      if (st.op === "update") return resolve({ data: [{ id: "x" }], error: null });
      if (table === "memory_note" && /trust_tier/.test(st.selectCols)) {
        return resolve({ data: H.tierRows, error: null });
      }
      return resolve({ data: [], error: null });
    };
    return b;
  }
  return {
    from: vi.fn((t: string) => makeBuilder(t)),
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      H.rpcCalls.push({ name, args });
      if (name === "memory_nearest_neighbors") {
        const lim = (args.p_limit as number) ?? H.neighbors.length;
        return { data: H.neighbors.slice(0, lim), error: null };
      }
      return { data: null, error: null };
    }),
  };
}

function reset() {
  H.rpcCalls.length = 0;
  H.insertCalls.length = 0;
  H.updateCalls.length = 0;
  H.neighbors = [];
  H.tierRows = [];
  H.flagOn = true;
  H.extractFrom = null;
  H.extractTo = null;
  H.sb.current = makeServiceClientMock();
}

const noteInsert = () => H.insertCalls.find((c) => c.table === "memory_note");
const validToUpdates = () =>
  H.updateCalls.filter((u) => u.table === "memory_note" && "valid_to" in u.arg);
const verdicts = () => H.rpcCalls.filter((c) => c.name === "apply_dream_verdict");

describe("writeNote wiring — bi-temporal valid-time", () => {
  beforeEach(reset);

  it("(b) flag ON + extractable date → STAMPS valid_from/valid_to on the inserted note", async () => {
    H.neighbors = [];
    H.extractFrom = "2024-03-01T00:00:00.000Z";
    H.extractTo = "2025-06-01T00:00:00.000Z";

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, {
      title: "Upcar coverage",
      body_markdown: "Upcar operated in TX from March 2024 until June 2025.",
      note_type: "untyped",
      trust_tier: 2,
    });

    expect(res.note_id).toBe("new-note-1");
    const ins = noteInsert();
    expect(ins).toBeTruthy();
    expect(ins!.arg.valid_from).toBe("2024-03-01T00:00:00.000Z");
    expect(ins!.arg.valid_to).toBe("2025-06-01T00:00:00.000Z");
  });

  it("(b) supersede → CLOSES the old note's valid_to = new note's valid_from", async () => {
    H.neighbors = [neighbor({ note_id: "stale-1", cosine: 0.93 })];
    H.tierRows = [{ id: "stale-1", trust_tier: 2 }];
    H.extractFrom = "2025-06-01T00:00:00.000Z";
    H.extractTo = null;

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, {
      title: "Upcar coverage",
      body_markdown: "Upcar operates in 7 states as of June 2025.",
      note_type: "untyped",
      trust_tier: 2,
    });

    expect(res.note_id).toBe("new-note-1");
    const v = verdicts();
    expect(v.length).toBe(1);
    expect(v[0].args.p_existing_id).toBe("stale-1");
    const closes = validToUpdates();
    expect(closes.length).toBe(1);
    expect(closes[0].arg.valid_to).toBe("2025-06-01T00:00:00.000Z");
    expect(closes[0].eqs).toEqual(expect.arrayContaining([["id", "stale-1"], ["tenant_id", TENANT]]));
    expect(closes[0].isNull).toContain("valid_to");
  });

  it("(c) flag ON + NO extractable date → no stamping, NO interval close (never guessed)", async () => {
    H.neighbors = [neighbor({ note_id: "stale-1", cosine: 0.93 })];
    H.tierRows = [{ id: "stale-1", trust_tier: 2 }];
    H.extractFrom = null;
    H.extractTo = null;

    const { writeNote } = await import("../index");
    await writeNote(TENANT, { body_markdown: "Upcar operates in 7 states.", note_type: "untyped", trust_tier: 2 });

    const ins = noteInsert();
    expect(ins!.arg.valid_from).toBeUndefined();
    expect(ins!.arg.valid_to).toBeUndefined();
    expect(verdicts().length).toBe(1);
    expect(validToUpdates().length).toBe(0);
  });

  it("(a) flag OFF → no extraction, no stamping, no interval close (byte-identical to today)", async () => {
    H.flagOn = false;
    H.neighbors = [neighbor({ note_id: "stale-1", cosine: 0.93 })];
    H.tierRows = [{ id: "stale-1", trust_tier: 2 }];
    H.extractFrom = "2024-03-01T00:00:00.000Z";

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, { body_markdown: "Upcar operates in 7 states.", note_type: "untyped" });

    expect(res.note_id).toBe("new-note-1");
    const ins = noteInsert();
    expect(ins!.arg.valid_from).toBeUndefined();
    expect(ins!.arg.valid_to).toBeUndefined();
    expect(verdicts().length).toBe(0);
    expect(validToUpdates().length).toBe(0);
  });
});
