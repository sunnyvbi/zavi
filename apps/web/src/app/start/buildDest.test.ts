import { describe, expect, it } from "vitest";
import { BUILD_TAB_DEST, buildDestFor } from "./buildDest";

const RUN = "509235e5-bb1b-448c-9a2b-4acdb9ccb0b2";

describe("buildDestFor", () => {
  it("deep-links the Build tab to the run the signup just started", () => {
    expect(buildDestFor({ ok: true, tenant_id: "t", conductor_run_id: RUN })).toBe(
      `/workspace?tab=build&build=${RUN}`,
    );
  });

  it("uses the in-flight run a 409 reports, so a retry lands on the build already running", () => {
    expect(buildDestFor({ error: { code: "build_already_in_progress" }, run_id: RUN })).toBe(
      `/workspace?tab=build&build=${RUN}`,
    );
  });

  it("never puts a non-uuid into the URL", () => {
    expect(buildDestFor({ conductor_run_id: "../etc" })).toBe(BUILD_TAB_DEST);
    expect(buildDestFor({ conductor_run_id: 42 })).toBe(BUILD_TAB_DEST);
    expect(buildDestFor(null)).toBe(BUILD_TAB_DEST);
    expect(buildDestFor({})).toBe(BUILD_TAB_DEST);
  });

  it("never sends a fresh build to the Website tab", () => {
    expect(buildDestFor({ tenant_id: "t" })).not.toContain("tab=website");
  });
});
