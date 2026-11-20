import { describe, expect, it } from "vitest";
import { hasOwnGithub, isOwnSite, isZaviHostedRepoUrl } from "./existingProduct";

describe("isOwnSite", () => {
  it("is true for a site the tenant runs themselves", () => {
    expect(isOwnSite("https://www.upcar.ai")).toBe(true);
    expect(isOwnSite("https://counsilplumbing.com")).toBe(true);
    expect(isOwnSite("https://a2zevents.ai")).toBe(true);
  });

  it("is false for a Zavi-hosted app", () => {
    expect(isOwnSite("https://upcarai-6ec4d609.onrender.com")).toBe(false);
    expect(isOwnSite("https://upcarai-6ec4d609.zaviagent.com")).toBe(false);
    expect(isOwnSite("https://www.zaviagent.com")).toBe(false);
  });

  it("does not match a lookalike host by substring", () => {
    expect(isOwnSite("https://onrender.com.evil.net")).toBe(true);
    expect(isOwnSite("https://anything.onrender.com")).toBe(false);
  });

  it("is false on absent or unparseable input", () => {
    expect(isOwnSite(undefined)).toBe(false);
    expect(isOwnSite(null)).toBe(false);
    expect(isOwnSite("")).toBe(false);
    expect(isOwnSite("not a url")).toBe(false);
    expect(isOwnSite("upcar.ai")).toBe(false);
  });
});

describe("hasOwnGithub", () => {
  it("is true only for an install on the tenant's own account", () => {
    expect(hasOwnGithub([{ slug: "github", account_login: "rravi149" }])).toBe(true);
  });

  it("is false for the umbrella sentinel", () => {
    expect(hasOwnGithub([{ slug: "github", account_login: "Praxis-build" }])).toBe(
      false,
    );
  });

  it("is false when github is absent", () => {
    expect(hasOwnGithub([{ slug: "slack", account_login: "acme" }])).toBe(false);
    expect(hasOwnGithub([])).toBe(false);
  });

  it("returns null for an unknown read, never false", () => {
    expect(hasOwnGithub(null)).toBeNull();
  });

  it("ignores a non-github row that happens to carry the umbrella login", () => {
    expect(
      hasOwnGithub([
        { slug: "slack", account_login: "Praxis-build" },
        { slug: "github", account_login: "ecloset-app" },
      ]),
    ).toBe(true);
  });
});

describe("isZaviHostedRepoUrl", () => {
  it("is true for the umbrella org, whatever the case", () => {
    expect(isZaviHostedRepoUrl("https://github.com/Praxis-build/acme-6ec4d609")).toBe(true);
    expect(isZaviHostedRepoUrl("https://github.com/praxis-build/acme")).toBe(true);
    expect(isZaviHostedRepoUrl("https://github.com/praxis-built/acme")).toBe(true);
  });

  it("is false for a repo the tenant owns, or anything that is not a GitHub URL", () => {
    expect(isZaviHostedRepoUrl("https://github.com/acme/storefront")).toBe(false);
    expect(isZaviHostedRepoUrl("https://gitlab.com/Praxis-build/acme")).toBe(false);
    expect(isZaviHostedRepoUrl("not a url")).toBe(false);
    expect(isZaviHostedRepoUrl(null)).toBe(false);
  });
});
