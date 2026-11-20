
import { describe, it, expect } from "vitest";
import {
  extractDeliverables,
  verificationCoversAll,
} from "@/agents/engineer/completeness-check";

describe("extractDeliverables", () => {
  it("a single imperative → []", () => {
    expect(extractDeliverables("fix the timeout in the worker")).toEqual([]);
  });

  it("a bullet list of 3 → 3", () => {
    const task = [
      "Please do these:",
      "- add a rejectionReason field",
      "- surface it in the admin UI",
      "- emit a metric on reject",
    ].join("\n");
    expect(extractDeliverables(task).length).toBe(3);
  });

  it("'add X and wire Y' → 2", () => {
    const out = extractDeliverables("add a rejectionReason field and wire it into the admin UI");
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("prose with no enumeration → []", () => {
    expect(extractDeliverables("the worker keeps timing out under load")).toEqual([]);
  });

  it("empty / non-string → []", () => {
    expect(extractDeliverables("")).toEqual([]);
    // @ts-expect-error defensive: non-string input never throws
    expect(extractDeliverables(undefined)).toEqual([]);
  });
});

describe("verificationCoversAll", () => {
  it("single-deliverable task → true (never WARN)", () => {
    expect(
      verificationCoversAll(
        "fix the timeout in the worker",
        "## Verification\nfixed the timeout",
      ),
    ).toBe(true);
  });

  it("multi-deliverable + both addressed in ## Verification → true", () => {
    const task = "add a rejectionReason field and surface it in the admin UI";
    const rm =
      "## Verification\nAdded the rejectionReason field to the schema and surfaced it in the admin UI table.";
    expect(verificationCoversAll(task, rm)).toBe(true);
  });

  it("multi-deliverable + only the first addressed → false (WARN fires)", () => {
    const task = "add a rejectionReason field and surface it in the admin panel UI";
    const rm = "## Verification\nAdded the rejectionReason field to the schema.";
    expect(verificationCoversAll(task, rm)).toBe(false);
  });

  it("multi-deliverable + 'admin UI deferred' → true (deferral counts)", () => {
    const task = "add a rejectionReason field and surface it in the admin panel UI";
    const rm =
      "## Verification\nrejectionReason field done; admin UI deferred — needs the table refactor first.";
    expect(verificationCoversAll(task, rm)).toBe(true);
  });

  it("multi-deliverable + no Verification section → false (WARN)", () => {
    const task = "add a rejectionReason field and surface it in the admin panel UI";
    const rm = "## Plan\nAdded the field.";
    expect(verificationCoversAll(task, rm)).toBe(false);
  });

  it("F20 — a single shared keyword no longer clears a deliverable (needs 2)", () => {
    const task = "add a rejectionReason field and surface it in the admin panel UI";
    const rm =
      "## Verification\nAdded the rejectionReason field to the admin schema; tests pass.";
    expect(verificationCoversAll(task, rm)).toBe(false);
  });
});
