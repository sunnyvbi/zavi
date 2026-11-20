import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (s: string) => s, tenantClient: vi.fn() }));
vi.mock("@/services/tools/google-analytics/_client", () => ({ googleAnalyticsCreds: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: vi.fn(), metaAdsCreds: vi.fn() }));
vi.mock("@/services/growth/booking-metrics/config", () => ({ getConfirmedBookingConfig: vi.fn() }));

import { isStorableTimeZone, resolveReportingTimezone, type TzDeps } from "../tenant-timezone";

function deps(over: Partial<Record<keyof TzDeps, unknown>> = {}) {
  const d = {
    readStored: vi.fn(async () => null),
    ga4PropertyTz: vi.fn(async () => null),
    metaAccountTz: vi.fn(async () => null),
    bookingConfigTz: vi.fn(async () => null),
    persistIfUnset: vi.fn(async () => undefined),
    ...over,
  };
  return d as unknown as TzDeps & Record<keyof TzDeps, ReturnType<typeof vi.fn>>;
}

describe("resolveReportingTimezone order", () => {
  it("a stored zone wins and nothing is detected or written", async () => {
    const d = deps({ readStored: vi.fn(async () => "Europe/London"), ga4PropertyTz: vi.fn(async () => "Asia/Tokyo") });
    await expect(resolveReportingTimezone("t1", { deps: d })).resolves.toEqual({ tz: "Europe/London", source: "stored" });
    expect(d.ga4PropertyTz).not.toHaveBeenCalled();
    expect(d.persistIfUnset).not.toHaveBeenCalled();
  });

  it("GA4 beats Meta beats booking config, and the first hit is persisted", async () => {
    const d = deps({
      ga4PropertyTz: vi.fn(async () => "America/New_York"),
      metaAccountTz: vi.fn(async () => "America/Chicago"),
      bookingConfigTz: vi.fn(async () => "America/Denver"),
    });
    await expect(resolveReportingTimezone("t1", { deps: d })).resolves.toEqual({ tz: "America/New_York", source: "ga4_property" });
    expect(d.metaAccountTz).not.toHaveBeenCalled();
    expect(d.persistIfUnset).toHaveBeenCalledWith("t1", "America/New_York");
  });

  it("falls through a failing or invalid source to the next", async () => {
    const d = deps({
      ga4PropertyTz: vi.fn(async () => {
        throw new Error("boom");
      }),
      metaAccountTz: vi.fn(async () => "Not/AZone"),
      bookingConfigTz: vi.fn(async () => "America/Denver"),
    });
    await expect(resolveReportingTimezone("t1", { deps: d })).resolves.toEqual({ tz: "America/Denver", source: "booking_config" });
  });

  it("an invalid stored value is ignored, not trusted", async () => {
    const d = deps({ readStored: vi.fn(async () => "Mars/Olympus"), metaAccountTz: vi.fn(async () => "Asia/Kolkata") });
    await expect(resolveReportingTimezone("t1", { deps: d })).resolves.toEqual({ tz: "Asia/Kolkata", source: "meta_ad_account" });
  });

  it("nothing found -> UTC, never persisted", async () => {
    const d = deps();
    await expect(resolveReportingTimezone("t1", { deps: d })).resolves.toEqual({ tz: "UTC", source: "default" });
    expect(d.persistIfUnset).not.toHaveBeenCalled();
  });

  it("persist:false (the GET route) never writes", async () => {
    const d = deps({ ga4PropertyTz: vi.fn(async () => "America/New_York") });
    await resolveReportingTimezone("t1", { deps: d, persist: false });
    expect(d.persistIfUnset).not.toHaveBeenCalled();
  });

  it("a failed persist does not fail the read", async () => {
    const d = deps({
      ga4PropertyTz: vi.fn(async () => "America/New_York"),
      persistIfUnset: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(resolveReportingTimezone("t1", { deps: d })).resolves.toMatchObject({ tz: "America/New_York" });
  });
});

describe("isStorableTimeZone", () => {
  it("accepts IANA region names and UTC, rejects the rest", () => {
    for (const ok of ["UTC", "America/New_York", "America/Argentina/Buenos_Aires", "Etc/GMT+5", "America/Port-au-Prince"]) {
      expect(isStorableTimeZone(ok), ok).toBe(true);
    }
    for (const bad of ["", "Mars/Olympus", "America/New_York; drop table", "EST5EDT", 42, null]) {
      expect(isStorableTimeZone(bad), String(bad)).toBe(false);
    }
  });
});
