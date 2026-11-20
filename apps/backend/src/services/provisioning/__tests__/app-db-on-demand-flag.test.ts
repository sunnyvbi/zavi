import { describe, it, expect } from "vitest";
import { isAppDbOnDemandEnabled } from "../app-db-on-demand-flag";

function stubSb(result: { data: unknown; error: unknown }) {
  return {
    from: (_t: string) => ({
      select: (_c: string) => ({
        eq: (_k: string, _v: unknown) => ({
          maybeSingle: async () => result,
        }),
      }),
    }),
  } as unknown as Parameters<typeof isAppDbOnDemandEnabled>[0];
}

describe("isAppDbOnDemandEnabled — flag reader (default ON, error OFF)", () => {
  it("ON when the key is absent", async () => {
    expect(await isAppDbOnDemandEnabled(stubSb({ data: { blob: {} }, error: null }))).toBe(true);
  });

  it("ON when blob/data is null", async () => {
    expect(await isAppDbOnDemandEnabled(stubSb({ data: null, error: null }))).toBe(true);
  });

  it("ON when the key is true", async () => {
    const sb = stubSb({ data: { blob: { app_db_on_demand: true } }, error: null });
    expect(await isAppDbOnDemandEnabled(sb)).toBe(true);
  });

  it("OFF when the key is literally false (kill switch)", async () => {
    const sb = stubSb({ data: { blob: { app_db_on_demand: false } }, error: null });
    expect(await isAppDbOnDemandEnabled(sb)).toBe(false);
  });

  it("OFF on a read error", async () => {
    const sb = stubSb({ data: null, error: { message: "system_config read failed" } });
    expect(await isAppDbOnDemandEnabled(sb)).toBe(false);
  });

  it("OFF when the read throws", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              throw new Error("boom");
            },
          }),
        }),
      }),
    } as unknown as Parameters<typeof isAppDbOnDemandEnabled>[0];
    expect(await isAppDbOnDemandEnabled(sb)).toBe(false);
  });
});
