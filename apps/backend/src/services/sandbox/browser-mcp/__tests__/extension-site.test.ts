import { describe, it, expect } from "vitest";
import { registrableSite } from "../extension-site";

describe("registrableSite", () => {
  it("keeps subdomains of one registrable domain together", () => {
    expect(registrableSite("https://adsmanager.facebook.com/adsmanager")).toBe("facebook.com");
    expect(registrableSite("https://business.facebook.com/settings")).toBe("facebook.com");
    expect(registrableSite("https://FACEBOOK.com./x")).toBe("facebook.com");
  });

  it("uses the public suffix list, not the last two labels (co.uk, com.au, co.in)", () => {
    expect(registrableSite("https://shop.example.co.uk/")).toBe("example.co.uk");
    expect(registrableSite("https://other.co.uk/")).toBe("other.co.uk");
    expect(registrableSite("https://a.b.shop.com.au/")).toBe("shop.com.au");
    expect(registrableSite("https://www.flipkart.co.in/")).toBe("flipkart.co.in");
    expect(registrableSite("https://alice.github.io/")).not.toBe(registrableSite("https://bob.github.io/"));
  });

  it("compares IDNs in punycode, so the unicode and ascii spellings are one site", () => {
    expect(registrableSite("https://shop.münchen.de/")).toBe("xn--mnchen-3ya.de");
    expect(registrableSite("https://xn--mnchen-3ya.de/")).toBe("xn--mnchen-3ya.de");
    expect(registrableSite("https://xn--facebok-y0a.com/")).not.toBe("facebook.com");
  });

  it("treats an IP or a single-label host as its own site (psl would turn 127.0.0.1 into 0.1)", () => {
    expect(registrableSite("http://127.0.0.1:3000/")).toBe("127.0.0.1");
    expect(registrableSite("http://127.0.0.2/")).not.toBe(registrableSite("http://127.0.0.1/"));
    expect(registrableSite("http://localhost:5173/")).toBe("localhost");
    expect(registrableSite("http://[::1]:8080/")).toBe("[::1]");
  });

  it("gives opaque and non-web URLs no site", () => {
    for (const u of [
      "about:blank",
      "chrome://newtab/",
      "data:text/html,hi",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
      "",
      null,
      undefined,
    ]) {
      expect(registrableSite(u as string)).toBeNull();
    }
  });
});
