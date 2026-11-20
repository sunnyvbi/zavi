import { describe, it, expect, vi } from "vitest";
import { buildPlanDossier, quoteIsOnPage, unescapeExcerpt } from "../plan-dossier";

const page = (url: string, text: string) => ({ url, title: "t", text_excerpt: text });
const long = (s: string) => `${s} ${"filler text about the company. ".repeat(10)}`;

describe("quoteIsOnPage", () => {
  it("matches ignoring case, whitespace runs and curly quotes", () => {
    expect(quoteIsOnPage("Plans start at $9 per month", "…  plans   START at $9 per month for …")).toBe(true);
    expect(quoteIsOnPage("We’re the best rated", "we're the best rated")).toBe(true);
  });
  it("rejects a quote that is not on the page, or too short to mean anything", () => {
    expect(quoteIsOnPage("Plans start at $19 per month", "plans start at $9 per month")).toBe(false);
    expect(quoteIsOnPage("price", "price")).toBe(false);
  });
});

describe("unescapeExcerpt", () => {
  it("restores the characters the stored excerpt escaped", () => {
    expect(unescapeExcerpt("Tom &amp; Jerry &lt;3 &quot;hi&quot;")).toBe('Tom & Jerry <3 "hi"');
  });
});

describe("buildPlanDossier", () => {
  it("keeps only facts whose quote is on the cited page", async () => {
    const out = await buildPlanDossier(
      { orgName: "Acme", domain: "acme.com", researchPages: [page("https://review.site/acme", long("Customers say support replies within 2 hours"))] },
      {
        checkSite: async () => [],
      renderPage: async () => null,
      readSiteMap: async () => [],
      checkPages: async () => [],
      fetchCompanyPages: async () => [page("https://acme.com/pricing", long("Pro plan costs $49 per month billed annually"))],
        extract: async () => ({
          cost_usd: 0.02,
          text: JSON.stringify({
            facts: [
              { topic: "pricing", fact: "Pro plan is $49/month billed annually", quote: "Pro plan costs $49 per month", page: "P1" },
              { topic: "reviews", fact: "Support replies within two hours", quote: "support replies within 2 hours", page: "P2" },
              { topic: "traction", fact: "Has 50,000 customers", quote: "trusted by 50,000 customers", page: "P1" },
              { topic: "pricing", fact: "A fact citing a page that does not exist", quote: "Pro plan costs $49 per month", page: "P9" },
            ],
          }),
        }),
      },
    );
    expect(out?.facts.map((f) => f.topic)).toEqual(["pricing", "reviews"]);
    expect(out?.facts[0].source_url).toBe("https://acme.com/pricing");
    expect(out?.dropped_unverified).toBe(2);
    expect(out?.cost_usd).toBe(0.02);
  });

  it("returns null when there is nothing to read, and when extraction fails", async () => {
    const empty = await buildPlanDossier(
      { orgName: "Acme", domain: "acme.com", researchPages: [] },
      { checkSite: async () => [],
      renderPage: async () => null,
      readSiteMap: async () => [],
      checkPages: async () => [],
      fetchCompanyPages: async () => [], extract: async () => ({ text: "{}", cost_usd: 0 }) },
    );
    expect(empty).toBeNull();
    const failed = await buildPlanDossier(
      { orgName: "Acme", domain: "acme.com", researchPages: [page("https://acme.com", long("hello"))] },
      { checkSite: async () => [],
      renderPage: async () => null,
      readSiteMap: async () => [],
      checkPages: async () => [],
      fetchCompanyPages: async () => [], extract: async () => { throw new Error("timeout"); } },
    );
    expect(failed).toBeNull();
  });
});

describe("where a fact came from", () => {
  it("knows the company's own pages from someone else's", async () => {
    const { isOwnSite, isUsableStatus } = await import("../plan-dossier");
    expect(isOwnSite("https://www.acme.com/pricing", "acme.com")).toBe(true);
    expect(isOwnSite("https://blog.acme.com/post", "acme.com")).toBe(true);
    expect(isOwnSite("https://techcrunch.com/acme", "acme.com")).toBe(false);
    expect(isOwnSite("not a url", "acme.com")).toBe(false);

    expect(isUsableStatus(200)).toBe(true);
    expect(isUsableStatus(301)).toBe(true);
    expect(isUsableStatus(403)).toBe(false);
    expect(isUsableStatus(404)).toBe(false);
    expect(isUsableStatus(null)).toBe(false);
  });
});

describe("a site that refuses our fetcher", () => {
  it("reads the home page through a browser once, and only when we got nothing", async () => {
    const { buildPlanDossier } = await import("../plan-dossier");
    const rendered = { url: "https://acme.com/", title: "Acme", text_excerpt: "x".repeat(400) };
    const calls: string[] = [];
    const deps = {
      fetchCompanyPages: async () => [],
      checkSite: async () => [{ url: "https://acme.com/", status: 403 }],
      readSiteMap: async () => [],
      checkPages: async () => [],
      renderPage: async (url: string) => {
        calls.push(url);
        return rendered;
      },
      extract: async () => ({ text: '{"facts":[]}', cost_usd: 0 }),
    };
    const out = await buildPlanDossier({ orgName: "Acme", domain: "acme.com", researchPages: [] }, deps);
    expect(calls).toEqual(["https://acme.com/"]);
    expect(out?.pages_read.map((p) => p.url)).toEqual(["https://acme.com/"]);

    calls.length = 0;
    await buildPlanDossier(
      { orgName: "Acme", domain: "acme.com", researchPages: [] },
      { ...deps, fetchCompanyPages: async () => [rendered], checkSite: async () => [{ url: "https://acme.com/", status: 200 }] },
    );
    expect(calls).toEqual([]);
  });
});

it("starts independent page checks and extraction together and retains facts if checks fail", async () => {
 let release!: () => void;
 const checking = new Promise<void>(r => { release = r; });
 const extract = vi.fn(async () => ({cost_usd:0, text: JSON.stringify({facts:[{topic:"pricing",fact:"Pro costs $49 per month",quote:"Pro costs $49 per month",page:"P1"}]})}));
 const pending = buildPlanDossier({orgName:"Acme",domain:"acme.com",researchPages:[]}, {
  fetchCompanyPages:async()=>[page("https://acme.com",long("Pro costs $49 per month"))],
  checkSite:async()=>[],readSiteMap:async()=>[],renderPage:async()=>null,
  checkPages:async()=>{await checking;throw new Error("offline")}, extract,
 });
 await new Promise(r=>setTimeout(r,0));
 const startedBeforeChecksFinished=extract.mock.calls.length;
 release(); const out=await pending;
 expect(startedBeforeChecksFinished).toBe(1);
 expect(out?.facts).toHaveLength(1);expect(out?.page_checks).toEqual([]);
});
