import type { Request, Response } from "express";
import { z } from "zod";
import { readSignupSources } from "@/services/tenants/signup-sources-read";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

export function validGrowthRange(
  from: unknown,
  to: unknown,
  now = new Date(),
): from is string {
  const date = (s: unknown): s is string =>
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s;
  if (!date(from) || !date(to)) return false;
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  const today = new Date(now.getTime() + 19800000).toISOString().slice(0, 10);
  return days >= 0 && days <= 3659 && to <= today;
}
export async function staffTenantsGrowth(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);
  res.setHeader("Cache-Control", "private, no-store");
  const { from, to } = req.query;
  if (!validGrowthRange(from, to)) {
    res.status(400).json({
      error: {
        message:
          "Choose valid dates, up to ten years, ending no later than today (IST).",
      },
    });
    return;
  }
  const db = staffCrossTenantClient(
    "admin/tenants-growth: staff reads customer growth metrics",
  );
  const { data, error } = await db.rpc("admin_tenants_growth", {
    p_from: from,
    p_to: to,
    p_include_usage: req.query.include_usage === "1",
  });
  if (error || !data) {
    res.status(503).json({
      error: { message: "Growth data is unavailable. Please retry." },
    });
    return;
  }
  try {
    const tenants = data.tenants as Array<{ id: string }>;
    const sources = await readSignupSources(
      db,
      tenants.map((t) => t.id),
    );
    res.json({
      ...data,
      sources_available: true,
      tenants: tenants.map((t) => ({ ...t, ...sources.get(t.id) })),
    });
  } catch {
    console.warn("[admin/tenants-growth] signup source lookup failed");
    res.json({ ...data, sources_available: false });
  }
}
const Classification = z
  .object({
    subject_type: z.enum(["tenant", "user"]),
    ids: z.array(z.string().uuid()).min(1).max(200),
    is_test: z.boolean(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export async function staffClassifyGrowthAccounts(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  res.setHeader("Cache-Control", "private, no-store");
  const parsed = Classification.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: "Choose up to 200 accounts and provide a review reason.",
      },
    });
    return;
  }
  const body = parsed.data;
  const { data, error } = await staffCrossTenantClient(
    "admin/tenants-growth: staff confirms reporting classifications",
  ).rpc("admin_growth_classify", {
    p_subject_type: body.subject_type,
    p_ids: [...new Set(body.ids)],
    p_is_test: body.is_test,
    p_reason: body.reason,
    p_actor: staff.user_id,
  });
  if (error) {
    res
      .status(error.code === "42501" ? 403 : error.code === "22023" ? 400 : 503)
      .json({
        error: {
          message: "Classification was not saved. Refresh the list and retry.",
        },
      });
    return;
  }
  res.json({ updated: data });
}
