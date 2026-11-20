import { beforeEach, describe, expect, it, vi } from "vitest";

const readiness = vi.hoisted(() => ({
  readPostalAddress: vi.fn<[string], Promise<string | null>>(),
  readEmailSettingText: vi.fn<[string, string], Promise<string | null>>(),
}));
vi.mock("@/services/comms/bulk-outbound/readiness", () => readiness);

import { draftTemplateFromBrand, liveDraftTemplateDeps } from "../draft-from-brand";
import { emailTemplateSchema } from "../store";

const brightloop = {
  name: "Brightloop",
  colors: { primary: "#1A73E8", accent: "#ff6b35", background: null, text: null },
  voice: null,
  logoSvg: null,
};

const deps = {
  ...liveDraftTemplateDeps,
  brand: async () => brightloop,
  logoUrl: async () => "https://api.example.test/api/public/workspace-files/t-1/f-1/logo.png",
};

describe("the first brand draft keeps the postal address from the old Email campaigns setting", () => {
  beforeEach(() => {
    readiness.readPostalAddress.mockReset();
    readiness.readEmailSettingText.mockReset();
  });

  it("a workspace with only the setting gets a branded draft the store accepts, carrying that address", async () => {
    readiness.readPostalAddress.mockResolvedValue(null);
    readiness.readEmailSettingText.mockResolvedValue("1 Main St, Austin TX");
    const { company_name, ...draft } = await draftTemplateFromBrand("t-1", deps);
    expect(readiness.readEmailSettingText).toHaveBeenCalledWith("t-1", "postal_address");
    expect(draft).toMatchObject({ brand_color: "#1a73e8", button_color: "#ff6b35", postal_address: "1 Main St, Austin TX" });
    expect(company_name).toBe("Brightloop");
    expect(emailTemplateSchema.safeParse(draft).success).toBe(true);
  });

  it("an address already saved on the template wins over the setting", async () => {
    readiness.readPostalAddress.mockResolvedValue("100 Founder Ave");
    readiness.readEmailSettingText.mockResolvedValue("Old setting address");
    const draft = await draftTemplateFromBrand("t-1", deps);
    expect(draft.postal_address).toBe("100 Founder Ave");
    expect(readiness.readEmailSettingText).not.toHaveBeenCalled();
  });

  it("a template read that fails still falls back to the setting", async () => {
    readiness.readPostalAddress.mockRejectedValue(new Error("db down"));
    readiness.readEmailSettingText.mockResolvedValue("9 Elm Rd");
    expect((await draftTemplateFromBrand("t-1", deps)).postal_address).toBe("9 Elm Rd");
  });

  it("with neither, the draft has no address and the store refuses it", async () => {
    readiness.readPostalAddress.mockResolvedValue(null);
    readiness.readEmailSettingText.mockResolvedValue(null);
    const { company_name: _n, ...draft } = await draftTemplateFromBrand("t-1", deps);
    expect(draft.postal_address).toBeNull();
    expect(emailTemplateSchema.safeParse(draft).success).toBe(false);
  });
});
