import { describe, expect, it } from "vitest";
import { blankName, blanksLine, copyLabel, fillBlanks, findBlanks, withBlanks } from "../blanks";

describe("findBlanks: fill-ins are found", () => {
  it.each([
    ["Hi [First name],\n\nThanks for booking.", ["[First name]"]],
    ["--\n[Postal address: required by US law on every marketing email]", ["[Postal address: required by US law on every marketing email]"]],
    ["Unsubscribe: [your email tool's unsubscribe link]", ["[your email tool's unsubscribe link]"]],
    ["I rented a [BRACKET: make/model/year] for [BRACKET: nightly rate].", ["[BRACKET: make/model/year]", "[BRACKET: nightly rate]"]],
    ["Budget: [FOUNDER: $____] per creator", ["[FOUNDER: $____]"]],
    ["[Name the video you just watched] was great", ["[Name the video you just watched]"]],
    ["does this work in [city]?", ["[city]"]],
    ["utm_campaign=[issue via growth__propose_creative_brief when ready]", ["[issue via growth__propose_creative_brief when ready]"]],
    ["[OPERATOR TO CONFIRM: delivery model]", ["[OPERATOR TO CONFIRM: delivery model]"]],
    ["Hi {{first_name}}, your code is {{ promo_code }}", ["{{first_name}}", "{{ promo_code }}"]],
    ["Hi [FIRST_NAME] from [CITY] at [COMPANY]", ["[FIRST_NAME]", "[CITY]", "[COMPANY]"]],
    ["Verified guests only [CONFIRM]. Launch date [TBD], price [TK].", ["[CONFIRM]", "[TBD]", "[TK]"]],
    ["[INSERT] and [YOUR_CITY] and [TBA]", ["[INSERT]", "[YOUR_CITY]", "[TBA]"]],
  ])("%j", (text, want) => {
    expect(findBlanks(text)).toEqual(want);
  });

  it("a labelled slot may run long and across lines (the SEO artifact shape)", () => {
    const slot = "[OPERATOR TO CONFIRM: the catch-up price per month. Not stated on any page\n> we fetched, so we did not estimate it.]";
    expect(findBlanks(`> Yes, catch-up is quoted per month.\n> ${slot}`)).toEqual([slot]);
    expect(blanksLine([slot])).toBe("Fill before sending: [OPERATOR TO CONFIRM: the catch-up pric…]");
  });

  it("names each blank once, in the order it first appears", () => {
    expect(findBlanks("Hi [First name], [city] is great. Bye [First name].")).toEqual(["[First name]", "[city]"]);
  });
});

describe("findBlanks: things in brackets that are not blanks", () => {
  it.each([
    ["markdown link", "See [Protection Plans](https://www.upcar.ai/help-center/protection-plans)."],
    ["markdown image", "![hero](https://x.test/a.png)"],
    ["reference link", "See [the guide][1]."],
    ["reference link with a word ref", "See [the guide][pricing guide]."],
    ["reference definition", "Read the guide.\n\n[pricing guide]: https://x.test/pricing\n[home]:https://x.test"],
    ["written-out button", "[Find a car near you] -> https://www.upcar.ai"],
    ["checkboxes", "- [ ] write it\n- [x] ship it\n- [X] done"],
    ["route segment", "All /buy/[id] pages use the homepage meta."],
    ["short id", "follow-up on [9358264e]"],
    ["severity tag", "Duplicate titles [HIGH]"],
    ["JSON array", '["Open Google Ads and make the change.","Then press Done."]'],
    ["no letters", "[1] [2024] [$50]"],
    ["empty", "[]"],
    ["too long to be a fill-in", `[${"a".repeat(81)}]`],
    ["an unlabelled span across lines", "[see the table\nbelow]"],
    ["a labelled slot past its cap", `[FOUNDER: ${"a".repeat(400)}]`],
    ["wiki link", "[[Home]]"],
    ["nothing at all", "Just a normal post."],
  ])("%s", (_name, text) => {
    expect(findBlanks(text)).toEqual([]);
  });

  it("a code deliverable is never read for blanks", () => {
    const code = 'const sameAs = [linkedin, facebook];\n// [TODO: add youtube]';
    expect(findBlanks(code)).not.toEqual([]);
    expect(findBlanks(code, "code")).toEqual([]);
    expect(findBlanks("Hi [First name]", "email")).toEqual(["[First name]"]);
  });

  it("null and undefined are empty", () => {
    expect(findBlanks(null)).toEqual([]);
    expect(findBlanks(undefined)).toEqual([]);
  });
});

describe("the words", () => {
  it("copyLabel counts blanks, and leaves a clean label alone", () => {
    expect(copyLabel("Copy email", [])).toBe("Copy email");
    expect(copyLabel("Copy", ["[First name]"])).toBe("Copy (1 blank to fill)");
    expect(copyLabel("Copy email", ["[First name]", "[city]"])).toBe("Copy email (2 blanks to fill)");
  });

  it("blanksLine lists them, clipping a long one", () => {
    expect(blanksLine([])).toBeNull();
    expect(blanksLine(["[First name]", "[Postal address: required by US law on every marketing email]"])).toBe(
      "Fill before sending: [First name], [Postal address: required by US law on…]",
    );
  });

  it("withBlanks appends the line only when there is one", () => {
    expect(withBlanks("Copied.", [])).toBe("Copied.");
    expect(withBlanks("Copied.", ["[city]"])).toBe("Copied. Fill before sending: [city]");
  });
});

describe("blankName: the field label for a blank", () => {
  it.each([
    ["[First name]", "First name"],
    ["{{ promo_code }}", "promo_code"],
    ["[FOUNDER: $____]", "FOUNDER: $____"],
    ["[OPERATOR TO CONFIRM: the catch-up price\n> per month]", "OPERATOR TO CONFIRM: the catch-up price > per month"],
  ])("%j", (blank, want) => {
    expect(blankName(blank)).toBe(want);
  });

  it("a long one is cut with an ellipsis", () => {
    const name = blankName(`[${"a".repeat(100)}]`);
    expect(name.length).toBe(60);
    expect(name.endsWith("…")).toBe(true);
  });
});

describe("fillBlanks: what the founder typed goes in", () => {
  it("every occurrence, and an empty value leaves the blank as written", () => {
    const text = "Hi [First name], see you in [city]. [First name], bring ID.";
    expect(fillBlanks(text, { "[First name]": "Maya", "[city]": "  " })).toBe("Hi Maya, see you in [city]. Maya, bring ID.");
  });

  it("merge tags too; the filled text has no blanks left", () => {
    const text = "Code {{ promo_code }}";
    const out = fillBlanks(text, { "{{ promo_code }}": "SAVE10" });
    expect(out).toBe("Code SAVE10");
    expect(findBlanks(out)).toEqual([]);
  });
});

describe("findBlanks: a lower-case fill-in label runs as long as an upper-case one", () => {
  const locations = "[fill in: the cities or region you deliver to; the site says only 'delivered locally']";
  const industries = "[fill in: industries of your last five corporate orders]";
  const card = `Locations:  ${locations}\nIndustries: ${industries}`;

  it("finds both fill-ins on the LinkedIn Ads card, in order", () => {
    expect(locations.length - 2).toBeGreaterThan(80);
    expect(findBlanks(card)).toEqual([locations, industries]);
  });

  it("filling only the short one still leaves the long one", () => {
    const out = fillBlanks(card, { [industries]: "logistics, retail" });
    expect(findBlanks(out)).toEqual([locations]);
    expect(findBlanks(fillBlanks(out, { [locations]: "Austin" }))).toEqual([]);
  });

  it.each([
    ["Fill in", `[Fill in: ${"a".repeat(120)}]`],
    ["fill-in", `[fill-in: ${"a".repeat(120)}]`],
    ["FILL IN", `[FILL IN: ${"a".repeat(120)}]`],
    ["across lines", "[fill in: the cities or region you deliver to;\nthe site says only 'delivered locally']"],
    ["at the labelled cap", `[fill in: ${"a".repeat(390)}]`],
  ])("%s is a blank", (_name, text) => {
    expect(findBlanks(text)).toEqual([text]);
  });

  it.each([
    ["a long lower-case aside", `[note that ${"a".repeat(100)} which we checked]`],
    ["a long sentence that mentions fill in later", `[please ask the founder to fill in: ${"a".repeat(80)}]`],
    ["refill in is not fill in", `[refill in: ${"a".repeat(100)}]`],
    ["a lower-case label that is not fill in", `[note: ${"a".repeat(100)}]`],
    ["a fill-in past the labelled cap", `[fill in: ${"a".repeat(395)}]`],
  ])("%s is not a blank", (_name, text) => {
    expect(findBlanks(text)).toEqual([]);
  });
});
