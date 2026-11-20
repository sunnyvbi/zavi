import { describe, it, expect } from "vitest";
import { SetRetentionBody } from "../retention-policy";

describe("retention-policy body schema", () => {
  it("accepts ttl override + store_raw", () => {
    const r = SetRetentionBody.safeParse({
      tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
      raw_ttl_days: 7,
      store_raw: true,
    });
    expect(r.success).toBe(true);
  });

  it("accepts null ttl (use global default)", () => {
    const r = SetRetentionBody.safeParse({
      tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
      raw_ttl_days: null,
      store_raw: false,
    });
    expect(r.success).toBe(true);
  });

  it("rejects negative ttl and missing store_raw", () => {
    expect(
      SetRetentionBody.safeParse({
        tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
        raw_ttl_days: -1,
        store_raw: true,
      }).success,
    ).toBe(false);
    expect(
      SetRetentionBody.safeParse({
        tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
      }).success,
    ).toBe(false);
  });
});
