import { describe, it, expect, vi, beforeEach } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../mixpanel", () => ({ track }));

import {
  SURFACE_OPEN_SOURCES,
  parseSurfaceSource,
  trackSurfaceOpened,
  trackSurfaceSummoned,
} from "../surface-events";

beforeEach(() => {
  track.mockReset();
});

describe("parseSurfaceSource", () => {
  it("reads the only value the client ever sends", () => {
    expect(parseSurfaceSource("summon")).toBe("summon");
  });

  it.each([
    undefined,
    null,
    "",
    "roster",
    "Summon",
    "SUMMON",
    " summon",
    "summon ",
    "nav",
    "deep-link",
    0,
    1,
    true,
    {},
    ["summon"],
  ])("folds %p to roster", (raw) => {
    expect(parseSurfaceSource(raw)).toBe("roster");
  });

  it("exposes a closed set of buckets", () => {
    expect([...SURFACE_OPEN_SOURCES]).toEqual(["roster", "summon"]);
  });
});

describe("trackSurfaceOpened", () => {
  it("emits agent_surface_opened with identifiers and the source only", () => {
    trackSurfaceOpened({
      tenant_id: "t-1",
      user_id: "u-1",
      agent_slug: "engineer",
      source: "summon",
    });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("agent_surface_opened", {
      tenant_id: "t-1",
      user_id: "u-1",
      agent_slug: "engineer",
      source: "summon",
    });
  });

  it("carries no property beyond the four identifiers/enums", () => {
    trackSurfaceOpened({
      tenant_id: "t-1",
      user_id: "u-1",
      agent_slug: "operator",
      source: "roster",
    });
    expect(Object.keys(track.mock.calls[0][1]).sort()).toEqual([
      "agent_slug",
      "source",
      "tenant_id",
      "user_id",
    ]);
  });

  it("never throws when the rail does", () => {
    track.mockImplementation(() => {
      throw new Error("mixpanel down");
    });
    let threw = false;
    try {
      trackSurfaceOpened({
        tenant_id: "t-1",
        user_id: "u-1",
        agent_slug: "engineer",
        source: "roster",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

describe("trackSurfaceSummoned", () => {
  it("emits agent_surface_summoned with the replying agent AND the dashboard", () => {
    trackSurfaceSummoned({
      tenant_id: "t-1",
      agent_slug: "operator",
      surface_key: "builds",
      dashboard_slug: "engineer",
    });
    expect(track).toHaveBeenCalledWith("agent_surface_summoned", {
      tenant_id: "t-1",
      agent_slug: "operator",
      surface_key: "builds",
      dashboard_slug: "engineer",
    });
  });

  it("carries no label and no task text", () => {
    trackSurfaceSummoned({
      tenant_id: "t-1",
      agent_slug: "operator",
      surface_key: "builds",
      dashboard_slug: "engineer",
    });
    expect(Object.keys(track.mock.calls[0][1]).sort()).toEqual([
      "agent_slug",
      "dashboard_slug",
      "surface_key",
      "tenant_id",
    ]);
  });

  it("never throws when the rail does", () => {
    track.mockImplementation(() => {
      throw new Error("mixpanel down");
    });
    let threw = false;
    try {
      trackSurfaceSummoned({
        tenant_id: "t-1",
        agent_slug: "operator",
        surface_key: "builds",
        dashboard_slug: "engineer",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
