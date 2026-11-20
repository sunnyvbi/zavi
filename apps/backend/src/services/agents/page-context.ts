import { z } from "zod";

export const PAGE_CONTEXT_SURFACE = "chrome_extension";

export const SUPPORTED_ADAPTER_IDS = ["meta_ads"] as const;

export const CURRENT_SCHEMA_VERSION = 1;

export const MAX_EXTRACTION_BYTES = 32 * 1024;

export const MAX_LABEL_CHARS = 120;
const MAX_ROWS = 60;

const finiteOrNull = z
  .number()
  .finite()
  .nullish()
  .transform((v) => (v === undefined ? null : v));

const extractionRowSchema = z.object({
  name: z.string().max(MAX_LABEL_CHARS * 4),
  level: z.enum(["campaign", "adset", "ad", "unknown"]).default("unknown"),
  status: z.string().max(64).nullish(),
  spend: finiteOrNull,
  impressions: finiteOrNull,
  clicks: finiteOrNull,
  cpa: finiteOrNull,
  roas: finiteOrNull,
  currency: z.string().max(8).nullish(),
}).strict();

export const extractionSchema = z.object({
  rows: z.array(extractionRowSchema).max(MAX_ROWS),
  date_preset: z.string().max(64).nullish(),
  account_name: z.string().max(MAX_LABEL_CHARS * 4).nullish(),
  truncated: z.boolean().default(false),
  row_count_total: z.number().int().nonnegative().default(0),
}).strict();

export const pageContextSchema = z
  .object({
    url: z.string().max(2048),
    title: z.string().max(512).nullish(),
    adapter_id: z.enum(SUPPORTED_ADAPTER_IDS).optional(),
    schema_version: z.literal(CURRENT_SCHEMA_VERSION).optional(),
    extraction: extractionSchema.optional(),
  })
  .strict()
  .refine((v) => !v.extraction || (v.adapter_id && v.schema_version), {
    message: "extraction requires adapter_id and schema_version",
  })
  .refine(
    (v) =>
      !v.extraction ||
      Buffer.byteLength(JSON.stringify(v.extraction), "utf8") <=
        MAX_EXTRACTION_BYTES,
    { message: `extraction exceeds ${MAX_EXTRACTION_BYTES} bytes` },
  );

export type PageContextInput = z.infer<typeof pageContextSchema>;

export const SCREENSHOT_PAGE_CONTEXT_MODE = "screenshot";

export const screenshotPageContextSchema = z
  .object({
    mode: z.literal(SCREENSHOT_PAGE_CONTEXT_MODE),
    url: z.string().max(2048),
    title: z.string().max(512).nullish(),
  })
  .strict()
  .refine((v) => stripUrlQuery(v.url) !== null, {
    message: "screenshot page_context url must be an http(s) URL",
  });

export type ScreenshotPageContextInput = z.infer<
  typeof screenshotPageContextSchema
>;

export const pageContextRequestSchema = z.union([
  screenshotPageContextSchema,
  pageContextSchema,
]);

export type PageContextRequestInput = z.infer<typeof pageContextRequestSchema>;

export function isScreenshotPageContext(holder: unknown): boolean {
  if (!holder || typeof holder !== "object") return false;
  const pc = (holder as { page_context?: unknown }).page_context;
  if (!pc || typeof pc !== "object") return false;
  return (pc as { mode?: unknown }).mode === SCREENSHOT_PAGE_CONTEXT_MODE;
}

export type NormalizedScreenshotPageContext = {
  mode: typeof SCREENSHOT_PAGE_CONTEXT_MODE;
  url: string | null;
  title: string | null;
};

export function normalizeScreenshotPageContext(
  input: ScreenshotPageContextInput,
): NormalizedScreenshotPageContext {
  return {
    mode: SCREENSHOT_PAGE_CONTEXT_MODE,
    url: stripUrlQuery(input.url),
    title: input.title ? cleanLabel(input.title, 512) : null,
  };
}

const ADAPTER_HOSTS: Record<(typeof SUPPORTED_ADAPTER_IDS)[number], string[]> = {
  meta_ads: ["adsmanager.facebook.com", "business.facebook.com"],
};

export function stripUrlQuery(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.search = "";
  u.hash = "";
  u.username = "";
  u.password = "";
  return u.toString();
}

function cleanLabel(s: string, cap = MAX_LABEL_CHARS): string {
  return (
    s
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/<{2,}/g, "<")
      .replace(/>{2,}/g, ">")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, cap)
  );
}

export type NormalizedPageContext = {
  url: string | null;
  title: string | null;
  adapter_id: string | null;
  schema_version: number | null;
  extraction: z.infer<typeof extractionSchema> | null;
  observation_only: boolean;
  browser_observed: true;
};

export function normalizePageContext(
  input: PageContextInput,
): NormalizedPageContext {
  const url = stripUrlQuery(input.url);
  let host: string | null = null;
  try {
    host = url ? new URL(url).hostname : null;
  } catch {
    host = null;
  }

  const hostOk =
    input.adapter_id && host
      ? ADAPTER_HOSTS[input.adapter_id].includes(host)
      : false;
  const usable = Boolean(input.extraction && input.adapter_id && hostOk);

  const extraction =
    usable && input.extraction
      ? {
          ...input.extraction,
          account_name: input.extraction.account_name
            ? cleanLabel(input.extraction.account_name)
            : null,
          rows: input.extraction.rows.map((r) => ({
            ...r,
            name: cleanLabel(r.name),
            status: r.status ? cleanLabel(r.status, 64) : null,
          })),
        }
      : null;

  return {
    url,
    title: input.title ? cleanLabel(input.title, 512) : null,
    adapter_id: usable ? (input.adapter_id ?? null) : null,
    schema_version: usable ? (input.schema_version ?? null) : null,
    extraction,
    observation_only: !usable,
    browser_observed: true,
  };
}
