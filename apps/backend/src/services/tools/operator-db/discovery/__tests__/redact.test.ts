import { describe, it, expect } from "vitest";
import { redactValue, redactRow, redactDocDeep, redactDeep } from "../redact";

describe("redactValue — column-name denylist (value never emitted regardless of content)", () => {
  for (const col of [
    "password",
    "password_hash",
    "secret",
    "api_secret",
    "token",
    "refresh_token",
    "ssn",
    "social_security_number",
    "dob",
    "date_of_birth",
    "card",
    "card_number",
    "cvv",
    "bank",
    "bank_account",
    "routing",
    "routing_number",
  ]) {
    it(`redacts column "${col}" even with innocuous value`, () => {
      expect(redactValue(col, "hello")).toBe("‹redacted›");
    });
  }

  it("is case-insensitive on column name", () => {
    expect(redactValue("PassWord", "x")).toBe("‹redacted›");
  });

  for (const col of [
    "email",
    "user_email",
    "phone",
    "mobile",
    "address",
    "street",
    "zip",
    "postal_code",
    "first_name",
    "last_name",
    "full_name",
    "surname",
    "name",
    "contact",
    "latitude",
    "longitude",
  ]) {
    it(`redacts direct-PII column "${col}" by name`, () => {
      expect(redactValue(col, "Smith")).toBe("‹redacted›");
    });
  }
});

describe("redactValue — value patterns", () => {
  it("redacts emails (value pattern, neutral column)", () => {
    expect(redactValue("freeform", "jane.doe+x@example.co.uk")).toBe("‹redacted:email›");
  });
  it("does not overmatch email through punctuation", () => {
    expect(redactValue("note", "mail jane@example.com, city Austin")).toBe(
      "mail ‹redacted:email›, city Austin",
    );
  });
  it("redacts US/E.164 phones (value pattern, neutral column)", () => {
    expect(redactValue("freeform", "+1 (415) 555-0199")).toBe("‹redacted:phone›");
    expect(redactValue("notes", "call 4155550199")).toContain("‹redacted:phone›");
  });
  it("redacts SSN", () => {
    expect(redactValue("misc", "123-45-6789")).toBe("‹redacted:ssn›");
  });
  it("redacts 13-16 digit card-like numbers", () => {
    expect(redactValue("ref", "4242424242424242")).toBe("‹redacted:card›");
    expect(redactValue("ref", "4242 4242 4242 4242")).toBe("‹redacted:card›");
  });
  it("redacts JWT / sk- / token-ish secrets", () => {
    expect(redactValue("blob", "sk-abcdEFGH1234ijklMNOP5678qrst")).toBe("‹redacted:secret›");
    expect(
      redactValue("blob", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF_-123"),
    ).toBe("‹redacted:secret›");
  });
});

describe("redactValue — non-PII passes through untouched", () => {
  for (const [col, val] of [
    ["city", "San Francisco"],
    ["category", "sedan"],
    ["status", "active"],
    ["count", 42],
    ["created_at", "2026-05-16T00:00:00Z"],
    ["is_active", true],
    ["price_cents", 1999],
  ] as const) {
    it(`passes ${col}=${String(val)}`, () => {
      expect(redactValue(col, val)).toBe(val);
    });
  }

  it("passes null/undefined", () => {
    expect(redactValue("anything", null)).toBe(null);
    expect(redactValue("anything", undefined)).toBe(undefined);
  });
});

describe("redactRow", () => {
  it("redacts by key and by value across a row", () => {
    const row = redactRow({
      id: "u_1",
      email: "a@b.com",
      status: "banned",
      password_hash: "$2b$...",
      city: "Austin",
    });
    expect(row).toEqual({
      id: "u_1",
      email: "‹redacted›",
      status: "banned",
      password_hash: "‹redacted›",
      city: "Austin",
    });
  });
});

describe("redactDocDeep — recursive path-aware redaction (generic Mongo read)", () => {
  it("redacts a PII field nested inside an embedded (neutral-named) object", () => {
    const out = redactDocDeep({
      id: "u_1",
      status: "active",
      profile: { email: "a@b.com", city: "Austin" },
    });
    expect(out).toEqual({
      id: "u_1",
      status: "active",
      profile: { email: "‹redacted›", city: "Austin" },
    });
  });

  it("collapses a PII-NAMED container to a single redaction marker (safe short-circuit)", () => {
    const out = redactDocDeep({
      id: "u_1",
      contact: { email: "a@b.com", city: "Austin" },
    });
    expect(out).toEqual({ id: "u_1", contact: "‹redacted›" });
  });

  it("redacts a PII field deep inside an array of sub-documents", () => {
    const out = redactDocDeep({
      id: "u_1",
      payments: [
        { amount: 100, card_number: "4242424242424242" },
        { amount: 200, card_number: "4111111111111111" },
      ],
    });
    expect(out).toEqual({
      id: "u_1",
      payments: [
        { amount: 100, card_number: "‹redacted›" },
        { amount: 200, card_number: "‹redacted›" },
      ],
    });
  });

  it("redacts a value-pattern PII leaf at depth (neutral field name)", () => {
    const out = redactDocDeep({
      profile: { bio: "reach me at jane@example.com please" },
    });
    expect((out.profile as { bio: string }).bio).toContain("‹redacted:email›");
  });

  it("collapses a PII-named array (field name signals PII → whole subtree suppressed)", () => {
    const out = redactDocDeep({ emails: ["a@b.com", "c@d.com"] });
    expect(out.emails).toBe("‹redacted›");
  });

  it("redacts PII leaves inside a NEUTRAL-named array of value-pattern PII", () => {
    const out = redactDocDeep({ notes: ["ping a@b.com", "all good"] });
    expect(out.notes).toEqual(["ping ‹redacted:email›", "all good"]);
  });

  it("leaves non-PII nested data untouched", () => {
    const doc = {
      id: "u_1",
      meta: { tags: ["a", "b"], counts: { views: 12, clicks: 3 } },
    };
    expect(redactDocDeep(doc)).toEqual(doc);
  });

  it("does not descend into Date / opaque objects (left as-is)", () => {
    const d = new Date("2026-05-16T00:00:00Z");
    const out = redactDocDeep({ created_at: d });
    expect(out.created_at).toBe(d);
  });

  it("redactDeep handles a top-level array", () => {
    const out = redactDeep([{ email: "a@b.com" }, { status: "ok" }]);
    expect(out).toEqual([{ email: "‹redacted›" }, { status: "ok" }]);
  });
});
