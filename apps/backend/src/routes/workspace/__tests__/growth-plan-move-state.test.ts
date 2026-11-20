import { expect, it } from "vitest";
import { moveState } from "../growth-plan";

it("a successful run whose filed change failed downstream is blocked, not done", () => {
  expect(moveState("acted", "success", true)).toBe("blocked");
});

it("a successful run with no failed change is done (unchanged behavior)", () => {
  expect(moveState("acted", "success", false)).toBe("done");
  expect(moveState("acted", "success")).toBe("done");
});

it("the earlier states are untouched by the downstream verdict", () => {
  expect(moveState("proposed", null, true)).toBe("waiting");
  expect(moveState("rejected", null, true)).toBe("declined");
  expect(moveState("dispatch_failed", null, true)).toBe("failed");
  expect(moveState("acted", null, true)).toBe("starting");
  expect(moveState("acted", "running", true)).toBe("running");
  expect(moveState("acted", "failed", false)).toBe("failed");
});
