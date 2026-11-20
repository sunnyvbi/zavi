
import { describe, it, expect } from "vitest";
import { parseAddrSpec, canonicalizeDomain, domainCoveredBy } from "../addr-spec";

describe("parseAddrSpec — accepts", () => {
  it("a plain address", () => {
    expect(parseAddrSpec("bob@acme.com")).toEqual({
      address: "bob@acme.com",
      local: "bob",
      domain: "acme.com",
    });
  });

  it("lowercases both sides", () => {
    expect(parseAddrSpec("  Bob@ACME.CoM ")?.address).toBe("bob@acme.com");
  });

  it("plus-addressing (the local part is opaque to us)", () => {
    expect(parseAddrSpec("ops+zavi@acme.com")?.local).toBe("ops+zavi");
  });

  it("a subdomain sender", () => {
    expect(parseAddrSpec("bob@mail.acme.com")?.domain).toBe("mail.acme.com");
  });
});

describe("parseAddrSpec — rejects the ambiguous", () => {
  it.each([
    ["empty", ""],
    ["null", null],
    ["no domain", "bob"],
    ["trailing @", "bob@"],
    ["no local", "@acme.com"],
    ["undotted domain", "bob@localhost"],
    ["whitespace inside", "bob acme@x.com"],
    ["list of two", "a@x.com,b@y.com"],
    ["empty label", "bob@acme..com"],
    ["leading dot local", "bob.@acme.com"],
    ["IP literal", "bob@[10.0.0.1]"],
  ])("%s", (_label, input) => {
    expect(parseAddrSpec(input as string)).toBeNull();
  });

  it("multi-@ (domainOf read `acme.com`; SQL read no-match)", () => {
    expect(parseAddrSpec("user@acme.com@evil.com")).toBeNull();
  });

  it("display-name / angle-addr (loop guard missed this)", () => {
    expect(parseAddrSpec("Bob <b@acme.com>")).toBeNull();
    expect(parseAddrSpec("<b@acme.com>")).toBeNull();
    expect(parseAddrSpec("Ravi R <rravi149@gmail.com>")).toBeNull();
  });

  it("quoted local part", () => {
    expect(parseAddrSpec('"bob@evil"@acme.com')).toBeNull();
  });
});

describe("canonicalizeDomain — the evasions a denylist must survive", () => {
  it("strips the RFC 1034 root dot (`gmail.com.` is gmail.com)", () => {
    expect(canonicalizeDomain("gmail.com.")).toBe("gmail.com");
    expect(canonicalizeDomain("gmail.com...")).toBe("gmail.com");
  });

  it("lowercases", () => {
    expect(canonicalizeDomain("GMAIL.COM")).toBe("gmail.com");
  });

  it("IDN folds to punycode so a homograph cannot masquerade", () => {
    const homograph = canonicalizeDomain("gmаil.com");
    expect(homograph).toBe("xn--gmil-63d.com");
    expect(homograph).not.toBe("gmail.com");
  });

  it("an already-punycode domain is stable", () => {
    expect(canonicalizeDomain("xn--gmil-63d.com")).toBe("xn--gmil-63d.com");
  });

  it("rejects non-domains", () => {
    for (const bad of ["", "localhost", "acme", ".com", "a b.com"]) {
      expect(canonicalizeDomain(bad)).toBeNull();
    }
  });

  it("rejects URL syntax rather than silently dropping it", () => {
    for (const bad of [
      "acme.com/path",
      "acme.com:25",
      "acme.com?q=1",
      "acme.com#frag",
      "a@b.com",
      "http://acme.com",
      "acme.com\\x",
    ]) {
      expect(canonicalizeDomain(bad)).toBeNull();
    }
  });

  it("a trailing-dot address parses to the canonical domain", () => {
    expect(parseAddrSpec("bob@gmail.com.")?.domain).toBe("gmail.com");
  });
});

describe("domainCoveredBy — DKIM/DMARC alignment only", () => {
  it("exact match", () => {
    expect(domainCoveredBy("acme.com", "acme.com")).toBe(true);
  });

  it("parent domain covers a subdomain sender", () => {
    expect(domainCoveredBy("mail.acme.com", "acme.com")).toBe(true);
  });

  it("a subdomain does NOT cover its parent", () => {
    expect(domainCoveredBy("acme.com", "mail.acme.com")).toBe(false);
  });

  it("suffix collision is not coverage (`evilacme.com` vs `acme.com`)", () => {
    expect(domainCoveredBy("evilacme.com", "acme.com")).toBe(false);
  });

  it("normalizes both sides before comparing", () => {
    expect(domainCoveredBy("MAIL.ACME.COM.", "acme.com")).toBe(true);
  });
});
