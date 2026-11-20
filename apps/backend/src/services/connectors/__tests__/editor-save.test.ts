import { describe, expect, it } from "vitest";
import { applyPlannedChanges, EditorPartialSaveError, partialSaveMessage, type PlannedEditorChange } from "../_editor-save";

const plan = (label: string): PlannedEditorChange => ({ decision_class: "x.y", body: { label }, label });
const staged = (label: string, approved = true) => ({ label, decision_id: `d-${label}`, approved, code: approved ? null : "budget_choice_required" });

describe("applyPlannedChanges", () => {
  it("stages every change in order", async () => {
    const out = await applyPlannedChanges([plan("a"), plan("b")], async (p) => staged(p.label));
    expect(out.map((c) => c.label)).toEqual(["a", "b"]);
  });

  it("a first change that fails is rethrown as is: nothing was saved", async () => {
    const boom = new Error("boom");
    await expect(applyPlannedChanges([plan("a"), plan("b")], async () => { throw boom; })).rejects.toBe(boom);
  });

  it("a later failure carries what landed, what failed and what was never sent", async () => {
    const err = await applyPlannedChanges([plan("a"), plan("b"), plan("c")], async (p) => {
      if (p.label === "b") throw new Error("boom");
      return staged(p.label, false);
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EditorPartialSaveError);
    expect(err.landed.map((c: { label: string }) => c.label)).toEqual(["a"]);
    expect(err.failed_label).toBe("b");
    expect(err.not_sent).toEqual(["c"]);
  });
});

describe("partialSaveMessage", () => {
  it("names what was saved and what was not, and drops a 'nothing was saved' line that is no longer true", () => {
    const e = new EditorPartialSaveError([staged("Spring: name"), staged("Spring: spend cap", false)], "US adults: places", ["US adults: end date"], new Error("x"));
    expect(partialSaveMessage(e, "Zavi can't change Meta campaigns right now. Nothing was saved.")).toBe(
      'Zavi can\'t change Meta campaigns right now. Saved: "Spring: name" (on its way), "Spring: spend cap" (waiting in Approvals). Not saved: "US adults: places", "US adults: end date".',
    );
    expect(partialSaveMessage(e, "Zavi couldn't reach Meta just now.")).toContain("Zavi couldn't reach Meta just now. Saved:");
  });

  it("a change staged but not read back is not listed as not saved", () => {
    const unknown = Object.assign(new Error("x"), { code: "meta_editor_stage_unknown" });
    const e = new EditorPartialSaveError([staged("Spring: name")], "US adults: places", [], unknown);
    expect(partialSaveMessage(e, 'Zavi saved "US adults: places" but could not confirm it. Check Approvals before saving it again.')).toBe(
      'Zavi saved "US adults: places" but could not confirm it. Check Approvals before saving it again. Saved: "Spring: name" (on its way).',
    );
  });
});
