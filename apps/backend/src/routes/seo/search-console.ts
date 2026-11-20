import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { buildSearchConsoleSummary } from "@/services/tools/google-search-console/summary";
import { ExpectedToolError } from "@/services/tools/types";

const NOT_CONNECTED_CODES = new Set([
  "google_search_console_not_connected",
  "google_search_console_not_configured",
]);

export async function searchConsoleSummary(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const daysRaw = Number(req.query.days ?? 28);
  const days = [7, 28, 90].includes(daysRaw) ? daysRaw : 28;

  try {
    res.json(await buildSearchConsoleSummary(auth.tenant_id, days));
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      if (NOT_CONNECTED_CODES.has(e.code)) {
        res.json({ connected: false, reason: e.code });
        return;
      }
      res.status(502).json({ error: { code: e.code, message: e.message } });
      return;
    }
    throw e;
  }
}
