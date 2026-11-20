import { describe, it, expect } from "vitest";
import { isPmInteractiveHandoffEnabled } from "../pm-interactive-handoff-flag";

function stubSb(result: { data: unknown; error: unknown }) {
  return {
    from: (_table: string) => ({
      select: (_c: string) => ({
        eq: (_k: string, _v: unknown) => ({
          maybeSingle: async () => result,
        }),
      }),
    }),
  } as unknown as Parameters<typeof isPmInteractiveHandoffEnabled>[0];
}

describe("isPmInteractiveHandoffEnabled — flag reader (Slice 1)", () => {
  it("true ONLY when blob.pm_interactive_handoff === true", async () => {
    const sb = stubSb({ data: { blob: { pm_interactive_handoff: true } }, error: null });
    expect(await isPmInteractiveHandoffEnabled(sb)).toBe(true);
  });

  it("false when the key is literally false", async () => {
    const sb = stubSb({ data: { blob: { pm_interactive_handoff: false } }, error: null });
    expect(await isPmInteractiveHandoffEnabled(sb)).toBe(false);
  });

  it("false when the key is absent from blob", async () => {
    const sb = stubSb({ data: { blob: {} }, error: null });
    expect(await isPmInteractiveHandoffEnabled(sb)).toBe(false);
  });

  it("false when blob/data is null", async () => {
    const sb = stubSb({ data: null, error: null });
    expect(await isPmInteractiveHandoffEnabled(sb)).toBe(false);
  });

  it("false (soft-fail) when truthy-but-non-boolean (e.g. string 'true')", async () => {
    const sb = stubSb({ data: { blob: { pm_interactive_handoff: "true" } }, error: null });
    expect(await isPmInteractiveHandoffEnabled(sb)).toBe(false);
  });

  it("soft-fails to FALSE on a read error (never silently arms the E3 path)", async () => {
    const sb = stubSb({ data: null, error: { message: "system_config read failed" } });
    expect(await isPmInteractiveHandoffEnabled(sb)).toBe(false);
  });

  it("soft-fails to FALSE when maybeSingle throws", async () => {
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
    } as unknown as Parameters<typeof isPmInteractiveHandoffEnabled>[0];
    expect(await isPmInteractiveHandoffEnabled(sb)).toBe(false);
  });
});
