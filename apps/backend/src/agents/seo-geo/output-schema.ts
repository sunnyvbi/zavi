
import { makeAdviceSchema } from "../advisor/output-schema";

export const SEO_GEO_DISPATCH_ALLOWLIST = [
  "content-design",
  "growth-lead",
  "chief-of-staff",
] as const;

export const seoGeoAdviceSchema = makeAdviceSchema(
  new Set<string>(SEO_GEO_DISPATCH_ALLOWLIST),
  "seo-geo",
);

export type SeoGeoAdvice = typeof seoGeoAdviceSchema._output;
