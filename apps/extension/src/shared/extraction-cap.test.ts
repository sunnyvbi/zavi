import { describe, expect, it } from "vitest";
import { byteLength } from "./text-caps";
import {
  MAX_EXTRACTION_BYTES,
  MAX_STRING_BYTES,
  capExtraction,
} from "./extraction-cap";

const size = (v: unknown): number => byteLength(JSON.stringify(v) ?? "");

describe("capExtraction", () => {
  it("passes a small typed payload through untouched", () => {
    const input = {
      account: { id: "act_1", currency: "USD" },
      campaigns: [
        { name: "Prospecting", spend: 4201.55, cpa: 84.2, target_cpa: 40 },
      ],
    };
    const res = capExtraction(input);
    expect(res.truncated).toBe(false);
    expect(res.value).toEqual(input);
  });

  it("caps an over-long string and reports it", () => {
    const res = capExtraction({ name: "z".repeat(MAX_STRING_BYTES + 100) });
    expect(res.truncated).toBe(true);
    const name = (res.value as { name: string }).name;
    expect(byteLength(name)).toBeLessThanOrEqual(MAX_STRING_BYTES);
  });

  it("caps strings nested in arrays and objects", () => {
    const res = capExtraction({
      rows: [{ label: "y".repeat(MAX_STRING_BYTES + 10) }],
    });
    const label = (res.value as { rows: { label: string }[] }).rows[0].label;
    expect(byteLength(label)).toBeLessThanOrEqual(MAX_STRING_BYTES);
    expect(res.truncated).toBe(true);
  });

  it("trims the array TAIL until the whole payload fits", () => {
    const rows = Array.from({ length: 4000 }, (_, i) => ({
      name: `campaign ${i}`,
      spend: i * 1.5,
    }));
    const res = capExtraction({ rows });
    expect(res.truncated).toBe(true);
    expect(size(res.value)).toBeLessThanOrEqual(MAX_EXTRACTION_BYTES);
    const kept = (res.value as { rows: unknown[] }).rows;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(4000);
    expect(kept[0]).toEqual({ name: "campaign 0", spend: 0 });
  });

  it("never drops a key to make room — only array tails shrink", () => {
    const res = capExtraction({
      account: { id: "act_1" },
      rows: Array.from({ length: 5000 }, (_, i) => ({ n: `row ${i}` })),
    });
    expect((res.value as { account: unknown }).account).toEqual({ id: "act_1" });
  });

  it("normalizes non-finite numbers to null rather than losing them silently", () => {
    const res = capExtraction({ cpa: Number.NaN, roas: Number.POSITIVE_INFINITY });
    expect(res.value).toEqual({ cpa: null, roas: null });
  });

  it("drops values JSON cannot carry", () => {
    const res = capExtraction({
      keep: 1,
      fn: () => 1,
      undef: undefined,
    });
    expect(res.value).toEqual({ keep: 1 });
  });

  it("preserves booleans and nulls", () => {
    const res = capExtraction({ active: true, paused: false, note: null });
    expect(res.value).toEqual({ active: true, paused: false, note: null });
  });

  it("degrades instead of throwing on a circular payload", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => capExtraction({ rows: [1, 2, 3] })).not.toThrow();
    expect(() => JSON.stringify(circular)).toThrow();
  });

  it("honours explicit limits", () => {
    const res = capExtraction({ s: "abcdefghij" }, { maxStringBytes: 4 });
    expect((res.value as { s: string }).s).toBe("abcd");
    expect(res.truncated).toBe(true);
  });
});
