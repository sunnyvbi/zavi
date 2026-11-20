import { describe, it, expect } from "vitest";
import { classifyCalibration } from "../judge-labeler";

describe("classifyCalibration", () => {
  it("strong = EXACT set match only", () => {
    expect(classifyCalibration(["n1"], ["n1"])).toBe("strong");
    expect(classifyCalibration(["n2", "n1"], ["n1", "n2"])).toBe("strong");
  });
  it("weak = partial overlap OR superset (recall, not agreement)", () => {
    expect(classifyCalibration(["n1", "n3"], ["n1", "n2"])).toBe("weak");
    expect(classifyCalibration(["n1", "n2", "n9"], ["n1", "n2"])).toBe("weak");
  });
  it("disagree = no overlap", () => {
    expect(classifyCalibration(["n3", "n4"], ["n1", "n2"])).toBe("disagree");
  });
  it("empty judge or anchor → disagree", () => {
    expect(classifyCalibration([], ["n1"])).toBe("disagree");
    expect(classifyCalibration(["n1"], [])).toBe("disagree");
  });
});
