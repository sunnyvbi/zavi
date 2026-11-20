
import type { Request, Response } from "express";
import { SITE_TEMPLATES_VERSION, publicSiteTemplates } from "@/services/sites/site-templates";

export function publicSiteTemplatesRoute(_req: Request, res: Response): void {
  res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  res.json({ version: SITE_TEMPLATES_VERSION, templates: publicSiteTemplates() });
}
