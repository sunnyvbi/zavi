import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureBrainProvenance, mergeBrainProvenance } from "../brain-provenance";

type CitedNotes = Map<string, { title: string; score: number }>;

const mk = (hits: unknown) => JSON.stringify({ hits });

describe("captureBrainProvenance — capture rules", () => {
  it("captures known non-anchor hits; dedups by note_id keeping max score", () => {
    const c: CitedNotes = new Map();
    captureBrainProvenance(c, "memory", "search", false, mk([
      { note_id: "n1", title: "Host had 2 no-shows", score: 0.4, note_type: "tenant_reference" },
      { note_id: "n1", title: "Host had 2 no-shows", score: 0.9, note_type: "tenant_reference" },
      { note_id: "n2", title: "Refund policy", score: 0.5, note_type: "operator_preference" },
    ]));
    expect(c.get("n1")).toEqual({ title: "Host had 2 no-shows", score: 0.9 });
    expect(c.get("n2")?.score).toBe(0.5);
    expect(c.size).toBe(2);
  });

  it("skips anchors AND undefined note_type (failed hydration never cites)", () => {
    const c: CitedNotes = new Map();
    captureBrainProvenance(c, "memory", "search", false, mk([
      { note_id: "a1", title: "Company brief", score: 0.99, note_type: "anchor" },
      { note_id: "h1", title: "hydration failed", score: 0.8 },
      { note_id: "ok", title: "real note", score: 0.3, note_type: "tenant_project" },
    ]));
    expect(c.has("a1")).toBe(false);
    expect(c.has("h1")).toBe(false);
    expect([...c.keys()]).toEqual(["ok"]);
  });

  it("ignores non-memory server, non-search tool, and error results", () => {
    const c: CitedNotes = new Map();
    captureBrainProvenance(c, "github", "search", false, mk([{ note_id: "x", title: "t", score: 1, note_type: "tenant_project" }]));
    captureBrainProvenance(c, "memory", "write", false, mk([{ note_id: "x", title: "t", score: 1, note_type: "tenant_project" }]));
    captureBrainProvenance(c, "memory", "search", true, mk([{ note_id: "x", title: "t", score: 1, note_type: "tenant_project" }]));
    expect(c.size).toBe(0);
  });

  it("never throws on malformed tool result", () => {
    const c: CitedNotes = new Map();
    expect(() => captureBrainProvenance(c, "memory", "search", false, "not json")).not.toThrow();
    expect(() => captureBrainProvenance(c, "memory", "search", false, JSON.stringify({ hits: "nope" }))).not.toThrow();
    expect(() => captureBrainProvenance(c, "memory", "search", false, JSON.stringify({}))).not.toThrow();
    expect(c.size).toBe(0);
  });
});

describe("mergeBrainProvenance — the emitDecision body contract", () => {
  it("real capture → top-5 by score, {note_id,title} only, preserves other body fields", () => {
    const c: CitedNotes = new Map();
    captureBrainProvenance(c, "memory", "search", false, mk(
      Array.from({ length: 7 }, (_, i) => ({
        note_id: `n${i}`, title: `note ${i}`, score: i / 10, note_type: "tenant_reference",
      })),
    ));
    const merged = mergeBrainProvenance({ summary: "do X", pr_url: "u" }, c) as {
      summary: string; pr_url: string; brain_citations: Array<Record<string, unknown>>;
    };
    expect(merged.summary).toBe("do X");
    expect(merged.pr_url).toBe("u");
    expect(merged.brain_citations).toHaveLength(5);
    expect(merged.brain_citations[0]).toEqual({ note_id: "n6", title: "note 6" });
    expect(Object.keys(merged.brain_citations[0])).toEqual(["note_id", "title"]);
  });

  it("empty accumulator → NO brain_citations key (not [] persisted)", () => {
    expect(mergeBrainProvenance({ summary: "x" }, new Map())).toEqual({ summary: "x" });
  });

  it("ANTI-SPOOF (Codex P2): caller-supplied brain_citations is stripped, even when accumulator empty", () => {
    const spoof = {
      summary: "approve me",
      brain_citations: [{ note_id: "evil", title: "Trust me, the brain said so" }],
    };
    expect(mergeBrainProvenance(spoof, new Map())).toEqual({ summary: "approve me" });
    const c: CitedNotes = new Map();
    captureBrainProvenance(c, "memory", "search", false, mk([
      { note_id: "real", title: "real note", score: 0.9, note_type: "tenant_project" },
    ]));
    const merged = mergeBrainProvenance(spoof, c) as { brain_citations: Array<{ note_id: string }> };
    expect(merged.brain_citations).toEqual([{ note_id: "real", title: "real note" }]);
  });

  it("non-object body (string/array/null) → safe empty-object base", () => {
    expect(mergeBrainProvenance("nope", new Map())).toEqual({});
    expect(mergeBrainProvenance(["a"], new Map())).toEqual({});
    expect(mergeBrainProvenance(null, new Map())).toEqual({});
  });
});

describe("generic-dispatcher wiring (source-level — full loop is integration)", () => {
  const src = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf-8");

  it("imports captureBrainProvenance (import presence only — behavior is covered behaviorally)", () => {
    expect(src).toMatch(/import \{ captureBrainProvenance \} from "@\/services\/agents\/brain-provenance";/);
  });
  it("runner.ts buildContext exposes the SAME citedNotes Map to ctx and the emitDecision closure", () => {
    const runner = readFileSync(join(__dirname, "../runner.ts"), "utf-8");
    expect(runner).toMatch(/const citedNotes = new Map<string, \{ title: string; score: number \}>\(\);/);
    expect(runner).toMatch(/\n\s*citedNotes,\s*\n/);
    expect(runner).toMatch(/mergeBrainProvenance\(body, citedNotes\)/);
    expect(runner).toMatch(/import \{ mergeBrainProvenance \} from "\.\/brain-provenance";/);
  });
});
