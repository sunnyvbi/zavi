
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { writeNote } from "@/services/memory";
import { serviceClient } from "@/services/supabase";

const Body = z.object({
  body_markdown: z.string().min(1).max(2000),
});

export async function staffTenantAgentNote(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenantId = req.params.tenant_id;
  const slug = req.params.slug;

  const { data: tenant, error: tErr } = await serviceClient()
    .from("tenants")
    .select("id")
    .eq("id", tenantId)
    .maybeSingle();
  if (tErr) {
    res.status(500).json({ error: { code: "tenant_lookup_failed", message: tErr.message } });
    return;
  }
  if (!tenant) {
    res.status(404).json({ error: { code: "tenant_not_found", message: tenantId } });
    return;
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  try {
    const result = await writeNote(tenantId, {
      title: `Praxis staff note — ${slug}`,
      body_markdown: parsed.data.body_markdown,
      source: "praxis_staff",
      source_ref: `${staff.user_id}:${staff.email}:${today}`,
      tags: [`agent:${slug}`, "praxis_staff_note", `staff:${staff.email}`],
    });
    res.json({ ok: true, note_id: result.note_id });
  } catch (e) {
    res
      .status(500)
      .json({ error: { code: "note_write_failed", message: (e as Error).message } });
  }
}
