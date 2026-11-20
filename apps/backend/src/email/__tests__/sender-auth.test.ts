
import { describe, it, expect } from "vitest";
import { verifyFromAuthenticity } from "@/email/sender-auth";

const REAL_CF_AR =
  "mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=20251104 header.b=P1PMvac3; " +
  "dmarc=pass header.from=gmail.com policy.dmarc=none; " +
  "spf=none (mx.cloudflare.net: no SPF records found for postmaster@mail-vk1-xa2b.google.com) " +
  "smtp.helo=mail-vk1-xa2b.google.com; " +
  "spf=pass (mx.cloudflare.net: domain of rravi149@gmail.com designates 2607:f8b0:4864:20::a2b " +
  'as permitted sender) smtp.mailfrom=rravi149@gmail.com; arc=pass smtp.remote-ip="2607:f8b0:4864:20::a2b"';

describe("real production mail still authenticates", () => {
  it("accepts the real captured Cloudflare AR for its real sender", () => {
    const r = verifyFromAuthenticity("rravi149@gmail.com", REAL_CF_AR);
    expect(r.authentic).toBe(true);
    expect(r.reason).toBe("dmarc_pass_aligned:gmail.com");
  });
});

describe("accepts legitimate senders", () => {
  it("accepts an ALIGNED dmarc pass", () => {
    const r = verifyFromAuthenticity(
      "ravi@upcar.ai",
      "mx.cloudflare.net; dkim=pass header.d=upcar.ai; spf=pass; dmarc=pass header.from=upcar.ai",
    );
    expect(r.authentic).toBe(true);
  });

  it("accepts an ALIGNED dkim pass (header.d matches the From domain)", () => {
    const r = verifyFromAuthenticity("ravi@upcar.ai", "mx.cloudflare.net; dkim=pass header.d=upcar.ai");
    expect(r.authentic).toBe(true);
    expect(r.reason).toContain("aligned");
  });

  it("accepts a subdomain From signed by the parent domain", () => {
    const r = verifyFromAuthenticity("ravi@mail.upcar.ai", "mx.cloudflare.net; dkim=pass header.d=upcar.ai");
    expect(r.authentic).toBe(true);
  });

  it("accepts a subdomain From under a parent-domain DMARC pass", () => {
    const r = verifyFromAuthenticity("bob@mail.acme.com", "mx.cloudflare.net; dmarc=pass header.from=acme.com");
    expect(r.authentic).toBe(true);
  });

  it("is case-insensitive about the verdict text", () => {
    const r = verifyFromAuthenticity("Ravi@Upcar.AI", "MX.CLOUDFLARE.NET; DKIM=PASS header.d=UPCAR.AI");
    expect(r.authentic).toBe(true);
  });

  it("normalizes case + trailing dot on the From before aligning", () => {
    expect(verifyFromAuthenticity("RRavi149@GMAIL.COM.", REAL_CF_AR).authentic).toBe(true);
  });
});

describe("P0-A — dmarc=pass must be ALIGNED to the address being authorized", () => {
  it("REJECTS a real dmarc=pass for a DIFFERENT domain (the spoof)", () => {
    const ar = "mx.cloudflare.net; dkim=pass header.d=evil.com; dmarc=pass header.from=evil.com";
    const r = verifyFromAuthenticity("ravi@upcar.ai", ar);
    expect(r.authentic).toBe(false);
    expect(r.reason).toBe("dmarc_pass_but_unaligned:evil.com");
  });

  it("REJECTS dmarc=pass that names no header.from", () => {
    const r = verifyFromAuthenticity("ravi@upcar.ai", "mx.cloudflare.net; dmarc=pass");
    expect(r.authentic).toBe(false);
    expect(r.reason).toBe("dmarc_pass_but_no_header_from");
  });

  it("REJECTS a suffix-collision domain (evilupcar.ai does not cover upcar.ai)", () => {
    const ar = "mx.cloudflare.net; dmarc=pass header.from=evilupcar.ai";
    expect(verifyFromAuthenticity("ravi@upcar.ai", ar).authentic).toBe(false);
  });

  it("REJECTS a child domain claiming to cover its parent", () => {
    const ar = "mx.cloudflare.net; dmarc=pass header.from=evil.upcar.ai";
    expect(verifyFromAuthenticity("ravi@upcar.ai", ar).authentic).toBe(false);
  });

  it("REJECTS a dkim pass signed by a DIFFERENT domain than the From", () => {
    const r = verifyFromAuthenticity("ravi@upcar.ai", "mx.cloudflare.net; dkim=pass header.d=evil-attacker.com");
    expect(r.authentic).toBe(false);
    expect(r.reason).toContain("unaligned");
  });
});

describe("P0-B — the verdict comes from the Worker's trusted field, or not at all", () => {
  it("FAILS CLOSED when there is no trusted verdict", () => {
    for (const v of [null, undefined, "", "   "]) {
      const r = verifyFromAuthenticity("ravi@upcar.ai", v);
      expect(r.authentic).toBe(false);
      expect(r.reason).toBe("no_trusted_auth_results");
    }
  });

  it("cannot be handed a raw header bag (the old shape must not typecheck)", () => {
    const bag = { "authentication-results": "mx.evil.com; dmarc=pass header.from=upcar.ai" };
    // @ts-expect-error — headers are evidence, not a verdict. Regression guard.
    const r = verifyFromAuthenticity("ravi@upcar.ai", bag);
    expect(r.authentic).toBe(false);
  });
});

describe("SPF alone is never enough", () => {
  it("REJECTS spf=pass alone", () => {
    const r = verifyFromAuthenticity("ravi@upcar.ai", "mx.cloudflare.net; spf=pass smtp.mailfrom=attacker.com; dkim=none");
    expect(r.authentic).toBe(false);
    expect(r.reason).toBe("spf_only_from_not_authenticated");
  });

  it("REJECTS an outright failure", () => {
    const r = verifyFromAuthenticity("ravi@upcar.ai", "mx.cloudflare.net; dkim=fail; spf=fail; dmarc=fail");
    expect(r.authentic).toBe(false);
    expect(r.reason).toBe("no_passing_auth");
  });
});

describe("the From must be a parseable bare addr-spec", () => {
  it.each([
    ["display-name form (a caller bug — pass parsed.from.address)", "Ravi R <rravi149@gmail.com>"],
    ["multi-@", "user@gmail.com@evil.com"],
    ["garbage with no domain", "notanemail"],
    ["empty", ""],
  ])("REJECTS %s", (_label, from) => {
    const r = verifyFromAuthenticity(from, REAL_CF_AR);
    expect(r.authentic).toBe(false);
    expect(r.reason).toBe("unparseable_from");
  });
});

describe("per-clause parsing: a pass counts only for the domain in its own clause", () => {
  it("REJECTS the repro: failing gmail signature + passing evil signature + dmarc fail", () => {
    const ar =
      "mx.cloudflare.net; dkim=fail header.d=gmail.com; dkim=pass header.d=evil.com; dmarc=fail header.from=gmail.com";
    expect(verifyFromAuthenticity("victim@gmail.com", ar).authentic).toBe(false);
  });

  it("REJECTS failing aligned + passing unaligned DKIM with no DMARC clause", () => {
    const ar = "mx.cloudflare.net; dkim=fail header.d=gmail.com; dkim=pass header.d=evil.com";
    const r = verifyFromAuthenticity("victim@gmail.com", ar);
    expect(r.authentic).toBe(false);
    expect(r.reason).toBe("dkim_pass_but_unaligned:evil.com");
  });

  it("accepts a single passing aligned DKIM", () => {
    const r = verifyFromAuthenticity("bob@acme.com", "mx.cloudflare.net; dkim=pass header.d=acme.com header.s=s1");
    expect(r).toEqual({ authentic: true, reason: "dkim_pass_aligned:acme.com" });
  });

  it("accepts an aligned dmarc pass", () => {
    const r = verifyFromAuthenticity("bob@acme.com", "mx.cloudflare.net; dmarc=pass (p=none) header.from=acme.com");
    expect(r).toEqual({ authentic: true, reason: "dmarc_pass_aligned:acme.com" });
  });

  it.each([
    ["unaligned first", "mx.cloudflare.net; dkim=pass header.d=esp.net; dkim=pass header.d=acme.com"],
    ["aligned first", "mx.cloudflare.net; dkim=pass header.d=acme.com; dkim=pass header.d=esp.net"],
    [
      "failing signature among passes",
      "mx.cloudflare.net; dkim=fail header.d=other.com; dkim=pass header.d=esp.net; dkim=pass header.d=acme.com",
    ],
  ])("accepts when ONE signature passes aligned, in any order (%s)", (_l, ar) => {
    expect(verifyFromAuthenticity("bob@acme.com", ar)).toEqual({
      authentic: true,
      reason: "dkim_pass_aligned:acme.com",
    });
  });

  it("does not let a header.d from a DIFFERENT clause lend alignment", () => {
    const ar = "mx.cloudflare.net; spf=pass header.d=acme.com; dkim=pass header.d=esp.net";
    expect(verifyFromAuthenticity("bob@acme.com", ar).authentic).toBe(false);
  });

  it("REJECTS a clause that repeats header.d (ambiguous)", () => {
    const ar = "mx.cloudflare.net; dkim=pass header.d=evil.com header.d=acme.com";
    expect(verifyFromAuthenticity("bob@acme.com", ar).authentic).toBe(false);
  });

  it("an explicit dmarc=fail for the From domain vetoes an aligned DKIM pass", () => {
    const ar = "mx.cloudflare.net; dkim=pass header.d=acme.com; dmarc=fail header.from=mail.acme.com";
    const r = verifyFromAuthenticity("bob@mail.acme.com", ar);
    expect(r).toEqual({ authentic: false, reason: "dmarc_fail:mail.acme.com" });
  });

  it("a DMARC clause about another domain refuses even with an aligned DKIM pass", () => {
    const ar = "mx.cloudflare.net; dkim=pass header.d=acme.com; dmarc=none header.from=evil.com";
    expect(verifyFromAuthenticity("bob@acme.com", ar).authentic).toBe(false);
  });

  it("text inside a comment or quoted string is never read as a verdict", () => {
    const comment = "mx.cloudflare.net; dkim=fail (dkim=pass header.d=acme.com) header.d=acme.com";
    expect(verifyFromAuthenticity("bob@acme.com", comment).authentic).toBe(false);
    const quoted =
      'mx.cloudflare.net; dkim=pass header.i="x header.d=acme.com; dmarc=pass header.from=acme.com" header.d=esp.net';
    expect(verifyFromAuthenticity("bob@acme.com", quoted).authentic).toBe(false);
  });

  it.each([
    ["unbalanced comment", "mx.cloudflare.net; dkim=pass (oops header.d=acme.com"],
    ["stray close paren", "mx.cloudflare.net; dkim=pass) header.d=acme.com"],
    ["unterminated quote", 'mx.cloudflare.net; dkim=pass header.d=acme.com header.b="abc'],
    ["two methods in one clause", "mx.cloudflare.net; dkim=fail header.d=esp.net dkim=pass header.d=acme.com"],
  ])("FAILS CLOSED on a malformed AR (%s)", (_l, ar) => {
    const r = verifyFromAuthenticity("bob@acme.com", ar);
    expect(r).toEqual({ authentic: false, reason: "malformed_auth_results" });
  });

  it("an AR with no result clauses (authserv-id only, or 'none') is not a pass", () => {
    expect(verifyFromAuthenticity("bob@acme.com", "mx.cloudflare.net").authentic).toBe(false);
    expect(verifyFromAuthenticity("bob@acme.com", "mx.cloudflare.net; none").authentic).toBe(false);
  });

  it("tolerates whitespace around '=' and a method version", () => {
    const r = verifyFromAuthenticity("bob@acme.com", "mx.cloudflare.net 1; dkim/1 = pass header.d = acme.com");
    expect(r.authentic).toBe(true);
  });
});
