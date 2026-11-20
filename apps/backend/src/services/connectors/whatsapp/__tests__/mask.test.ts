import { describe, it, expect } from "vitest";
import { HANDSET_NAME_MAX, handsetDisplayName, maskWaId } from "../mask";

describe("maskWaId", () => {
  it("splits the +1 NANP shape so a US operator recognises their own phone", () => {
    expect(maskWaId("16692256032")).toBe("+1 ••• ••• 6032");
  });

  it("never guesses a country code for other shapes", () => {
    expect(maskWaId("919876543210")).toBe("••• 3210");
    expect(maskWaId("447700900123")).toBe("••• 0123");
  });

  it("keeps at most the last four digits, whatever the input", () => {
    for (const n of ["16692256032", "919876543210", "5511987654321"]) {
      const out = maskWaId(n);
      const shown = out.replace(/\D/g, "");
      const subscriber = out.startsWith("+1") ? shown.slice(1) : shown;
      expect(subscriber).toHaveLength(4);
      expect(n.endsWith(subscriber)).toBe(true);
    }
  });

  it("refuses to leak a short or junk value", () => {
    expect(maskWaId("123")).toBe("•••");
    expect(maskWaId("")).toBe("•••");
    expect(maskWaId(undefined as unknown as string)).toBe("•••");
  });

  it("tolerates formatting characters on the way in", () => {
    expect(maskWaId("+1 (669) 225-6032")).toBe("+1 ••• ••• 6032");
  });
});

describe("handsetDisplayName", () => {
  const RLO = String.fromCharCode(0x202e);
  const ZWSP = String.fromCharCode(0x200b);
  const NUL = String.fromCharCode(0);

  it("passes an ordinary profile name through, trimmed", () => {
    expect(handsetDisplayName("  Aryaan ")).toBe("Aryaan");
    expect(handsetDisplayName("Ravi R")).toBe("Ravi R");
  });

  it("collapses runs of whitespace so a padded name lines up in the tile", () => {
    expect(handsetDisplayName("Ravi \t\n  R")).toBe("Ravi R");
  });

  it("drops bidi overrides and zero-width characters — a name must not be able to visually reverse the number beside it", () => {
    expect(handsetDisplayName(`Ravi${RLO}${ZWSP} R`)).toBe("Ravi R");
    expect(handsetDisplayName(`${NUL}Ravi`)).toBe("Ravi");
  });

  it("caps a runaway name with an ellipsis", () => {
    const long = "A".repeat(HANDSET_NAME_MAX + 20);
    const out = handsetDisplayName(long)!;
    expect(out.length).toBe(HANDSET_NAME_MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  it("keeps a name exactly at the cap untouched", () => {
    const exact = "B".repeat(HANDSET_NAME_MAX);
    expect(handsetDisplayName(exact)).toBe(exact);
  });

  it("returns null for an empty, invisible-only or non-string name so the caller falls back to the number", () => {
    expect(handsetDisplayName("")).toBeNull();
    expect(handsetDisplayName("   ")).toBeNull();
    expect(handsetDisplayName(`${RLO}${ZWSP}`)).toBeNull();
    expect(handsetDisplayName(null)).toBeNull();
    expect(handsetDisplayName(undefined)).toBeNull();
    expect(handsetDisplayName(42)).toBeNull();
  });
});
