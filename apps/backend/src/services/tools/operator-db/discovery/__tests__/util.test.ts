import { describe, it, expect } from "vitest";
import { isSafeName, prioritizeAndCap } from "../util";

describe("isSafeName", () => {
  it("accepts snake_case identifiers", () => {
    expect(isSafeName("users")).toBe(true);
    expect(isSafeName("_internal")).toBe(true);
    expect(isSafeName("Booking_2024")).toBe(true);
  });
  it("rejects exotic / unsafe names", () => {
    for (const n of ["weird name", 'a"b', "a;b", "1tbl", "public.users", "tbl-x", ""]) {
      expect(isSafeName(n)).toBe(false);
    }
  });
});

describe("prioritizeAndCap", () => {
  it("is deterministic and puts likely entities first", () => {
    const input = ["zebra_logs", "users", "audit_2024", "listings", "bookings", "alpha"];
    const out = prioritizeAndCap(input, 10);
    expect(out.indexOf("users")).toBeLessThan(out.indexOf("alpha"));
    expect(out.indexOf("listings")).toBeLessThan(out.indexOf("zebra_logs"));
    expect(out.indexOf("bookings")).toBeLessThan(out.indexOf("audit_2024"));
    expect(prioritizeAndCap(input, 10)).toEqual(out);
  });

  it("filters unsafe names before capping", () => {
    const out = prioritizeAndCap(["users", "bad name", 'x"y', "orders"], 10);
    expect(out).toEqual(["users", "orders"]);
  });

  it("caps to N (priority entities survive the cap)", () => {
    const filler = Array.from({ length: 60 }, (_, i) => `zzz_tbl_${String(i).padStart(2, "0")}`);
    const out = prioritizeAndCap(["users", "bookings", ...filler], 3);
    expect(out.length).toBe(3);
    expect(out).toContain("users");
    expect(out).toContain("bookings");
  });

  it("orders priority entities by PRIORITY rank then alpha within rank", () => {
    const out = prioritizeAndCap(["reviews", "users", "messages", "listings"], 10);
    expect(out[0]).toBe("users");
  });
});
