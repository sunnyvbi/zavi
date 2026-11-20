
import type { ToolSpec } from "@/services/tools/types";
import { z } from "zod";
import { PAGE_DESIGN_GUIDE, brandGuideSection } from "@/services/shared-pages/design-guide";
import { resolveBrandKit, type ResolvedBrandKit } from "@/services/brand/resolve-brand-kit";

export const getPageDesignGuideInputSchema = z.object({});

export const getPageDesignGuideTool: ToolSpec<
  z.infer<typeof getPageDesignGuideInputSchema>,
  { guide: string }
> = {
  name: "report_get_page_design_guide",
  effect: "read",
  description:
    "Returns the rules and craft guide for report__render_artifact pages, plus THIS customer's own brand colours to build the page with. Call it once before writing a page or a wireframe.",
  input_schema: getPageDesignGuideInputSchema,
  async execute(ctx) {
    let kit: ResolvedBrandKit | null = null;
    try {
      if (ctx.tenant_id) kit = await resolveBrandKit(ctx.tenant_id);
    } catch (e) {
      ctx.log?.(`brand_kit_unresolved: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
    return { guide: `${PAGE_DESIGN_GUIDE}${brandGuideSection(kit)}` };
  },
};
