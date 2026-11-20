import { describe, expect, it } from "vitest";
import { faviconUrlFromDomain } from "./GrowthCompanyCard";

describe("faviconUrlFromDomain", () => {
  it("builds an https favicon URL from a bare host", () => {
    expect(faviconUrlFromDomain("upcar.ai")).toBe("https://upcar.ai/favicon.ico");
  });

  it("keeps the host and drops path, query and port-less extras", () => {
    expect(faviconUrlFromDomain("https://www.acme.com/pricing?ref=x")).toBe(
      "https://www.acme.com/favicon.ico",
    );
  });

  it("forces https on an http domain", () => {
    expect(faviconUrlFromDomain("http://acme.com")).toBe("https://acme.com/favicon.ico");
  });

  it("tolerates stored whitespace", () => {
    expect(faviconUrlFromDomain("  acme.com  ")).toBe("https://acme.com/favicon.ico");
  });

  it("returns null when no domain fact is set", () => {
    expect(faviconUrlFromDomain("")).toBeNull();
    expect(faviconUrlFromDomain("   ")).toBeNull();
  });

  it("returns null for a host that is not a public site", () => {
    expect(faviconUrlFromDomain("localhost")).toBeNull();
    expect(faviconUrlFromDomain("acme")).toBeNull();
  });

  it("returns null for junk rather than throwing", () => {
    expect(faviconUrlFromDomain("http://")).toBeNull();
    expect(faviconUrlFromDomain(":::")).toBeNull();
  });
});
