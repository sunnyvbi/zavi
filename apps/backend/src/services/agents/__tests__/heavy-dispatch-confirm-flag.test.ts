import { describe, it, expect } from "vitest";
import { isHeavyDispatchConfirmEnabled } from "../heavy-dispatch-confirm-flag";

function stubSb(result: { data: unknown; error: unknown }) {
  return {
    from: (_t: string) => ({
      select: (_c: string) => ({
        eq: (_k: string, _v: unknown) => ({
          maybeSingle: async () => result,
        }),
      }),
    }),
  } as unknown as Parameters<typeof isHeavyDispatchConfirmEnabled>[0];
}

describe("isHeavyDispatchConfirmEnabled — flag reader (default ON)", () => {
  it("ON when blob.heavy_dispatch_confirm === true", async () => {
    const sb = stubSb({ data: { blob: { heavy_dispatch_confirm: true } }, error: null });
    expect(await isHeavyDispatchConfirmEnabled(sb)).toBe(true);
  });

  it("OFF only when the key is literally false (kill-switch)", async () => {
    const sb = stubSb({ data: { blob: { heavy_dispatch_confirm: false } }, error: null });
    expect(await isHeavyDispatchConfirmEnabled(sb)).toBe(false);
  });

  it("ON (default) when the key is absent — gate live pre-seed", async () => {
    const sb = stubSb({ data: { blob: {} }, error: null });
    expect(await isHeavyDispatchConfirmEnabled(sb)).toBe(true);
  });

  it("ON when blob/data is null", async () => {
    const sb = stubSb({ data: null, error: null });
    expect(await isHeavyDispatchConfirmEnabled(sb)).toBe(true);
  });

  it("ON when the value is truthy-but-non-boolean (only literal false disarms)", async () => {
    const sb = stubSb({ data: { blob: { heavy_dispatch_confirm: "false" } }, error: null });
    expect(await isHeavyDispatchConfirmEnabled(sb)).toBe(true);
  });

  it("fail-SAFES to ON on a read error (never silently disarms the gate)", async () => {
    const sb = stubSb({ data: null, error: { message: "system_config read failed" } });
    expect(await isHeavyDispatchConfirmEnabled(sb)).toBe(true);
  });

  it("fail-SAFES to ON when maybeSingle throws", async () => {
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
    } as unknown as Parameters<typeof isHeavyDispatchConfirmEnabled>[0];
    expect(await isHeavyDispatchConfirmEnabled(sb)).toBe(true);
  });
});
