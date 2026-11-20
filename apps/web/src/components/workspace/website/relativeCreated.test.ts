
import { describe, it, expect } from "vitest";
import { relativeCreated } from "./WebsiteConsole";

const NOW = Date.parse("2026-07-17T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("relativeCreated", () => {
  it("returns null for missing / unparseable input", () => {
    expect(relativeCreated(null, NOW)).toBeNull();
    expect(relativeCreated("not-a-date", NOW)).toBeNull();
  });

  it("collapses same-day (incl. tiny future skew) to 'Created today'", () => {
    expect(relativeCreated(daysAgo(0), NOW)).toBe("Created today");
    expect(relativeCreated(new Date(NOW + 5_000).toISOString(), NOW)).toBe("Created today");
  });

  it("singularizes one day / month / year", () => {
    expect(relativeCreated(daysAgo(1), NOW)).toBe("Created 1 day ago");
    expect(relativeCreated(daysAgo(30), NOW)).toBe("Created 1 month ago");
    expect(relativeCreated(daysAgo(365), NOW)).toBe("Created 1 year ago");
  });

  it("uses days under a month, months under a year, else years", () => {
    expect(relativeCreated(daysAgo(3), NOW)).toBe("Created 3 days ago");
    expect(relativeCreated(daysAgo(90), NOW)).toBe("Created 3 months ago");
    expect(relativeCreated(daysAgo(800), NOW)).toBe("Created 2 years ago");
  });

  it("does not print '0 years' in the 360-364 day gap", () => {
    expect(relativeCreated(daysAgo(360), NOW)).toBe("Created 12 months ago");
    expect(relativeCreated(daysAgo(364), NOW)).toBe("Created 12 months ago");
  });
});
