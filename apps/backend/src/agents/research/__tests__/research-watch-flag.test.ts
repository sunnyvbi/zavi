
import { describe, it, expect } from "vitest";
import { isResearchWatchPrecheckEnabled } from "../research-watch-flag";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "00000000-0000-0000-0000-000000000000";

function fakeSb(opts: {
  blob?: Record<string, unknown>;
  error?: unknown;
}): Parameters<typeof isResearchWatchPrecheckEnabled>[1] {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () =>
      opts.error
        ? { data: null, error: opts.error }
        : { data: { blob: opts.blob ?? {} }, error: null },
  };
  return {
    from: () => builder,
  } as unknown as Parameters<typeof isResearchWatchPrecheckEnabled>[1];
}

describe("isResearchWatchPrecheckEnabled", () => {
  it("default OFF — empty config blob → false", async () => {
    expect(
      await isResearchWatchPrecheckEnabled(TENANT, fakeSb({ blob: {} })),
    ).toBe(false);
  });

  it("missing key → false", async () => {
    expect(
      await isResearchWatchPrecheckEnabled(
        TENANT,
        fakeSb({ blob: { some_other_flag: true } }),
      ),
    ).toBe(false);
  });

  it("value `true` → enabled for ALL tenants", async () => {
    const sb = fakeSb({ blob: { research_watch_precheck_enabled: true } });
    expect(await isResearchWatchPrecheckEnabled(TENANT, sb)).toBe(true);
    expect(await isResearchWatchPrecheckEnabled(OTHER, sb)).toBe(true);
  });

  it("CSV string → enabled only for listed tenant_ids", async () => {
    const sb = fakeSb({
      blob: { research_watch_precheck_enabled: `${TENANT}, another-tenant` },
    });
    expect(await isResearchWatchPrecheckEnabled(TENANT, sb)).toBe(true);
    expect(await isResearchWatchPrecheckEnabled("another-tenant", sb)).toBe(true);
    expect(await isResearchWatchPrecheckEnabled(OTHER, sb)).toBe(false);
  });

  it("value `false` → OFF", async () => {
    expect(
      await isResearchWatchPrecheckEnabled(
        TENANT,
        fakeSb({ blob: { research_watch_precheck_enabled: false } }),
      ),
    ).toBe(false);
  });

  it("non-true / non-string value → OFF", async () => {
    expect(
      await isResearchWatchPrecheckEnabled(
        TENANT,
        fakeSb({ blob: { research_watch_precheck_enabled: 1 } }),
      ),
    ).toBe(false);
  });

  it("read error → OFF (fail-closed)", async () => {
    expect(
      await isResearchWatchPrecheckEnabled(
        TENANT,
        fakeSb({ error: { message: "boom" } }),
      ),
    ).toBe(false);
  });
});
