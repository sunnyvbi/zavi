
import { describe, it, expect } from "vitest";
import { normalizeForHash, contentHash } from "../content-hash";

describe("normalizeForHash (v1: collapse whitespace, trim, lowercase)", () => {
  it("collapses internal whitespace runs to one space", () => {
    expect(normalizeForHash("a   b\t\tc\n\nd")).toBe("a b c d");
  });
  it("trims leading/trailing whitespace", () => {
    expect(normalizeForHash("  hello world  ")).toBe("hello world");
  });
  it("lowercases", () => {
    expect(normalizeForHash("Default Repo For Engineer")).toBe("default repo for engineer");
  });
  it("treats null/empty as empty string", () => {
    expect(normalizeForHash("")).toBe("");
    // @ts-expect-error — guards the runtime null path
    expect(normalizeForHash(null)).toBe("");
  });
  it("two phrasings that differ only in whitespace/case normalize equal", () => {
    expect(normalizeForHash("Weekend payouts in 11 HOURS")).toBe(
      normalizeForHash("  weekend   payouts in 11 hours  "),
    );
  });
});

describe("contentHash", () => {
  const T = "73db45ff-457e-4541-bc8f-bdb625390204";

  it("is a 64-char lowercase hex sha256", () => {
    const h = contentHash(T, "untyped", "hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls (deterministic)", () => {
    expect(contentHash(T, "knowledge_gap", "x")).toBe(contentHash(T, "knowledge_gap", "x"));
  });

  it("collapses whitespace/case differences to the SAME hash (dedup intent)", () => {
    expect(contentHash(T, "untyped", "Default repo for engineer")).toBe(
      contentHash(T, "untyped", "  default   repo for engineer  "),
    );
  });

  it("is tenant-scoped — same body, different tenant → different hash (no cross-tenant collapse)", () => {
    const a = contentHash("aaaaaaaa-0000-0000-0000-000000000001", "untyped", "same fact");
    const b = contentHash("bbbbbbbb-0000-0000-0000-000000000002", "untyped", "same fact");
    expect(a).not.toBe(b);
  });

  it("includes note_type — same body, different type → different hash", () => {
    expect(contentHash(T, "untyped", "x")).not.toBe(contentHash(T, "knowledge_gap", "x"));
  });

  it("defaults empty note_type to 'untyped' (matches SQL coalesce)", () => {
    expect(contentHash(T, "", "x")).toBe(contentHash(T, "untyped", "x"));
  });

  it("golden vector — pins the exact wire format (NUL-joined, v1 prefix)", () => {
    const SEP = String.fromCharCode(31);
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const expected = createHash("sha256")
      .update(["v1", T, "untyped", "hello"].join(SEP))
      .digest("hex");
    expect(contentHash(T, "untyped", "Hello")).toBe(expected);
  });
});

describe("contentHash dedup_key (scoped dedup for one caller)", () => {
  it("absent/null/empty: byte-identical to the unscoped hash (every other caller unchanged)", async () => {
    const { createHash } = await import("node:crypto");
    const legacy = createHash("sha256").update(["v1", "t1", "tenant_reference", "a fact"].join(String.fromCharCode(31))).digest("hex");
    expect(contentHash("t1", "tenant_reference", "A fact")).toBe(legacy);
    expect(contentHash("t1", "tenant_reference", "A fact", null, null)).toBe(legacy);
    expect(contentHash("t1", "tenant_reference", "A fact", null, "")).toBe(legacy);
  });
  it("different keys never collide on the same body; the same key does", () => {
    const a = contentHash("t1", "tenant_reference", "A fact", null, "import:d1:c1");
    expect(a).not.toBe(contentHash("t1", "tenant_reference", "A fact", null, "import:d2:c1"));
    expect(a).not.toBe(contentHash("t1", "tenant_reference", "A fact", null, "import:d1:c2"));
    expect(a).not.toBe(contentHash("t1", "tenant_reference", "A fact"));
    expect(a).toBe(contentHash("t1", "tenant_reference", "a  FACT", null, "import:d1:c1"));
  });
});
