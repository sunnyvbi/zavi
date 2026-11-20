import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateRecord, isUnderMockDir, PROVENANCES } from "../lib/schema.mjs";
import { loadRecordEntries, MOCK_DIR, BENCH_DIR, loadBriefs } from "../lib/io.mjs";
import { baseRecord, tmp } from "./helpers.mjs";

const briefIds = loadBriefs().map((b) => b.id);

describe("validateRecord provenance rules", () => {
  it("accepts a complete actual_ai_build record outside the mock dir", () => {
    expect(validateRecord(baseRecord(), { filePath: join(BENCH_DIR, "results", "r.record.json"), briefIds })).toEqual([]);
  });

  it.each([undefined, null, ""])("rejects a missing provenance (%s)", (p) => {
    const errs = validateRecord(baseRecord({ provenance: p }));
    expect(errs).toContain("provenance is required");
  });

  it("rejects an unknown provenance", () => {
    expect(validateRecord(baseRecord({ provenance: "real" })).join()).toMatch(/provenance must be one of/);
  });

  it.each([
    join(MOCK_DIR, "x.record.json"),
    join(MOCK_DIR, "nested", "deep", "x.record.json"),
    "/elsewhere/copy/fixtures/mock/x.record.json",
  ])("rejects actual_ai_build for a file under fixtures/mock: %s", (filePath) => {
    expect(validateRecord(baseRecord(), { filePath })).toContain("provenance actual_ai_build is not allowed for a file under fixtures/mock");
  });

  it("does not treat a sibling like fixtures/mockup as the mock dir", () => {
    expect(isUnderMockDir("/a/fixtures/mockup/x.json")).toBe(false);
    expect(isUnderMockDir("/a/fixtures/mock")).toBe(true);
  });

  it("allows every non-actual provenance under fixtures/mock", () => {
    for (const p of PROVENANCES.filter((x) => x !== "actual_ai_build")) {
      const rec = baseRecord({ provenance: p, system: p === "manual_import" ? "lovable" : "zavi" });
      expect(validateRecord(rec, { filePath: join(MOCK_DIR, "x.record.json") })).toEqual([]);
    }
  });

  it("rejects actual_ai_build pointing at mock screenshots even from a results dir", () => {
    const rec = baseRecord({ screenshots: { desktop: "../fixtures/mock/shots/a.png", mobile: "m.png" } });
    expect(validateRecord(rec, { filePath: "/x/results/r.record.json" })).toContain("provenance actual_ai_build cannot point at screenshots under fixtures/mock");
  });

  it("refuses actual_ai_build for a competitor and manual_import for zavi", () => {
    expect(validateRecord(baseRecord({ system: "lovable" })).join()).toMatch(/only for zavi builds/);
    expect(validateRecord(baseRecord({ provenance: "manual_import" })).join()).toMatch(/zavi records come from collect/);
  });

  it("loading a shipped mock record with provenance flipped to actual is rejected at its real path", () => {
    const file = join(MOCK_DIR, "mock-zavi-dental-clinic.record.json");
    const rec = JSON.parse(readFileSync(file, "utf8"));
    expect(validateRecord(rec, { filePath: file, briefIds })).toEqual([]);
    rec.provenance = "actual_ai_build";
    expect(validateRecord(rec, { filePath: file, briefIds })).toContain("provenance actual_ai_build is not allowed for a file under fixtures/mock");
  });

  it("loadRecordEntries reports a tampered copy inside any fixtures/mock tree and keeps the honest ones", () => {
    const root = tmp();
    const dir = join(root, "fixtures", "mock");
    mkdirSync(dir, { recursive: true });
    const src = join(MOCK_DIR, "mock-lovable-tattoo-studio.record.json");
    copyFileSync(src, join(dir, "honest.record.json"));
    const forged = { ...JSON.parse(readFileSync(src, "utf8")), system: "zavi", provenance: "actual_ai_build", screenshots: { desktop: "a.png", mobile: "b.png" } };
    writeFileSync(join(dir, "forged.record.json"), JSON.stringify(forged));
    const { entries, errors } = loadRecordEntries([root], { briefIds });
    expect(entries.map((e) => e.file)).toEqual([join(dir, "honest.record.json")]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/forged\.record\.json: .*not allowed for a file under fixtures\/mock/);
  });

  it("every shipped fixture record is valid and none claims to be evidence", () => {
    const { entries, errors } = loadRecordEntries([MOCK_DIR], { briefIds });
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(12);
    expect(new Set(entries.map((e) => e.record.provenance))).toEqual(new Set(["mocked"]));
    expect(new Set(entries.map((e) => e.record.brief_id))).toEqual(new Set(briefIds));
  });
});

describe("validateRecord scores", () => {
  it("rejects scores without a rater", () => {
    const errs = validateRecord(baseRecord({ scores: { hierarchy: 4 } }));
    expect(errs).toContain("scores.rater is required when any axis is scored");
    expect(validateRecord(baseRecord({ scores: { rater: "  ", typography: 2 } }))).toContain("scores.rater is required when any axis is scored");
  });

  it("accepts scores with a rater and all-null scores without one", () => {
    expect(validateRecord(baseRecord({ scores: { rater: "mohit", hierarchy: 4, mobile_readability: 1 } }))).toEqual([]);
    expect(validateRecord(baseRecord({ scores: { hierarchy: null, spacing: null } }))).toEqual([]);
  });

  it.each([0, 6, 3.5, "4"])("rejects out-of-range score %s", (v) => {
    expect(validateRecord(baseRecord({ scores: { rater: "r", imagery: v } })).join()).toMatch(/scores\.imagery must be an integer 1-5/);
  });

  it("rejects an unknown axis", () => {
    expect(validateRecord(baseRecord({ scores: { rater: "r", vibes: 5 } })).join()).toMatch(/scores\.vibes is not a known axis/);
  });
});

describe("validateRecord shape", () => {
  it("names every broken field", () => {
    const errs = validateRecord({
      ...baseRecord(),
      brief_id: "nope",
      captured_at: "yesterday",
      timings: { to_first_preview_s: -1, to_usable_complete_s: "5" },
      cost: { usd: null },
      repairs: 1.5,
      failures: [1],
      journeys: [{ name: "x" }],
      requirement_coverage: [{ requirement: "x", met: "yes", evidence: "" }],
    }, { briefIds });
    expect(errs).toEqual(
      expect.arrayContaining([
        'brief_id "nope" is not a known brief',
        "captured_at must be an ISO 8601 timestamp",
        "timings.to_first_preview_s must be a non-negative number or null",
        "timings.to_usable_complete_s must be a non-negative number or null",
        "cost.source is required",
        "repairs must be a non-negative integer or null",
        "failures must be a string[]",
        "journeys[0] must be {name, passed:boolean}",
        "requirement_coverage[0] must be {requirement, met:boolean, evidence:string}",
      ]),
    );
  });
});
