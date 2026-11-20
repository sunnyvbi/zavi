import { describe, it, expect } from "vitest";
import { adChangeCleanObjectLabel, cleanAdName } from "./ad-change-headline";

describe("cleanAdName", () => {
  it("drops the Zavi prefix and the internal id from the live names", () => {
    expect(cleanAdName("Zavi · Host Recommended Areas (copy) · zvf101c3e846")).toBe("Host Recommended Areas (copy)");
    expect(cleanAdName("Zavi · Regular Leads - Ad set (copy) · zv5dea8ca411")).toBe("Regular Leads - Ad set (copy)");
    expect(cleanAdName("Zavi · Spring launch · campaign · zv0123456789")).toBe("Spring launch");
  });
  it("leaves a founder's own name alone", () => {
    expect(cleanAdName("Regular Leads - Ad set")).toBe("Regular Leads - Ad set");
    expect(cleanAdName("Zavier · Search")).toBe("Zavier · Search");
  });
  it("the label quotes the clean platform name", () => {
    expect(adChangeCleanObjectLabel("meta_ads.set_status_review", { object_id: "1", level: "adset", verified_name: "Zavi · X · zvabcdef1234" })).toBe("“X”");
  });
});
