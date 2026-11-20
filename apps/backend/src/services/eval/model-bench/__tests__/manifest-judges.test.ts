import { describe, it, expect } from "vitest";
import {
  MODEL_MANIFEST,
  pickJudges,
  resolveModel,
  type ManifestEntry,
  type ModelFamily,
} from "../manifest";

const ALL_FAMILIES = [...new Set([...MODEL_MANIFEST.values()].map((e) => e.family))];

describe("judge picker (test 5)", () => {
  it("never returns a family present in the comparison, for every pairing in the manifest", () => {
    for (const a of MODEL_MANIFEST.values()) {
      const comparison: ModelFamily[] = ["anthropic", a.family];
      const pick = pickJudges(comparison);
      if (pick.status === "ok") {
        for (const j of pick.judges) expect(comparison).not.toContain(j.family);
      }
    }
  });

  it("the two judges are always two DISTINCT families", () => {
    for (const fam of ALL_FAMILIES) {
      const pick = pickJudges(["anthropic", fam]);
      if (pick.status === "ok") {
        expect(pick.judges[0].family).not.toBe(pick.judges[1].family);
      }
    }
  });

  it("returns judge_unavailable when fewer than two eligible families remain (never a same-family judge)", () => {
    const only: ManifestEntry[] = [
      { key: "j1", route: "shared_loop", model_id: "a/x", upstream: "A", family: "openai", lineage: "", retention: "", judge_eligible: true },
      { key: "j2", route: "shared_loop", model_id: "a/y", upstream: "A", family: "openai", lineage: "", retention: "", judge_eligible: true },
      { key: "j3", route: "shared_loop", model_id: "b/z", upstream: "B", family: "google", lineage: "", retention: "", judge_eligible: true },
    ];
    const pick = pickJudges(["anthropic", "google"], only);
    expect(pick.status).toBe("judge_unavailable");
  });

  it("ignores non-judge-eligible and claude_sdk entries", () => {
    const pick = pickJudges(["anthropic", "qwen"]);
    expect(pick.status).toBe("ok");
    if (pick.status === "ok") {
      for (const j of pick.judges) {
        expect(j.judge_eligible).toBe(true);
        expect(j.route).toBe("shared_loop");
      }
    }
  });
});

describe("manifest", () => {
  it("refuses an unknown model (unknown lineage)", () => {
    expect(() => resolveModel("some-random-model")).toThrow(/unknown lineage/);
  });
  it("every shared-loop entry is pinned to exactly one upstream and has a retention note", () => {
    for (const e of MODEL_MANIFEST.values()) {
      if (e.route === "shared_loop") expect(e.upstream).toBeTruthy();
      expect(e.retention.length).toBeGreaterThan(0);
      expect(e.lineage.length).toBeGreaterThan(0);
    }
  });
  it("entries are immutable", () => {
    const e = resolveModel("qwen");
    expect(() => {
      (e as { model_id: string }).model_id = "evil/x";
    }).toThrow();
  });
});
