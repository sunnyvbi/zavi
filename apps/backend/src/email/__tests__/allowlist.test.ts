
import { describe, it, expect } from "vitest";
import { matchesAllowlist, validateAllowlistEntry, isPublicMailboxDomain } from "../allowlist";
import type { AllowlistEntry } from "../allowlist";

const entry = (kind: "address" | "domain", value: string): AllowlistEntry => ({ kind, value });

describe("matchesAllowlist — empty means members-only", () => {
  it("no entries matches nobody", () => {
    expect(matchesAllowlist("bob@acme.com", [])).toBe(false);
  });

  it("tolerates a null/undefined list", () => {
    expect(matchesAllowlist("bob@acme.com", undefined as unknown as AllowlistEntry[])).toBe(false);
  });
});

describe("matchesAllowlist — address entries", () => {
  const list = [entry("address", "ops@acme.com")];

  it("matches exactly", () => {
    expect(matchesAllowlist("ops@acme.com", list)).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(matchesAllowlist("OPS@ACME.COM", list)).toBe(true);
  });

  it("matches through a trailing dot", () => {
    expect(matchesAllowlist("ops@acme.com.", list)).toBe(true);
  });

  it("does not match a different local part", () => {
    expect(matchesAllowlist("eve@acme.com", list)).toBe(false);
  });

  it("does NOT match plus-addressing (exact only — support footgun, not a hole)", () => {
    expect(matchesAllowlist("ops+zavi@acme.com", list)).toBe(false);
  });

  it("a freemail ADDRESS is fine — one person, not a wildcard", () => {
    expect(matchesAllowlist("ravi@gmail.com", [entry("address", "ravi@gmail.com")])).toBe(true);
  });
});

describe("matchesAllowlist — domain entries", () => {
  const list = [entry("domain", "acme.com")];

  it("matches any local part at the domain", () => {
    expect(matchesAllowlist("anyone@acme.com", list)).toBe(true);
  });

  it("does NOT match a subdomain", () => {
    expect(matchesAllowlist("bob@mail.acme.com", list)).toBe(false);
  });

  it("does NOT match a suffix collision", () => {
    expect(matchesAllowlist("bob@evilacme.com", list)).toBe(false);
  });

  it("does NOT match the parent of the entry", () => {
    expect(matchesAllowlist("bob@com", [entry("domain", "mail.acme.com")])).toBe(false);
  });

  it("matches through case + trailing dot on both sides", () => {
    expect(matchesAllowlist("BOB@ACME.COM.", [entry("domain", "AcMe.CoM.")])).toBe(true);
  });
});

describe("matchesAllowlist — a planted freemail row grants nothing", () => {
  it.each(["gmail.com", "outlook.com", "yahoo.com", "proton.me", "qq.com", "mailinator.com"])(
    "%s wildcard matches nobody even when present as a row",
    (domain) => {
      expect(matchesAllowlist(`attacker@${domain}`, [entry("domain", domain)])).toBe(false);
    },
  );

  it("a planted `gmail.com.` (trailing dot) row also grants nothing", () => {
    expect(matchesAllowlist("attacker@gmail.com", [entry("domain", "gmail.com.")])).toBe(false);
  });

  it("a planted `GMAIL.COM` row also grants nothing", () => {
    expect(matchesAllowlist("attacker@gmail.com", [entry("domain", "GMAIL.COM")])).toBe(false);
  });

  it("a planted own-domain row grants nothing (loop guard belt + braces)", () => {
    expect(
      matchesAllowlist("x@inbox.zaviagent.com", [entry("domain", "inbox.zaviagent.com")]),
    ).toBe(false);
  });
});

describe("matchesAllowlist — malformed input never matches", () => {
  it.each([
    ["multi-@ sender", "user@acme.com@evil.com", [entry("domain", "acme.com")]],
    ["display-name sender", "Bob <bob@acme.com>", [entry("domain", "acme.com")]],
    ["empty sender", "", [entry("domain", "acme.com")]],
    ["garbage entry value", "bob@acme.com", [entry("domain", "not a domain")]],
    ["garbage address entry", "bob@acme.com", [entry("address", "@@@")]],
  ])("%s", (_label, email, list) => {
    expect(matchesAllowlist(email, list as AllowlistEntry[])).toBe(false);
  });

  it("an unknown kind matches nothing", () => {
    expect(
      matchesAllowlist("bob@acme.com", [{ kind: "regex", value: ".*" } as unknown as AllowlistEntry]),
    ).toBe(false);
  });
});

describe("matchesAllowlist — one match in a list is enough", () => {
  it("scans past non-matching entries", () => {
    const list = [
      entry("domain", "other.com"),
      entry("address", "nope@x.com"),
      entry("domain", "acme.com"),
    ];
    expect(matchesAllowlist("bob@acme.com", list)).toBe(true);
  });
});

describe("validateAllowlistEntry", () => {
  it("classifies an address by the @", () => {
    const r = validateAllowlistEntry(" Ops@Acme.COM ");
    expect(r).toEqual({ ok: true, entry: { kind: "address", value: "ops@acme.com" } });
  });

  it("classifies a bare domain", () => {
    const r = validateAllowlistEntry("Acme.COM.");
    expect(r).toEqual({ ok: true, entry: { kind: "domain", value: "acme.com" } });
  });

  it("canonicalizes an IDN domain to punycode", () => {
    const r = validateAllowlistEntry("gmаil.com");
    expect(r).toEqual({ ok: true, entry: { kind: "domain", value: "xn--gmil-63d.com" } });
  });

  it("refuses empty", () => {
    expect(validateAllowlistEntry("  ")).toMatchObject({ ok: false, code: "empty" });
  });

  it("refuses a freemail wildcard, and says why", () => {
    const r = validateAllowlistEntry("gmail.com");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("public_domain");
    expect(r.message).toContain("anyone with a gmail.com address");
  });

  it("refuses a freemail wildcard spelled with a trailing dot", () => {
    expect(validateAllowlistEntry("gmail.com.")).toMatchObject({ ok: false, code: "public_domain" });
  });

  it("allows a freemail ADDRESS", () => {
    expect(validateAllowlistEntry("ravi@gmail.com")).toMatchObject({ ok: true });
  });

  it("refuses our own domains", () => {
    expect(validateAllowlistEntry("inbox.zaviagent.com")).toMatchObject({ ok: false, code: "own_domain" });
    expect(validateAllowlistEntry("x@inbox.zaviagent.com")).toMatchObject({ ok: false, code: "own_domain" });
  });

  it.each(["bob@", "@acme.com", "a@b@c.com", "Bob <b@acme.com>"])("refuses malformed address %s", (v) => {
    expect(validateAllowlistEntry(v)).toMatchObject({ ok: false, code: "malformed_address" });
  });

  it.each(["acme", "localhost", "acme.com/path", "not a domain"])("refuses malformed domain %s", (v) => {
    expect(validateAllowlistEntry(v)).toMatchObject({ ok: false, code: "malformed_domain" });
  });
});

describe("isPublicMailboxDomain", () => {
  it("is canonicalizing, not string-equality", () => {
    expect(isPublicMailboxDomain("GMAIL.COM.")).toBe(true);
    expect(isPublicMailboxDomain("gmail.com")).toBe(true);
  });

  it("a company domain is not public", () => {
    expect(isPublicMailboxDomain("acme.com")).toBe(false);
    expect(isPublicMailboxDomain("upcar.ai")).toBe(false);
  });

  it("a homograph is not the real thing (and is not on the list)", () => {
    expect(isPublicMailboxDomain("gmаil.com")).toBe(false);
  });
});
