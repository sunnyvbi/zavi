import { describe, expect, it } from "vitest";
import { countrySetByZavi } from "./CompanyFactsPanel";

describe("countrySetByZavi", () => {
  it("returns where Zavi took the country from", () => {
    expect(
      countrySetByZavi([
        { key: "markets", value_text: "US", source: "human_confirmed" },
        { key: "country", value_text: "US", source: "connector", source_ref: "your Meta and TikTok ad accounts" },
      ]),
    ).toBe("your Meta and TikTok ad accounts");
  });

  it("is null for a founder's country, or when no country is set", () => {
    expect(countrySetByZavi([{ key: "country", value_text: "CA", source: "human_confirmed", source_ref: "settings" }])).toBeNull();
    expect(countrySetByZavi([])).toBeNull();
  });
});
