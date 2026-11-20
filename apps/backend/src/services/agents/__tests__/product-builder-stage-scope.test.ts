import { describe, it, expect } from "vitest";
import { productBuilderStageScope } from "../product-builder-stage-scope";

describe("productBuilderStageScope", () => {
  it("scaffold gets a skeleton scope, not the full feature set", () => {
    const s = productBuilderStageScope(false);
    const text = `${s.writeRule}\n${s.depthBaseline}`;
    expect(text).not.toMatch(/Build the WHOLE product/);
    expect(text).not.toMatch(/Implement EVERY primary feature/);
    expect(text).not.toMatch(/Generate the whole app/);
    expect(s.depthBaseline).toMatch(/ONE primary flow/);
  });

  it("build keeps the full feature set", () => {
    const b = productBuilderStageScope(true);
    expect(b.writeRule).toMatch(/Generate the whole app/);
    expect(b.depthBaseline).toMatch(/Build the WHOLE product/);
    expect(b.depthBaseline).toMatch(/Implement EVERY primary feature/);
  });
});
