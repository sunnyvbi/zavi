// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetBuildStartKeyForTests,
  buildStartBody,
  buildStartKey,
  clearBuildStartKey,
  keepsBuildStartKey,
} from "./buildStartKey";

beforeEach(() => _resetBuildStartKeyForTests());

describe("build start key", () => {
  it("every door builds the same body for the same intent (trimmed, defaulted, fixed order)", () => {
    const fromBuildPage = buildStartBody({ idea: "a bakery site ", company_name: "Shop" });
    const fromStartPage = buildStartBody({ idea: " a bakery site", company_name: " Shop ", reference_images: [] });
    expect(fromStartPage).toBe(fromBuildPage);
    expect(JSON.parse(buildStartBody({ idea: "x".repeat(9), company_name: "" }))).toEqual({ idea: "x".repeat(9), company_name: "My Company", await_look_pick: true });
    expect(JSON.parse(buildStartBody({ idea: "a bakery site", company_name: "Shop", reference_images: ["i1"] }))).toEqual({
      idea: "a bakery site",
      company_name: "Shop",
      reference_images: ["i1"],
      await_look_pick: true,
    });
  });

  it("the same intent gets the same key across doors until it is cleared", () => {
    const body = buildStartBody({ idea: "a bakery site", company_name: "Shop" });
    const a = buildStartKey(body);
    expect(a).toMatch(/^[A-Za-z0-9_.:-]{8,200}$/);
    expect(buildStartKey(body)).toBe(a);
    const other = buildStartKey(buildStartBody({ idea: "a florist site", company_name: "Shop" }));
    expect(other).not.toBe(a);
  });

  it("survives the module's memory being lost (a reload): read back from sessionStorage", () => {
    const body = buildStartBody({ idea: "a bakery site", company_name: "Shop" });
    const a = buildStartKey(body);
    const stored = JSON.parse(window.sessionStorage.getItem("zavi:pending-build-start") ?? "null");
    expect(stored).toEqual({ signature: body, requestId: a });
  });

  it("clearing drops it: the next press of the same idea is a new intent", () => {
    const body = buildStartBody({ idea: "a bakery site", company_name: "Shop" });
    const a = buildStartKey(body);
    clearBuildStartKey(a);
    expect(buildStartKey(body)).not.toBe(a);
  });

  it("clearing an OLDER key never drops a newer intent's key", () => {
    const a = buildStartKey(buildStartBody({ idea: "a bakery site", company_name: "Shop" }));
    const bBody = buildStartBody({ idea: "a florist site", company_name: "Shop" });
    const b = buildStartKey(bBody);
    clearBuildStartKey(a);
    expect(buildStartKey(bBody)).toBe(b);
  });

  it("only in-progress and stale answers keep the key", () => {
    expect(keepsBuildStartKey("idempotency_in_progress")).toBe(true);
    expect(keepsBuildStartKey("idempotency_stale")).toBe(true);
    for (const code of ["build_already_in_progress", "product_builder_unavailable", "insufficient_credits_for_build", null, undefined]) {
      expect(keepsBuildStartKey(code)).toBe(false);
    }
  });
});

describe("buildStartBody with a starting template", () => {
  it("carries the template id, so the same idea from another template is another intent", () => {
    const plain = buildStartBody({ idea: "A bike shop", company_name: "Spoke" });
    const tpl = buildStartBody({ idea: "A bike shop", company_name: "Spoke", template: "book-a-service" });
    expect(JSON.parse(tpl).template).toBe("book-a-service");
    expect(JSON.parse(plain)).not.toHaveProperty("template");
    expect(buildStartBody({ idea: "A bike shop", company_name: "Spoke", template: null })).toBe(plain);
    expect(tpl).not.toBe(plain);
  });
});

