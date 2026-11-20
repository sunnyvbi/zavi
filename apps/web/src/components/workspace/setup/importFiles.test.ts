import { describe, it, expect } from "vitest";
import { ACCEPT, admitFiles, rowLabel, MAX_FILES_PER_DROP, type FileRow } from "./importFiles";
import { fileFromServer, summarizeReads, STALE_READ_MS } from "./importReadState";

const f = (name: string, size = 10) => ({ name, size }) as File;

describe("admitFiles", () => {
  it("keeps the supported types, flags the rest with a reason, and caps a drop at 20", () => {
    const rows = admitFiles([f("a.md"), f("b.zip"), f("c.png"), f("d.pdf", 26 * 1024 * 1024)]);
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ["a.md", "waiting"], ["b.zip", "failed"], ["c.png", "waiting"], ["d.pdf", "failed"],
    ]);
    expect(rows[1].reason).toBe(".zip files aren't supported");
    expect(rows[3].reason).toBe("bigger than 25 MB");
    expect(admitFiles(Array.from({ length: 25 }, (_, i) => f(`${i}.md`)))).toHaveLength(MAX_FILES_PER_DROP);
  });
});

describe("old Office formats (spec Q15)", () => {
  it("are listed in the chooser, refused, and each says what to save it as", () => {
    for (const e of [".doc", ".xlsx", ".ppt", ".pptx"]) expect(ACCEPT.split(",")).toContain(e);
    const rows = admitFiles([f("a.doc"), f("b.xlsx"), f("c.ppt"), f("d.pptx")]);
    expect(rows.map((r) => r.reason)).toEqual([
      "save it as .docx and drop it again",
      "save it as .csv and drop it again",
      "save it as .pdf and drop it again",
      "save it as .pdf and drop it again",
    ]);
    expect(rows.every((r) => r.status === "failed")).toBe(true);
  });
});

describe("rowLabel", () => {
  const rows: FileRow[] = [
    { key: "1", name: "a.md", size: 1, status: "done", facts: 4, redactions: 2 },
    { key: "2", name: "b.md", size: 1, status: "done", facts: 1, redactions: 0 },
    { key: "3", name: "c.png", size: 1, status: "stored" },
    { key: "4", name: "d.pdf", size: 1, status: "failed", reason: "no text in it, it may be a scan" },
    { key: "5", name: "e.md", size: 1, status: "reading" },
  ];
  it("labels each row the way the spec says (no read percentage)", () => {
    expect(rows.map(rowLabel)).toEqual(["4 facts", "1 fact", "Saved, not read (image)", "Couldn't read this one (no text in it, it may be a scan)", "Reading"]);
  });
});

describe("fileFromServer / summarizeReads (the server is the source of truth)", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const row = (extraction: unknown, msAgo = 1000) => ({ id: "d", filename: "zavi-context.md", created_at: at(msAgo), extraction });
  it("maps each stored read state", () => {
    expect(fileFromServer(row(null), now)).toMatchObject({ status: "reading", unclaimed: true });
    expect(fileFromServer(row({ state: "reading", claim_id: "c" }), now)).toMatchObject({ status: "reading", unclaimed: false });
    expect(fileFromServer(row({ state: "compensating" }), now).status).toBe("reading");
    expect(fileFromServer(row({ state: "read", facts: 42, redactions: 1, truncated: true }), now)).toMatchObject({ status: "done", facts: 42, redactions: 1, truncated: true });
    expect(fileFromServer(row({ state: "stored", reason: "image" }), now).status).toBe("stored");
    expect(fileFromServer(row({ state: "unreadable", reason: "no text in it" }), now)).toMatchObject({ status: "failed", reason: "no text in it" });
  });
  it("a read open longer than 10 minutes counts as failed (matches the draft's wait)", () => {
    expect(fileFromServer(row({ state: "reading" }, STALE_READ_MS + 1), now).status).toBe("failed");
  });
  it("sums facts from files actually read", () => {
    const s = summarizeReads([
      fileFromServer(row({ state: "read", facts: 4 }), now),
      fileFromServer(row({ state: "read", facts: 1 }), now),
      fileFromServer(row(null), now),
    ]);
    expect(s.facts).toBe(5);
    expect(s.reading).toHaveLength(1);
  });
});
