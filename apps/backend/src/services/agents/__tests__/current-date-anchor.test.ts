import { describe, it, expect } from "vitest";
import {
  buildStablePromptPrefix,
  renderCurrentDateLine,
} from "../generic-dispatcher";

const BODY = "# pm\n\nYou are an agent. Tenant: {{tenant.name}}.\n";
const MEMORY = {
  company: "test co",
  ops: "test ops",
  policies: "",
  disputes: "",
  support: "",
};

const FAILURE_INSTANT_MS = Date.parse("2026-07-16T00:25:00Z");

describe("renderCurrentDateLine — tenant-tz current-date anchor", () => {
  it("renders the PT calendar date at the UTC-rollover instant, NOT the UTC date", () => {
    const line = renderCurrentDateLine(
      { timezone: "America/Los_Angeles" },
      FAILURE_INSTANT_MS,
    );
    expect(line).toContain("July 15, 2026");
    expect(line).toContain("Wednesday");
    expect(line).not.toContain("July 16");
    expect(line).toContain("America/Los_Angeles");
  });

  it("honors a non-PT tenant timezone", () => {
    const nyLine = renderCurrentDateLine(
      { timezone: "America/New_York" },
      FAILURE_INSTANT_MS,
    );
    expect(nyLine).toContain("July 15, 2026");
    expect(nyLine).toContain("America/New_York");
    const utcLine = renderCurrentDateLine({ timezone: "UTC" }, FAILURE_INSTANT_MS);
    expect(utcLine).toContain("July 16, 2026");
  });

  it("falls back to America/Los_Angeles without throwing on a bad tz string", () => {
    const line = renderCurrentDateLine(
      { timezone: "Not/AReal_Zone" },
      FAILURE_INSTANT_MS,
    );
    expect(line).toContain("America/Los_Angeles");
    expect(line).toContain("July 15, 2026");
  });

  it("falls back when tenant/timezone is absent", () => {
    expect(renderCurrentDateLine(undefined, FAILURE_INSTANT_MS)).toContain(
      "America/Los_Angeles",
    );
    expect(renderCurrentDateLine({}, FAILURE_INSTANT_MS)).toContain(
      "America/Los_Angeles",
    );
  });

  it("instructs the model to prefer this over UTC timestamps", () => {
    const line = renderCurrentDateLine({ timezone: "UTC" }, FAILURE_INSTANT_MS);
    expect(line).toMatch(/today/i);
    expect(line).toMatch(/UTC timestamps/i);
  });

  it("carries NO ISO-8601 timestamp — safe for the cache-prefix ISO guard", () => {
    const line = renderCurrentDateLine({ timezone: "UTC" }, FAILURE_INSTANT_MS);
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe("buildStablePromptPrefix — date anchor stays OUT of the cached prefix", () => {
  it("does not fold the Current date line into the stable prefix", () => {
    const prefix = buildStablePromptPrefix({
      body_markdown: BODY,
      tenant: { name: "Upcar", timezone: "America/Los_Angeles" },
      memory: MEMORY,
    });
    expect(prefix).not.toContain("Current date:");
  });
});
