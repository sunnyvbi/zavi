import { describe, it, expect } from "vitest";
import { formatTurnMessage, decodeXmlEntities, refineStatusBadge } from "./builderThreadFormat";

describe("formatTurnMessage — approved-plan turns show a clean ask, not raw markdown", () => {
  it("hides the composed clarify answers, including the sanitized single-newline form", () => {
    expect(formatTurnMessage("A bike shop\nAdditional context:\n- Name: CycleHub")).toEqual({ text: "A bike shop", planApplied: false });
    expect(formatTurnMessage("A bike shop Additional context: - Name: CycleHub")).toEqual({ text: "A bike shop", planApplied: false });
    expect(formatTurnMessage("A bike shop\n\nAdditional context:\n- Name: X\nApproved plan:\n## A")).toEqual({ text: "A bike shop", planApplied: true });
  });

  it("passes a normal refine message through unchanged", () => {
    const r = formatTurnMessage("Add a contact email field to the signup form.");
    expect(r).toEqual({
      text: "Add a contact email field to the signup form.",
      planApplied: false,
    });
  });

  it("strips the approved-plan markdown tail, keeping only the operator's ask", () => {
    const combined =
      "Let entrepreneurs download validation results as PDF or Word." +
      "\n\nApproved plan:\n## Approach\nAdd export functionality...\n## What changes\n- New export endpoint";
    const r = formatTurnMessage(combined);
    expect(r.planApplied).toBe(true);
    expect(r.text).toBe("Let entrepreneurs download validation results as PDF or Word.");
    expect(r.text).not.toMatch(/##/);
  });

  it("falls back to a generic label when the plan has no leading ask", () => {
    const r = formatTurnMessage("\n\nApproved plan:\n## Approach\nDo the thing");
    expect(r).toEqual({ text: "Applied the proposed plan", planApplied: true });
  });
});

describe("formatTurnMessage / decodeXmlEntities — display decode (DEL-686)", () => {
  it("decodes an escaped apostrophe (the reported bug)", () => {
    expect(formatTurnMessage("i didn&apos;t like the orange, make it purple").text).toBe(
      "i didn't like the orange, make it purple",
    );
  });

  it("decodes the escaped ask even when an approved-plan tail is present", () => {
    const r = formatTurnMessage(
      "i didn&apos;t like the orange\n\nApproved plan:\n## Approach\ndo it",
    );
    expect(r.planApplied).toBe(true);
    expect(r.text).toBe("i didn't like the orange");
  });

  it("decodes the numeric apostrophe + amp/lt/gt/quot", () => {
    expect(decodeXmlEntities("a &amp; b &lt;x&gt; &quot;q&quot; it&#39;s")).toBe(
      'a & b <x> "q" it\'s',
    );
  });

  it("is a no-op on already-clean text (idempotent)", () => {
    expect(formatTurnMessage("make the hero purple").text).toBe("make the hero purple");
    expect(formatTurnMessage("it's fine").text).toBe("it's fine");
  });

  it("resolves double-escaped entities to their literal (bounded fixed-point)", () => {
    expect(decodeXmlEntities("Founder&amp;apos;s")).toBe("Founder's");
  });

  it("handles empty input", () => {
    expect(formatTurnMessage("").text).toBe("");
  });
});

describe("refineStatusBadge — real conductor vocabulary + context-aware labels (DEL-686)", () => {
  it("maps 'done' + a parked PR to 'Ready to review' (not shipped yet)", () => {
    const b = refineStatusBadge("done", { prUrl: "https://github.com/x/y/pull/3" });
    expect(b.label).toBe("Ready to review");
    expect(b.title).toMatch(/parked/i);
    expect(b.title).not.toMatch(/pull request/i);
  });

  it("maps 'done' with NO PR to 'Shipped' (direct-merge)", () => {
    const b = refineStatusBadge("done");
    expect(b.label).toBe("Shipped");
    expect(b.title).toBeUndefined();
  });

  it("maps 'halted' + a no-ship failure to 'Stopped' WITHOUT a pull-request title", () => {
    const b = refineStatusBadge("halted", { noShip: true });
    expect(b.label).toBe("Stopped");
    expect(b.title ?? "").not.toMatch(/pull request/i);
    expect(b.title).toMatch(/try again|couldn't ship/i);
  });

  it("maps 'halted' + a parked PR (no failure) to 'Paused — parked for publishing'", () => {
    const b = refineStatusBadge("halted", { prUrl: "https://github.com/x/y/pull/3" });
    expect(b.label).toBe("Paused");
    expect(b.title).toMatch(/parked/i);
    expect(b.title).not.toMatch(/pull request/i);
  });

  it("maps a bare 'halted' (no PR, no failure) to 'Stopped'", () => {
    expect(refineStatusBadge("halted").label).toBe("Stopped");
  });

  it("maps 'held' to 'Needs review' with a title", () => {
    const b = refineStatusBadge("held");
    expect(b.label).toBe("Needs review");
    expect(b.title).toBeTruthy();
  });

  it("maps live/queued statuses", () => {
    expect(refineStatusBadge("failed").label).toBe("Failed");
    expect(refineStatusBadge("active").label).toBe("Working…");
    expect(refineStatusBadge("provisioning").label).toBe("Working…");
    expect(refineStatusBadge("proposed").label).toBe("Queued");
  });

  it("still handles legacy 'success' as Shipped (defensive, never emitted)", () => {
    expect(refineStatusBadge("success").label).toBe("Shipped");
  });
});
