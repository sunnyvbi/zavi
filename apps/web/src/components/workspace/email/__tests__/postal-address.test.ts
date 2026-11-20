import { describe, expect, it } from "vitest";
import { footerPostal, postalAddressProblem } from "../postalAddress";

describe("postalAddressProblem", () => {
  it.each([null, undefined, "", "   ", "\n\t "])("blank %j is missing", (v) => {
    expect(postalAddressProblem(v)).toBe("missing");
  });

  it.each([
    "123 Test Street, San Francisco, CA 94105, USA",
    "Yoga Studio, 123 Test Street, Suite 4, San Francisco, CA 94105",
    "123   test\nstreet, Springfield",
    "12 Example St",
    "12 Example Street\nSpringfield, ST 00000",
    "1 Example Way, Springfield",
    "99 Fake Rd, Nowhere",
    "Street, city, state, ZIP",
    "1 Main St, Anytown, USA",
    "Your business address",
    "TBD",
    "xxx",
    "Lorem ipsum dolor",
    "12345",
    "- - -",
  ])("%j is a placeholder", (v) => {
    expect(postalAddressProblem(v)).toBe("placeholder");
  });

  it.each([
    "1 Main St, Springfield, IL 62701",
    "Cakely Bakery, 450 Valencia Street, San Francisco, CA 94103, USA",
    "Testa Road 4, 1010 Wien, Austria",
    "Cakely Bakery, 2200 W Sample Rd, Pompano Beach, FL 33073",
    "1800 East Sample Road, Lighthouse Point, FL 33064",
    "PO Box 1180, Contest Avenue Plaza, Austin, TX 78701",
    "Flat 2, 10 Downing Street, London SW1A 2AA",
    "東京都千代田区丸の内1-1",
  ])("%j is a real address", (v) => {
    expect(postalAddressProblem(v)).toBeNull();
  });
});

describe("footerPostal: a saved template row decides; the old setting counts only when no row exists", () => {
  const row = (postal_address: string | null) => ({ postal_address });
  it("a template row with an address wins over the setting, trimmed", () => {
    expect(footerPostal(row("  1 Main St, Springfield, IL 62701  "), ["9 Old Rd, Austin, TX 78701"])).toBe("1 Main St, Springfield, IL 62701");
  });
  it.each([null, "", "   ", "\n\t "])("a template row with address %j is missing even when the setting holds a real one", (v) => {
    expect(footerPostal(row(v), ["9 Old Rd, Austin, TX 78701"])).toBe("");
    expect(postalAddressProblem(footerPostal(row(v), ["9 Old Rd, Austin, TX 78701"]))).toBe("missing");
  });
  it.each([null, undefined])("no template row (%j): the first non-empty setting value counts, trimmed", (t) => {
    expect(footerPostal(t, ["", "   ", "  9 Old Rd, Austin, TX 78701  ", "2 Later St, Austin, TX"])).toBe("9 Old Rd, Austin, TX 78701");
    expect(postalAddressProblem(footerPostal(t, ["9 Old Rd, Austin, TX 78701"]))).toBeNull();
    expect(postalAddressProblem(footerPostal(t, ["123 Test Street, San Francisco"]))).toBe("placeholder");
  });
  it.each([null, undefined, [], ["", "  "]])("no template row and no usable setting (%j) is missing", (setting) => {
    expect(footerPostal(null, setting)).toBe("");
    expect(postalAddressProblem(footerPostal(undefined, setting))).toBe("missing");
  });
});
