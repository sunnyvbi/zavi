
import { describe, it, expect } from "vitest";
import { matchesAllowlist, type AllowlistEntry } from "../allowlist";

function mayDealWithAgent(
  email: string,
  opts: { disabled: Set<string>; members: Set<string>; entries: AllowlistEntry[] },
): boolean {
  const a = email.trim().toLowerCase();
  if (opts.disabled.has(a)) return false;
  return opts.members.has(a) || matchesAllowlist(a, opts.entries);
}

const BOB = "bob@acme.com";
const domainAllow: AllowlistEntry[] = [{ kind: "domain", value: "acme.com" }];

describe("disabled member vs allowlisted domain — deny wins", () => {
  it("a disabled member at an ALLOWLISTED domain is still refused", () => {
    expect(
      mayDealWithAgent(BOB, {
        disabled: new Set([BOB]),
        members: new Set([BOB]),
        entries: domainAllow,
      }),
    ).toBe(false);
  });

  it("a disabled member with their exact address ALSO allowlisted is still refused", () => {
    expect(
      mayDealWithAgent(BOB, {
        disabled: new Set([BOB]),
        members: new Set([BOB]),
        entries: [{ kind: "address", value: BOB }],
      }),
    ).toBe(false);
  });

  it("their disabled colleague does not disable the rest of the domain", () => {
    expect(
      mayDealWithAgent("carol@acme.com", {
        disabled: new Set([BOB]),
        members: new Set([BOB]),
        entries: domainAllow,
      }),
    ).toBe(true);
  });

  it("a disabled NON-member (belt + braces) is refused", () => {
    expect(
      mayDealWithAgent(BOB, {
        disabled: new Set([BOB]),
        members: new Set(),
        entries: domainAllow,
      }),
    ).toBe(false);
  });
});

describe("the toggle actually toggles", () => {
  const base = { members: new Set([BOB]), entries: [] as AllowlistEntry[] };

  it("ON (absent from the disabled set) = allowed", () => {
    expect(mayDealWithAgent(BOB, { ...base, disabled: new Set() })).toBe(true);
  });

  it("OFF = refused", () => {
    expect(mayDealWithAgent(BOB, { ...base, disabled: new Set([BOB]) })).toBe(false);
  });

  it("back ON = allowed again (no tombstone)", () => {
    const disabled = new Set([BOB]);
    disabled.delete(BOB);
    expect(mayDealWithAgent(BOB, { ...base, disabled })).toBe(true);
  });
});

describe("absence = ON, so nothing needs a backfill", () => {
  it("an empty disabled set leaves every member enabled", () => {
    const members = new Set(["a@x.com", "b@x.com", "c@x.com"]);
    for (const m of members) {
      expect(mayDealWithAgent(m, { disabled: new Set(), members, entries: [] })).toBe(true);
    }
  });

  it("a brand-new member is enabled with no row written", () => {
    const members = new Set(["existing@x.com"]);
    members.add("newhire@x.com");
    expect(
      mayDealWithAgent("newhire@x.com", { disabled: new Set(["someone-else@x.com"]), members, entries: [] }),
    ).toBe(true);
  });
});

describe("the empty-everything default is unchanged (members-only)", () => {
  it("no disabled, no allowlist => members in, strangers out", () => {
    const members = new Set([BOB]);
    expect(mayDealWithAgent(BOB, { disabled: new Set(), members, entries: [] })).toBe(true);
    expect(mayDealWithAgent("stranger@evil.com", { disabled: new Set(), members, entries: [] })).toBe(
      false,
    );
  });
});

describe("case + trailing-dot normalization cannot smuggle a disabled member back in", () => {
  it("uppercase does not evade the deny", () => {
    expect(
      mayDealWithAgent("BOB@ACME.COM", {
        disabled: new Set([BOB]),
        members: new Set([BOB]),
        entries: domainAllow,
      }),
    ).toBe(false);
  });
});
