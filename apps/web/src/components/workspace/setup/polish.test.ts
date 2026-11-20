import { describe, it, expect } from "vitest";
import { displayedFacts, kitToSlots, slotsToBody, addColour, removeColour, formFromFacts, type CompanyForm } from "./polish";

const before: CompanyForm = { company_name: "Apna", domain: "https://apna.com", what_we_sell: "Tutoring", competitors: ["Preply"] };

describe("displayedFacts (spec Q14: every displayed field becomes the founder's own)", () => {
  it("sends every non-empty displayed field, changed or not, competitors as one list", () => {
    expect(displayedFacts({ ...before, what_we_sell: "1:1 tutoring", competitors: ["Preply", "Varsity"] })).toEqual([
      { key: "company_name", value: "Apna" },
      { key: "domain", value: "https://apna.com" },
      { key: "what_we_sell", value: "1:1 tutoring" },
      { key: "competitors", value: "Preply, Varsity" },
    ]);
  });
  it("never sends an empty field (that would clear a fact the page did not show)", () => {
    expect(displayedFacts({ company_name: "Apna", domain: "", what_we_sell: " ", competitors: [] })).toEqual([
      { key: "company_name", value: "Apna" },
    ]);
  });
  it("a field the founder emptied on purpose IS sent, as a clear", () => {
    expect(displayedFacts({ ...before, what_we_sell: "" }, before)).toContainEqual({ key: "what_we_sell", value: "" });
  });
});

describe("formFromFacts", () => {
  it("reads the four keys, competitors split on commas", () => {
    expect(
      formFromFacts([
        { key: "company_name", value_text: " Apna " },
        { key: "competitors", value_text: "Preply, Varsity ,," },
        { key: "domain", value_text: null },
      ]),
    ).toEqual({ company_name: "Apna", domain: "", what_we_sell: "", competitors: ["Preply", "Varsity"] });
  });
});

describe("brand colours (the kit has four fixed slots)", () => {
  const kit = { primary: "#027bff", accent: "#0e0f11", bg: null, text: null };
  it("add fills the next empty slot, at most four", () => {
    const slots = addColour(kitToSlots(kit), "#46658a");
    expect(slotsToBody(slots)).toEqual({ primary: "#027bff", accent: "#0e0f11", bg: "#46658a", text: null });
    expect(addColour(addColour(slots, "#111111"), "#222222")).toEqual(addColour(slots, "#111111"));
  });
  it("remove clears a slot; Main can go while another colour remains", () => {
    expect(slotsToBody(removeColour(kitToSlots(kit), "accent")).accent).toBeNull();
    const moved = removeColour(kitToSlots(kit), "primary");
    expect(moved.primary).toBe(kit.accent);
    expect(moved.accent).toBeNull();
    const only = { primary: "#111111", accent: null, bg: null, text: null };
    expect(removeColour(only, "primary")).toEqual(only);
  });
});
