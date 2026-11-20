
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

const DOCTOR_SOURCES = ["praxis-doctor.cli", "praxis-doctor.cron"] as const;
const DOCTOR_CODES = [
  "doctor.uptime",
  "doctor.secrets",
  "doctor.db",
  "doctor.inngest",
] as const;
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 200;

type DoctorLogRowRaw = {
  level: string;
  source: string;
  code: string | null;
  message: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
};
type DoctorLogRow = {
  level: string;
  source: string;
  code: string | null;
  message: string | null;
  meta: Record<string, unknown> | null;
  ts: string;
};

export async function staffDoctorStatus(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);

  const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;

  const sb = serviceClient();
  const { data, error } = await sb
    .from("praxis_logs")
    .select("level, source, code, message, meta, created_at")
    .in("source", DOCTOR_SOURCES as unknown as string[])
    .in("code", DOCTOR_CODES as unknown as string[])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    res
      .status(500)
      .json({
        error: { code: "praxis_logs_query_failed", message: error.message },
      });
    return;
  }

  const rows: DoctorLogRow[] = ((data ?? []) as DoctorLogRowRaw[]).map((r) => ({
    level: r.level,
    source: r.source,
    code: r.code,
    message: r.message,
    meta: r.meta,
    ts: r.created_at,
  }));

  const latest: Record<string, DoctorLogRow | null> = {
    uptime: null,
    secrets: null,
    db: null,
    inngest: null,
  };
  for (const row of rows) {
    const name = (row.code ?? "").replace(/^doctor\./, "");
    if (name in latest && latest[name] === null) {
      latest[name] = row;
    }
  }

  res.json({
    latest,
    rows,
    ts: new Date().toISOString(),
  });
}
