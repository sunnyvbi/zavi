import { describe, it, expect, beforeEach } from "vitest";
import {
  seatLabelForToken,
  seatLabelForAuth,
  API_KEY_SEAT,
  NO_SEAT,
  _resetSeatSaltForTest,
} from "../seat-identity";

const ENV = { SEAT_LABEL_SALT: "test-salt" } as NodeJS.ProcessEnv;

describe("seatLabelForToken", () => {
  beforeEach(() => _resetSeatSaltForTest());

  it("is stable for the same token", () => {
    expect(seatLabelForToken("oat-abc", ENV)).toBe(seatLabelForToken("oat-abc", ENV));
  });

  it("differs across tokens", () => {
    expect(seatLabelForToken("oat-a", ENV)).not.toBe(seatLabelForToken("oat-b", ENV));
  });

  it("is independent of the token's position in the pool", () => {
    const pool = ["oat-a", "oat-b", "oat-c"];
    const before = pool.map((t) => seatLabelForToken(t, ENV));
    const afterRemoval = ["oat-a", "oat-c"].map((t) => seatLabelForToken(t, ENV));
    expect(afterRemoval).toEqual([before[0], before[2]]);
  });

  it("never contains the token", () => {
    const label = seatLabelForToken("oat-supersecret", ENV);
    expect(label).not.toContain("supersecret");
    expect(label).toMatch(/^seat_[0-9a-f]{12}$/);
  });

  it("a different salt yields a different label (not reversible by guessing)", () => {
    const a = seatLabelForToken("oat-x", { SEAT_LABEL_SALT: "s1" } as NodeJS.ProcessEnv);
    const b = seatLabelForToken("oat-x", { SEAT_LABEL_SALT: "s2" } as NodeJS.ProcessEnv);
    expect(a).not.toBe(b);
  });

  it("blank / absent token → NO_SEAT", () => {
    expect(seatLabelForToken(undefined, ENV)).toBe(NO_SEAT);
    expect(seatLabelForToken("   ", ENV)).toBe(NO_SEAT);
  });
});

describe("seatLabelForAuth", () => {
  beforeEach(() => _resetSeatSaltForTest());

  it("api_key mode → api_key label, regardless of any token present", () => {
    expect(seatLabelForAuth({ mode: "api_key", token: "oat-a", env: ENV })).toBe(API_KEY_SEAT);
  });

  it("none mode → none label", () => {
    expect(seatLabelForAuth({ mode: "none", env: ENV })).toBe(NO_SEAT);
  });

  it("oauth mode → the token's seat label", () => {
    expect(seatLabelForAuth({ mode: "oauth", token: "oat-a", env: ENV })).toBe(
      seatLabelForToken("oat-a", ENV),
    );
  });
});
