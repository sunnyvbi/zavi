import { describe, expect, it } from "vitest";
import { carriedSummary, toConfig, toForm, type Config } from "./variant-form";

const V2: Config = {
  effort: "low",
  isolate_settings: true,
  prompt: { skills: ["operator-render-video", "operator-slack-document"] },
  tools: { always_load: ["praxis__handoff", "memory__search"] },
};

describe("variant form round trip", () => {
  it("keeps the levers the form has no field for", () => {
    const saved = toConfig(toForm({ slug: "v2", label: "V2", note: null, config: V2 }));
    expect(saved).toEqual(V2);
  });

  it("keeps them when the staff edit changes a field it does own", () => {
    const f = toForm({ slug: "v2", label: "V2", note: null, config: V2 });
    const saved = toConfig({ ...f, effort: "medium" });
    expect(saved.effort).toBe("medium");
    expect(saved.tools?.always_load).toEqual(V2.tools?.always_load);
    expect(saved.prompt?.skills).toEqual(V2.prompt?.skills);
  });

  it("keeps a tools-only variant from collapsing to an empty config", () => {
    const only: Config = { tools: { always_load: ["praxis__handoff"] } };
    expect(toConfig(toForm({ slug: "v2-tools", label: "t", note: null, config: only }))).toEqual(only);
  });

  it("still drops a field the operator cleared", () => {
    const f = toForm({ slug: "v1", label: "V1", note: null, config: { effort: "low", max_turns: 40 } });
    const saved = toConfig({ ...f, effort: "", maxTurns: "" });
    expect(saved.effort).toBeUndefined();
    expect(saved.max_turns).toBeUndefined();
  });

  it("names the carried keys so the edit is not blind", () => {
    const s = carriedSummary(toForm({ slug: "v2", label: "V2", note: null, config: V2 }));
    expect(s).toContain("always_load");
    expect(s).toContain("operator-render-video");
  });

  it("carries nothing for a config the form fully owns", () => {
    const f = toForm({ slug: "v1-medium", label: "m", note: null, config: { effort: "medium", isolate_settings: true } });
    expect(f.carried).toEqual({});
    expect(carriedSummary(f)).toBe("");
  });
});
