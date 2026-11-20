
import type { Request, Response } from "express";
import { ingestLogBatch } from "@/services/site-functions/logs";
import { createSiteFunctionsStore } from "@/services/site-functions/store";

function h(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function createSiteFunctionLogsHandler(deps: () => Parameters<typeof ingestLogBatch>[0]) {
  return async function siteFunctionLogs(req: Request, res: Response): Promise<void> {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const r = await ingestLogBatch(deps(), (n) => h(req, n), raw);
      res.status(r.status).json(r.body);
    } catch (e) {
      console.warn(JSON.stringify({ evt: "site_functions", step: "log_ingest", outcome: "failed", error: (e as Error).message.slice(0, 200) }));
      res.status(503).json({ error: "unavailable" });
    }
  };
}

export const siteFunctionLogsWebhook = createSiteFunctionLogsHandler(() => ({
  store: createSiteFunctionsStore(),
  secret: (process.env.SITE_FN_LOG_SECRET ?? "").trim() || undefined,
}));
