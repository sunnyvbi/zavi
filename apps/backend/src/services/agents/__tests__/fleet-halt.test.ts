import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
const serviceClient = vi.fn();

vi.mock("@/services/supabase", () => ({
  serviceClient: () => serviceClient(),
}));

import { isFleetHalted, FleetHaltedError } from "../fleet-halt";

function mkClient() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle,
        }),
      }),
    }),
  };
}

beforeEach(() => {
  maybeSingle.mockReset();
  serviceClient.mockReset();
  serviceClient.mockReturnValue(mkClient());
});

describe("isFleetHalted", () => {
  it("returns true when blob.fleet_halt === true", async () => {
    maybeSingle.mockResolvedValue({ data: { blob: { fleet_halt: true } }, error: null });
    expect(await isFleetHalted()).toBe(true);
  });

  it("returns false when blob.fleet_halt === false", async () => {
    maybeSingle.mockResolvedValue({ data: { blob: { fleet_halt: false } }, error: null });
    expect(await isFleetHalted()).toBe(false);
  });

  it("returns false when the flag is absent (default running)", async () => {
    maybeSingle.mockResolvedValue({ data: { blob: {} }, error: null });
    expect(await isFleetHalted()).toBe(false);
  });

  it("returns false when the config row is missing entirely", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await isFleetHalted()).toBe(false);
  });

  it("FAIL-SAFE: returns true (halted) on a DB read error", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await isFleetHalted()).toBe(true);
  });

  it("FAIL-SAFE: returns true (halted) when the client throws", async () => {
    serviceClient.mockImplementation(() => {
      throw new Error("client init failed");
    });
    expect(await isFleetHalted()).toBe(true);
  });

  it("treats a truthy-but-not-boolean fleet_halt as NOT halted (strict === true)", async () => {
    maybeSingle.mockResolvedValue({ data: { blob: { fleet_halt: "true" } }, error: null });
    expect(await isFleetHalted()).toBe(false);
  });
});

describe("FleetHaltedError", () => {
  it("carries the fleet_halted code", () => {
    const e = new FleetHaltedError();
    expect(e.code).toBe("fleet_halted");
    expect(e.name).toBe("FleetHaltedError");
    expect(e.message).toMatch(/fleet halt/i);
  });
});
