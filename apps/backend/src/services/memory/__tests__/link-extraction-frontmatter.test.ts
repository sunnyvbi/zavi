import { describe, it, expect } from "vitest";
import {
  assertBoundedFrontmatter,
  extractFrontmatterLinks,
  _FRONTMATTER_LINK_MAP_V1_FIELDS,
} from "../link-extraction";

describe("assertBoundedFrontmatter", () => {
  it("accepts undefined (no-op)", () => {
    expect(() => assertBoundedFrontmatter(undefined)).not.toThrow();
  });
  it("accepts empty object", () => {
    expect(() => assertBoundedFrontmatter({})).not.toThrow();
  });
  it("accepts string + string[] values", () => {
    expect(() =>
      assertBoundedFrontmatter({
        mentions_subject: "alice",
        dispute_between: ["alice", "acme"],
      }),
    ).not.toThrow();
  });
  it("rejects non-object", () => {
    expect(() => assertBoundedFrontmatter("string" as unknown as Record<string, unknown>)).toThrow(/plain object/);
    expect(() => assertBoundedFrontmatter([] as unknown as Record<string, unknown>)).toThrow(/plain object/);
    expect(() => assertBoundedFrontmatter(null as unknown as Record<string, unknown>)).toThrow(/plain object/);
  });
  it("rejects > 32 keys", () => {
    const fm: Record<string, string> = {};
    for (let i = 0; i < 33; i++) fm[`k${i}`] = "v";
    expect(() => assertBoundedFrontmatter(fm)).toThrow(/max 32/);
  });
  it("rejects > 256-char scalar", () => {
    expect(() =>
      assertBoundedFrontmatter({ a: "x".repeat(257) }),
    ).toThrow(/exceeds 256/);
  });
  it("rejects > 16-item array", () => {
    expect(() =>
      assertBoundedFrontmatter({ a: Array(17).fill("x") }),
    ).toThrow(/max 16/);
  });
  it("rejects non-string array item", () => {
    expect(() => assertBoundedFrontmatter({ a: [1, 2] as unknown as string[] })).toThrow(/must be string/);
  });
  it("rejects nested object", () => {
    
    expect(() => assertBoundedFrontmatter({ a: { nested: "x" } })).toThrow(/string or string\[\]/);
  });
  it("rejects > 8KB serialized total", () => {
    expect(() =>
      assertBoundedFrontmatter({
        big: Array(16).fill("x".repeat(256)),
        big2: Array(16).fill("y".repeat(256)),
      }),
    ).toThrow(/serialized size/);
  });
});

describe("FRONTMATTER_LINK_MAP_V1 — registered fields", () => {
  it("ships exactly the v1 set", () => {
    expect(_FRONTMATTER_LINK_MAP_V1_FIELDS.sort()).toEqual(
      ["dispute_between", "mentions", "related_to_pair"].sort(),
    );
  });
});

describe("extractFrontmatterLinks", () => {
  function makeLookup(resolutions: Record<string, string | null>) {
    return async (canonical: string) => resolutions[canonical] ?? null;
  }

  it("dispute_between with both resolved → 2 symmetric edges", async () => {
    const { resolved, unresolved } = await extractFrontmatterLinks(
      { dispute_between: ["alice", "acme"] },
      makeLookup({ alice: "ent-1", acme: "ent-2" }),
    );
    expect(unresolved).toEqual([]);
    expect(resolved.length).toBe(2);
    expect(resolved.map((r) => `${r.fromEntityId}→${r.toEntityId}`).sort()).toEqual([
      "ent-1→ent-2",
      "ent-2→ent-1",
    ]);
    expect(resolved.every((r) => r.relationType === "mentions")).toBe(true);
    expect(resolved.every((r) => r.linkSource === "frontmatter")).toBe(true);
    expect(resolved.every((r) => r.originField === "dispute_between")).toBe(true);
  });

  it("dispute_between with one unresolved → 0 edges, unresolved listed", async () => {
    const { resolved, unresolved } = await extractFrontmatterLinks(
      { dispute_between: ["alice", "ghost"] },
      makeLookup({ alice: "ent-1" }),
    );
    expect(resolved.length).toBe(0);
    expect(unresolved).toContain("ghost");
  });

  it("dispute_between with malformed value (1 string) → 0 edges, no throw", async () => {
    const { resolved } = await extractFrontmatterLinks(
      { dispute_between: "just-one" as unknown as string[] },
      makeLookup({}),
    );
    expect(resolved.length).toBe(0);
  });

  it("dispute_between with self-pair → 0 edges", async () => {
    const { resolved } = await extractFrontmatterLinks(
      { dispute_between: ["alice", "alice"] },
      makeLookup({ alice: "ent-1" }),
    );
    expect(resolved.length).toBe(0);
  });

  it("related_to_pair → symmetric related_to edges", async () => {
    const { resolved } = await extractFrontmatterLinks(
      { related_to_pair: ["trip-1", "trip-2"] },
      makeLookup({ "trip-1": "ent-a", "trip-2": "ent-b" }),
    );
    expect(resolved.length).toBe(2);
    expect(resolved.every((r) => r.relationType === "related_to")).toBe(true);
  });

  it("mentions without mentions_subject → 0 edges", async () => {
    const { resolved } = await extractFrontmatterLinks(
      { mentions: ["acme", "stripe"] },
      makeLookup({ acme: "ent-1", stripe: "ent-2" }),
    );
    expect(resolved.length).toBe(0);
  });

  it("mentions with mentions_subject → subject→each member", async () => {
    const { resolved } = await extractFrontmatterLinks(
      { mentions_subject: "alice", mentions: ["acme", "stripe"] },
      makeLookup({ alice: "ent-A", acme: "ent-1", stripe: "ent-2" }),
    );
    expect(resolved.length).toBe(2);
    expect(resolved.map((r) => r.toEntityId).sort()).toEqual(["ent-1", "ent-2"]);
    expect(resolved.every((r) => r.fromEntityId === "ent-A")).toBe(true);
    expect(resolved.every((r) => r.relationType === "mentions")).toBe(true);
  });

  it("mentions skips self-mention", async () => {
    const { resolved } = await extractFrontmatterLinks(
      { mentions_subject: "alice", mentions: ["alice", "acme"] },
      makeLookup({ alice: "ent-A", acme: "ent-1" }),
    );
    expect(resolved.length).toBe(1);
    expect(resolved[0].toEntityId).toBe("ent-1");
  });

  it("unknown field → ignored silently", async () => {
    const { resolved, unresolved } = await extractFrontmatterLinks(
      { bogus_field: "x", dispute_between: ["a", "b"] },
      makeLookup({ a: "1", b: "2" }),
    );
    expect(resolved.length).toBe(2);
    expect(unresolved.length).toBe(0);
  });

  it("within-note dedup: same edge twice from different fields collapses to one", async () => {
    const { resolved } = await extractFrontmatterLinks(
      {
        dispute_between: ["alice", "acme"],
        mentions_subject: "alice",
        mentions: ["acme"],
      },
      makeLookup({ alice: "ent-A", acme: "ent-1" }),
    );
    expect(resolved.length).toBe(2);
  });
});
