
import { describe, it, expect } from "vitest";
import { CANONICAL_AREAS } from "../areas";
import { listTools } from "../registry";

describe("CANONICAL_AREAS registry sanity", () => {
  it("every listed tool_slug exists in the live tool registry", () => {
    const registeredSlugs = new Set(listTools().map((t) => t.name));
    const issues: string[] = [];
    for (const area of CANONICAL_AREAS) {
      for (const slug of area.tool_slugs) {
        if (!registeredSlugs.has(slug)) {
          issues.push(
            `area "${area.id}" lists "${slug}" but no such tool in registry`,
          );
        }
      }
    }
    expect(issues).toEqual([]);
  });

  it("no two areas claim the same slug", () => {
    const claimedBy = new Map<string, string>();
    const dups: string[] = [];
    for (const area of CANONICAL_AREAS) {
      for (const slug of area.tool_slugs) {
        const prior = claimedBy.get(slug);
        if (prior && prior !== area.id) {
          dups.push(`slug "${slug}" claimed by both "${prior}" and "${area.id}"`);
        } else {
          claimedBy.set(slug, area.id);
        }
      }
    }
    expect(dups).toEqual([]);
  });

  it("area ids are unique", () => {
    const ids = CANONICAL_AREAS.map((a) => a.id);
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) dups.push(id);
      seen.add(id);
    }
    expect(dups).toEqual([]);
  });

  it("declaration order snapshot (catches accidental reordering)", () => {
    expect(CANONICAL_AREAS.map((a) => a.id)).toEqual([
      "slack_ops",
      "memory_ops",
      "github_ops",
      "stripe_ops",
      "gmail_ops",
      "agent_meta",
    ]);
  });

  it("each area has non-empty name + description", () => {
    for (const area of CANONICAL_AREAS) {
      expect(area.name.length).toBeGreaterThan(0);
      expect(area.description.length).toBeGreaterThan(0);
    }
  });

  it("empty tool_slugs arrays are allowed (placeholder areas)", () => {
    const counts = CANONICAL_AREAS.map((a) => a.tool_slugs.length);
    expect(counts.some((n) => n === 0)).toBe(true);
    expect(counts.some((n) => n > 0)).toBe(true);
  });
});
