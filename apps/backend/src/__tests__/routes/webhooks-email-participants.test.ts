
import { describe, it, expect } from "vitest";
import { normalizeAddresses } from "@/routes/webhooks/email";

describe("normalizeAddresses — untrusted MIME participants", () => {
  it("keeps the other humans on the thread", () => {
    expect(normalizeAddresses(["jane@acme.com", "bob@acme.com"])).toEqual([
      "jane@acme.com",
      "bob@acme.com",
    ]);
  });

  it("lowercases and trims", () => {
    expect(normalizeAddresses(["  Jane@ACME.com  "])).toEqual(["jane@acme.com"]);
  });

  it("de-dupes (case-insensitively) so nobody is CC'd twice", () => {
    expect(normalizeAddresses(["jane@acme.com", "JANE@acme.com", "jane@acme.com"])).toEqual([
      "jane@acme.com",
    ]);
  });

  it("drops empty / null / undefined entries", () => {
    expect(
      normalizeAddresses(["", "  ", null as unknown as string, undefined as unknown as string]),
    ).toEqual([]);
    expect(normalizeAddresses(undefined)).toEqual([]);
  });

  it("rejects header-injection shapes rather than passing them through", () => {
    expect(
      normalizeAddresses([
        "Jane Doe <jane@acme.com>",
        "jane@acme.com, attacker@evil.com",
        "jane@acme.com;attacker@evil.com",
        'jane"@acme.com',
        "jane@acme.com\nbcc: attacker@evil.com",
      ]),
    ).toEqual([]);
  });

  it("rejects malformed addresses (no @, multiple @)", () => {
    expect(normalizeAddresses(["notanemail", "a@b@c.com"])).toEqual([]);
  });

  it("caps the participant list", () => {
    const many = Array.from({ length: 500 }, (_, i) => `user${i}@acme.com`);
    expect(normalizeAddresses(many).length).toBe(50);
  });
});
