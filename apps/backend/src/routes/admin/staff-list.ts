
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";

export async function staffList(_req: Request, res: Response): Promise<void> {
  assertStaff(_req);
  const allowlistRaw = process.env.STAFF_EMAIL_ALLOWLIST ?? "";
  const allowlist = allowlistRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  res.json({
    allowlist,
    source: "env:STAFF_EMAIL_ALLOWLIST",
    active: false,
    note: "LEGACY / INACTIVE. As of 2026-07-17 the STAFF_EMAIL_ALLOWLIST env no longer gates admin access. The DB-backed Super Users page (staff_users table) is the live gate. This view is retained for reference only.",
  });
}
