import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import {
  CONTEXT_SECTIONS,
  loadClientContextSections,
  type ContextSectionKey,
} from "@/services/client-context";

const SectionKey = z.enum(CONTEXT_SECTIONS);

const Query = z.object({
  tenant_id: z.string().uuid(),
  window_days: z.coerce.number().int().min(1).max(365).optional(),
  sections: z
    .string()
    .optional()
    .transform((raw) => (raw ? raw.split(",").map((part) => part.trim()).filter(Boolean) : []))
    .pipe(z.array(SectionKey)),
  fresh: z.enum(["0", "1"]).optional(),
});

export async function staffSuggestionsContext(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const parsed = Query.safeParse(req.query ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "bad_request", message: "tenant_id (uuid) and valid optional sections are required" },
    });
    return;
  }

  const sections: readonly ContextSectionKey[] =
    parsed.data.sections.length > 0 ? parsed.data.sections : CONTEXT_SECTIONS;
  try {
    const context = await loadClientContextSections(parsed.data.tenant_id, sections, {
      windowDays: parsed.data.window_days,
      fresh: parsed.data.fresh === "1",
    });
    res.json(context);
  } catch (e) {
    res.status(500).json({
      error: { code: "context_read_failed", message: (e as Error).message },
    });
  }
}
