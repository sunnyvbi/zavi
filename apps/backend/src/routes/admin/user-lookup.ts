
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

const Query = z.object({
  email: z.string().trim().email("email must be a valid address").max(320),
});

type TenantMembership = {
  tenant_id: string;
  slug: string;
  display_name: string | null;
  role: string;
};

const MAX_PAGES = 20;
const PER_PAGE = 1000;

export async function staffUserLookup(req: Request, res: Response): Promise<void> {
  assertStaff(req);

  const parsed = Query.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "invalid query" },
    });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  const sb = serviceClient();

  let target: { id: string; email: string | null; app_metadata: Record<string, unknown> } | null =
    null;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error } = await sb.auth.admin.listUsers({ page, perPage: PER_PAGE });
      if (error) {
        res.status(502).json({ error: { code: "user_lookup_failed", message: error.message } });
        return;
      }
      const users = data?.users ?? [];
      const hit = users.find((u) => (u.email ?? "").toLowerCase() === email);
      if (hit) {
        target = {
          id: hit.id,
          email: hit.email ?? null,
          app_metadata: (hit.app_metadata ?? {}) as Record<string, unknown>,
        };
        break;
      }
      if (users.length < PER_PAGE) break;
    }
  } catch (e) {
    res.status(502).json({ error: { code: "user_lookup_failed", message: (e as Error).message } });
    return;
  }

  if (!target) {
    res.status(404).json({ error: { code: "user_not_found", message: "no user with that email" } });
    return;
  }

  if (target.app_metadata.role === "staff") {
    res.status(403).json({
      error: { code: "staff_target_forbidden", message: "cannot impersonate a staff account" },
    });
    return;
  }

  const { data: memRows, error: mErr } = await sb
    .from("tenant_users")
    .select("tenant_id, role")
    .eq("user_id", target.id);
  if (mErr) {
    res.status(500).json({ error: { code: "membership_lookup_failed", message: mErr.message } });
    return;
  }
  const rows = (memRows ?? []) as Array<{ tenant_id: string; role: string | null }>;

  let tenants: TenantMembership[] = [];
  if (rows.length > 0) {
    const ids = rows.map((r) => r.tenant_id);
    const { data: tRows, error: tErr } = await sb
      .from("tenants")
      .select("id, slug, display_name")
      .in("id", ids);
    if (tErr) {
      res.status(500).json({ error: { code: "tenant_lookup_failed", message: tErr.message } });
      return;
    }
    const byId = new Map(
      ((tRows ?? []) as Array<{ id: string; slug: string; display_name: string | null }>).map((t) => [
        t.id,
        t,
      ]),
    );
    tenants = rows
      .map((r) => {
        const t = byId.get(r.tenant_id);
        if (!t) return null;
        return {
          tenant_id: r.tenant_id,
          slug: t.slug,
          display_name: t.display_name,
          role: r.role || "member",
        } as TenantMembership;
      })
      .filter((x): x is TenantMembership => x !== null)
      .sort((a, b) => (a.display_name || a.slug).localeCompare(b.display_name || b.slug));
  }

  res.json({
    user_id: target.id,
    email: target.email,
    tenants,
  });
}
