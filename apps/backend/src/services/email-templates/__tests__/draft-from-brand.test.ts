import { describe, it, expect } from "vitest";
import { draftTemplateFromBrand, DEFAULT_BRAND_COLOR, type DraftTemplateDeps } from "../draft-from-brand";
import { render } from "../render";

function deps(over: Partial<DraftTemplateDeps>): DraftTemplateDeps {
  return {
    brand: async () => null,
    logoUrl: async () => null,
    postalAddress: async () => null,
    ...over,
  };
}

describe("draftTemplateFromBrand", () => {
  it("drafts from a full brand (Brightloop)", async () => {
    const d = await draftTemplateFromBrand(
      "t-1",
      deps({
        brand: async () => ({ name: "Brightloop", colors: { primary: "#1A73E8", accent: "#ff6b35", background: null, text: null }, voice: null, logoSvg: null }),
        logoUrl: async () => "https://api.example.test/api/public/workspace-files/t-1/f-1/logo.png",
        postalAddress: async () => "12 Example Street",
      }),
    );
    expect(d).toMatchObject({
      logo_url: "https://api.example.test/api/public/workspace-files/t-1/f-1/logo.png",
      brand_color: "#1a73e8",
      button_color: "#ff6b35",
      font_key: "system",
      sign_off: "Thanks,\nThe Brightloop team",
      postal_address: "12 Example Street",
      show_cards: false,
      company_name: "Brightloop",
    });
    expect(() => render(d, { subject: "s", preview_text: "p", title: "t", paragraphs: ["x"], button: { label: "Go", url: "https://brightloop.test" } }, { route: "sendgrid", campaignSlug: "a", ownHost: "brightloop.test" })).not.toThrow();
  });

  it("falls back to neutral values for a workspace with no brand, logo, or postal address", async () => {
    const d = await draftTemplateFromBrand("t-2", deps({ brand: async () => { throw new Error("down"); } }));
    expect(d).toMatchObject({ logo_url: null, brand_color: DEFAULT_BRAND_COLOR, button_color: DEFAULT_BRAND_COLOR, postal_address: null, company_name: null, sign_off: "Thanks,\nThe team" });
  });

  it("drops a non-https logo and a bad color", async () => {
    const d = await draftTemplateFromBrand(
      "t-3",
      deps({
        brand: async () => ({ name: "Lakeside Studio", colors: { primary: "red;x" as string, accent: null, background: null, text: null }, voice: null, logoSvg: null }),
        logoUrl: async () => "http://insecure.test/logo.png",
      }),
    );
    expect(d.logo_url).toBeNull();
    expect(d.brand_color).toBe(DEFAULT_BRAND_COLOR);
  });

  it("uses the saved brand kit colours when Zavi knows no company name apart from the workspace label", async () => {
    const d = await draftTemplateFromBrand(
      "t-4",
      deps({
        brand: async () => null,
        colors: async (tenant) => (tenant === "t-4" ? { primary: "#CBD5E0", accent: "#233D63", background: "#ffffff", text: "#000000" } : null),
      }),
    );
    expect(d).toMatchObject({ brand_color: "#cbd5e0", button_color: "#233d63", company_name: null, sign_off: "Thanks,\nThe team" });
  });

  it("a known brand's own colours win over the kit read, and a failing kit read falls back to the neutral default", async () => {
    const kit = async () => ({ primary: "#000001", accent: null, background: null, text: null });
    const named = await draftTemplateFromBrand(
      "t-5",
      deps({ brand: async () => ({ name: "Brightloop", colors: { primary: "#1A73E8", accent: null, background: null, text: null }, voice: null, logoSvg: null }), colors: kit }),
    );
    expect(named).toMatchObject({ brand_color: "#1a73e8", button_color: "#1a73e8" });
    const down = await draftTemplateFromBrand("t-6", deps({ colors: async () => { throw new Error("db down"); } }));
    expect(down).toMatchObject({ brand_color: DEFAULT_BRAND_COLOR, button_color: DEFAULT_BRAND_COLOR });
  });
});
