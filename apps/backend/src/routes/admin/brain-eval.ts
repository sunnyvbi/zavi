
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { streamExport, runReplay } from "@/services/memory/replay";

const exportBodySchema = z
  .object({
    tenant_id: z.string().uuid(),
    since_days: z.number().int().min(1).max(90).default(7),
    tool_name: z.enum(["search", "query"]).optional(),
  })
  .strict();

const replayBodySchema = z
  .object({
    tenant_id: z.string().uuid(),
    baseline_ndjson: z.string().min(1).max(5_000_000),
  })
  .strict();

export async function staffBrainEvalExport(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);
  let body: z.infer<typeof exportBodySchema>;
  try {
    body = exportBodySchema.parse(req.body);
  } catch (e) {
    res.status(400).json({
      error: {
        code: "invalid_body",
        message: (e as Error).message,
      },
    });
    return;
  }

  res.setHeader("content-type", "application/x-ndjson");
  res.setHeader(
    "content-disposition",
    `attachment; filename="brain-eval-${body.tenant_id}-${Date.now()}.ndjson"`,
  );

  try {
    await streamExport(
      {
        tenant_id: body.tenant_id,
        since_days: body.since_days,
        tool_name: body.tool_name,
      },
      res,
    );
  } catch (e) {
    if (!res.headersSent) {
      res
        .status(500)
        .json({ error: { code: "export_failed", message: (e as Error).message } });
    } else {
      res.end(`\n# export_failed: ${(e as Error).message}\n`);
    }
  }
}

export async function staffBrainEvalReplay(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);
  let body: z.infer<typeof replayBodySchema>;
  try {
    body = replayBodySchema.parse(req.body);
  } catch (e) {
    res.status(400).json({
      error: {
        code: "invalid_body",
        message: (e as Error).message,
      },
    });
    return;
  }

  try {
    const report = await runReplay({
      tenant_id: body.tenant_id,
      baselineNdjson: body.baseline_ndjson,
    });
    res.json({ ok: true, report });
  } catch (e) {
    res
      .status(500)
      .json({ error: { code: "replay_failed", message: (e as Error).message } });
  }
}
