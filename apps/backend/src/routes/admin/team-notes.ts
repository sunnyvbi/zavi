
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { writeStaffAuditStrict } from "@/services/staff/audit";

const CLIENT_REASON = "admin/team-notes: staff counts + founder-sent team reports";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 50;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

type Count = { n: number | string };
const num = (n: unknown) => (typeof n === "number" ? n : Number.parseInt(String(n ?? "0"), 10) || 0);

export async function staffTeamNotesSummary(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const raw = String(req.query.days ?? "7");
  if (raw !== "7" && raw !== "30") return fail(res, 400, "invalid_days", "days must be 7 or 30");
  const days = Number(raw);
  const sb = staffCrossTenantClient(CLIENT_REASON);
  const [judged, offered] = await Promise.all([
    sb.rpc("team_note_judgement_summary", { p_days: days }),
    sb.rpc("team_note_offer_summary", { p_days: days }),
  ]);
  if (judged.error || offered.error) {
    return fail(res, 500, "summary_failed", (judged.error ?? offered.error)!.message);
  }
  const judgements = ((judged.data ?? []) as Array<Record<string, unknown> & Count>).map((r) => ({
    agent_slug: String(r.agent_slug), code_signal: String(r.code_signal),
    judge_signal: (r.judge_signal as string | null) ?? null, source: String(r.source),
    surface: (r.surface as string | null) ?? null, verdict: String(r.verdict), n: num(r.n),
  }));
  const offers = ((offered.data ?? []) as Array<Record<string, unknown> & Count>).map((r) => ({
    agent_slug: String(r.agent_slug), code_signal: String(r.code_signal),
    judge_signal: String(r.judge_signal), source: String(r.source),
    surface: String(r.surface), status: String(r.status), n: num(r.n),
  }));
  const sum = <T extends { n: number }>(rows: T[], pick?: (r: T) => boolean) =>
    rows.filter((r) => (pick ? pick(r) : true)).reduce((a, r) => a + r.n, 0);
  res.json({
    days,
    totals: {
      judged: sum(judgements),
      judged_bad: sum(judgements, (r) => r.verdict === "bad"),
      judge_failed: sum(judgements, (r) => r.verdict === "transport" || r.verdict === "parse"),
      offered: sum(offers),
      strips: sum(offers, (r) => r.surface === "strip"),
      flags: sum(offers, (r) => r.surface === "flag"),
      sent: sum(offers, (r) => r.status === "sent"),
      dismissed: sum(offers, (r) => r.status === "dismissed" || r.status === "stopped"),
    },
    judgements,
    offers,
  });
}

type ListRow = {
  id: string; tenant_id: string; tenant_slug: string | null; tenant_name: string | null; agent_slug: string;
  signal: string; source: string; created_at: string; has_extra: boolean; note_edited: boolean;
  status: string; thread_id: string | null; message_id: string | null;
};

export async function staffTeamReportList(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const before = typeof req.query.before === "string" && req.query.before ? req.query.before : null;
  const beforeId = typeof req.query.before_id === "string" && req.query.before_id ? req.query.before_id : null;
  if ((before === null) !== (beforeId === null)) {
    return fail(res, 400, "invalid_cursor", "before and before_id go together");
  }
  if (before !== null && (Number.isNaN(Date.parse(before)) || !UUID_RE.test(beforeId!))) {
    return fail(res, 400, "invalid_cursor", "bad cursor");
  }
  const { data, error } = await staffCrossTenantClient(CLIENT_REASON).rpc("team_reports_staff_list", {
    p_before_created: before, p_before_id: beforeId, p_limit: PAGE + 1,
  });
  if (error) return fail(res, 500, "list_failed", error.message);
  const rows = (data ?? []) as ListRow[];
  const page = rows.slice(0, PAGE);
  const last = page[page.length - 1];
  res.json({
    reports: page.map((r) => ({
      id: r.id, tenant_id: r.tenant_id, tenant_slug: r.tenant_slug, tenant_name: r.tenant_name,
      agent_slug: r.agent_slug, signal: r.signal, source: r.source, created_at: r.created_at,
      has_extra: r.has_extra === true, note_edited: r.note_edited === true, status: r.status,
      thread_id: r.thread_id ?? null, message_id: r.message_id ?? null,
    })),
    next_cursor: rows.length > PAGE && last ? { before: last.created_at, before_id: last.id } : null,
  });
}

export async function staffTeamReportRead(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return fail(res, 404, "not_found", "No such report.");
  const sb = staffCrossTenantClient(CLIENT_REASON);

  const { data: meta, error: metaErr } = await sb
    .from("team_reports")
    .select("id, tenant_id, thread_id, message_id, agent_slug, signal, source, created_at")
    .eq("id", id)
    .maybeSingle();
  if (metaErr) return fail(res, 500, "read_failed", metaErr.message);
  if (!meta) return fail(res, 404, "not_found", "No such report.");
  const m = meta as {
    id: string; tenant_id: string; thread_id: string | null; message_id: string | null;
    agent_slug: string; signal: string; source: string; created_at: string;
  };

  try {
    await writeStaffAuditStrict({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "staff.team_report.read",
      target_table: "team_reports",
      target_id: m.id,
      tenant_id: m.tenant_id,
    });
  } catch {
    return fail(res, 503, "audit_unavailable", "Could not record this read, so the note stays hidden. Try again.");
  }

  const { data: body, error: bodyErr } = await sb
    .from("team_reports")
    .select("note, founder_extra")
    .eq("id", m.id)
    .eq("tenant_id", m.tenant_id)
    .maybeSingle();
  if (bodyErr) return fail(res, 500, "read_failed", bodyErr.message);
  if (!body) return fail(res, 404, "not_found", "No such report.");
  const b = body as { note: string; founder_extra: string | null };
  res.json({
    report: {
      ...m,
      note: b.note,
      founder_extra: b.founder_extra ?? null,
      thread_path: m.thread_id ? `/tenants/${m.tenant_id}/threads/${m.thread_id}` : null,
    },
  });
}
