import { describe, expect, it } from "vitest";
import { TEMPLATE_FILES as DEDICATED } from "@/services/provisioning/templates/vite-react-supabase/template-files.generated";
import { TEMPLATE_FILES as POOLED } from "@/services/provisioning/templates/vite-react-zavi/template-files.generated";
import {
  pageFileName,
  zaviHead,
  zaviHeadTags,
  zaviPageHtml,
} from "@/services/provisioning/templates/vite-react-supabase/files/vite-zavi-head";
import { personalizeSiteStarter, siteCardUrl, siteFaviconSvg, siteSourceWithLogo, ZAVI_HEAD_DECLARATION_RE } from "../site-head";

const SITE = { label: "mile-high-coffee-693dfbdb-523441", hostname: "mile-high-coffee-693dfbdb-523441.zaviagent.com", webBase: "https://www.zaviagent.com" };

describe("both starters ship the head plugin", () => {
  it.each([["vite-react-supabase", DEDICATED], ["vite-react-zavi", POOLED]] as const)("%s", (_name, files) => {
    expect(files["vite-zavi-head.ts"]).toBe(DEDICATED["vite-zavi-head.ts"]);
    expect(files["vite.config.ts"]).toMatch(ZAVI_HEAD_DECLARATION_RE);
    expect(files["vite.config.ts"]).toContain("zaviHead(ZAVI_HEAD, pages)");
    expect(JSON.parse(files["zavi-pages.json"])).toEqual({ site: { jsonLd: [] }, pages: {} });
    expect(files["index.html"]).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(files["public/favicon.svg"]).toContain("<svg");
  });
});

describe("personalizeSiteStarter", () => {
  it.each([["vite-react-supabase", DEDICATED], ["vite-react-zavi", POOLED]] as const)(
    "names %s after the site, not the hashes, and points previews at its address",
    (_name, files) => {
      const out = personalizeSiteStarter(files, SITE);
      expect(out["index.html"]).toContain("<title>Mile High Coffee</title>");
      expect(out["index.html"]).not.toContain("New site");
      const decl = ZAVI_HEAD_DECLARATION_RE.exec(out["vite.config.ts"])?.[0] ?? "";
      const head = JSON.parse(decl.replace(/^const ZAVI_HEAD = /, "").replace(/;$/, ""));
      expect(head).toEqual({
        name: "Mile High Coffee",
        url: "https://mile-high-coffee-693dfbdb-523441.zaviagent.com/",
        image: "https://www.zaviagent.com/api/public/site-card?name=Mile+High+Coffee&host=mile-high-coffee-693dfbdb-523441.zaviagent.com",
      });
      expect(out["public/favicon.svg"]).toContain(">M</text>");
      expect(files["index.html"]).toContain("New site");
    },
  );

  it("has no share image without a web base, and leaves a map without the plugin alone", () => {
    const out = personalizeSiteStarter(DEDICATED, { ...SITE, webBase: "" });
    expect(out["vite.config.ts"]).toContain('"image":""');
    const bare = { "index.html": "<title>New site</title>", "vite.config.ts": "export default {}" };
    expect(personalizeSiteStarter(bare, SITE)).toEqual(bare);
  });

  it("a hostile name cannot break out of the config string or the markup", () => {
    const label = 'evil-"};alert(1);//-693dfbdb-523441';
    const out = personalizeSiteStarter(DEDICATED, { ...SITE, label });
    const decl = ZAVI_HEAD_DECLARATION_RE.exec(out["vite.config.ts"])?.[0];
    expect(decl).toBeTruthy();
    expect(() => JSON.parse(decl!.replace(/^const ZAVI_HEAD = /, "").replace(/;$/, ""))).not.toThrow();
    expect(siteFaviconSvg('<"&>')).not.toContain('<"&>');
  });

  it("siteCardUrl encodes its parameters", () => {
    expect(siteCardUrl("https://www.zaviagent.com/", "Joe's & Co", "a.zaviagent.com")).toBe(
      "https://www.zaviagent.com/api/public/site-card?name=Joe%27s+%26+Co&host=a.zaviagent.com",
    );
  });
});

describe("zaviHeadTags (the starter's build-time plugin)", () => {
  const head = { name: "Mile High Coffee", url: "https://m.zaviagent.com/", image: "https://www.zaviagent.com/api/public/site-card?name=M" };
  const page = (inner: string) => `<!doctype html><html><head>\n${inner}\n</head><body></body></html>`;

  it("adds the favicon, Open Graph and Twitter tags from the page's own title and description", () => {
    const html = zaviHeadTags(
      page('<title>Mile High Coffee | Denver</title><meta name="description" content="Small-batch coffee &amp; pastries.">'),
      head,
    );
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(html).toContain('<meta property="og:title" content="Mile High Coffee | Denver" />');
    expect(html).toContain('<meta property="og:description" content="Small-batch coffee &amp; pastries." />');
    expect(html).toContain('<meta property="og:url" content="https://m.zaviagent.com/" />');
    expect(html).toContain('<meta property="og:image" content="https://www.zaviagent.com/api/public/site-card?name=M" />');
    expect(html).toContain('<meta property="og:site_name" content="Mile High Coffee" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('<meta name="twitter:title" content="Mile High Coffee | Denver" />');
  });

  it("never overrides or duplicates a tag the page already has, and is idempotent", () => {
    const own = page(
      '<title>Hush</title><link rel="icon" href="/logo.png"><meta property="og:image" content="https://hush.example/hero.jpg"><meta name="twitter:card" content="summary">',
    );
    const once = zaviHeadTags(own, head);
    expect(once.match(/rel="icon"/g)).toHaveLength(1);
    expect(once.match(/og:image/g)).toHaveLength(1);
    expect(once).toContain("https://hush.example/hero.jpg");
    expect(once.match(/twitter:card/g)).toHaveLength(1);
    expect(zaviHeadTags(once, head)).toBe(once);
  });

  it("names a page still titled 'New site' after the site", () => {
    const html = zaviHeadTags(page("<title>New site</title>"), head);
    expect(html).toContain("<title>Mile High Coffee</title>");
    expect(html).toContain('<meta property="og:title" content="Mile High Coffee" />');
    expect(html).not.toContain("og:description");
  });

  it("uses a summary card when there is no image at all", () => {
    const html = zaviHeadTags(page("<title>Hush</title>"), { name: "Hush" });
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).not.toContain("og:image");
  });
});

describe("per-page heads (zavi-pages.json)", () => {
  const head = { name: "Evently", url: "https://evently.zaviagent.com/", image: "" };
  const BUILT =
    '<!doctype html><html><head><title>Evently</title><meta name="description" content="Home." />' +
    '<meta property="og:title" content="Evently" /><meta property="og:url" content="https://evently.zaviagent.com/" />' +
    '<script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>';

  it("maps a static path to its file, and refuses one the host cannot serve as a file", () => {
    expect(pageFileName("/")).toBe("index.html");
    expect(pageFileName("/events/")).toBe("events/index.html");
    expect(pageFileName("/about/team")).toBe("about/team/index.html");
    expect(pageFileName("/events/:id")).toBeNull();
    expect(pageFileName("/../etc")).toBeNull();
  });

  it("gives a page its own title, description, share tags and JSON-LD, keeping the app", () => {
    const html = zaviPageHtml(BUILT, head, "/events", {
      title: "Upcoming events | Evently",
      description: "Every event near you.",
      jsonLd: { "@type": "ItemList", name: "</script><b>" },
    });
    expect(html).toContain("<title>Upcoming events | Evently</title>");
    expect(html).toContain('<meta name="description" content="Every event near you." />');
    expect(html).not.toContain('content="Home."');
    expect(html).toContain('<meta property="og:title" content="Upcoming events | Evently" />');
    expect(html).toContain('<meta property="og:url" content="https://evently.zaviagent.com/events" />');
    expect(html.match(/og:title/g)).toHaveLength(1);
    expect(html).toContain('<script type="application/ld+json">{"@type":"ItemList","name":"\\u003c/script>\\u003cb>"}</script>');
    expect(html).not.toContain("</script><b>");
    expect(html).toContain('<script type="module" src="/assets/index.js"></script>');
  });

  it("writes one file per listed page at build, and the site JSON-LD into the home page", () => {
    const plugin = zaviHead(head, {
      site: { jsonLd: { "@type": "Organization", name: "Evently" } },
      pages: {
        "/": { title: "Evently | Find events", jsonLd: { "@type": "WebPage", name: "Home" } },
        "/events": { title: "Events" },
        "/events/:id": { title: "x" },
      },
    });
    const home = plugin.transformIndexHtml(BUILT);
    expect(home).toContain("<title>Evently | Find events</title>");
    expect(home).toContain('"@type":"Organization"');

    const emitted: Array<{ fileName: string; source: string }> = [];
    plugin.generateBundle.call(
      { emitFile: (f) => (emitted.push(f), f.fileName) },
      {},
      { "index.html": { type: "asset", source: home } },
    );
    expect(emitted.map((f) => f.fileName)).toEqual(["events/index.html"]);
    expect(emitted[0].source).toContain("<title>Events</title>");
    expect(emitted[0].source.match(/"@type":"Organization"/g)).toHaveLength(1);
    expect(home).toContain('"@type":"WebPage"');
    expect(emitted[0].source).not.toContain('"@type":"WebPage"');
  });
});

describe("personalizeSiteStarter names the pooled starter's header and footer", () => {
  it("fills SITE.name in src/site.ts so the live page never says New site, escaping quotes", () => {
    const out = personalizeSiteStarter(POOLED, { ...SITE, name: 'Joe\'s "Best" Diner' });
    expect(POOLED["src/site.ts"]).toContain('name: "New site",');
    expect(out["src/site.ts"]).toContain('name: "Joe\'s \\"Best\\" Diner",');
    expect(out["src/site.ts"]).not.toContain('"New site"');
    expect(out["src/site.ts"]).toContain('tagline: "A new site, coming soon."');
  });

  it("falls back to the label's words when the site has no name", () => {
    expect(personalizeSiteStarter(POOLED, SITE)["src/site.ts"]).toContain('name: "Mile High Coffee",');
  });
});

describe("starterShowsLogo", () => {
  it("is true exactly when personalizing the starter writes the logo", async () => {
    const { starterShowsLogo, SITE_LOGO_PATH } = await import("../site-head");
    expect(starterShowsLogo(POOLED)).toBe(true);
    expect(personalizeSiteStarter(POOLED, { ...SITE, logoSvg: "<svg>x</svg>" })[SITE_LOGO_PATH]).toBe("<svg>x</svg>");
    expect(starterShowsLogo(DEDICATED)).toBe(false);
    expect(personalizeSiteStarter(DEDICATED, { ...SITE, logoSvg: "<svg>x</svg>" })[SITE_LOGO_PATH]).toBeUndefined();
    expect(starterShowsLogo({ "src/site.ts": 'export const SITE = {\n  name: "New site",\n};\n' })).toBe(false);
  });
  it("the header logo and the favicon can differ; a missing or bad favicon falls back to the logo", async () => {
    const { SITE_LOGO_PATH } = await import("../site-head");
    const both = personalizeSiteStarter(POOLED, { ...SITE, logoSvg: "<svg>mark</svg>", faviconSvg: "<svg>tile</svg>" });
    expect(both[SITE_LOGO_PATH]).toBe("<svg>mark</svg>");
    expect(both["public/favicon.svg"]).toBe("<svg>tile</svg>");
    expect(personalizeSiteStarter(POOLED, { ...SITE, logoSvg: "<svg>mark</svg>" })["public/favicon.svg"]).toBe("<svg>mark</svg>");
    expect(personalizeSiteStarter(POOLED, { ...SITE, logoSvg: "<svg>mark</svg>", faviconSvg: "<script/>" })["public/favicon.svg"]).toBe("<svg>mark</svg>");
    expect(personalizeSiteStarter(POOLED, { ...SITE, logoSvg: null, faviconSvg: "<svg>tile</svg>" })["public/favicon.svg"]).toContain(">M</text>");
  });
});

describe("siteSourceWithLogo", () => {
  it("replaces logo values with or without a comma and preserves comments", () => {
    expect(siteSourceWithLogo('export const SITE = {\n  logo: "/old.svg"\n};\n', "/new.svg")).toContain('logo: "/new.svg"');
    expect(siteSourceWithLogo('export const SITE = {\n  logo: "/old.svg", // keep\n};\n', "/new.svg")).toContain('logo: "/new.svg", // keep');
  });

  it("refuses an unsupported logo expression instead of adding a duplicate property", () => {
    expect(siteSourceWithLogo('export const SITE = {\n  name: "Acme",\n  logo: makeLogo(),\n};\n')).toBeNull();
  });

  it("refuses a spread that could overwrite the generated logo", () => {
    expect(siteSourceWithLogo('export const SITE = {\n  name: "Acme",\n  ...oldBrand,\n};\n')).toBeNull();
  });
});
