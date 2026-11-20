
import { describe, it, expect } from "vitest";
import { isStreamTokensEnabled } from "../_stream-tokens-flag-check";

function sbWith(result: { data: unknown; error: unknown }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
  };
  return { from: () => chain } as never;
}

describe("isStreamTokensEnabled (default OFF)", () => {
  it("true ONLY when blob.stream_tokens_enabled === true", async () => {
    expect(
      await isStreamTokensEnabled(
        sbWith({ data: { blob: { stream_tokens_enabled: true } }, error: null }),
      ),
    ).toBe(true);
  });

  it("FALSE when the flag is ABSENT (default OFF)", async () => {
    expect(
      await isStreamTokensEnabled(sbWith({ data: { blob: {} }, error: null })),
    ).toBe(false);
  });

  it("FALSE when there is no system_config row at all (default OFF)", async () => {
    expect(
      await isStreamTokensEnabled(sbWith({ data: null, error: null })),
    ).toBe(false);
  });

  it("FALSE when the flag is explicitly false", async () => {
    expect(
      await isStreamTokensEnabled(
        sbWith({ data: { blob: { stream_tokens_enabled: false } }, error: null }),
      ),
    ).toBe(false);
  });

  it("FALSE for a truthy non-boolean ('true' STRING is not the boolean flag)", async () => {
    expect(
      await isStreamTokensEnabled(
        sbWith({
          data: { blob: { stream_tokens_enabled: "true" } },
          error: null,
        }),
      ),
    ).toBe(false);
  });

  it("SOFT-FAILS to false on a read error", async () => {
    expect(
      await isStreamTokensEnabled(
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
    expect(await isStreamTokensEnabled(throwingSb)).toBe(false);
  });
});
