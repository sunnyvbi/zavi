import { describe, it, expect } from "vitest";
import { validateStepArgs, validateRoutineArgs } from "../arg-validate";

const schema = {
  type: "object",
  properties: { channel: { type: "string" }, count: { type: "number" }, dry: { type: "boolean" } },
  required: ["channel"],
  additionalProperties: false,
};

describe("validateStepArgs", () => {
  it("accepts valid args", () => {
    expect(validateStepArgs("t", { channel: "#ops", count: 3, dry: true }, schema).ok).toBe(true);
  });
  it("accepts when only required present", () => {
    expect(validateStepArgs("t", { channel: "#ops" }, schema).ok).toBe(true);
  });
  it("rejects a missing required arg", () => {
    const r = validateStepArgs("t", { count: 1 }, schema);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/missing required arg 'channel'/);
  });
  it("rejects an unexpected key when additionalProperties:false", () => {
    const r = validateStepArgs("t", { channel: "#ops", evil: "x" }, schema);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/unexpected arg 'evil'/);
  });
  it("allows extra keys when additionalProperties is not false", () => {
    const loose = { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] };
    expect(validateStepArgs("t", { channel: "#ops", extra: 1 }, loose).ok).toBe(true);
  });
  it("rejects a wrong-typed arg", () => {
    const r = validateStepArgs("t", { channel: 123 }, schema);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/arg 'channel' has wrong type/);
  });
  it("fails closed on a null/absent schema", () => {
    expect(validateStepArgs("t", { channel: "#ops" }, null).ok).toBe(false);
    expect(validateStepArgs("t", { channel: "#ops" }, undefined).ok).toBe(false);
  });
  it("fails closed on a non-object schema", () => {
    const r = validateStepArgs("t", {}, { type: "string" });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/not an object schema/);
  });
});

describe("validateRoutineArgs", () => {
  const map = new Map<string, unknown>([["slack__post_message", schema]]);
  it("validates every step and reports the first failure with its index", () => {
    const r = validateRoutineArgs(
      [{ tool: "slack__post_message", args: { channel: "#ops" } }, { tool: "slack__post_message", args: {} }],
      map,
    );
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/step 1.*missing required arg 'channel'/);
  });
  it("fails closed when a step's tool has no schema in the map", () => {
    const r = validateRoutineArgs([{ tool: "unknown__tool", args: {} }], map);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/step 0.*not among the agent's live tools/);
  });
  it("passes when all steps are valid", () => {
    expect(validateRoutineArgs([{ tool: "slack__post_message", args: { channel: "#ops" } }], map).ok).toBe(true);
  });
});
