import { describe, it, expect } from "vitest";
import {
  resolveScriptVariants,
  capVariantsForAspects,
  MAX_VIDEO_OUTPUTS,
} from "../script-variants";
import { intakeToVideoBrief, type LaunchVideoIntake } from "../brief-mapper";
import { aspectArtifactFilename } from "../aspect-artifacts";

const base: LaunchVideoIntake = {
  product_name: "Upcar",
  one_liner: "Rent the perfect car from local hosts.",
  url: "https://upcar.ai",
  audience: "people who need a car for the weekend",
  tone: "bold",
  features: [
    { title: "Book in two minutes", detail: "Find a car near you and reserve it instantly." },
    { title: "Real local hosts", detail: "Cars from real people in your city." },
    { title: "Fully insured", detail: "Every trip covered end to end." },
  ],
  cta_text: "Start your trip",
  cta_url: "https://upcar.ai",
};

describe("resolveScriptVariants — A/B opt-in (default byte-identical)", () => {
  it("NO scripts → exactly ONE variant 'A' whose brief is byte-identical to the launch path", () => {
    const variants = resolveScriptVariants(base);
    expect(variants).toHaveLength(1);
    expect(variants[0].label).toBe("A");
    expect(intakeToVideoBrief(variants[0].intake)).toEqual(intakeToVideoBrief(base));
  });

  it("the A variant never carries the scripts field forward (no re-expansion)", () => {
    const withScripts: LaunchVideoIntake = { ...base, scripts: [{ one_liner: "B hook" }] };
    const variants = resolveScriptVariants(withScripts);
    expect((variants[0].intake as { scripts?: unknown }).scripts).toBeUndefined();
    expect((variants[1].intake as { scripts?: unknown }).scripts).toBeUndefined();
  });

  it("an intake WITH scripts still maps variant A byte-identically to the same intake WITHOUT scripts", () => {
    const withScripts: LaunchVideoIntake = { ...base, scripts: [{ cta_text: "Try it free" }] };
    expect(intakeToVideoBrief(resolveScriptVariants(withScripts)[0].intake)).toEqual(intakeToVideoBrief(base));
  });

  it("scripts:[overlay] → 2 variants A/B; overlay fields REPLACE base, others fall through", () => {
    const variants = resolveScriptVariants({
      ...base,
      scripts: [{ one_liner: "There's a car parked near you.", cta_text: "Find your car" }],
    });
    expect(variants.map((v) => v.label)).toEqual(["A", "B"]);
    expect(variants[0].intake.one_liner).toBe(base.one_liner);
    expect(variants[0].intake.cta_text).toBe(base.cta_text);
    expect(variants[1].intake.one_liner).toBe("There's a car parked near you.");
    expect(variants[1].intake.cta_text).toBe("Find your car");
    expect(variants[1].intake.product_name).toBe("Upcar");
    expect(variants[1].intake.features).toEqual(base.features);
  });

  it("labels run A,B,C,D for 3 overlays", () => {
    const variants = resolveScriptVariants({
      ...base,
      scripts: [{ one_liner: "b" }, { one_liner: "c" }, { one_liner: "d" }],
    });
    expect(variants.map((v) => v.label)).toEqual(["A", "B", "C", "D"]);
  });

  it("A/B=2 × single aspect → 2 DISTINCT artifact filenames (= 2 run_artifacts rows)", () => {
    const variants = resolveScriptVariants({ ...base, scripts: [{ one_liner: "B hook" }] });
    const filenames = variants.map((v) => aspectArtifactFilename("16:9", v.label));
    expect(filenames).toEqual(["video-A-16x9.mp4", "video-B-16x9.mp4"]);
    expect(new Set(filenames).size).toBe(2);
  });
});

describe("capVariantsForAspects — variants × aspects cap", () => {
  it("no cap when within the budget", () => {
    const v = resolveScriptVariants({ ...base, scripts: [{ one_liner: "b" }] });
    expect(capVariantsForAspects(v, 1)).toEqual({ kept: v, capped: false });
    expect(capVariantsForAspects(v, 3).capped).toBe(false);
  });

  it("caps variants so variants × aspects ≤ MAX_VIDEO_OUTPUTS", () => {
    const v = resolveScriptVariants({ ...base, scripts: [{ one_liner: "b" }, { one_liner: "c" }] });
    const r = capVariantsForAspects(v, 3);
    expect(r.capped).toBe(true);
    expect(r.kept.map((x) => x.label)).toEqual(["A", "B"]);
    expect(r.kept.length * 3).toBeLessThanOrEqual(MAX_VIDEO_OUTPUTS);
  });

  it("always keeps at least one variant even if a single output already exceeds the cap", () => {
    const v = resolveScriptVariants(base);
    const r = capVariantsForAspects(v, 99);
    expect(r.kept).toHaveLength(1);
    expect(r.capped).toBe(false);
  });

  it("with 1 aspect up to 6 variants fit", () => {
    const v = resolveScriptVariants({
      ...base,
      scripts: [{ one_liner: "b" }, { one_liner: "c" }, { one_liner: "d" }, { one_liner: "e" }, { one_liner: "f" }],
    });
    expect(capVariantsForAspects(v, 1)).toEqual({ kept: v, capped: false });
  });
});
