
import { asTenantId } from "@/services/tenant-client";
import { liveBrandColors, loadCompanyBrand, liveCompanyBrandSources, pickLogoFile, type BrandColors, type CompanyBrand } from "@/services/sites/company-brand";
import { readEmailSettingText, readPostalAddress } from "@/services/comms/bulk-outbound/readiness";
import { checkEmailUrl, isHexColor, type EmailTemplate, type FontKey } from "./render";

export const DEFAULT_BRAND_COLOR = "#111827";
export const DEFAULT_FONT: FontKey = "system";

export type DraftTemplateDeps = {
  brand: (tenant_id: string) => Promise<CompanyBrand | null>;
  logoUrl: (tenant_id: string) => Promise<string | null>;
  postalAddress: (tenant_id: string) => Promise<string | null>;
  colors?: (tenant_id: string) => Promise<BrandColors | null>;
};

async function liveLogoUrl(tenant_id: string): Promise<string | null> {
  const { readIndex, publicUrl, workspaceFilesDeps } = await import("@/services/workspace-files/workspace-files");
  const deps = workspaceFilesDeps(asTenantId(tenant_id));
  const logo = pickLogoFile((await readIndex(deps)).files);
  return logo ? publicUrl(deps, logo) : null;
}

export async function liveDraftPostalAddress(tenant_id: string): Promise<string | null> {
  const saved = await readPostalAddress(tenant_id).catch(() => null);
  if (saved) return saved;
  return readEmailSettingText(tenant_id, "postal_address");
}

export const liveDraftTemplateDeps: DraftTemplateDeps = {
  brand: (tenant_id) => loadCompanyBrand(tenant_id, liveCompanyBrandSources),
  logoUrl: liveLogoUrl,
  postalAddress: liveDraftPostalAddress,
  colors: liveBrandColors,
};

function safeLogo(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return checkEmailUrl(raw, "logo", "image").toString();
  } catch {
    return null;
  }
}

export type EmailTemplateDraft = EmailTemplate & { company_name: string | null };

export async function draftTemplateFromBrand(
  tenant_id: string,
  deps: DraftTemplateDeps = liveDraftTemplateDeps,
): Promise<EmailTemplateDraft> {
  const [brand, logo, postal] = await Promise.all([
    deps.brand(tenant_id).catch(() => null),
    deps.logoUrl(tenant_id).catch(() => null),
    deps.postalAddress(tenant_id).catch(() => null),
  ]);
  const colors = brand?.colors ?? (deps.colors ? await deps.colors(tenant_id).catch(() => null) : null);
  const primary = isHexColor(colors?.primary) ? colors!.primary.toLowerCase() : DEFAULT_BRAND_COLOR;
  const accent = isHexColor(colors?.accent) ? colors!.accent!.toLowerCase() : primary;
  const name = brand?.name?.trim() || null;
  return {
    logo_url: safeLogo(logo),
    brand_color: primary,
    button_color: accent,
    font_key: DEFAULT_FONT,
    sign_off: name ? `Thanks,\nThe ${name} team` : "Thanks,\nThe team",
    postal_address: postal?.trim() ? postal.trim().slice(0, 500) : null,
    show_cards: false,
    company_name: name,
  };
}
