import { describe, it, expect, vi, beforeEach } from "vitest";

const search = vi.hoisted(() => vi.fn());
vi.mock("@/services/tools/meta-ads/_client", () => ({
  fbGet: (_t: string, _p: string, q: Record<string, unknown>) => search(String(q.q)),
}));

import { resolvePlace, resolvePlaceDetailed } from "../places";

const row = (key: string, name: string, type: string, extra: Record<string, string> = {}) => ({ key, name, type, country_code: "US", ...extra });
const ROWS: Record<string, unknown[]> = {
  Springfield: [row("1", "Springfield", "city", { region: "Illinois" }), row("2", "Springfield", "city", { region: "Missouri" })],
  "New York": [row("3", "New York", "city", { region: "New York" }), row("4", "New York", "region", { country_name: "United States" })],
  Georgia: [row("5", "Georgia", "region", { country_name: "United States" }), { key: "GE", name: "Georgia", type: "country", country_code: "GE" }],
  Paris: [row("6", "Paris", "city", { region: "Texas" }), { key: "7", name: "Paris", type: "city", country_code: "FR", region: "Ile-de-France" }],
};

beforeEach(() => {
  search.mockReset();
  search.mockImplementation(async (q: string) => ({ data: ROWS[q] ?? [] }));
});

describe("resolvePlaceDetailed", () => {
  it("two cities of one name are ambiguous; the state after the name (code or name) picks one", async () => {
    expect(await resolvePlaceDetailed("t", "meta", "Springfield", "US")).toEqual({
      status: "ambiguous",
      candidates: [
        { id: "city:1", name: "Springfield, Illinois", kind: "City" },
        { id: "city:2", name: "Springfield, Missouri", kind: "City" },
      ],
    });
    expect(await resolvePlaceDetailed("t", "meta", "Springfield, MO", "US")).toMatchObject({ status: "resolved", place: { id: "city:2" } });
    expect(await resolvePlaceDetailed("t", "meta", "Springfield, Illinois", "US")).toMatchObject({ status: "resolved", place: { id: "city:1" } });
  });

  it("a city and a state of one name are ambiguous with no hint; a hint picks the city, a kind picks either; a state alone resolves; a country never does", async () => {
    expect(await resolvePlaceDetailed("t", "meta", "New York", "US")).toMatchObject({
      status: "ambiguous",
      candidates: [{ id: "city:3" }, { id: "region:4" }],
    });
    expect(await resolvePlaceDetailed("t", "meta", "New York, NY", "US")).toMatchObject({ status: "resolved", place: { id: "city:3" } });
    expect(await resolvePlaceDetailed("t", "meta", "New York", "US", "State")).toMatchObject({ status: "resolved", place: { id: "region:4" } });
    expect(await resolvePlaceDetailed("t", "meta", "New York", "US", "City")).toMatchObject({ status: "resolved", place: { id: "city:3" } });
    expect(await resolvePlaceDetailed("t", "meta", "Georgia", "US")).toMatchObject({ status: "resolved", place: { id: "region:5", kind: "State" } });
  });

  it("the business's country narrows the match; without one, every country counts", async () => {
    expect(await resolvePlaceDetailed("t", "meta", "Paris", "US")).toMatchObject({ status: "resolved", place: { id: "city:6" } });
    expect(await resolvePlaceDetailed("t", "meta", "Paris", null)).toMatchObject({ status: "ambiguous" });
    expect(await resolvePlaceDetailed("t", "meta", "Atlantis", "US")).toEqual({ status: "not_found" });
  });

  it("a failed search throws (the caller must not guess); resolvePlace still answers null and picks the first city", async () => {
    search.mockRejectedValueOnce(new Error("Meta 500"));
    await expect(resolvePlaceDetailed("t", "meta", "Springfield", "US")).rejects.toThrow("Meta 500");
    expect(await resolvePlace("t", "meta", "Springfield", "US")).toEqual({ id: "city:1", name: "Springfield, Illinois", kind: "City" });
    search.mockRejectedValueOnce(new Error("Meta 500"));
    expect(await resolvePlace("t", "meta", "Springfield", "US")).toBeNull();
  });
});
