import { describe, it, expect } from "vitest";
import { forkableTemplates } from "./templates";

describe("forkableTemplates", () => {
  it("drops custom agents from the template grid", () => {
    expect(
      forkableTemplates([{ slug: "research" }, { slug: "c-abc123def0", custom: true }]).map((a) => a.slug),
    ).toEqual(["research"]);
  });
});
