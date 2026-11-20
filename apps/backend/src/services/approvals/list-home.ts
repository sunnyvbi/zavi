
import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DECISION_HOME_KINDS, type DecisionHomeKind } from "@zavi/shared";
import { cgoHoldView, founderAdviceView } from "./hold-view";
import { logEvent } from "@/services/logging/logEvent";
import { approveNeedsOwnerOrAdmin } from "@/services/approvals/approve-role-gate";
import { socialDraftVersion } from "@/services/approvals/social-draft-version";
import { SOCIAL_PUBLISH_CLASS } from "@/routes/approvals/decision-channel";

export const HOME_PAGE_DEFAULT = 50;
export const HOME_PAGE_MAX = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HomeCursor = { emitted_at: string; id: string };

export function encodeHomeCursor(c: HomeCursor): string {
  return Buffer.from(`${c.emitted_at}|${c.id}`, "utf8").toString("base64url");
}

export function decodeHomeCursor(raw: string): HomeCursor | null {
  if (raw.length === 0 || raw.length > 200) return null;
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const bar = text.lastIndexOf("|");
  if (bar <= 0) return null;
  const emitted_at = text.slice(0, bar);
  const id = text.slice(bar + 1);
  if (!UUID_RE.test(id) || !Number.isFinite(Date.parse(emitted_at))) return null;
  if (!/^[0-9T:.\-+ Z]+$/.test(emitted_at)) return null;
  return { emitted_at, id };
}

export function parseHomeKind(raw: unknown): DecisionHomeKind | null {
  return typeof raw === "string" && (DECISION_HOME_KINDS as readonly string[]).includes(raw) ? (raw as DecisionHomeKind) : null;
}

export function parseHomeKinds(raw: unknown): DecisionHomeKind[] | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return null;
  const parts = raw.split(",");
  const kinds = parts.map(parseHomeKind);
  if (kinds.some((k) => k === null) || new Set(kinds).size !== kinds.length) return null;
  return kinds as DecisionHomeKind[];
}

export function parseHomeLimit(raw: unknown): number | null {
  if (raw === undefined) return HOME_PAGE_DEFAULT;
  if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= HOME_PAGE_MAX ? n : null;
}

type Row = {
  id: string;
  agent_run_id: string | null;
  decision_class: string;
  body: unknown;
  emitted_at: string;
  home: string | null;
  home_channel: string | null;
} & Record<string, unknown>;

export async function approvalsListHome(args: {
  req: Request;
  res: Response;
  supabase: SupabaseClient;
  tenant_id: string;
  source: string;
  statusFilter: string | null;
  listColumns: string;
  runGroupOf: (d: { agent_run_id: string | null; body: unknown }) => unknown;
}): Promise<void> {
  const { req, res, supabase, tenant_id, source, statusFilter, listColumns } = args;
  const started = Date.now();
  const homes = parseHomeKinds(req.query.home);
  if (!homes) {
    res.status(400).json({ error: { code: "invalid_home", message: `home must be one or more of ${DECISION_HOME_KINDS.join(", ")}` } });
    return;
  }
  const home = homes.join(",");
  if (typeof req.query.channel === "string" && req.query.channel.length > 0) {
    res.status(400).json({ error: { code: "invalid_query", message: "home and channel cannot be combined" } });
    return;
  }
  const limit = parseHomeLimit(req.query.limit);
  if (limit === null) {
    res.status(400).json({ error: { code: "invalid_limit", message: `limit must be 1..${HOME_PAGE_MAX}` } });
    return;
  }
  let cursor: HomeCursor | null = null;
  if (req.query.cursor !== undefined) {
    cursor = typeof req.query.cursor === "string" ? decodeHomeCursor(req.query.cursor) : null;
    if (!cursor) {
      res.status(400).json({ error: { code: "invalid_cursor", message: "cursor is not valid" } });
      return;
    }
  }
  const wantCount = req.query.count === "1" || req.query.count === "true";

  const base = (columns: string, opts?: { count: "exact"; head: true }) => {
    let q = supabase.from(source).select(columns, opts).eq("tenant_id", tenant_id);
    if (statusFilter) q = q.eq("status", statusFilter);
    return q;
  };

  let pageQ = base(`${listColumns}, home, home_channel, cgo_hold, founder_advice`);
  pageQ = homes.length === 1 ? pageQ.eq("home", homes[0]) : pageQ.in("home", homes);
  if (cursor) {
    pageQ = pageQ.or(`emitted_at.lt."${cursor.emitted_at}",and(emitted_at.eq."${cursor.emitted_at}",id.lt.${cursor.id})`);
  }
  const [page, totals] = await Promise.all([
    pageQ.order("emitted_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1),
    wantCount
      ? Promise.all(DECISION_HOME_KINDS.map((h) => base("id", { count: "exact", head: true }).eq("home", h)))
      : Promise.resolve(null),
  ]);
  const countError = totals?.find((t) => t.error)?.error ?? null;
  if (page.error || countError) {
    const err = page.error ?? countError;
    void logEvent({
      level: "error",
      source: "routes/approvals/list",
      code: page.error ? "approvals.list_failed" : "approvals.count_failed",
      tenant_id,
      message: err?.message ?? "list read failed",
      meta: { home, db_error_code: (err as { code?: string } | null)?.code ?? "unknown" },
    });
    res.status(500).json({ error: { code: page.error ? "list_failed" : "count_failed", message: "Could not read this list." } });
    return;
  }

  const fetched = (page.data ?? []) as unknown as Row[];
  const rows = fetched.slice(0, limit);
  const last = rows.at(-1);
  const next_cursor = fetched.length > limit && last ? encodeHomeCursor({ emitted_at: last.emitted_at, id: last.id }) : null;

  const runIds = [...new Set(rows.map((r) => r.agent_run_id).filter((x): x is string => !!x))];
  const runMeta = new Map<string, { agent_slug: string | null; thread_id: string | null; run_stopped: boolean }>();
  if (runIds.length > 0) {
    const { data: runs, error: runsError } = await supabase
      .from("agent_runs")
      .select("id, agent_slug, payload, stop_requested")
      .eq("tenant_id", tenant_id)
      .in("id", runIds);
    if (runsError) {
      void logEvent({ level: "warn", source: "routes/approvals/list", code: "approvals.run_meta_failed", tenant_id, message: runsError.message, meta: { home } });
    }
    for (const r of (runs ?? []) as Array<Record<string, unknown>>) {
      const payload = (r.payload ?? {}) as { thread_id?: unknown; operator_thread_id?: unknown };
      runMeta.set(r.id as string, {
        agent_slug: (r.agent_slug as string | null) ?? null,
        thread_id:
          typeof payload.thread_id === "string"
            ? payload.thread_id
            : typeof payload.operator_thread_id === "string"
              ? payload.operator_thread_id
              : null,
        run_stopped: r.stop_requested === true,
      });
    }
  }

  const allowlistable = new Set<string>();
  if (rows.length > 0) {
    const { data: clsRows } = await supabase.from("decision_classes").select("slug").eq("click_allowlistable", true);
    for (const c of (clsRows ?? []) as Array<{ slug: string }>) allowlistable.add(c.slug);
  }

  const decisions = rows.map((d) => {
    const meta = d.agent_run_id ? runMeta.get(d.agent_run_id) : undefined;
    return {
      ...d,
      cgo_hold: cgoHoldView((d as { cgo_hold?: unknown }).cgo_hold),
      founder_advice: founderAdviceView((d as { founder_advice?: unknown }).founder_advice),
      ...(d.decision_class === SOCIAL_PUBLISH_CLASS ? { post_revision: socialDraftVersion(d.body) } : {}),
      agent_slug: meta?.agent_slug ?? null,
      thread_id: meta?.thread_id ?? null,
      run_stopped: meta?.run_stopped ?? false,
      channel_slug: d.home === "channel" ? d.home_channel : null,
      run_group: args.runGroupOf(d),
      click_allowlistable: allowlistable.has(d.decision_class),
      needs_owner_admin: approveNeedsOwnerOrAdmin(d.decision_class, d.body),
      action_source: "decision" as const,
    };
  });

  const ms = Date.now() - started;
  void logEvent({
    level: "info",
    source: "routes/approvals/list",
    code: "approvals.list_served",
    tenant_id,
    meta: { home, page_size: limit, count: decisions.length, ms },
  });

  res.json({
    decisions,
    next_cursor,
    ...(totals
      ? { totals: Object.fromEntries(DECISION_HOME_KINDS.map((h, i) => [h, totals[i].count ?? 0])) as Record<DecisionHomeKind, number> }
      : {}),
  });
}
