import { describe, it, expect, vi } from "vitest";
vi.mock("@/services/onboarding/enrichment/sanitize", () => ({
  sanitizeFetchedContent: (s: string) => s.replace(/&#45;/g, "-"),
}));
import { readImportedFile } from "../read";

const deps = () => ({
  getCompanyFacts: vi.fn(async () => ({ facts: {} })),
  extractFacts: vi.fn(async (i: { text: string }) => ({
    facts: [{ text: "t", quote: "q".repeat(8), line: 1, key: null, value: null }],
    dropped: 0,
    truncated: false,
    seen: i.text,
  })),
  saveImportedFacts: vi.fn(async () => ({ saved: 1, conflicts: [] })),
});

describe("readImportedFile", () => {
  it("images are stored, not read", async () => {
    const d = deps();
    expect(await readImportedFile({ tenant_id: "t1", doc_id: "d1", claim_id: "c1", filename: "logo.png", buffer: Buffer.from("x") }, d as never)).toEqual({ state: "stored", reason: "image" });
    expect(d.extractFacts).not.toHaveBeenCalled();
  });
  it("unreadable files say why", async () => {
    const out = await readImportedFile({ tenant_id: "t1", doc_id: "d1", claim_id: "c1", filename: "empty.md", buffer: Buffer.from("") }, deps() as never);
    expect(out).toEqual({ state: "unreadable", reason: "the file is empty" });
  });
  it("the model never sees a secret, and the count is reported", async () => {
    const d = deps();
    const out = await readImportedFile(
      { tenant_id: "t1", doc_id: "d1", claim_id: "c1", filename: "env.md", buffer: Buffer.from("notes\nSTRIPE_KEY=sk_live_" + "a".repeat(24)) },
      d as never,
    );
    const sent = (d.extractFacts.mock.calls[0][0] as { text: string }).text;
    expect(sent).not.toContain("sk_live_");
    expect(out).toMatchObject({ state: "read", facts: 1, redactions: 1 });
  });
  it("an ENTITY-ENCODED key decoded by the sanitizer is still cut before the model sees it", async () => {
    const d = deps();
    await readImportedFile(
      { tenant_id: "t1", doc_id: "d1", claim_id: "c1", filename: "a.md", buffer: Buffer.from("notes\nopenai sk&#45;" + "b".repeat(30)) },
      d as never,
    );
    const sent = (d.extractFacts.mock.calls[0][0] as { text: string }).text;
    expect(sent).not.toMatch(/sk-b{20}/);
    expect(sent).toContain("[redacted]");
  });
  it("an entity-encoded CSV credential HEADER is caught on the post-sanitizer pass", async () => {
    const d = deps();
    await readImportedFile(
      { tenant_id: "t1", doc_id: "d1", claim_id: "c1", filename: "keys.csv", buffer: Buffer.from("name,api&#45;key\nAcme,zz9-secret-value") },
      d as never,
    );
    expect((d.extractFacts.mock.calls[0][0] as { text: string }).text).not.toContain("zz9-secret-value");
  });
  it("the model sees the file's lines on their own lines", async () => {
    const d = deps();
    await readImportedFile({ tenant_id: "t1", doc_id: "d1", claim_id: "c1", filename: "a.md", buffer: Buffer.from("one\ntwo\n\nfour") }, d as never);
    expect((d.extractFacts.mock.calls[0][0] as { text: string }).text).toBe("one\ntwo\n\nfour");
  });
  it("a model failure throws (transient: the caller frees the file and it is retried), never a terminal unreadable", async () => {
    const d = deps();
    d.extractFacts.mockRejectedValueOnce(new Error("429"));
    await expect(
      readImportedFile({ tenant_id: "t1", doc_id: "d1", claim_id: "c1", filename: "a.md", buffer: Buffer.from("hello there world") }, d as never),
    ).rejects.toThrow("429");
    expect(d.saveImportedFacts).not.toHaveBeenCalled();
  });
});
