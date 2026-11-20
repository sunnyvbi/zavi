import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));

import { pauserNames, UNKNOWN_PAUSER } from "../custom-agent-pausers";

const T = "11111111-1111-4111-8111-111111111111";

describe("pauserNames", () => {
  it("a member gets the email local part only, never the address", async () => {
    const names = await pauserNames(T, ["u1"], {
      isMember: async () => true,
      emailOf: async () => "priya@acme.com",
    });
    expect(names.get("u1")).toBe("priya");
  });

  it("a non-member is 'a teammate' and their email is never looked up", async () => {
    const emailOf = vi.fn(async () => "x@other.com");
    const names = await pauserNames(T, ["u2"], { isMember: async () => false, emailOf });
    expect(names.get("u2")).toBe(UNKNOWN_PAUSER);
    expect(emailOf).not.toHaveBeenCalled();
  });

  it("a lookup error or a missing email falls back to 'a teammate'", async () => {
    const names = await pauserNames(T, ["u3", "u4"], {
      isMember: async (_t, u) => {
        if (u === "u3") throw new Error("db down");
        return true;
      },
      emailOf: async () => null,
    });
    expect(names.get("u3")).toBe(UNKNOWN_PAUSER);
    expect(names.get("u4")).toBe(UNKNOWN_PAUSER);
  });

  it("dedupes ids and skips null/empty", async () => {
    const isMember = vi.fn(async () => true);
    const names = await pauserNames(T, ["u5", "u5", null, undefined, ""], { isMember, emailOf: async () => "a@b.c" });
    expect(isMember).toHaveBeenCalledTimes(1);
    expect([...names.keys()]).toEqual(["u5"]);
  });
});
