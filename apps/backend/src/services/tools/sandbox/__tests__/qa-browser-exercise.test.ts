
import { describe, it, expect } from "vitest";
import {
  buildQaExercisePlan,
  assertExerciseResult,
  type QaExerciseObserved,
} from "../qa-browser-exercise";

describe("buildQaExercisePlan — pure plan builder", () => {
  it("picks the first VISIBLE primary button over a hidden one", () => {
    const html = `
      <html><body>
        <button id="hidden" style="display:none">Ghost</button>
        <button id="go">Get started</button>
      </body></html>`;
    const plan = buildQaExercisePlan(html);
    const click = plan.ops.find((o) => o.op === "click");
    expect(click).toBeTruthy();
    expect((click as { selector: string }).selector).toContain("#go");
    expect((click as { selector: string }).selector).not.toContain("#hidden");
  });

  it("prefers an a[href] / [role=button] when no plain <button> exists", () => {
    const html = `<html><body><a id="cta" href="/start">Start now</a></body></html>`;
    const plan = buildQaExercisePlan(html);
    const click = plan.ops.find((o) => o.op === "click");
    expect(click).toBeTruthy();
    expect((click as { selector: string }).selector).toContain("#cta");
  });

  it("finds a <form> with fillable inputs + submit and emits fill+submit ops", () => {
    const html = `
      <html><body>
        <form id="signup">
          <input id="email" name="email" type="email" />
          <input id="name" name="name" type="text" />
          <button id="submit" type="submit">Sign up</button>
        </form>
      </body></html>`;
    const plan = buildQaExercisePlan(html);
    const fills = plan.ops.filter((o) => o.op === "fill");
    expect(fills.length).toBeGreaterThanOrEqual(1);
    const click = plan.ops.find((o) => o.op === "click");
    expect(click).toBeTruthy();
    expect((click as { selector: string }).selector).toContain("#submit");
    expect(plan.has_form).toBe(true);
  });

  it("skips hidden/disabled inputs and non-fillable input types when filling a form", () => {
    const html = `
      <html><body>
        <form id="f">
          <input id="csrf" type="hidden" name="csrf" value="x" />
          <input id="ok" name="ok" type="text" />
          <input id="dis" name="dis" type="text" disabled />
          <button id="submit" type="submit">Go</button>
        </form>
      </body></html>`;
    const plan = buildQaExercisePlan(html);
    const fillSelectors = plan.ops
      .filter((o) => o.op === "fill")
      .map((o) => (o as { selector: string }).selector);
    expect(fillSelectors.join(" ")).toContain("#ok");
    expect(fillSelectors.join(" ")).not.toContain("#csrf");
    expect(fillSelectors.join(" ")).not.toContain("#dis");
  });

  it("no interactive element → minimal/no-op plan (no click, no fill)", () => {
    const html = `<html><body><p>Just some static text.</p></body></html>`;
    const plan = buildQaExercisePlan(html);
    expect(plan.ops.filter((o) => o.op === "click").length).toBe(0);
    expect(plan.ops.filter((o) => o.op === "fill").length).toBe(0);
    expect(plan.has_interactive).toBe(false);
  });
});

describe("assertExerciseResult — pure signal combiner", () => {
  const base = (over: Partial<QaExerciseObserved>): QaExerciseObserved => ({
    nav_ok: true,
    console_errors: [],
    plan: { ops: [], has_form: false, has_interactive: true, primary_selector: "#go" },
    op_results: [],
    final_url: "http://127.0.0.1:3000/",
    ...over,
  });

  it("ok:false + concrete signal on a console error", () => {
    const r = assertExerciseResult(
      base({ console_errors: ["Uncaught TypeError: x is not a function"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.signal).toContain("qa-browser");
    expect(r.signal).toContain("console error");
    expect(r.signal).toContain("Uncaught TypeError");
  });

  it("ok:false when the primary CTA click navigates to a 5xx page", () => {
    const r = assertExerciseResult(
      base({
        op_results: [{ op: "click", ok: true }],
        final_url: "http://127.0.0.1:3000/500",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.signal).toContain("qa-browser");
    expect(r.signal).toMatch(/500|5xx/);
  });

  it("ok:false when an op threw (daemon op-level failure)", () => {
    const r = assertExerciseResult(
      base({
        op_results: [
          { op: "click", ok: false, error_message: "selector not found: #go" },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.signal).toContain("qa-browser");
  });

  it("ok:true on a clean load + responsive CTA (no console errors, click ok)", () => {
    const r = assertExerciseResult(
      base({
        op_results: [{ op: "click", ok: true }],
        final_url: "http://127.0.0.1:3000/dashboard",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("ok:true when there is no form (form round-trip is optional)", () => {
    const r = assertExerciseResult(
      base({
        plan: { ops: [], has_form: false, has_interactive: true, primary_selector: "#go" },
        op_results: [{ op: "click", ok: true }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("no interactive element → PASS-with-warning (ok:true), NOT a fail", () => {
    const r = assertExerciseResult(
      base({
        plan: { ops: [], has_form: false, has_interactive: false, primary_selector: null },
        op_results: [],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/no.*interactive|warning/i);
  });

  it("ok:false when nav itself failed (page never loaded)", () => {
    const r = assertExerciseResult(base({ nav_ok: false }));
    expect(r.ok).toBe(false);
    expect(r.signal).toContain("qa-browser");
  });
});
