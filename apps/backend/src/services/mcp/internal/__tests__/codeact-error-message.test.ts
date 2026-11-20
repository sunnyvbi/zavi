import { describe, it, expect } from "vitest";
import { pythonError } from "../codeact-tool";

const ROW = "{'phone': '4155550100', 'password': 'hunter2'}";

describe("CodeAct python errors never carry row values", () => {
  it("withholds the message for every exception class, including code-shaped ones", () => {
    for (const cls of ["Exception", "ValueError", "KeyError", "NameError", "ImportError", "AttributeError", "codeact_no_output", "codeact_x"]) {
      const out = JSON.stringify(pythonError(cls, ROW));
      expect(out, cls).not.toContain("4155550100");
      expect(out, cls).not.toContain("hunter2");
    }
  });

  it("does not forward a class name the model's code invented", () => {
    expect(pythonError("hunter2_4155550100", "x")).toMatchObject({ error: "Exception" });
    expect(pythonError("NameError", "name 'rowz' is not defined").error).toBe("NameError");
  });

  it("reports nothing when there was no error", () => {
    expect(pythonError(undefined, undefined)).toEqual({ error: null, message: null });
  });
});
