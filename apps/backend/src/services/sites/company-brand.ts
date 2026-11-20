import sharp from "sharp";
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";
import { BRIEF_COLOR_TOKENS, contrast, repairBriefContrast, type BriefColorToken, type DesignBrief } from "./design-brief";
import { SITE_LOGO_URL } from "./site-head";

export const BRAND_LOAD_TIMEOUT_MS = 4_000;
const LOGO_MAX_SIDE = 256;
const LOGO_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const LOGO_MAX_SVG_BYTES = 200 * 1024;
const VOICE_MAX = 300;
const NAME_MAX = 80;
const HEX = /^#[0-9a-f]{6}$/i;

export type BrandColors = { primary: string; accent: string | null; background: string | null; text: string | null };

export type CompanyBrand = {
  name: string;
  colors: BrandColors | null;
  voice: string | null;
  logoSvg: string | null;
};

export type CompanyBrandSources = {
  name: (tenant_id: string) => Promise<{ name: string | null; nameIsWorkspaceLabel: boolean }>;
  colors: (tenant_id: string) => Promise<BrandColors | null>;
  voice: (tenant_id: string) => Promise<string | null>;
  logo: (tenant_id: string) => Promise<Uint8Array | null>;
};

function oneLine(raw: unknown, max: number): string {
  return typeof raw === "string" ? decodeXmlEntities(raw).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim() : "";
}

function hex(raw: unknown): string | null {
  return typeof raw === "string" && HEX.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}

const SUFFIX = /\b(inc|llc|ltd|limited|co|corp|corporation|company|gmbh|plc|pvt|private)\b/g;

export function brandNameKey(raw: string | null | undefined): string {
  return decodeXmlEntities(String(raw ?? ""))
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(SUFFIX, " ")
    .replace(/\s+/g, "");
}

export function brandAppliesToSite(brand: Pick<CompanyBrand, "name"> | null, siteName: string | null | undefined): boolean {
  if (!brand) return false;
  const company = brandNameKey(brand.name);
  return company.length > 0 && company === brandNameKey(siteName);
}

async function settle<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.catch(() => null), new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function logoSvgFrom(bytes: Uint8Array | null): Promise<string | null> {
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > LOGO_MAX_INPUT_BYTES) return null;
  try {
    const { data, info } = await sharp(bytes)
      .rotate()
      .resize({ width: LOGO_MAX_SIDE, height: LOGO_MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (!(info.width > 0 && info.height > 0)) return null;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${info.width} ${info.height}" width="${info.width}" height="${info.height}"><image width="${info.width}" height="${info.height}" href="data:image/png;base64,${Buffer.from(data).toString("base64")}"/></svg>`;
    return Buffer.byteLength(svg) <= LOGO_MAX_SVG_BYTES ? svg : null;
  } catch {
    return null;
  }
}

export async function loadCompanyBrand(
  tenant_id: string,
  sources: CompanyBrandSources,
  timeoutMs: number = BRAND_LOAD_TIMEOUT_MS,
): Promise<CompanyBrand | null> {
  const [named, colors, voice, logo] = await Promise.all([
    settle(sources.name(tenant_id), timeoutMs),
    settle(sources.colors(tenant_id), timeoutMs),
    settle(sources.voice(tenant_id), timeoutMs),
    settle(sources.logo(tenant_id).then(logoSvgFrom), timeoutMs),
  ]);
  const name = oneLine(named?.name, NAME_MAX);
  if (!name || named?.nameIsWorkspaceLabel) return null;
  const primary = hex(colors?.primary);
  return {
    name,
    colors: primary ? { primary, accent: hex(colors?.accent), background: hex(colors?.background), text: hex(colors?.text) } : null,
    voice: oneLine(voice, VOICE_MAX) || null,
    logoSvg: logo ?? null,
  };
}

const COLOUR_WORDS =
  /#[0-9a-f]{3}(?:[0-9a-f]{3})?\b|\b(colou?rs?|palette|red|orange|yellow|green|blue|navy|teal|purple|violet|pink|black|white|gold|silver|brown|beige|grey|gray|olive|sage|coral|cream|maroon|turquoise)\b/i;

export function ideaNamesColours(idea: string): boolean {
  return COLOUR_WORDS.test(decodeXmlEntities(String(idea ?? "")));
}

const INK = "#111827";
const PAPER = "#ffffff";

function readableOn(bg: string): string {
  return contrast(INK, bg) >= contrast(PAPER, bg) ? INK : PAPER;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyCompanyBrand(brief: DesignBrief, brand: CompanyBrand | null, idea: string): DesignBrief {
  if (!brand) return brief;
  const ownColours = ideaNamesColours(decodeXmlEntities(String(idea ?? "")).replace(new RegExp(escapeRe(brand.name), "gi"), " "));
  const out: DesignBrief = {
    ...brief,
    brand: {
      ...(brand.voice ? { voice: brand.voice } : {}),
      ...(brand.logoSvg ? { logo: SITE_LOGO_URL } : {}),
      ...(brand.colors && !ownColours ? { colors: "company" as const } : {}),
    },
  };
  if (!brand.colors || ownColours) return out;
  const colors: Record<BriefColorToken, string> = { ...brief.colors };
  colors.primary = brand.colors.primary;
  colors["primary-foreground"] = readableOn(brand.colors.primary);
  if (brand.colors.background && brand.colors.text && contrast(brand.colors.text, brand.colors.background) >= 4.5) {
    colors.background = brand.colors.background;
    colors.foreground = brand.colors.text;
  }
  for (const k of BRIEF_COLOR_TOKENS) if (!HEX.test(colors[k])) colors[k] = brief.colors[k];
  repairBriefContrast(colors);
  out.colors = colors;
  const { earthy_replaced: _dropped, ...rest } = out;
  return rest;
}

export async function liveBrandName(tenant_id: string): Promise<{ name: string | null; nameIsWorkspaceLabel: boolean }> {
  const { getCompanyFacts } = await import("@/services/company/facts");
  const f = await getCompanyFacts(tenant_id);
  return { name: f.name, nameIsWorkspaceLabel: f.nameIsWorkspaceLabel };
}

export async function liveBrandColors(tenant_id: string): Promise<BrandColors | null> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { data } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_brand_kits")
    .select("primary_hex,accent_hex,bg_hex,text_hex,source")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  const row = data as { primary_hex?: unknown; accent_hex?: unknown; bg_hex?: unknown; text_hex?: unknown; source?: unknown } | null;
  if (!row || (row.source !== "manual" && row.source !== "scrape")) return null;
  const primary = hex(row.primary_hex);
  return primary ? { primary, accent: hex(row.accent_hex), background: hex(row.bg_hex), text: hex(row.text_hex) } : null;
}

export async function liveBrandVoice(tenant_id: string): Promise<string | null> {
  const { getTenantPersonalization } = await import("@/services/personalization/store");
  const p = await getTenantPersonalization(tenant_id);
  const voice = p.brand_voice.trim();
  const tone = p.base_tone !== "default" ? p.base_tone : "";
  return [tone, voice].filter(Boolean).join(". ") || null;
}

const LOGO_NAME = /(^|[^a-z])logo([^a-z]|$)/i;

export function pickLogoFile<F extends { name: string; mime: string; created_at: string }>(files: readonly F[]): F | undefined {
  return [...files]
    .filter((f) => LOGO_NAME.test(f.name) && /^image\//.test(f.mime))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
}

export async function liveBrandLogo(tenant_id: string): Promise<Uint8Array | null> {
  const { asTenantId } = await import("@/services/tenant-client");
  const { readIndex, readPublicWorkspaceFile, workspaceFilesDeps } = await import("@/services/workspace-files/workspace-files");
  const deps = workspaceFilesDeps(asTenantId(tenant_id));
  const index = await readIndex(deps);
  const logo = pickLogoFile(index.files);
  if (!logo) return null;
  const served = await readPublicWorkspaceFile(deps.storage, tenant_id, logo.id, logo.path.split("/").pop() ?? "");
  return served ? new Uint8Array(served.body) : null;
}

export const liveCompanyBrandSources: CompanyBrandSources = {
  name: liveBrandName,
  colors: liveBrandColors,
  voice: liveBrandVoice,
  logo: liveBrandLogo,
};
