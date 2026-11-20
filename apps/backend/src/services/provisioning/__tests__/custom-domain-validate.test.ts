import { describe, it, expect } from "vitest";
import { validateCustomDomainHostname } from "../custom-domain-validate";

describe("validateCustomDomainHostname", () => {
  it("accepts a normal subdomain", () => {
    expect(validateCustomDomainHostname("app.example.com")).toEqual({
      ok: true,
      hostname: "app.example.com",
      domain_type: "subdomain",
    });
  });

  it("normalizes case, trailing dot, and a pasted URL", () => {
    expect(validateCustomDomainHostname("  HTTPS://App.Example.COM/path?x=1  ")).toEqual({
      ok: true,
      hostname: "app.example.com",
      domain_type: "subdomain",
    });
  });

  it("accepts an apex domain and tags it apex", () => {
    expect(validateCustomDomainHostname("example.com")).toEqual({
      ok: true,
      hostname: "example.com",
      domain_type: "apex",
    });
  });

  it("accepts an apex on a novel TLD (the reported 777in.ltd case)", () => {
    expect(validateCustomDomainHostname("http://777in.ltd")).toEqual({
      ok: true,
      hostname: "777in.ltd",
      domain_type: "apex",
    });
  });

  it("treats a two-label public suffix as apex, and a label under it as a subdomain", () => {
    expect(validateCustomDomainHostname("acme.co.uk")).toEqual({
      ok: true,
      hostname: "acme.co.uk",
      domain_type: "apex",
    });
    expect(validateCustomDomainHostname("app.acme.co.uk")).toEqual({
      ok: true,
      hostname: "app.acme.co.uk",
      domain_type: "subdomain",
    });
  });

  it("rejects literal IPs", () => {
    expect(validateCustomDomainHostname("1.2.3.4").ok).toBe(false);
    expect(validateCustomDomainHostname("[::1]").ok).toBe(false);
  });

  it("rejects localhost / internal names", () => {
    expect(validateCustomDomainHostname("localhost").ok).toBe(false);
    expect(validateCustomDomainHostname("foo.local").ok).toBe(false);
  });

  it("rejects platform-owned domains (no hijack of our own hosts)", () => {
    expect(validateCustomDomainHostname("evil.zaviagent.com").ok).toBe(false);
    expect(validateCustomDomainHostname("zaviagent.com").ok).toBe(false);
    expect(validateCustomDomainHostname("someapp.onrender.com").ok).toBe(false);
    expect(validateCustomDomainHostname("x.render.com").ok).toBe(false);
  });

  it("rejects empty / malformed input", () => {
    expect(validateCustomDomainHostname("").ok).toBe(false);
    expect(validateCustomDomainHostname("   ").ok).toBe(false);
    expect(validateCustomDomainHostname("no-dot").ok).toBe(false);
    expect(validateCustomDomainHostname("bad_underscore.example.com").ok).toBe(false);
    expect(validateCustomDomainHostname(42 as unknown).ok).toBe(false);
  });

  it("rejects userinfo/port forms that could smuggle a different host", () => {
    expect(validateCustomDomainHostname("user@evil.example.com").ok).toBe(false);
    expect(validateCustomDomainHostname("app.example.com:443").ok).toBe(false);
    expect(validateCustomDomainHostname("app.example.com boom").ok).toBe(false);
  });

  it("normalizes an IDN host to punycode", () => {
    const r = validateCustomDomainHostname("app.münchen.de");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hostname).toContain("xn--");
  });
});
