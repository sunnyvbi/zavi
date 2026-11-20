import { describe, expect, it } from "vitest";
import {
  FAST_EDIT_ROUTE_MISS_RULE,
  ROUTE_MISS_LEAD,
  classifySiteEdit,
  elementScopedRequest,
  escalateFastEdit,
  isFastPassRouteMiss,
  isStructuralElementAsk,
  safePagePath,
  structuralEditGuidance,
} from "../site-edit-route";
import { THEME_EDIT_RULE } from "../design-directions";

describe("classifySiteEdit", () => {
  it.each([
    'Fix this error in the preview: Failed to resolve import "lucide-react" from src/Contact.tsx.',
    'Fix the icon import: Failed to resolve import "lucide-react" from src/Contact.tsx.',
    'Fix this title error: Uncaught ReferenceError: heading is not defined',
  ])("routes compiler/runtime reports to the full pass: %s", (request) => {
    expect(classifySiteEdit(request)).toEqual({ size: "section", lane: "structural" });
  });
  const tweaks = [
    "change the heading to 'Runtime error'",
    'Change the headline to "Fresh sourdough every morning"',
    "make the call button green",
    "Fix the typo in the opening hours",
    "change the phone number to 555 0100",
    "Make the hero headline bigger",
    "Update the price of a cleaning to $90",
    "change the 'Book now' button text to 'Reserve a visit'",
    "use a warmer font for the headings",
    "make the logo smaller",
    "change the footer email address to hello@example.com",
  ];
  it.each(tweaks)("a small change to something that exists is fast: %s", (text) => {
    expect(classifySiteEdit(text)).toEqual({ size: "tweak", lane: "fast" });
  });

  const pages: string[] = [
    "add a gallery page with my wedding shoots",
    "I want a new page for our team",
    "Create an about page",
    "Add a page for each service we offer",
    "remove the blog page",
    "We need a separate screen where patients see their appointments",
  ];
  it.each(pages)("a page is structural: %s", (text) => {
    expect(classifySiteEdit(text)).toEqual({ size: "page", lane: "structural" });
  });

  const data: string[] = [
    "add a contact form",
    "let customers order a cake for pickup",
    "Add a field for allergies on the booking form",
    "add a newsletter signup",
    "Let visitors book a cleaning online",
    "save the client's preferred shoot date",
  ];
  it.each(data)("stored data or a visitor action is structural: %s", (text) => {
    expect(classifySiteEdit(text)).toEqual({ size: "data", lane: "structural" });
  });

  const sections: string[] = [
    "add a testimonials section",
    "Remove the pricing section",
    "move the gallery above the about section",
    "redesign the hero",
    "Add our partner logos under the hero",
    "it looks boring",
    "",
  ];
  it.each(sections)("adding, removing or reshaping part of a page is structural: %s", (text) => {
    expect(classifySiteEdit(text)).toEqual({ size: "section", lane: "structural" });
  });

  it("a structural target wins over a tweak verb and noun", () => {
    expect(classifySiteEdit("replace the hero image with a carousel").lane).toBe("structural");
    expect(classifySiteEdit("make the logo an animation").lane).toBe("structural");
    expect(classifySiteEdit("change the hero headline to Fresh bread")).toEqual({ size: "tweak", lane: "fast" });
  });

  it("a page title edit is not a new page", () => {
    expect(classifySiteEdit("change the page title to Maple Lane Bakery")).toEqual({ size: "tweak", lane: "fast" });
    expect(classifySiteEdit("remove the page title background colour").lane).toBe("structural");
  });

  it("reads the xml-escaped form the routes store", () => {
    expect(classifySiteEdit("change the headline to &quot;Smiles &amp; more&quot;")).toEqual({ size: "tweak", lane: "fast" });
  });

  it("several asks in one message are never a quick pass", () => {
    const many = "Change the headline. Make the button green. Fix the hours. Change the logo. Swap the photo.";
    expect(classifySiteEdit(many).lane).toBe("structural");
    expect(classifySiteEdit(`change the headline to ${"x".repeat(700)}`).lane).toBe("structural");
  });
});

describe("the look of the whole site is a theme change", () => {
  it.each([
    "make the whole site dark",
    "change the site colours to forest green",
    "switch to dark mode",
    "use a friendlier font across the site",
    "new colour scheme please",
  ])("%s", (text) => {
    expect(classifySiteEdit(text)).toEqual({ size: "theme", lane: "structural" });
  });

  it("a colour scheme for one part of the page is not the theme", () => {
    expect(classifySiteEdit("change this section's colour scheme to blue").size).not.toBe("theme");
    expect(classifySiteEdit("give the hero a darker colour scheme").size).not.toBe("theme");
  });

  it("one element's colour stays a tweak", () => {
    expect(classifySiteEdit("make the call button green")).toEqual({ size: "tweak", lane: "fast" });
  });
});

describe("structuralEditGuidance", () => {
  it("adds instructions for a structural pass only", () => {
    expect(structuralEditGuidance("page")).toContain("src/pages/");
    expect(structuralEditGuidance("section")).toContain("src/components/");
    expect(structuralEditGuidance("data")).toContain("additive");
    expect(structuralEditGuidance("section")).toContain("three believable examples");
    expect(structuralEditGuidance("theme")).toContain(THEME_EDIT_RULE);
    expect(structuralEditGuidance("tweak")).toBe("");
    expect(structuralEditGuidance(undefined)).toBe("");
  });
});

describe("escalateFastEdit", () => {
  const fast = () => ({ fast_edit: true, small_edit: true, edit_routed: "auto", edit_size: "tweak", push_check_started_at: "t" }) as Record<string, unknown>;

  it("turns a fast pass into one full pass with fresh dispatch keys", () => {
    const p = fast();
    expect(escalateFastEdit(p)).toBe(true);
    expect(p).toMatchObject({ escalated_from_fast: true, edit_size: "section", resume_epoch: 1 });
    expect(p.fast_edit).toBeUndefined();
    expect(p.small_edit).toBeUndefined();
    expect(p.push_check_started_at).toBeUndefined();
    expect(escalateFastEdit(p)).toBe(false);
  });

  it("keeps an existing resume epoch moving forward and a known size", () => {
    const p = { ...fast(), resume_epoch: 2, edit_size: "data" };
    expect(escalateFastEdit(p)).toBe(true);
    expect(p).toMatchObject({ resume_epoch: 3, edit_size: "data" });
  });

  it("an inline Apply escalates too; a full pass never does", () => {
    expect(escalateFastEdit({ fast_edit: true, small_edit: true, site_inline_edits: [{ id: "e1" }] })).toBe(true);
    expect(escalateFastEdit({ edit_size: "page" })).toBe(false);
  });
});

describe("isFastPassRouteMiss", () => {
  const refused = (customer_summary: unknown, extra: Record<string, unknown> = {}) => ({
    parsed: { refused: true, reason_code: "blocked", customer_summary, ...extra },
  });

  it("is an explicit refusal that leads with the route-miss sentence", () => {
    expect(isFastPassRouteMiss(refused(`${ROUTE_MISS_LEAD}: a new gallery page and a nav link`))).toBe(true);
    expect(isFastPassRouteMiss(refused("  this needs a bigger change: a new section component"))).toBe(true);
  });

  it("is never a plain answer, a question, another refusal, or a run that shipped", () => {
    expect(isFastPassRouteMiss(refused("The headline already says that."))).toBe(false);
    expect(isFastPassRouteMiss({ parsed: { refused: true, reason_code: "needs_input", customer_summary: "Which button?" } })).toBe(false);
    expect(isFastPassRouteMiss(refused(`${ROUTE_MISS_LEAD}: x`, { commit_sha: "abc1234" }))).toBe(false);
    expect(isFastPassRouteMiss({ parsed: { customer_summary: `${ROUTE_MISS_LEAD}: x` } })).toBe(false);
    expect(isFastPassRouteMiss({ parsed: null })).toBe(false);
    expect(isFastPassRouteMiss(null)).toBe(false);
  });

  it("the fast-pass rule asks for exactly that shape", () => {
    expect(FAST_EDIT_ROUTE_MISS_RULE).toContain(`"customer_summary": "${ROUTE_MISS_LEAD}:`);
    expect(FAST_EDIT_ROUTE_MISS_RULE).toContain('"refused": true');
  });
});

describe("Ask AI on one element", () => {
  it.each([
    "add a testimonials section below this",
    "put a booking form under it",
    "add another photo like this one",
    "create a page for this service",
    "a new gallery here please",
    "add a subtitle",
    "add another link",
  ])("needs a site change: %s", (msg) => {
    expect(isStructuralElementAsk(msg)).toBe(true);
  });

  it.each([
    "make this shorter",
    "warmer tone",
    "make it blue",
    'change it to "Order a cake"',
    "bigger and bold",
    "add an exclamation point",
    "add a link to our booking page",
    "add a blue background",
  ])(
    "stays an element patch: %s",
    (msg) => {
      expect(isStructuralElementAsk(msg)).toBe(false);
    },
  );

  it("scopes the change to the element the founder picked", () => {
    const req = elementScopedRequest({ selector: "main > section:nth-of-type(2) h2", text: "  Our   portfolio ", message: "add a testimonials section below this " });
    expect(req).toBe('On the page I\'m looking at, at the element `main > section:nth-of-type(2) h2` (it reads "Our portfolio"): add a testimonials section below this');
    expect(elementScopedRequest({ selector: "#x", message: "add a map" })).toBe("On the page I'm looking at, at the element `#x`: add a map");
    expect(elementScopedRequest({ selector: "#x", text: "y".repeat(400), message: "m" }).length).toBeLessThan(260);
  });

  it("names the page when the preview reported a clean path, never anything else", () => {
    expect(elementScopedRequest({ selector: "#x", message: "add a map", path: "/contact?ref=nav" })).toBe("On the page `/contact`, at the element `#x`: add a map");
    for (const bad of ["contact", "//evil.example/x", "/a b", "/`x`", 7, null, `/${"a".repeat(300)}`]) {
      expect(elementScopedRequest({ selector: "#x", message: "add a map", path: bad as string })).toBe("On the page I'm looking at, at the element `#x`: add a map");
    }
    expect(safePagePath("/")).toBe("/");
    expect(safePagePath("/services/teeth-cleaning#top")).toBe("/services/teeth-cleaning");
  });
});
