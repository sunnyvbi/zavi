
import { describe, it, expect } from "vitest";
import { coerceMongoExtendedJson } from "../query-input-coerce";

const at = (v: unknown) => (coerceMongoExtendedJson({ d: v }) as { d: unknown }).d;

describe("coerceMongoExtendedJson — $date shapes", () => {
  it.each([
    ["date-only", "2026-05-01", Date.UTC(2026, 4, 1)],
    ["no zone", "2026-05-01T00:00:00Z", Date.UTC(2026, 4, 1)],
    ["microseconds", "2026-05-01T00:00:00.000000Z", Date.UTC(2026, 4, 1)],
    ["offset zone", "2026-05-01T00:00:00+00:00", Date.UTC(2026, 4, 1)],
  ])("converts %s", (_label, input, expectedMs) => {
    const out = at({ $date: input });
    expect(out).toBeInstanceOf(Date);
    expect((out as Date).getTime()).toBe(expectedMs);
  });

  it("converts canonical Extended JSON v2 {$numberLong}", () => {
    const ms = Date.UTC(2026, 4, 1);
    const out = at({ $date: { $numberLong: String(ms) } });
    expect(out).toBeInstanceOf(Date);
    expect((out as Date).getTime()).toBe(ms);
  });

  it("converts epoch millis and passes through a real Date", () => {
    const ms = Date.UTC(2026, 4, 1);
    expect((at({ $date: ms }) as Date).getTime()).toBe(ms);
    expect(at(new Date(ms))).toBeInstanceOf(Date);
  });

  it("leaves an unparseable $date alone rather than inventing a time", () => {
    expect(at({ $date: "not-a-date" })).toEqual({ $date: "not-a-date" });
    expect(at({ $date: null })).toEqual({ $date: null });
  });

  it("only treats a SINGLETON $date as a wrapper", () => {
    const multi = { $date: "2026-05-01", other: 1 };
    expect(at(multi)).toEqual(multi);
  });

  it("converts $oid and leaves other operators untouched", () => {
    const oid = "507f1f77bcf86cd799439011";
    expect(String(at({ $oid: oid }))).toBe(oid);
    expect(at({ $regex: "^a", $options: "i" })).toEqual({ $regex: "^a", $options: "i" });
  });

  it("survives pathological nesting instead of blowing the stack", () => {
    let deep: unknown = { $date: "2026-05-01" };
    for (let i = 0; i < 5000; i++) deep = { nested: deep };
    expect(() => coerceMongoExtendedJson(deep)).not.toThrow();
  });
});
