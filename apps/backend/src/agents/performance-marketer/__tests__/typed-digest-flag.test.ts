
import { describe, it, expect } from "vitest";
import { isPerfmktTypedDigestEnabled } from "../typed-digest-flag";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "00000000-0000-0000-0000-000000000000";

function fakeSb(opts: {
  blob?: Record<string, unknown>;
  error?: unknown;
}): Parameters<typeof isPerfmktTypedDigestEnabled>[1] {
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
  } as unknown as Parameters<typeof isPerfmktTypedDigestEnabled>[1];
}

describe("isPerfmktTypedDigestEnabled", () => {
  it("default OFF — empty config blob → false", async () => {
    expect(await isPerfmktTypedDigestEnabled(TENANT, fakeSb({ blob: {} }))).toBe(
      false,
    );
  });

  it("missing key → false", async () => {
    expect(
      await isPerfmktTypedDigestEnabled(
        TENANT,
        fakeSb({ blob: { some_other_flag: true } }),
      ),
    ).toBe(false);
  });

  it("value `true` → enabled for ALL tenants", async () => {
    const sb = fakeSb({ blob: { perfmkt_typed_digest_enabled: true } });
    expect(await isPerfmktTypedDigestEnabled(TENANT, sb)).toBe(true);
    expect(await isPerfmktTypedDigestEnabled(OTHER, sb)).toBe(true);
  });

  it("CSV string → enabled only for listed tenant_ids", async () => {
    const sb = fakeSb({
      blob: { perfmkt_typed_digest_enabled: `${TENANT}, another-tenant` },
    });
    expect(await isPerfmktTypedDigestEnabled(TENANT, sb)).toBe(true);
    expect(await isPerfmktTypedDigestEnabled("another-tenant", sb)).toBe(true);
    expect(await isPerfmktTypedDigestEnabled(OTHER, sb)).toBe(false);
  });

  it("value `false` → OFF", async () => {
    expect(
      await isPerfmktTypedDigestEnabled(
        TENANT,
        fakeSb({ blob: { perfmkt_typed_digest_enabled: false } }),
      ),
    ).toBe(false);
  });

  it("non-true / non-string value (number/object) → OFF", async () => {
    expect(
      await isPerfmktTypedDigestEnabled(
        TENANT,
        fakeSb({ blob: { perfmkt_typed_digest_enabled: 1 } }),
      ),
    ).toBe(false);
    expect(
      await isPerfmktTypedDigestEnabled(
        TENANT,
        fakeSb({ blob: { perfmkt_typed_digest_enabled: { on: true } } }),
      ),
    ).toBe(false);
  });

  it("DB read error → OFF (fail-closed)", async () => {
    expect(
      await isPerfmktTypedDigestEnabled(
        TENANT,
        fakeSb({ error: { message: "boom" } }),
      ),
    ).toBe(false);
  });

  it("a throwing client → OFF (fail-closed, never throws)", async () => {
    const throwingSb = {
      from: () => {
        throw new Error("client exploded");
      },
    } as unknown as Parameters<typeof isPerfmktTypedDigestEnabled>[1];
    await expect(
      isPerfmktTypedDigestEnabled(TENANT, throwingSb),
    ).resolves.toBe(false);
  });
});
