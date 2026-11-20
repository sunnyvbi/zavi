
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { resolveBrandKit } from "@/services/brand/resolve-brand-kit";

const Hex = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "a colour must be a six-digit hex like #1A73FF")
  .transform((h) => h.toLowerCase());

const Body = z.object({
  primary: Hex,
  accent: Hex.nullable().optional(),
  bg: Hex.nullable().optional(),
  text: Hex.nullable().optional(),
});

export async function getBrandKit(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const kit = await resolveBrandKit(auth.tenant_id);
    res.json({ brand_kit: kit });
  } catch (e) {
    res.status(500).json({ error: { code: "read_failed", message: (e as Error).message } });
  }
}

export async function putBrandKit(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { code: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body" } });
    return;
  }
  const { primary, accent = null, bg = null, text = null } = parsed.data;
  try {
    const db = tenantClient(asTenantId(auth.tenant_id));
    const { error } = await db.from("tenant_brand_kits").upsert(
      {
        tenant_id: auth.tenant_id,
        primary_hex: primary,
        accent_hex: accent,
        bg_hex: bg,
        text_hex: text,
        source: "manual",
        evidence: [],
        refreshed_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id" },
    );
    if (error) throw new Error(error.message);
    res.json({
      brand_kit: { primary, accent, bg, text, source: "manual", source_url: null, evidence: [] },
    });
  } catch (e) {
    res.status(500).json({ error: { code: "write_failed", message: (e as Error).message } });
  }
}

export async function deleteBrandKit(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  try {
    const db = tenantClient(asTenantId(auth.tenant_id));
    const { error } = await db.from("tenant_brand_kits").delete().eq("tenant_id", auth.tenant_id);
    if (error) throw new Error(error.message);
    const kit = await resolveBrandKit(auth.tenant_id, { forceRefresh: true });
    res.json({ brand_kit: kit });
  } catch (e) {
    res.status(500).json({ error: { code: "write_failed", message: (e as Error).message } });
  }
}
