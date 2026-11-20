import { describe, it, expect } from "vitest";
import { durationForScript } from "../generate-video";

describe("durationForScript", () => {
  it("no script → a short generic talking length (8s), never the old 15s", () => {
    expect(durationForScript()).toBe(8);
    expect(durationForScript("")).toBe(8);
    expect(durationForScript("   ")).toBe(8);
  });

  it("a short line gets a short clip (the exact bug that broke audio)", () => {
    const d = durationForScript(
      "Renting a car should be as easy as booking a room. That's why we built Upcar.",
    );
    expect(d).toBe(8);
    expect(d).toBeLessThan(15);
  });

  it("clamps a long script to the 15s ceiling", () => {
    const long = Array.from({ length: 80 }, () => "word").join(" ");
    expect(durationForScript(long)).toBe(15);
  });

  it("clamps a one-word script to the 4s floor", () => {
    expect(durationForScript("Hi")).toBe(4);
  });

  it("scales monotonically with length", () => {
    const short = durationForScript("just a few words here now");
    const mid = durationForScript(
      "this is a noticeably longer scripted line that a founder might actually say on camera to the audience",
    );
    expect(mid).toBeGreaterThan(short);
  });
});
