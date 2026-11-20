import { describe, expect, it } from "vitest";
import { clean } from "../cardCopy";

describe("card copy keeps sentences whole when it hides raw ids", () => {
  it("drops an id inside a sentence", () => {
    expect(clean("Raise the ad set 120210000000000123 to $40.")).toBe("Raise the ad set to $40.");
  });

  it("keeps an id that is the subject of a sentence", () => {
    expect(clean('Three pixels are connected. 2019928222287599 is named "1390715445472794".')).toBe(
      'Three pixels are connected. 2019928222287599 is named "1390715445472794".',
    );
  });
});
