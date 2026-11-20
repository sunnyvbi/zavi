import { describe, expect, it } from "vitest";
import { SITE_CARD_NAME_MAX, siteCardColour, siteCardParams } from "./siteCard";

const params = (q: Record<string, string>) => new URLSearchParams(q);

describe("siteCardParams (QA B41 share image inputs)", () => {
  it("reads the site's name and host", () => {
    expect(siteCardParams(params({ name: "Mile High Coffee", host: "mile-high-coffee-693dfbdb-523441.zaviagent.com" }))).toEqual({
      name: "Mile High Coffee",
      host: "mile-high-coffee-693dfbdb-523441.zaviagent.com",
    });
  });

  it("caps the name, strips control characters and never renders an empty card", () => {
    const long = siteCardParams(params({ name: "A".repeat(200) })).name;
    expect(long.length).toBe(SITE_CARD_NAME_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(siteCardParams(params({ name: "Hush\u0000\n\tCafe" })).name).toBe("Hush Cafe");
    expect(siteCardParams(params({})).name).toBe("Website");
  });

  it("drops anything that is not a hostname", () => {
    for (const host of ["https://evil.example/x", "evil example.com", "localhost", "a".repeat(200) + ".com", "<script>.com"]) {
      expect(siteCardParams(params({ name: "x", host })).host).toBeNull();
    }
  });

  it("picks a stable colour per name", () => {
    expect(siteCardColour("Mile High Coffee")).toBe(siteCardColour("Mile High Coffee"));
    expect(siteCardColour("Mile High Coffee")).toMatch(/^#[0-9a-f]{6}$/);
  });
});
