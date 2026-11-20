
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export async function staffMemoryList(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const limit = Math.min(200, Number(req.query.limit ?? 50));
  const tenantId = typeof req.query.tenant_id === "string" ? req.query.tenant_id : null;
  const source = typeof req.query.source === "string" ? req.query.source : null;
  const tag = typeof req.query.tag === "string" ? req.query.tag : null;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  let query = serviceClient()
    .from("memory_note")
    .select("id, tenant_id, title, body_markdown, source, source_ref, tags, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (tenantId) query = query.eq("tenant_id", tenantId);
  if (source) query = query.eq("source", source);
  if (tag) query = query.contains("tags", [tag]);
  if (q.length > 0) query = query.textSearch("tsv", q, { config: "english" });

  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: { code: "memory_query_failed", message: error.message } });
    return;
  }

  type Row = {
    id: string;
    tenant_id: string;
    title: string;
    body_markdown: string;
    source: string;
    source_ref: string | null;
    tags: string[] | null;
    created_at: string;
    updated_at: string;
  };
  const notes = ((data ?? []) as Row[]).map((n) => ({
    ...n,
    body_markdown: n.body_markdown ? n.body_markdown.slice(0, 600) : "",
  }));
  res.json({ notes });
}
