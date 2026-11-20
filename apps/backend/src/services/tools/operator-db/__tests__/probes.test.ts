import { describe, it, expect } from "vitest";
import { probeRoleFields, probeMappedFields } from "../probes";
import type { CanonicalMap } from "../mapping";

describe("field-level probes", () => {
  it("REJECTS a date field mapped to an array column (created_at → photo array)", () => {
    const sample = [
      { additionalPhotoTimestamps: [1710000000, 1710000100] },
      { additionalPhotoTimestamps: [] },
      { additionalPhotoTimestamps: [1710000200] },
    ];
    const probes = probeRoleFields(
      "bookings",
      { table: "listings", created_at_field: "additionalPhotoTimestamps" },
      sample,
    );
    const date = probes.find((p) => p.field_key === "created_at_field");
    expect(date?.kind).toBe("date");
    expect(date?.ok).toBe(false);
    expect(date?.reason).toMatch(/array|non-date|no parseable/i);
  });

  it("ACCEPTS a real scalar-timestamp date field", () => {
    const sample = [
      { created_at: "2026-06-01T10:00:00Z" },
      { created_at: "2026-06-02T11:00:00Z" },
      { created_at: null },
    ];
    const probes = probeRoleFields("bookings", { table: "b", created_at_field: "created_at" }, sample);
    expect(probes[0].ok).toBe(true);
    expect(probes[0].coverage).toBeGreaterThan(0.5);
  });

  it("date probe REJECTS parseable-but-non-ISO string dates (lexical-unsafe — codex R5)", () => {
    const probes = probeRoleFields("bookings", { table: "b", created_at_field: "created_at" }, [
      { created_at: "06/01/2026" }, { created_at: "July 1 2026" }, { created_at: "06/02/2026" },
    ]);
    expect(probes[0].kind).toBe("date");
    expect(probes[0].ok).toBe(false);
  });

  it("date probe ACCEPTS ISO-8601 with and without time", () => {
    const probes = probeRoleFields("bookings", { table: "b", created_at_field: "created_at" }, [
      { created_at: "2026-06-01" }, { created_at: "2026-06-02T10:00:00Z" },
    ]);
    expect(probes[0].ok).toBe(true);
  });

  it("date probe REJECTS short numeric strings (created_at mis-mapped to an id/amount)", () => {
    const probes = probeRoleFields("bookings", { table: "b", created_at_field: "trip_number" }, [
      { trip_number: "1" }, { trip_number: "40" }, { trip_number: "12" },
    ]);
    expect(probes[0].kind).toBe("date");
    expect(probes[0].ok).toBe(false);
  });

  it("numeric probe rejects an all-null/zero amount and accepts positive values", () => {
    const bad = probeRoleFields("bookings", { table: "b", gmv_proxy_field: "amount" }, [
      { amount: 0 }, { amount: null }, { amount: "" },
    ]);
    expect(bad[0].kind).toBe("numeric");
    expect(bad[0].ok).toBe(false);

    const good = probeRoleFields("bookings", { table: "b", gmv_proxy_field: "amount" }, [
      { amount: 42.5 }, { amount: "19.99" }, { amount: 0 },
    ]);
    expect(good[0].ok).toBe(true);
  });

  it("numeric probe accepts Mongo extended-JSON numbers ($numberDecimal / $numberLong)", () => {
    const probes = probeRoleFields("bookings", { table: "b", gmv_proxy_field: "amount" }, [
      { amount: { $numberDecimal: "12.34" } },
      { amount: { $numberLong: "5000" } },
      { amount: null },
    ]);
    expect(probes[0].kind).toBe("numeric");
    expect(probes[0].ok).toBe(true);
  });

  it("enum probe REJECTS non-scalar (array/object) status/reason values", () => {
    const arrStatus = probeRoleFields("cancellations", { table: "c", status_field: "status" }, [
      { status: ["cancelled", "pending"] },
      { status: { code: 3 } },
    ]);
    expect(arrStatus[0].kind).toBe("status");
    expect(arrStatus[0].ok).toBe(false);

    const objReason = probeRoleFields("cancellations", { table: "c", reason_field: "reason" }, [
      { reason: { text: "no show" } },
    ]);
    expect(objReason[0].ok).toBe(false);
    expect(objReason[0].distinct).toBe(0);
  });

  it("reason probe accepts enum-like, rejects free text and high-cardinality", () => {
    const enumLike = probeRoleFields("cancellations", { table: "c", reason_field: "cancel_reason" }, [
      { cancel_reason: "verification_failed" },
      { cancel_reason: "no_show" },
      { cancel_reason: "verification_failed" },
    ]);
    expect(enumLike[0].kind).toBe("reason");
    expect(enumLike[0].ok).toBe(true);
    expect(enumLike[0].distinct).toBe(2);

    const freeText = probeRoleFields("cancellations", { table: "c", reason_field: "note" },
      Array.from({ length: 30 }, (_, i) => ({
        note: `The customer wrote a very long free-form explanation number ${i} about why they cancelled today`,
      })),
    );
    expect(freeText[0].ok).toBe(false);
    expect(freeText[0].reason).toMatch(/free text|high-cardinality/i);
  });

  it("does NOT emit raw reason labels — only counts/verdicts", () => {
    const probes = probeRoleFields("cancellations", { table: "c", reason_field: "cancel_reason" }, [
      { cancel_reason: "fraud_suspected" },
    ]);
    const serialized = JSON.stringify(probes);
    expect(serialized).not.toMatch(/fraud_suspected/);
    expect(probes[0].distinct).toBe(1);
  });

  it("skips non-column-ref keys (table/label)", () => {
    const probes = probeRoleFields("bookings", { table: "b", label: "Bookings", geo_field: "city" }, [
      { city: "SF" },
    ]);
    expect(probes.map((p) => p.field_key)).toEqual(["geo_field"]);
  });

  it("marks sample_unavailable when the sampler returns null (SQL / fetch fail)", async () => {
    const map: CanonicalMap = { bookings: { table: "b", label: "B", created_at_field: "created_at" } };
    const probes = await probeMappedFields(map, async () => null);
    expect(probes).toHaveLength(1);
    expect(probes[0].reason).toBe("sample_unavailable");
    expect(probes[0].ok).toBe(false);
  });

  it("probeMappedFields skips null/non-object role entries without crashing", async () => {
    const map = {
      bookings: { table: "b", label: "B", created_at_field: "created_at" },
      cancellations: null,
    } as unknown as CanonicalMap;
    const probes = await probeMappedFields(map, async () => [{ created_at: "2026-06-01T00:00:00Z" }]);
    expect(probes.every((p) => p.role === "bookings")).toBe(true);
  });

  it("probeMappedFields caches the sample per table across roles", async () => {
    const map: CanonicalMap = {
      bookings: { table: "shared", label: "B", created_at_field: "created_at" },
      cancellations: { table: "shared", label: "C", reason_field: "cancel_reason" },
    };
    let calls = 0;
    const probes = await probeMappedFields(map, async () => {
      calls++;
      return [{ created_at: "2026-06-01T00:00:00Z", cancel_reason: "no_show" }];
    });
    expect(calls).toBe(1);
    expect(probes.length).toBe(2);
  });
});
