import { describe, it, expect } from "vitest";
import { checkPublishText, findBlanks, PUBLISH_REFUSED_BLANKS, PUBLISH_REFUSED_TEST_MARKER } from "../social-publish-content-guard";

describe("checkPublishText", () => {
  it("refuses the post that leaked on 2026-09-10, naming the marker and the field", () => {
    const r = checkPublishText({
      text: "Local test from the X agent panel: a thread root, staged for approval, never posted on its own. (Zavi dev)",
      thread: ["Part two of the local test thread. Delete me after the panel check."],
    });
    expect(r).not.toBeNull();
    expect(r!.code).toBe(PUBLISH_REFUSED_TEST_MARKER);
    expect(r!.field).toBe("text");
    expect(r!.message).toMatch(/test marker/);
  });

  const marker = (c: unknown) => {
    const r = checkPublishText(c);
    return r && r.code === PUBLISH_REFUSED_TEST_MARKER ? r.marker : null;
  };

  it("checks every text field: thread parts, title, description, and a bare string", () => {
    expect(checkPublishText({ text: "ok", thread: ["fine", "Delete me after the check"] })?.field).toBe("thread[1]");
    expect(checkPublishText({ subreddit: "x", title: "[TEST] launch", text: "body" })?.field).toBe("title");
    expect(marker({ title: "Hi", description: "(zavi  dev)" })).toBe("(Zavi dev)");
    expect(checkPublishText("lorem ipsum dolor")?.field).toBe("text");
    expect(marker("[dev] hello")).toBe("[dev]");
  });

  it("passes real copy, including the plain words test/dev/local", () => {
    for (const text of [
      "We ran a test on our onboarding and cut drop-off by 18%.",
      "A/B testing, local SEO, and dev tools: what worked this month",
      "Our local team tested three pricing pages.",
      "Test drive the new plan today",
    ]) {
      expect(checkPublishText({ text })).toBeNull();
    }
  });

  it("does not read media references (a signed URL or storage path is not copy)", () => {
    expect(checkPublishText({ text: "Launch day", file: "https://x.test/sign?name=[test]&q=lorem ipsum" })).toBeNull();
  });
});

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
    expect(checkPublishText(slot)?.message).toBe("Fill before publishing: [OPERATOR TO CONFIRM: the catch-up pric…]");
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
    const code = "const sameAs = [linkedin, facebook];\n// [TODO: add youtube]";
    expect(findBlanks(code)).not.toEqual([]);
    expect(findBlanks(code, "code")).toEqual([]);
    expect(findBlanks("Hi [First name]", "email")).toEqual(["[First name]"]);
  });

  it("null and undefined are empty", () => {
    expect(findBlanks(null)).toEqual([]);
    expect(findBlanks(undefined)).toEqual([]);
  });
});

describe("checkPublishText: unfilled blanks", () => {
  it("refuses a post with blanks and names every one, across fields, for the approval card", () => {
    const r = checkPublishText({
      subreddit: "smallbusiness",
      title: "How we grew in [city]",
      text: "Hi {{first_name}}, we cut costs by [FOUNDER: $____]. See [our guide](https://x.test).",
    });
    expect(r?.code).toBe(PUBLISH_REFUSED_BLANKS);
    expect(r?.field).toBe("title");
    expect(r && "blanks" in r ? r.blanks : []).toEqual(["[city]", "{{first_name}}", "[FOUNDER: $____]"]);
    expect(r?.message).toBe(
      "Fill before publishing: [city], {{first_name}}, [FOUNDER: $____]. The title can't be edited here: reject this post and ask Zavi to redo it with the blanks filled.",
    );
  });

  it("a blank in a pin title says what to fill, since the pin card edits the title", () => {
    const r = checkPublishText({ title: "Linen for [city]", text: "Soft linen.", board_id: "222", link: "https://acme.com/p" });
    expect(r?.field).toBe("title");
    expect(r?.message).toBe("Fill before publishing: [city]");
  });

  it("a blank only in the editable text says just what to fill", () => {
    expect(checkPublishText({ text: "Hi [First name]", thread: ["and [city]"] })?.message).toBe(
      "Fill before publishing: [First name], [city]",
    );
  });

  it("clips a long blank in the message", () => {
    const r = checkPublishText("--\n[Postal address: required by US law on every marketing email]");
    expect(r?.message).toBe("Fill before publishing: [Postal address: required by US law on…]");
  });

  it("a test marker wins over blanks", () => {
    expect(checkPublishText("Hi [First name] (Zavi dev)")?.code).toBe(PUBLISH_REFUSED_TEST_MARKER);
  });
});

describe("findBlanks: fill-in words and post flair", () => {
  it.each([
    ["Hi [FIRST_NAME], welcome", ["[FIRST_NAME]"]],
    ["Hi [NAME]!", ["[NAME]"]],
    ["Now open in [CITY]", ["[CITY]"]],
    ["Join [COMPANY] today", ["[COMPANY]"]],
    ["Email us at [EMAIL]", ["[EMAIL]"]],
    ["Try [YOUR PRODUCT] free", ["[YOUR PRODUCT]"]],
    ["Try [YOUR_PRODUCT] free", ["[YOUR_PRODUCT]"]],
    ["Follow [INSERT_HANDLE]", ["[INSERT_HANDLE]"]],
    ["Launch date: [TBD]", ["[TBD]"]],
  ])("%j is a blank", (text, want) => {
    expect(findBlanks(text)).toEqual(want);
  });

  it.each([
    ["[Discussion] How do you price a first hire?"],
    ["[OC] Our first 100 customers"],
    ["[Question] Is SEO worth it at 10 visits a day?"],
    ["[AMA] We run a car rental marketplace"],
    ["Duplicate titles [HIGH] and [P0] stay tags"],
    ["An aside [that runs over\na line] is prose"],
  ])("%j is not a blank", (text) => {
    expect(findBlanks(text)).toEqual([]);
  });

  it("flair is case-insensitive", () => {
    expect(findBlanks("[discussion] What worked")).toEqual([]);
    expect(findBlanks("[QUESTION] What worked")).toEqual([]);
  });

  it("flair is only exempt at the start of the text", () => {
    expect(findBlanks("Read this [Discussion]")).toEqual(["[Discussion]"]);
    expect(findBlanks("[Discussion] Hi [First name]")).toEqual(["[First name]"]);
  });

  it("a Reddit title with flair publishes", () => {
    expect(checkPublishText({ subreddit: "startups", title: "[Discussion] What worked for us", text: "Details." })).toBeNull();
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

  it("the publish guard refuses the card and names both fill-ins", () => {
    const r = checkPublishText({ text: card });
    expect(r?.code).toBe(PUBLISH_REFUSED_BLANKS);
    expect(r && "blanks" in r ? r.blanks : []).toEqual([locations, industries]);
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
