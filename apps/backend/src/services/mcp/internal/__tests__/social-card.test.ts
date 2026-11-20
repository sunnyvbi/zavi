import { describe, it, expect } from "vitest";
import {
  extractSocialCard,
  renderSocialCardBody,
  isSocialOgDomain,
} from "../social-card";

const LI_OG = `<html><head>
<meta property="og:title" content="Andrea Manrique - Yanne Capital | LinkedIn">
<meta property="og:description" content="Associate at Kadenwood Group, an independent boutique investment bank specializing in&amp;hellip; · Experience: Yanne Capital · Education: Universidad Autónoma de Bucaramanga · Location: United States · 500+ connections on LinkedIn.">
<meta property="og:site_name" content="LinkedIn">
<title>Andrea Manrique - Yanne Capital | LinkedIn</title>
</head><body>Sign Up | LinkedIn — Join LinkedIn</body></html>`;

describe("extractSocialCard", () => {
  it("pulls og:title + og:description + site from a LinkedIn preview", () => {
    const card = extractSocialCard(LI_OG);
    expect(card).not.toBeNull();
    expect(card!.title).toBe("Andrea Manrique - Yanne Capital | LinkedIn");
    expect(card!.description).toContain("Associate at Kadenwood Group");
    expect(card!.description).toContain("Yanne Capital");
    expect(card!.site).toBe("LinkedIn");
  });

  it("decodes HTML entities in extracted values", () => {
    const html = `<meta property="og:title" content="A &amp; B &#39;Co&#39; &#x2014; team">`;
    const card = extractSocialCard(html);
    expect(card!.title).toBe("A & B 'Co' — team");
  });

  it("tolerates content-before-property attribute order", () => {
    const html = `<meta content="Flipped order" property="og:title">`;
    expect(extractSocialCard(html)!.title).toBe("Flipped order");
  });

  it("falls back to <title> + meta description when no og: tags", () => {
    const html = `<html><head><title>Plain Page</title><meta name="description" content="just a page"></head></html>`;
    const card = extractSocialCard(html);
    expect(card!.title).toBe("Plain Page");
    expect(card!.description).toBe("just a page");
  });

  it("returns null when there is no usable card", () => {
    expect(extractSocialCard("<html><body>nothing here</body></html>")).toBeNull();
  });
});

describe("renderSocialCardBody", () => {
  it("labels the card as preview metadata (disclosure) + includes the fields", () => {
    const body = renderSocialCardBody(
      { title: "Andrea Manrique", description: "Associate at Yanne Capital", site: "LinkedIn" },
      "www.linkedin.com",
    );
    expect(body).toContain("social preview card");
    expect(body).toContain("www.linkedin.com");
    expect(body).toContain("Andrea Manrique");
    expect(body).toContain("Associate at Yanne Capital");
  });
});

describe("isSocialOgDomain", () => {
  it("matches social/profile hosts incl. subdomains, rejects others", () => {
    expect(isSocialOgDomain("https://www.linkedin.com/in/x/")).toBe(true);
    expect(isSocialOgDomain("https://linkedin.com/in/x")).toBe(true);
    expect(isSocialOgDomain("https://x.com/someone")).toBe(true);
    expect(isSocialOgDomain("https://crunchbase.com/person/y")).toBe(true);
    expect(isSocialOgDomain("https://example.com/")).toBe(false);
    expect(isSocialOgDomain("https://notlinkedin.com.evil.com/")).toBe(false);
    expect(isSocialOgDomain("not a url")).toBe(false);
  });
});
