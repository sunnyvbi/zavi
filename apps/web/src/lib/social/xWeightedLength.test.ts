import { describe, it, expect } from "vitest";
import { xWeightedLength } from "@zavi/shared";

describe("xWeightedLength", () => {
  it("plain ASCII counts one per character", () => {
    expect(xWeightedLength("hello world")).toEqual({ length: 11, cutAt: null });
  });

  it("every URL weighs 23, long or short, schemed or bare", () => {
    expect(xWeightedLength("go https://trycoupleapp.com/a/very/long/path/here?x=1").length).toBe(3 + 23);
    expect(xWeightedLength("go trycoupleapp.com").length).toBe(3 + 23);
    expect(xWeightedLength("two https://a.co and https://b.co").length).toBe(4 + 23 + 5 + 23);
  });

  it("an email address is plain text, not a URL", () => {
    expect(xWeightedLength("mail a@b.co").length).toBe(11);
    expect(xWeightedLength("mail hi@sub.shop.co now").length).toBe(23);
    expect(xWeightedLength("first.last@example.com").length).toBe(22);
    expect(xWeightedLength("user!@sub.example.com").length).toBe(21);
  });

  it("a long run with no @ is counted in linear time", () => {
    const started = performance.now();
    expect(xWeightedLength("a".repeat(100_000)).length).toBe(100_000);
    expect(xWeightedLength("a.".repeat(50_000)).length).toBe(100_000);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("a bare domain right after - or . is plain text, as on X", () => {
    expect(xWeightedLength("a -site.com").length).toBe(11);
  });

  it("emoji and CJK weigh 2", () => {
    expect(xWeightedLength("🎉").length).toBe(2);
    expect(xWeightedLength("日本").length).toBe(4);
    expect(xWeightedLength("é").length).toBe(1);
  });

  it("cutAt is the string index where the weighted count first exceeds the cap", () => {
    const r = xWeightedLength("a".repeat(279) + "🎉");
    expect(r.length).toBe(281);
    expect(r.cutAt).toBe(279);
    expect(xWeightedLength("a".repeat(280)).cutAt).toBeNull();
    const url = xWeightedLength("a".repeat(260) + " https://x.co");
    expect(url.length).toBe(260 + 1 + 23);
    expect(url.cutAt).toBe(261);
  });
});
