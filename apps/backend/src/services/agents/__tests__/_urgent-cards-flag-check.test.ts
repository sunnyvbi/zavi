
import { describe, it, expect, vi } from "vitest";
import { isUrgentFlagsAsCardsEnabled } from "../_urgent-cards-flag-check";

function sbWith(result: { data: unknown; error: unknown }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
  };
  return { from: () => chain } as never;
}

describe("isUrgentFlagsAsCardsEnabled", () => {
  it("true ONLY when blob.urgent_flags_as_cards_enabled === true", async () => {
    expect(
      await isUrgentFlagsAsCardsEnabled(
        sbWith({ data: { blob: { urgent_flags_as_cards_enabled: true } }, error: null }),
      ),
    ).toBe(true);
  });

  it("false when the flag is absent (default OFF)", async () => {
    expect(
      await isUrgentFlagsAsCardsEnabled(sbWith({ data: { blob: {} }, error: null })),
    ).toBe(false);
  });

  it("false when the flag is explicitly false", async () => {
    expect(
      await isUrgentFlagsAsCardsEnabled(
        sbWith({ data: { blob: { urgent_flags_as_cards_enabled: false } }, error: null }),
      ),
    ).toBe(false);
  });

  it("false (NOT truthy) for a non-boolean 'true' string — strict === true only", async () => {
    expect(
      await isUrgentFlagsAsCardsEnabled(
        sbWith({
          data: { blob: { urgent_flags_as_cards_enabled: "true" } },
          error: null,
        }),
      ),
    ).toBe(false);
  });

  it("SOFT-FAILS to false on a read error (never silently flips on)", async () => {
    expect(
      await isUrgentFlagsAsCardsEnabled(
        sbWith({ data: null, error: { message: "boom" } }),
      ),
    ).toBe(false);
  });

  it("SOFT-FAILS to false when the client throws", async () => {
    const throwingSb = {
      from: () => {
        throw new Error("network down");
      },
    } as never;
    expect(await isUrgentFlagsAsCardsEnabled(throwingSb)).toBe(false);
  });
});
