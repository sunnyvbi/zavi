import { describe, expect, it } from "vitest";
import { projectSettings, RETIRED_SETTINGS } from "../context";

const saved = {
  production_route: [{ value: "ai_presenter", status: "active" }],
  run_surface: [{ value: "own_ad_account", status: "active" }],
  claims_off_limits: [{ value: "Guaranteed savings", status: "active" }],
};

describe("retired channel settings", () => {
  it("drops UGC's removed AI route but keeps the settings UGC still offers", () => {
    const out = projectSettings(saved, "ugc");
    expect(out).not.toHaveProperty("production_route");
    expect(Object.keys(out ?? {}).sort()).toEqual(["claims_off_limits", "run_surface"]);
  });

  it("is scoped to its channel: the same field id elsewhere is untouched", () => {
    expect(projectSettings(saved, "tiktok_organic")).toHaveProperty("production_route");
  });

  it("lists only slug:field keys", () => {
    for (const k of RETIRED_SETTINGS) expect(k).toMatch(/^[a-z_]+:[a-z_]+$/);
  });
});
