import { describe, expect, it } from "vitest";
import { enumLabelList } from "../app-data";

describe("enumLabelList", () => {
  it("passes a real array through", () => {
    expect(enumLabelList(["user", "admin"])).toEqual(["user", "admin"]);
  });
  it("parses a raw Postgres array literal", () => {
    expect(enumLabelList("{user,admin}")).toEqual(["user", "admin"]);
    expect(enumLabelList('{"in progress",done}')).toEqual(["in progress", "done"]);
  });
  it("returns null for empty or unknown shapes", () => {
    expect(enumLabelList("{}")).toBeNull();
    expect(enumLabelList(null)).toBeNull();
    expect(enumLabelList(undefined)).toBeNull();
    expect(enumLabelList(42)).toBeNull();
    expect(enumLabelList("user,admin")).toBeNull();
  });
});
