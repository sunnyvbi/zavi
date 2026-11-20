import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { parseIngestBody } from "@/services/live-stunt/ingest";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function keyMatches(presented: string, configured: string): boolean {
  if (!presented || !configured) return false;
  return timingSafeEqual(digest(presented), digest(configured));
}

export async function postUpcarHourlyCounts(req: Request, res: Response): Promise<void> {
  res.set("Cache-Control", "no-store");
  const configured = process.env.UPCAR_INGEST_KEY ?? "";
  const tenant = process.env.UPCAR_INGEST_TENANT_ID ?? "";
  if (!configured || !tenant) {
    res.status(503).json({ error: "not_configured" });
    return;
  }
  if (!keyMatches(String(req.header("x-zavi-ingest-key") ?? ""), configured)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const body = parseIngestBody(req.body);
  if (typeof body === "string") {
    res.status(400).json({ error: "bad_body", message: body });
    return;
  }
  const { error } = await tenantRpc(asTenantId(tenant), "live_source_replace", {
    p_tenant_id: tenant, p_from: body.from, p_to: body.to, p_metrics: body.metrics, p_rows: body.rows,
  });
  if (error) {
    res.status(503).json({ error: "unavailable" });
    return;
  }
  res.json({ ok: true, rows: body.rows.length });
}
