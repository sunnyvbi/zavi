
import { describe, it, expect } from "vitest";
import { pmPromptMode, toRunMode } from "@/agents/pm/dispatcher";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("pmPromptMode — what the MODEL is told it is doing", () => {
  it("a build_app spec run gets build_spec, not delivery", () => {
    expect(pmPromptMode({ stage: "spec", trigger: "a2a", userText: "" })).toBe("build_spec");
  });

  it("the stage wins regardless of trigger — the conductor is the only stamper", () => {
    for (const trigger of ["a2a", "cron", "manual", "chat", undefined]) {
      expect(pmPromptMode({ stage: "spec", trigger, userText: "" })).toBe("build_spec");
    }
  });

  it("every OTHER pm run is unchanged — no stage means the classifier decides", () => {
    expect(pmPromptMode({ stage: undefined, trigger: "a2a", userText: "" })).toBe("delivery");
    expect(pmPromptMode({ stage: undefined, trigger: "cron", userText: "" })).toBe("delivery");
    for (const stage of ["scaffold", "build", "qa", "deploy", "provision", "", null, 1, {}]) {
      expect(pmPromptMode({ stage, trigger: "a2a", userText: "" })).toBe("delivery");
    }
  });
});

describe("toRunMode — the safety invariant", () => {
  it("build_spec floors to delivery, keeping the precision gate reachable", () => {
    expect(toRunMode("build_spec")).toBe("delivery");
  });

  it("still honours the two modes post-run really does branch on", () => {
    expect(toRunMode("iterate")).toBe("iterate");
    expect(toRunMode("strategy_memo")).toBe("strategy_memo");
  });

  it("anything unrecognised floors to delivery (fail-safe, not fail-open)", () => {
    for (const v of [undefined, null, "", "nonsense", 0, {}, []]) {
      expect(toRunMode(v)).toBe("delivery");
    }
  });
});

describe("agent.md declares the mode it is sent", () => {
  const md = readFileSync(
    join(__dirname, "..", "agent.md"),
    "utf-8",
  );

  it("the MODE CONTRACT names build_spec — a mode the server sends but the prompt never defines is a silent no-op", () => {
    expect(md).toContain('`payload.mode === "build_spec"`');
    expect(md).toContain("## BUILD SPEC MODE");
  });

  it("names the failure it exists to prevent, so the instruction is not just a label", () => {
    const section = md.slice(md.indexOf("## BUILD SPEC MODE"));
    expect(section.toLowerCase()).toContain("pull request");
    expect(section).toMatch(/payload\.idea/);
    const ideaBullet = section.slice(section.indexOf("- `payload.idea`"), section.indexOf("- `payload.archetype`"));
    expect(ideaBullet).toMatch(/outranks everything else/);
    expect(ideaBullet).toMatch(/company\s+brief, memory notes and existing routes/);
    expect(ideaBullet).toMatch(/never "correct" the\s+idea back to the company record/);
    expect(section).toMatch(/payload\.archetype/);
    expect(section).toContain("rendered_markdown");
  });

  it("keeps the empty-evidence exemption aligned with the server", () => {
    const section = md.slice(md.indexOf("## BUILD SPEC MODE"));
    expect(section).toContain("evidence_sources");
  });

  it("budgets the spec so the stage cannot run away on output length", () => {
    const section = md.slice(md.indexOf("## BUILD SPEC MODE"));
    expect(section).toMatch(/under 700 words/);
    expect(section).toMatch(/at most 6 items/);
  });
});
