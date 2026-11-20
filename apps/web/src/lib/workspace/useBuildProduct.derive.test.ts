import { describe, it, expect } from "vitest";
import {
  deriveBuildStatus,
  deriveAppStatus,
  type TenantResource,
} from "./useBuildProduct";

describe("deriveBuildStatus — hosting + run terminal status precedence", () => {
  it("genuinely live (ready + url) stays live even when the run reads failed (never downgrade a real live app)", () => {
    expect(deriveBuildStatus("ready", "https://app.onrender.com", "failed")).toBe("live");
  });

  it("failed run over a ready-but-url-stripped placeholder → failed (THE fix: no infinite spinner)", () => {
    expect(deriveBuildStatus("ready", null, "failed")).toBe("failed");
  });

  it("failed run while hosting still provisioning → failed", () => {
    expect(deriveBuildStatus("provisioning", null, "failed")).toBe("failed");
  });

  it("halted / cancelled / canceled runs also map to failed", () => {
    expect(deriveBuildStatus("provisioning", null, "halted")).toBe("failed");
    expect(deriveBuildStatus("ready", null, "cancelled")).toBe("failed");
    expect(deriveBuildStatus("ready", null, "canceled")).toBe("failed");
  });

  it("active run while provisioning → building (still in flight)", () => {
    expect(deriveBuildStatus("provisioning", null, "active")).toBe("building");
  });

  it("done run with ready + url → live", () => {
    expect(deriveBuildStatus("ready", "https://app.onrender.com", "done")).toBe("live");
  });

  it("torn-down app with a stale failed run → none (must not show 'Build failed' for a deleted app)", () => {
    expect(deriveBuildStatus("torn_down", null, "failed")).toBe("none");
    expect(deriveBuildStatus("teardown", null, "failed")).toBe("none");
  });

  it("null run (refine-window / no build) falls back to hosting status, never masks or fabricates", () => {
    expect(deriveBuildStatus("provisioning", null, null)).toBe("building");
    expect(deriveBuildStatus("ready", "https://app.onrender.com", null)).toBe("live");
    expect(deriveBuildStatus("failed", null, null)).toBe("failed");
  });
});

describe("deriveAppStatus — resources + run status → {status, url}", () => {
  const hosting = (status: string, url?: string): TenantResource[] => [
    { resource_kind: "hosting", status, external_ref: url ? { url } : {} },
  ];

  it("ready + url + failed run → live WITH url (truthfulness: live wins)", () => {
    expect(deriveAppStatus(hosting("ready", "https://a.onrender.com"), "failed")).toEqual({
      status: "live",
      url: "https://a.onrender.com",
    });
  });

  it("ready + no url + failed run → failed, url withheld (the placeholder-on-fail spinner is now a failed card)", () => {
    expect(deriveAppStatus(hosting("ready"), "failed")).toEqual({ status: "failed", url: null });
  });

  it("no hosting row → none regardless of run status (nothing provisioned)", () => {
    expect(deriveAppStatus([{ resource_kind: "repo", status: "ready" }], "failed")).toEqual({
      status: "none",
      url: null,
    });
  });

  it("provisioning + null run → building", () => {
    expect(deriveAppStatus(hosting("provisioning"), null)).toEqual({
      status: "building",
      url: null,
    });
  });
});

describe("a paused build reads stopped, never building (checkpoint model)", () => {
  it("paused run over a placeholder host is not 'building'", () => {
    expect(deriveBuildStatus("ready", null, "paused")).toBe("failed");
    expect(deriveBuildStatus("provisioning", null, "paused")).toBe("failed");
  });
  it("a real live app still wins", () => {
    expect(deriveBuildStatus("ready", "https://app.example.com", "paused")).toBe("live");
  });
});
