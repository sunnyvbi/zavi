import { describe, it, expect } from "vitest";
import { handsetLabel, handsetsLabel, type PhoneHandset } from "./usePhoneHandsets";

const aryaan: PhoneHandset = { id: "th-1", name: "Aryaan", number: "+1 ••• ••• 6032" };
const ravi: PhoneHandset = { id: "th-2", name: "Ravi", number: "+1 ••• ••• 7710" };
const unnamed: PhoneHandset = { id: "th-3", name: null, number: "••• 3210" };

describe("handsetLabel", () => {
  it("prefers the phone's WhatsApp profile name", () => {
    expect(handsetLabel(aryaan)).toBe("Aryaan");
  });

  it("falls back to the masked number when the phone had no name", () => {
    expect(handsetLabel(unnamed)).toBe("••• 3210");
  });
});

describe("handsetsLabel", () => {
  it("gives a single handset the whole line", () => {
    expect(handsetsLabel([aryaan])).toBe("Aryaan");
  });

  it("shows two side by side, by name — the case that made numbers useless", () => {
    expect(handsetsLabel([aryaan, ravi])).toBe("Aryaan · Ravi");
  });

  it("mixes names and masked numbers when only some phones carry a name", () => {
    expect(handsetsLabel([aryaan, unnamed])).toBe("Aryaan · ••• 3210");
  });

  it("counts past two rather than wrapping the tile", () => {
    expect(handsetsLabel([aryaan, ravi, unnamed])).toBe("Aryaan +2 more");
  });

  it("returns nothing for a member (server sends an empty list), so the tile keeps its Connected fallback", () => {
    expect(handsetsLabel([])).toBe("");
  });
});
