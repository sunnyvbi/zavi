import { describe, it, expect } from "vitest";
import {
  classifyReadPath,
  isShippedCode,
  readPathFromInput,
  provenanceNote,
} from "../source-kind";

describe("classifyReadPath", () => {
  it.each([
    ["apps/backend/src/services/cohostSplit/splitMath.ts", "source"],
    ["apps/web/src/components/Thing.tsx", "source"],
    ["package.json", "source"],
    ["supabase/migrations/20260915_x.sql", "source"],
  ])("%s -> %s", (p, kind) => expect(classifyReadPath(p)).toBe(kind));

  it.each([
    ["docs/superpowers/plans/2026-09-11-cohost-earnings-split.md", "doc"],
    ["docs/superpowers/specs/2026-09-11-cohost-earnings-split-spec.md", "doc"],
    ["apps/backend/docs/HOST_PAYOUT_FLOW.md", "doc"],
    ["README.md", "doc"],
    ["CLAUDE.md", "doc"],
    ["adr/0004-queue.md", "doc"],
  ])("%s -> doc", (p) => expect(classifyReadPath(p)).toBe("doc"));

  it.each([
    ["apps/backend/src/services/agents/__tests__/runner.test.ts", "test"],
    ["src/foo.spec.ts", "test"],
    ["e2e/login.ts", "test"],
  ])("%s -> test", (p) => expect(classifyReadPath(p)).toBe("test"));

  it.each([
    ["apps/backend/dist/src/controller/cohostController.js", "generated"],
    ["node_modules/left-pad/index.js", "generated"],
    [".next/server/page.js", "generated"],
  ])("%s -> generated", (p) => expect(classifyReadPath(p)).toBe("generated"));

  it("lets the DIRECTORY beat the extension — a .ts under docs/ is an example", () => {
    expect(classifyReadPath("docs/examples/usage.ts")).toBe("doc");
  });

  it("lets generated beat doc — build output is stale before it is prose", () => {
    expect(classifyReadPath("dist/README.md")).toBe("generated");
  });

  it("defaults to source when the path is unknown, so provenance never invents a doubt", () => {
    expect(classifyReadPath(null)).toBe("source");
    expect(classifyReadPath("")).toBe("source");
    expect(classifyReadPath(undefined)).toBe("source");
  });

  it("is not fooled by a leading ./", () => {
    expect(classifyReadPath("./docs/plan.md")).toBe("doc");
  });

  it("only source counts as what shipped", () => {
    expect(isShippedCode("source")).toBe(true);
    for (const k of ["doc", "test", "generated"] as const) {
      expect(isShippedCode(k)).toBe(false);
    }
  });
});

describe("readPathFromInput", () => {
  it("finds the path across the read tools' input shapes", () => {
    expect(readPathFromInput({ path: "a/b.ts" })).toBe("a/b.ts");
    expect(readPathFromInput({ file_path: "a/b.ts" })).toBe("a/b.ts");
    expect(readPathFromInput({ owner: "o", repo: "r", path: " a/b.ts " })).toBe("a/b.ts");
  });

  it("returns null when the call names no single file — a search names none", () => {
    expect(readPathFromInput({ owner: "o", repo: "r", query: "cohost earnings" })).toBeNull();
    expect(readPathFromInput(null)).toBeNull();
    expect(readPathFromInput("nope")).toBeNull();
    expect(readPathFromInput({ path: "" })).toBeNull();
  });
});

describe("provenanceNote", () => {
  it("warns on a doc read, naming the file", () => {
    const note = provenanceNote("doc", "docs/plan.md");
    expect(note).toMatch(/source_kind: doc/);
    expect(note).toMatch(/docs\/plan\.md/);
    expect(note).toMatch(/INTENDED/);
    expect(note).toMatch(/present tense/);
  });

  it("says nothing on the normal case — source reads need no narration", () => {
    expect(provenanceNote("source", "src/a.ts")).toBeNull();
  });

  it("says nothing when there is no path to name", () => {
    expect(provenanceNote("doc", null)).toBeNull();
  });
});
