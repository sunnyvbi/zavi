import { describe, expect, it } from "vitest";
import { normalizeTiktokAudience, TIKTOK_AGE_GROUPS, tiktokAgeGroupsSchema, tiktokAudienceMatches, tiktokGenderSchema } from "../targeting";

describe("the approved TikTok audience", () => {
  it("old cards and empty selections explicitly target adults, every gender and every language", () => {
    const broad = { age_groups: [...TIKTOK_AGE_GROUPS], gender: "GENDER_UNLIMITED", languages: [] };
    expect(normalizeTiktokAudience({})).toEqual(broad);
    expect(normalizeTiktokAudience({ age_groups: [], languages: [] })).toEqual(broad);
    expect(tiktokAgeGroupsSchema.safeParse(["AGE_13_17"]).success).toBe(false);
    expect(tiktokGenderSchema.safeParse("guess").success).toBe(false);
  });

  it("set order and duplicates do not change the audience", () => {
    const approved = { age_groups: ["AGE_25_34", "AGE_18_24"] as const, gender: "GENDER_FEMALE" as const, languages: ["en", "es"] };
    expect(tiktokAudienceMatches({ age_groups: ["AGE_18_24", "AGE_25_34", "AGE_25_34"], gender: "GENDER_FEMALE", languages: ["es", "en"] }, { ...approved, age_groups: [...approved.age_groups] })).toBe(true);
  });

  it("does not mistake unrestricted ages, a changed gender or a dropped language for approval", () => {
    const broad = normalizeTiktokAudience({});
    expect(tiktokAudienceMatches({ ...broad, age_groups: [] }, {})).toBe(false);
    expect(tiktokAudienceMatches({ ...broad, age_groups: undefined }, {})).toBe(false);
    expect(tiktokAudienceMatches({ ...broad, age_groups: [...broad.age_groups, "AGE_13_17"] }, {})).toBe(false);
    expect(tiktokAudienceMatches({ ...broad, gender: "GENDER_MALE" }, {})).toBe(false);
    expect(tiktokAudienceMatches(broad, { languages: ["en"] })).toBe(false);
    expect(tiktokAudienceMatches({ ...broad, languages: "en" }, {})).toBe(false);
    expect(tiktokAudienceMatches({ ...broad, languages: null }, {})).toBe(false);
    expect(tiktokAudienceMatches({ ...broad, gender: undefined }, {})).toBe(false);
  });
});
