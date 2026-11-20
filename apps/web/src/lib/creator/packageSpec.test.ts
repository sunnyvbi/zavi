import { describe, it, expect } from "vitest";
import { checkCreatorPackage } from "@zavi/shared";
import { defaultPackage, packageTerms, specFromSaved, toPackagePayload, type SavedPackage } from "./packageSpec";

describe("package form -> backend template (D4)", () => {
  it("the form builds a ugc_video package the shared checker accepts", () => {
    const payload = toPackagePayload({ ...defaultPackage(), qty: 2, price: "150" });
    const check = checkCreatorPackage(payload);
    expect(check.ok, JSON.stringify(check)).toBe(true);
    expect(payload.kind).toBe("ugc_video");
  });

  it("never sends an audience-post field", () => {
    const payload = toPackagePayload({ ...defaultPackage(), qty: 3, price: "150" });
    for (const k of ["platform", "post_type", "stays_up_days", "post_count", "ad_label_required"]) {
      expect(payload).not.toHaveProperty(k);
    }
  });

  it("the shared checker refuses an audience post", () => {
    const check = checkCreatorPackage({ ...toPackagePayload({ ...defaultPackage(), price: "150" }), kind: "audience_post" });
    expect(check.ok).toBe(false);
  });

  it("UGC carries count, length and ad rights", () => {
    expect(toPackagePayload({ ...defaultPackage(), qty: 3, lengthSec: 15, adRights: "1 year", price: "400" })).toMatchObject({
      kind: "ugc_video",
      video_count: 3,
      video_length_seconds: 15,
      ad_rights_days: 365,
      price_cents: 40000,
      title: "3 UGC videos, 15s",
    });
  });

  it("a saved package reads back to the same terms", () => {
    const spec = { ...defaultPackage(), qty: 2, adRights: "30 days" as const, price: "60" };
    const saved = { id: "p", active: true, description: null, ...toPackagePayload(spec) } as unknown as SavedPackage;
    expect(packageTerms(specFromSaved(saved))).toBe(packageTerms(spec));
  });
});
