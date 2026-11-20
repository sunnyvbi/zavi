import { describe, it, expect, vi } from "vitest";
import { classifyKeyed, saveImportedFacts, sourceRefFor } from "../save-facts";
import { contentHash } from "@/services/memory/content-hash";

describe("classifyKeyed", () => {
  it("empty record: project it", () => expect(classifyKeyed("industry", "EdTech", undefined)).toBe("project"));
  it("another FILE's value (onboarding_enrichment from a tenant_document) is a conflict, not overwritten", () =>
    expect(classifyKeyed("industry", "Healthcare", { value: "EdTech", source: "onboarding_enrichment", verified_at: null, source_ref: "tenant_document:d0#L4~c0" })).toBe("conflict"));
  it("same value ignoring case and punctuation: nothing to do", () =>
    expect(classifyKeyed("industry", "EdTech.", { value: "edtech", source: "human_confirmed", verified_at: null })).toBe("same"));
  it("different value over an AI guess: project it", () =>
    expect(classifyKeyed("industry", "EdTech", { value: "Education", source: "ai_estimated", verified_at: null })).toBe("project"));
  it("the founder's file beats a website-scan guess: project it", () =>
    expect(classifyKeyed("industry", "EdTech", { value: "Education", source: "onboarding_enrichment", verified_at: null })).toBe("project"));
  it.each(["human_confirmed", "staff_reviewed"])("different value over a %s value: conflict (saved alongside, never over)", (source) =>
    expect(classifyKeyed("industry", "EdTech", { value: "Education", source, verified_at: null } as never)).toBe("conflict"));
  it("competitors never conflict; only an empty list is filled", () => {
    expect(classifyKeyed("competitors", "Preply", { value: "Varsity Tutors", source: "human_confirmed", verified_at: null })).toBe("same");
    expect(classifyKeyed("competitors", "Preply", undefined)).toBe("project");
  });
});

describe("saveImportedFacts", () => {
  it("a failed company-fact write fails the read instead of recording it as read", async () => {
    const writeNote = vi.fn(async () => ({ note_id: "n1", chunks: 1, entities: 0 }));
    const project = vi.fn(async () => ({ written: false, error: "rpc down" }));
    await expect(
      saveImportedFacts(
        { tenant_id: "t1", doc_id: "d1", claim_id: "c1", filename: "retro.md",
          facts: [{ text: "Industry is EdTech.", quote: "EdTech", line: 4, key: "industry", value: "EdTech" }], existing: {} },
        { writeNote, project },
      ),
    ).rejects.toThrow(/projection failed/);
  });
  it("writes one cited note per fact, projects empty keys, and returns conflicts", async () => {
    let written = 0;
    const writeNote = vi.fn(async (_t: string, _n: unknown) => ({ note_id: `n${++written}`, chunks: 1, entities: 0 }));
    const project = vi.fn(async () => ({ written: true, error: null }));
    const out = await saveImportedFacts(
      {
        tenant_id: "t1",
        doc_id: "d1",
        claim_id: "c1",
        filename: "retro.md",
        facts: [
          { text: "Industry is EdTech.", quote: "we are an EdTech company", line: 4, key: "industry", value: "EdTech" },
          { text: "Sells to parents.", quote: "our buyers are parents", line: 9, key: "who_we_serve", value: "Parents" },
          { text: "Trial to paid is 22%.", quote: "trial->paid 22% (Aug)", line: 12, key: null, value: null },
        ],
        existing: { who_we_serve: { value: "Schools", source: "human_confirmed", verified_at: null } },
      },
      { writeNote, project },
    );
    expect(out.saved).toBe(3);
    expect(project).toHaveBeenCalledOnce();
    expect(project).toHaveBeenCalledWith("t1", "industry", "EdTech", "onboarding_enrichment", sourceRefFor("d1", 4, "c1"));
    const notes = writeNote.mock.calls.map((c) => c[1] as Record<string, any>);
    expect(notes.every((n) => n.source === "document_import" && n.note_type === "tenant_reference")).toBe(true);
    expect(notes[2].source_ref).toBe("tenant_document:d1#L12~c1");
    expect(notes[2].metadata).toMatchObject({ document_id: "d1", claim_id: "c1", filename: "retro.md", line: 12, quote: "trial->paid 22% (Aug)" });
    expect(out.conflicts).toEqual([
      expect.objectContaining({ key: "who_we_serve", file_value: "Parents", existing_value: "Schools", filename: "retro.md", line: 9 }),
    ]);
    expect(notes[1].metadata.conflict).toMatchObject({ status: "open", existing_value: "Schools" });
  });

  it("the same key twice in one file: only the FIRST projects, the later one is a note only", async () => {
    let n = 0;
    const writeNote = vi.fn(async () => ({ note_id: `n${++n}`, chunks: 1, entities: 0 }));
    const project = vi.fn(async () => ({ written: true, error: null }));
    const out = await saveImportedFacts(
      {
        tenant_id: "t1",
        doc_id: "d1",
        claim_id: "c1",
        filename: "retro.md",
        facts: [
          { text: "Industry is EdTech.", quote: "we are an EdTech company", line: 4, key: "industry", value: "EdTech" },
          { text: "Industry is tutoring.", quote: "a tutoring business", line: 30, key: "industry", value: "Tutoring" },
        ],
        existing: {},
      },
      { writeNote, project },
    );
    expect(out.saved).toBe(2);
    expect(project).toHaveBeenCalledOnce();
    expect(project).toHaveBeenCalledWith("t1", "industry", "EdTech", "onboarding_enrichment", sourceRefFor("d1", 4, "c1"));
    expect(writeNote).toHaveBeenCalledTimes(2);
  });
});

describe("the same fact from two uploads", () => {
  function dedupingStore() {
    const rows = new Map<string, { id: string; source_ref: string }>();
    let n = 0;
    const writeNote = vi.fn(async (t: string, note: any) => {
      const hash = contentHash(t, note.note_type, note.body_markdown, null, note.dedup_key);
      const hit = rows.get(hash);
      if (hit) return { note_id: hit.id, chunks: 0, entities: 0 };
      const row = { id: `n${++n}`, source_ref: note.source_ref };
      rows.set(hash, row);
      return { note_id: row.id, chunks: 1, entities: 0 };
    });
    return { rows, writeNote };
  }
  const fact = { text: "Trial to paid is 22%.", quote: "trial->paid 22% (Aug)", line: 12, key: null, value: null };

  it("makes two notes, and removing one file's notes leaves the other's", async () => {
    const store = dedupingStore();
    const project = vi.fn(async () => ({ written: true, error: null }));
    const docA = "aaaaaaaa-1111-1111-1111-111111111111";
    const docB = "bbbbbbbb-2222-2222-2222-222222222222";
    for (const doc_id of [docA, docB]) {
      await saveImportedFacts({ tenant_id: "t1", doc_id, claim_id: "c1", filename: "retro.md", facts: [fact], existing: {} }, { writeNote: store.writeNote, project });
    }
    expect(store.rows.size).toBe(2);
    for (const [hash, row] of store.rows) if (row.source_ref.startsWith(`tenant_document:${docA}#`)) store.rows.delete(hash);
    expect([...store.rows.values()].map((r) => r.source_ref)).toEqual([sourceRefFor(docB, 12, "c1")]);
  });
  it("two READS of one file (two claims) make two notes, and removing one claim's leaves the other's", async () => {
    const store = dedupingStore();
    const project = vi.fn(async () => ({ written: true, error: null }));
    const doc = "aaaaaaaa-1111-1111-1111-111111111111";
    for (const claim_id of ["claim-1", "claim-2"]) {
      await saveImportedFacts({ tenant_id: "t1", doc_id: doc, claim_id, filename: "retro.md", facts: [fact], existing: {} }, { writeNote: store.writeNote, project });
    }
    expect(store.rows.size).toBe(2);
    for (const [hash, row] of store.rows) if (row.source_ref.endsWith("~claim-1")) store.rows.delete(hash);
    expect([...store.rows.values()].map((r) => r.source_ref)).toEqual([sourceRefFor(doc, 12, "claim-2")]);
  });
  it("two docs sharing their first 8 characters still make two notes (the FULL id is in the body)", async () => {
    const store = dedupingStore();
    const project = vi.fn(async () => ({ written: true, error: null }));
    for (const doc_id of ["aaaaaaaa-1111-1111-1111-111111111111", "aaaaaaaa-2222-2222-2222-222222222222"]) {
      await saveImportedFacts({ tenant_id: "t1", doc_id, claim_id: "c1", filename: "retro.md", facts: [fact], existing: {} }, { writeNote: store.writeNote, project });
    }
    expect(store.rows.size).toBe(2);
    const notes = store.writeNote.mock.calls.map((c) => c[1] as { body_markdown: string; title: string; dedup_key: string });
    expect(notes.map((n) => n.dedup_key)).toEqual(["import:aaaaaaaa-1111-1111-1111-111111111111:c1", "import:aaaaaaaa-2222-2222-2222-222222222222:c1"]);
    for (const n of notes) expect(`${n.title}\n${n.body_markdown}`).not.toMatch(/aaaaaaaa|import:|<!--/);
  });
});
