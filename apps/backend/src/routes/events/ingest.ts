
import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { serviceClient } from "@/services/supabase";

const bodySchema = z.object({
  event_name: z.string().min(1).max(120),
  distinct_id: z.string().max(200).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  source: z.enum(["web", "server", "sdk"]).optional(),
  occurred_at: z.string().datetime().optional(),
});

function extractIngestKey(req: Request): string | null {
  const headerKey = req.header("x-praxis-ingest-key");
  if (headerKey && headerKey.trim()) return headerKey.trim();
  const authz = req.header("authorization");
  if (authz && /^bearer\s+/i.test(authz)) {
    const tok = authz.replace(/^bearer\s+/i, "").trim();
    if (tok) return tok;
  }
  return null;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export async function eventsIngest(req: Request, res: Response): Promise<void> {
  const key = extractIngestKey(req);
  if (!key) {
    res.status(401).json({
      error: {
        code: "no_ingest_key",
        message:
          "Missing ingest key. Send your per-workspace ingest key in the x-praxis-ingest-key header.",
      },
    });
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_event",
        message: "Invalid event body.",
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const sc = serviceClient();

  const { data: tenantId, error: resolveErr } = await sc.rpc(
    "resolve_tenant_ingest_key",
    { p_key_hash: hashKey(key) },
  );
  if (resolveErr) {
    res.status(500).json({
      error: { code: "ingest_resolve_failed", message: "Could not validate ingest key." },
    });
    return;
  }
  if (!tenantId) {
    res.status(401).json({
      error: { code: "invalid_ingest_key", message: "Ingest key is not valid." },
    });
    return;
  }

  const { event_name, distinct_id, properties, source, occurred_at } = parsed.data;

  const { data: eventId, error: writeErr } = await sc.rpc("ingest_tenant_event", {
    p_tenant_id: tenantId,
    p_event_name: event_name,
    p_distinct_id: distinct_id ?? null,
    p_properties: properties ?? {},
    p_occurred_at: occurred_at ?? null,
    p_source: source ?? "server",
  });
  if (writeErr) {
    res.status(500).json({
      error: { code: "ingest_write_failed", message: "Could not record event." },
    });
    return;
  }

  res.status(202).json({ ok: true, event_id: eventId });
}
