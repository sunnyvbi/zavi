
import { describe, it, expect } from "vitest";
import { shouldDistillRun, makeShouldDistillRun } from "../should-distill";

describe("shouldDistillRun — brain-correction skip", () => {
  it("skips a chat turn that used a brain-correction tool", () => {
    const r = shouldDistillRun({ agent_slug: "chief-of-staff", trigger: "chat", used_brain_correction: true });
    expect(r).toEqual({ ok: false, reason: "brain_correction_turn" });
  });

  it("still distills a normal chat turn (no brain tool used)", () => {
    expect(shouldDistillRun({ agent_slug: "chief-of-staff", trigger: "chat", used_brain_correction: false })).toEqual({
      ok: true,
    });
    expect(shouldDistillRun({ agent_slug: "operator", trigger: "chat" })).toEqual({ ok: true });
  });

  it("brain skip takes precedence over the seed/short-output checks", () => {
    expect(
      shouldDistillRun({ agent_slug: "operator", trigger: "chat", used_brain_correction: true, is_seed: true }),
    ).toEqual({ ok: false, reason: "brain_correction_turn" });
  });

  it("test seam (makeShouldDistillRun) honors the brain skip too", () => {
    const fn = makeShouldDistillRun(new Set<string>());
    expect(fn({ agent_slug: "operator", trigger: "chat", used_brain_correction: true })).toEqual({
      ok: false,
      reason: "brain_correction_turn",
    });
  });
});
