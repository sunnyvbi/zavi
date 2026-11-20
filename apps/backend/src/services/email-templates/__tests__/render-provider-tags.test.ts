import { describe, expect, it } from "vitest";
import { render, UNSUBSCRIBE_HREF, type EmailContent, type EmailRoute, type EmailTemplate } from "../render";
import { chosenVersion, sealVariants } from "@/services/email-cards/variants";

const TEMPLATE: EmailTemplate = {
  logo_url: null,
  brand_color: "#1a73e8",
  button_color: "#ff6b35",
  font_key: "system",
  sign_off: "Cheers {{ owner }} *|SIGN|*",
  postal_address: "12 Example St | Suite {% 4 %}",
  show_cards: true,
};

const TAGGED: EmailContent = {
  subject: "Hi {{first_name}}, *|FNAME|* {% if vip %}VIP{% endif %}",
  preview_text: "Only for {{{unsubscribe}}} people",
  title: "Hello {{ first_name }}",
  hero: { big: "{{discount}}", small: "*|MC:DATE|*" },
  paragraphs: ["Your code is {% coupon %}.", "Use *|COUPON|* or {{{unsubscribe}}} now. |* stray"],
  button: { label: "Claim {{ offer }}", url: "https://brightloop.test/claim?u={{email}}&m=*|EMAIL|*" },
  cards: [{ title: "Kit {{sku}}", meta: "*|META|*", price: "{% price %}", url: "https://brightloop.test/kit/{{id}}", image_url: "https://cdn.brightloop.test/{{img}}.png" }],
};

const OPENERS = /\{\{|\{%|\*\||\|\*/g;

function evaluatedTags(route: EmailRoute, s: string): string[] {
  const unsub = UNSUBSCRIBE_HREF[route];
  return (s.split(unsub).join("").match(OPENERS) ?? []) as string[];
}

const decode = (html: string) =>
  html.replace(/\u200b/g, "").replace(/&#123;/g, "{").replace(/&#125;/g, "}").replace(/&#124;/g, "|").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

describe("provider template tags written by the model or the founder are never evaluated by the provider", () => {
  for (const route of ["sendgrid", "mailchimp", "klaviyo", "zavi_list"] as const) {
    it(`${route}: the html and the text carry no tag but the route's own unsubscribe link`, () => {
      const r = render(TEMPLATE, TAGGED, { route, campaignSlug: "spring", ownHost: "brightloop.test", companyName: "Bright {{co}}" });
      expect(evaluatedTags(route, r.html)).toEqual([]);
      expect(evaluatedTags(route, r.text)).toEqual([]);
      expect(r.html.split(UNSUBSCRIBE_HREF[route]).length - 1).toBe(1);
      expect(r.text.split(UNSUBSCRIBE_HREF[route]).length - 1).toBe(1);
      expect(decode(r.html)).toContain("Hello {{ first_name }}");
      expect(decode(r.html)).toContain("Use *|COUPON|* or {{{unsubscribe}}} now.");
      expect(r.text.replace(/​/g, "")).toContain("Your code is {% coupon %}.");
      expect(r.text.replace(/​/g, "")).toContain("Cheers {{ owner }} *|SIGN|*");
      expect(r.html).toContain("https://brightloop.test/claim?u=%7B%7Bemail%7D%7D");
      expect(r.html).toContain("https://brightloop.test/kit/%7B%7Bid%7D%7D");
    });
  }

  it("the subject and preview the provider receives carry no live tag, on the test send and the real send alike", () => {
    const s = sealVariants(TEMPLATE, [TAGGED], { route: "sendgrid", companyName: null, ownHost: null, slugSuffix: "abcdefghij" });
    const c = chosenVersion({ variants: s.variants, renderer_version: s.renderer_version, chosen_variant: 1 });
    if (!c.ok) throw new Error(c.reason);
    expect(c.version.subject.match(OPENERS)).toBeNull();
    expect(c.version.preview_text?.match(OPENERS) ?? null).toBeNull();
    expect(c.version.subject.replace(/​/g, "")).toBe(TAGGED.subject);
  });

  it("content with no tag renders byte-for-byte as before", () => {
    const plain: EmailContent = { ...TAGGED, subject: "Spring", preview_text: "Save", title: "Hello", hero: undefined, paragraphs: ["One.", "Two."], button: { label: "Go", url: "https://brightloop.test/go" }, cards: [] };
    const r = render({ ...TEMPLATE, sign_off: "Thanks", postal_address: "12 Example St" }, plain, { route: "sendgrid", campaignSlug: "spring", ownHost: null, companyName: null });
    expect(r.text).toBe(`Hello\n\nOne.\n\nTwo.\n\nGo: https://brightloop.test/go\n\nThanks\n\n--\n12 Example St\nUnsubscribe: ${UNSUBSCRIBE_HREF.sendgrid}\n`);
    expect(r.html).not.toContain("&#12");
  });
});

describe("founder words cannot become a Klaviyo template tag", () => {
  const decoded = (html: string) => html.replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)));
  const hostile = "Try {% if x %} or {{ y }} or {# z #} now";
  const content: EmailContent = {
    subject: hostile,
    preview_text: hostile,
    title: hostile,
    hero: { big: hostile, small: hostile },
    paragraphs: [hostile],
    button: { label: hostile, url: "https://brightloop.test/{{a}}/{%b%}" },
    cards: [{ title: hostile, meta: hostile, price: hostile, url: "https://brightloop.test/{%c%}", image_url: "https://cdn.test/{{d}}.png" }],
  };
  const template: EmailTemplate = { logo_url: null, brand_color: "#1a73e8", button_color: "#1a73e8", font_key: "system", sign_off: hostile, postal_address: hostile, show_cards: true };

  it("leaves only Klaviyo's unsubscribe tag, even after Klaviyo decodes the entities it stores", () => {
    const r = render(template, content, { route: "klaviyo", campaignSlug: "s", ownHost: "brightloop.test", companyName: hostile });
    for (const part of [r.html, decoded(r.html), r.text]) {
      expect(part.match(/\{[{%#]/g)).toEqual(["{%"]);
      expect(part).toContain("{% unsubscribe_link %}");
    }
  });
});
