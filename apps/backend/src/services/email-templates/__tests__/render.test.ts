import { describe, it, expect } from "vitest";
import { render, EmailRenderError, RENDERER_VERSION, UNSUBSCRIBE_HREF, type EmailContent, type EmailTemplate, type RenderContext } from "../render";

const BRIGHTLOOP: EmailTemplate = {
  logo_url: "https://cdn.brightloop.test/logo.png",
  brand_color: "#1A73E8",
  button_color: "#ff6b35",
  font_key: "georgia",
  sign_off: "Thanks,\nThe Brightloop team",
  postal_address: "12 Example Street\nSpringfield, ST 00000",
  show_cards: true,
};

const PLAIN: EmailTemplate = {
  logo_url: null,
  brand_color: "#111827",
  button_color: "#111827",
  font_key: "system",
  sign_off: "",
  postal_address: "PO Box 7, Lakeside",
  show_cards: false,
};

const CONTENT: EmailContent = {
  subject: "Your spring offer",
  preview_text: "Save 20% this week",
  title: "Spring is here",
  hero: { big: "20% off", small: "Until Sunday" },
  paragraphs: ["We made something new.", "Come and see it."],
  button: { label: "Shop now", url: "https://brightloop.test/shop?ref=a" },
  cards: [{ title: "Starter kit", meta: "Ships in 2 days", price: "$40", url: "https://shop.brightloop.test/kit", image_url: "https://cdn.brightloop.test/kit.jpg" }],
};

const CTX: RenderContext = { route: "sendgrid", campaignSlug: "spring-offer", ownHost: "www.brightloop.test", companyName: "Brightloop" };

function refuses(fn: () => unknown, code: string): EmailRenderError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EmailRenderError);
    expect((e as EmailRenderError).code).toBe(code);
    expect((e as EmailRenderError).message.length).toBeGreaterThan(10);
    return e as EmailRenderError;
  }
  throw new Error("expected render to refuse");
}

describe("render: URLs", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://brightloop.test/shop", "/relative/path", "https://user:pw@brightloop.test/"]) {
    it(`refuses button url ${bad}`, () => {
      refuses(() => render(BRIGHTLOOP, { ...CONTENT, button: { label: "Go", url: bad } }, CTX), "bad_url");
    });
    it(`refuses card url ${bad}`, () => {
      refuses(() => render(BRIGHTLOOP, { ...CONTENT, cards: [{ title: "x", meta: "y", url: bad }] }, CTX), "bad_url");
    });
  }

  it("refuses http and data logos and card images", () => {
    refuses(() => render({ ...BRIGHTLOOP, logo_url: "http://cdn.brightloop.test/logo.png" }, CONTENT, CTX), "bad_url");
    refuses(() => render({ ...BRIGHTLOOP, logo_url: "data:image/png;base64,AAAA" }, CONTENT, CTX), "bad_url");
    refuses(() => render(BRIGHTLOOP, { ...CONTENT, cards: [{ title: "x", meta: "y", image_url: "http://cdn.brightloop.test/a.jpg" }] }, CTX), "bad_url");
  });

  it("allows a bare mailto only on the button", () => {
    const out = render(BRIGHTLOOP, { ...CONTENT, button: { label: "Write to us", url: "mailto:hello@brightloop.test" } }, CTX);
    expect(out.html).toContain('href="mailto:hello@brightloop.test"');
    expect(out.html).not.toMatch(/mailto:[^"]*utm_/);
    refuses(() => render(BRIGHTLOOP, { ...CONTENT, cards: [{ title: "x", meta: "y", url: "mailto:hello@brightloop.test" }] }, CTX), "bad_url");
    refuses(() => render({ ...BRIGHTLOOP, logo_url: "mailto:hello@brightloop.test" }, CONTENT, CTX), "bad_url");
  });

  it("refuses mailto with query parameters", () => {
    for (const url of ["mailto:hello@brightloop.test?subject=Hi", "mailto:hello@brightloop.test?cc=x@evil.test", "mailto:hello@brightloop.test?body=x"]) {
      refuses(() => render(BRIGHTLOOP, { ...CONTENT, button: { label: "Go", url } }, CTX), "bad_url");
    }
  });
});

describe("render: colors and fonts", () => {
  it("refuses CSS-breaking colors", () => {
    for (const c of ["red;background:url(https://evil.test)", "#fff", "#12345g", "#1a73e8;", "rgb(0,0,0)", "#1a73e8\" onload=\"x"]) {
      refuses(() => render({ ...BRIGHTLOOP, brand_color: c }, CONTENT, CTX), "bad_color");
      refuses(() => render({ ...BRIGHTLOOP, button_color: c }, CONTENT, CTX), "bad_color");
    }
  });

  it("accepts upper-case hex and writes it lower-case", () => {
    const html = render({ ...BRIGHTLOOP, logo_url: null }, CONTENT, CTX).html;
    expect(html).toContain("background-color:#1a73e8");
    expect(html).not.toContain("#1A73E8");
  });

  it("refuses an unknown font", () => {
    refuses(() => render({ ...BRIGHTLOOP, font_key: "comic;}</style><script>" }, CONTENT, CTX), "bad_font");
    refuses(() => render({ ...BRIGHTLOOP, font_key: "toString" }, CONTENT, CTX), "bad_font");
  });

  it("maps the font key to its stack", () => {
    expect(render(BRIGHTLOOP, CONTENT, CTX).html).toContain("font-family:Georgia,");
  });
});

describe("render: text stays text", () => {
  it("escapes script and HTML in title, paragraphs, hero, cards, button label", () => {
    const evil = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
    const out = render(
      BRIGHTLOOP,
      {
        ...CONTENT,
        subject: evil,
        preview_text: evil,
        title: evil,
        hero: { big: evil, small: evil },
        paragraphs: [evil],
        button: { label: evil, url: "https://brightloop.test/" },
        cards: [{ title: evil, meta: evil, price: evil }],
      },
      { ...CTX, companyName: evil },
    );
    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toContain("<img src=x");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html.match(/<img /g)?.length).toBe(1);
  });

  it("escapes quotes in attribute values (logo alt)", () => {
    const out = render(BRIGHTLOOP, CONTENT, { ...CTX, companyName: `Bright" onerror="alert(1)` });
    expect(out.html).toContain('alt="Bright&quot; onerror=&quot;alert(1)"');
  });

  it("puts the preview text in a hidden preheader", () => {
    expect(render(BRIGHTLOOP, CONTENT, CTX).html).toMatch(/<div style="display:none;[^"]*">Save 20% this week<\/div>/);
  });
});

describe("render: links in the body", () => {
  const bodyCells = (html: string) => [...html.matchAll(/<td class="zp" style="padding-top:0;padding-bottom:14px;[^"]*">([\s\S]*?)<\/td><\/tr>/g)].map((m) => m[1]);
  const anchors = (cell: string) => [...cell.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1], href: /^ href="([^"]*)"/.exec(m[1])?.[1] ?? null, label: m[2] }));

  it("turns every https link the founder wrote into a link, tags only the own site, and leaves the trailing punctuation as text", () => {
    const out = render(PLAIN, { ...CONTENT, paragraphs: ["Read the notes at https://www.brightloop.test/changelog.", "Also see https://other.test/b?x=1&y=2, and (https://docs.other.test/c)."] }, CTX);
    const [one, two] = bodyCells(out.html);
    expect(anchors(one)).toEqual([
      expect.objectContaining({ href: "https://www.brightloop.test/changelog?utm_source=email&amp;utm_medium=zavi&amp;utm_campaign=spring-offer", label: "https://www.brightloop.test/changelog" }),
    ]);
    expect(one).toMatch(/<\/a>\.$/);
    expect(anchors(two).map((a) => [a.href, a.label])).toEqual([
      ["https://other.test/b?x=1&amp;y=2", "https://other.test/b?x=1&amp;y=2"],
      ["https://docs.other.test/c", "https://docs.other.test/c"],
    ]);
    expect(two).toMatch(/^Also see <a /);
    expect(two).toMatch(/<\/a>, and \(<a /);
    expect(two).toMatch(/<\/a>\)\.$/);
    expect(out.text).toContain("Read the notes at https://www.brightloop.test/changelog.");
  });

  it("never links anything that is not a clean https address, and nothing the founder typed can break out of the link or the text", () => {
    const evil = [
      `https://evil.test/"onmouseover="alert(1)`,
      `https://evil.test/'onclick='alert(1)`,
      "javascript:alert(1)",
      "JaVaScRiPt:alert(document.cookie)",
      "http://plain.test/x",
      "data:text/html,<script>alert(1)</script>",
      `<a href="javascript:alert(1)">click</a>`,
      "https://a.test/<script>alert(1)</script>",
      "https://user:pw@evil.test/login",
      "https://x.test/{{{unsubscribe}}}/*|UNSUB|*/{% x %}",
      "https://x.test/a`b",
    ].join("\n");
    const out = render(PLAIN, { ...CONTENT, paragraphs: [evil] }, CTX);
    const [cell] = bodyCells(out.html);
    expect(cell).not.toMatch(/<script/i);
    expect(cell).not.toMatch(/<a href="javascript/i);
    expect(cell).not.toMatch(/\son\w+=/i);
    expect(cell).not.toMatch(/\{\{|\}\}|\*\||\|\*|\{%/);
    const links = anchors(cell);
    for (const a of links) {
      expect(a.attrs).toMatch(/^ href="https:\/\/[^"\s<>]*" style="[^"]*"$/);
      expect(a.href).not.toMatch(/['`]/);
      expect(a.label).not.toMatch(/[<>"]/);
    }
    expect(links.map((a) => a.href)).toEqual([
      "https://evil.test/",
      "https://evil.test/",
      "https://a.test/",
      "https://x.test/%7B%7B%7Bunsubscribe%7D%7D%7D/*%7CUNSUB%7C*/%7B%",
      "https://x.test/a",
    ]);
    expect(cell).toContain("http://plain.test/x");
    expect(cell).toContain("https://user:pw@evil.test/login");
    expect(cell).not.toContain('href="https://user:pw@');
    expect(cell).not.toContain('href="http://');
  });
});

describe("render: UTM", () => {
  const utm = "utm_source=email&utm_medium=zavi&utm_campaign=spring-offer";

  it("tags links to the own host and its subdomains", () => {
    const out = render(BRIGHTLOOP, CONTENT, CTX);
    expect(out.html).toContain(`https://brightloop.test/shop?ref=a&amp;${utm.replace(/&/g, "&amp;")}`);
    expect(out.html).toContain(`https://shop.brightloop.test/kit?${utm.replace(/&/g, "&amp;")}`);
    expect(out.text).toContain(`https://brightloop.test/shop?ref=a&${utm}`);
  });

  it("does not tag look-alike or other hosts", () => {
    for (const url of ["https://brightloop.test.evil.test/x", "https://evilbrightloop.test/x", "https://other.test/x"]) {
      const out = render(BRIGHTLOOP, { ...CONTENT, button: { label: "Go", url } }, CTX);
      expect(out.html).toContain(`href="${url}"`);
      expect(out.html).not.toContain(`${url}?utm`);
    }
  });

  it("never tags images, mailto or the unsubscribe link", () => {
    const out = render(BRIGHTLOOP, { ...CONTENT, button: { label: "Mail", url: "mailto:hi@brightloop.test" } }, CTX);
    expect(out.html).toContain('src="https://cdn.brightloop.test/logo.png"');
    expect(out.html).toContain('src="https://cdn.brightloop.test/kit.jpg"');
    expect(out.html).toContain('href="{{{unsubscribe}}}"');
    expect(out.html).not.toContain("unsubscribe}}}?");
  });

  it("tags nothing when the workspace has no website", () => {
    const out = render(PLAIN, CONTENT, { route: "zavi_list", campaignSlug: "spring", ownHost: null });
    expect(out.html).not.toContain("utm_");
  });

  it("refuses a bad campaign slug", () => {
    refuses(() => render(BRIGHTLOOP, CONTENT, { ...CTX, campaignSlug: "x&utm_source=evil" }), "bad_campaign_slug");
  });
});

describe("render: footer, determinism, second shape", () => {
  it("always has the postal address and the route's unsubscribe link", () => {
    for (const route of ["sendgrid", "mailchimp", "klaviyo", "zavi_list"] as const) {
      const out = render(BRIGHTLOOP, CONTENT, { ...CTX, route });
      expect(out.html).toContain("12 Example Street<br>Springfield");
      expect(out.html).toContain(`href="${UNSUBSCRIBE_HREF[route].replace(/"/g, "&quot;")}"`);
      expect(out.text).toContain(`Unsubscribe: ${UNSUBSCRIBE_HREF[route]}`);
    }
  });

  it("refuses without a postal address", () => {
    refuses(() => render({ ...BRIGHTLOOP, postal_address: "  " }, CONTENT, CTX), "missing_postal_address");
  });

  it("is deterministic", () => {
    const a = render(BRIGHTLOOP, CONTENT, CTX);
    const b = render(structuredClone(BRIGHTLOOP), structuredClone(CONTENT), { ...CTX });
    expect(a).toEqual(b);
    expect(a.render_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(a.renderer_version).toBe(RENDERER_VERSION);
    const c = render(BRIGHTLOOP, { ...CONTENT, paragraphs: ["We made something new!", "Come and see it."] }, CTX);
    expect(c.render_sha).not.toBe(a.render_sha);
  });

  it("renders a brand with no logo and no website", () => {
    const out = render(PLAIN, { ...CONTENT, hero: undefined }, { route: "mailchimp", campaignSlug: "news-1", ownHost: null, companyName: null });
    expect(out.html).not.toContain("<img");
    expect(out.html).toContain("PO Box 7, Lakeside");
    expect(out.html).toContain("*|UNSUB|*");
    expect(out.html).toContain("Shop now");
    expect(out.html).not.toContain("Starter kit");
    expect(out.html).toMatch(/<table role="presentation"/);
  });
});

describe("render: layout", () => {
  it("draws a monogram wordmark and no brand bar when there is no logo", () => {
    const out = render(PLAIN, { ...CONTENT, hero: undefined }, { route: "zavi_list", campaignSlug: "news-1", ownHost: null, companyName: "bakery" });
    expect(out.html).not.toMatch(/height:4px;line-height:4px;font-size:0;/);
    const header = out.html.slice(out.html.indexOf('class="zc"'), out.html.indexOf("Spring is here"));
    expect(header).toMatch(/<td width="28" height="28" align="center" valign="middle" bgcolor="#111827" style="[^"]*color:#ffffff;[^"]*">B<\/td>/);
    expect(header).toMatch(/padding-left:10px;[^"]*font-weight:bold;[^"]*">bakery<\/td>/);
    expect(header).not.toContain("border-bottom");
  });

  it("puts the logo in the header with the company name as alt, and no wordmark or brand bar", () => {
    const out = render(BRIGHTLOOP, CONTENT, CTX);
    const header = out.html.slice(out.html.indexOf('class="zc"'), out.html.indexOf("Spring is here"));
    expect(header).toMatch(/<img src="https:\/\/cdn\.brightloop\.test\/logo\.png" alt="Brightloop" height="32" style="[^"]*height:32px;width:auto;max-width:180px;/);
    expect(header).not.toContain('width="28"');
    expect(header).not.toContain(">Brightloop</td>");
    expect(out.html).not.toContain("height:4px;line-height:4px");
  });

  it("sits on a warm canvas in a hairline card", () => {
    const out = render(BRIGHTLOOP, CONTENT, CTX).html;
    expect(out).toContain('<body style="margin:0;padding:0;background-color:#f7f6f3;">');
    expect(out).toMatch(/class="zc" role="presentation" width="560" [^>]*style="width:100%;max-width:560px;background-color:#ffffff;border:1px solid #e6e3db;border-radius:12px;/);
    expect(out).not.toMatch(/#f3f4f6|#f9fafb|#e5e7eb/);
  });

  it("draws the hero as a hairline-ruled detail line, never a brand-filled box", () => {
    const out = render(BRIGHTLOOP, CONTENT, CTX).html;
    const hero = out.slice(out.indexOf("Spring is here"), out.indexOf("We made something new."));
    expect(hero).toContain("border-top:1px solid #e6e3db;border-bottom:1px solid #e6e3db;");
    expect(hero).toMatch(/font-size:20px;[^"]*color:#141413;">20% off<\/div>/);
    expect(hero).toMatch(/font-size:14px;line-height:1\.5;color:#77716a;">Until Sunday<\/div>/);
    expect(hero).not.toContain("#1a73e8");
    expect(hero).not.toContain("font-size:40px");
  });

  it("never prints the headline twice when the hero repeats the title, in html and in text", () => {
    const content = { ...CONTENT, title: "Happy Diwali", hero: { big: "  HAPPY   diwali ", small: "From all of us at Zavi" }, paragraphs: ["Warm wishes."] };
    const out = render(BRIGHTLOOP, content, CTX);
    const count = (s: string) => s.toLowerCase().split("happy diwali").length - 1;
    expect(count(out.html.slice(out.html.indexOf("<body")))).toBe(1);
    expect(count(out.text)).toBe(1);
    expect(out.html).toContain("From all of us at Zavi");
    expect(out.text).toContain("From all of us at Zavi");
    expect(out.html).not.toContain("font-size:20px");
  });

  it("draws no hero row at all when it only repeats the title and has no small line", () => {
    const withHero = render(BRIGHTLOOP, { ...CONTENT, title: "Happy Diwali", hero: { big: "Happy Diwali", small: " " } }, CTX);
    const without = render(BRIGHTLOOP, { ...CONTENT, title: "Happy Diwali", hero: undefined }, CTX);
    expect(withHero.html).toBe(without.html);
    expect(withHero.text).toBe(without.text);
  });

  it("puts the footer, postal address and unsubscribe under the card, after the sign-off", () => {
    const out = render(BRIGHTLOOP, CONTENT, { ...CTX, route: "zavi_list" });
    const open = out.html.indexOf('class="zc"');
    const sign = out.html.indexOf("The Brightloop team");
    const cardEnd = out.html.indexOf("</table>", sign);
    const footer = out.html.slice(cardEnd);
    expect(open).toBeGreaterThan(0);
    expect(sign).toBeGreaterThan(open);
    expect(out.html.slice(open, cardEnd)).not.toContain("Example Street");
    expect(out.html.slice(open, cardEnd)).not.toContain("nsubscribe");
    expect(footer).toContain("font-size:12px;line-height:1.6;color:#77716a;");
    expect(footer).toContain(">Brightloop</div>");
    expect(footer).toContain("12 Example Street<br>Springfield, ST 00000");
    expect(footer).toContain('href="{{zavi_unsubscribe_url}}"');
    expect(footer).not.toContain("bgcolor");
  });

  it("renders the button as a bulletproof rounded table cell in button_color with contrast ink", () => {
    const dark = render({ ...PLAIN, button_color: "#0B3D2E" }, CONTENT, CTX).html;
    expect(dark).toMatch(/<td align="center" bgcolor="#0b3d2e" style="background-color:#0b3d2e;border-radius:8px;mso-padding-alt:14px 26px;"><a href="[^"]+" style="display:inline-block;padding:14px 26px;border:1px solid #0b3d2e;border-radius:8px;background-color:#0b3d2e;[^"]*color:#ffffff;text-decoration:none;">Shop now<\/a><\/td>/);
    const light = render({ ...PLAIN, button_color: "#FDE68A" }, CONTENT, CTX).html;
    expect(light).toMatch(/bgcolor="#fde68a" style="background-color:#fde68a;border-radius:8px;mso-padding-alt:14px 26px;"><a [^>]*color:#111827;text-decoration:none;">Shop now<\/a>/);
  });

  it("uses a 16px/1.65 body and a 26px title", () => {
    const out = render(PLAIN, CONTENT, CTX).html;
    expect(out).toMatch(/font-size:16px;line-height:1\.65;color:#3d3b37;">We made something new\.<\/td>/);
    expect(out).toMatch(/class="zp zt" style="[^"]*font-size:26px;line-height:1\.25;[^"]*">Spring is here<\/td>/);
  });

  it("keeps the button bulletproof and readable on a light button color", () => {
    const out = render({ ...PLAIN, button_color: "#fde68a" }, CONTENT, CTX);
    expect(out.html).toContain('bgcolor="#fde68a"');
    expect(out.html).toMatch(/color:#111827;text-decoration:none;">Shop now<\/a>/);
  });

  it("narrows the side padding on phones", () => {
    expect(render(PLAIN, CONTENT, CTX).html).toContain("@media only screen and (max-width:620px)");
  });
});
