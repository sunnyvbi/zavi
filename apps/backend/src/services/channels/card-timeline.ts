
import { asTenantId, tenantClient, type TenantId } from "@/services/tenant-client";
import { IN_CHUNK } from "./completed-actions";

export type ApproverKind = "you" | "autopilot" | "teammate" | "zavi_team";

export type CardApproval = { by: ApproverKind; name: string | null; at: string };

export type TimelineKind = "proposed" | "approved" | "sent" | "executed" | "failed" | "refused" | "revised";

export type TimelineEntry = { kind: TimelineKind; at: string; by?: ApproverKind };

export type CardEvent = { id: number; action_id: string; event: string; actor_kind: string; at: string };

export type ApprovalRow = {
  approved_by?: string | null;
  approved_by_source?: string | null;
  exec_claimed_at?: string | null;
};

const EVENTS_READ = ["proposed", "approved", "executed", "exec_failed", "revised", "stale_flagged"] as const;
const EVENTS_READ_CAP = 1000;
const NAME_LOOKUP_CAP = 10;

const byNewest = (a: CardEvent, b: CardEvent) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id;

export function latestApproved(events: readonly CardEvent[]): CardEvent | null {
  return [...events].filter((e) => e.event === "approved").sort(byNewest)[0] ?? null;
}

export function approverKind(row: ApprovalRow, viewerUserId: string): ApproverKind {
  if (row.approved_by_source === "cgo") return "autopilot";
  if (row.approved_by_source === "staff") return "zavi_team";
  if (row.approved_by && row.approved_by === viewerUserId) return "you";
  return "teammate";
}

export function approvalOf(
  row: ApprovalRow,
  approved: CardEvent | null,
  viewerUserId: string,
  nameOf: (userId: string) => string | null,
): CardApproval | null {
  if (!approved) return null;
  const by = approverKind(row, viewerUserId);
  const name = by === "teammate" && row.approved_by ? nameOf(row.approved_by) : null;
  return { by, name, at: approved.at };
}

const ORDER: Record<TimelineKind, number> = { proposed: 0, revised: 1, approved: 2, sent: 3, executed: 4, failed: 4, refused: 5 };

export function timelineOf(
  events: readonly CardEvent[],
  row: ApprovalRow & { exec_bucket?: string | null },
  approval: CardApproval | null,
): TimelineEntry[] {
  const latest = latestApproved(events);
  const out: Array<TimelineEntry & { id: number }> = [];
  let failedAt: number | null = null;
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);
  for (const e of sorted) {
    switch (e.event) {
      case "proposed":
      case "revised":
      case "executed":
        out.push({ id: e.id, kind: e.event, at: e.at });
        break;
      case "approved": {
        const by: ApproverKind | undefined =
          e.actor_kind === "system" ? "autopilot" : latest && e.id === latest.id ? approval?.by : undefined;
        out.push({ id: e.id, kind: "approved", at: e.at, ...(by ? { by } : {}) });
        break;
      }
      case "exec_failed":
        out.push({ id: e.id, kind: "failed", at: e.at });
        failedAt = Date.parse(e.at);
        break;
      case "stale_flagged":
        if (row.exec_bucket === "blocked_on_us" && failedAt !== null && Date.parse(e.at) >= failedAt) {
          out.push({ id: e.id, kind: "refused", at: e.at });
        }
        break;
    }
  }
  if (row.exec_claimed_at && Number.isFinite(Date.parse(row.exec_claimed_at))) {
    out.push({ id: Number.MAX_SAFE_INTEGER, kind: "sent", at: row.exec_claimed_at });
  }
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || ORDER[a.kind] - ORDER[b.kind] || a.id - b.id);
  return out.map(({ id: _id, ...e }) => {
    void _id;
    return e;
  });
}

export type TimelineDeps = {
  readEvents: (tid: TenantId, actionIds: string[]) => Promise<CardEvent[]>;
  readNames: (tid: TenantId, userIds: string[]) => Promise<Map<string, string | null>>;
};

async function readEventsDefault(tid: TenantId, actionIds: string[]): Promise<CardEvent[]> {
  const out: CardEvent[] = [];
  const db = tenantClient(tid);
  for (let i = 0; i < actionIds.length; i += IN_CHUNK) {
    const { data, error } = await db
      .from("channel_action_events")
      .select("id, action_id, event, actor_kind, at")
      .eq("tenant_id", tid)
      .in("action_id", actionIds.slice(i, i + IN_CHUNK))
      .in("event", [...EVENTS_READ])
      .order("at", { ascending: true })
      .limit(EVENTS_READ_CAP);
    if (error) throw new Error(`card events read failed: ${error.message}`);
    out.push(...((data ?? []) as CardEvent[]));
  }
  return out;
}

async function readNamesDefault(_tid: TenantId, _userIds: string[]): Promise<Map<string, string | null>> {
  return new Map();
}

const defaultDeps: TimelineDeps = { readEvents: readEventsDefault, readNames: readNamesDefault };

export async function withCardTimelines<V extends { id: string; exec_status: string | null; exec_bucket?: string | null }>(
  tenantId: string,
  views: V[],
  rows: ReadonlyMap<string, ApprovalRow>,
  viewerUserId: string,
  deps: Partial<TimelineDeps> = {},
): Promise<Array<V & { approval?: CardApproval | null; timeline?: TimelineEntry[]; exec_started_at?: string | null }>> {
  const d = { ...defaultDeps, ...deps };
  const exec = views.filter((v) => v.exec_status != null && rows.has(v.id));
  if (exec.length === 0) return views;
  const started = (v: V) => (v.exec_status != null && rows.has(v.id) ? { ...v, exec_started_at: rows.get(v.id)!.exec_claimed_at ?? null } : v);
  const tid = asTenantId(tenantId);
  const teammateIds = [
    ...new Set(
      exec
        .map((v) => rows.get(v.id)!)
        .filter((r) => r.approved_by && approverKind(r, viewerUserId) === "teammate")
        .map((r) => r.approved_by as string),
    ),
  ].slice(0, NAME_LOOKUP_CAP);
  const [eventsRead, names] = await Promise.all([
    Promise.resolve().then(() => d.readEvents(tid, exec.map((v) => v.id))).then(
      (events) => ({ events, failed: null as Error | null }),
      (e: unknown) => ({ events: [] as CardEvent[], failed: e as Error }),
    ),
    Promise.resolve().then(() => d.readNames(tid, teammateIds)).catch((e: unknown) => {
      console.warn(`[card-timeline] approver name read failed: ${(e as Error).message}`);
      return new Map<string, string | null>();
    }),
  ]);
  if (eventsRead.failed) {
    console.warn(`[card-timeline] events read failed, serving cards without approval: ${eventsRead.failed.message}`);
    return views.map(started);
  }
  const byAction = new Map<string, CardEvent[]>();
  for (const e of eventsRead.events) byAction.set(e.action_id, [...(byAction.get(e.action_id) ?? []), e]);
  return views.map((v) => {
    const row = rows.get(v.id);
    if (v.exec_status == null || !row) return v;
    const evs = byAction.get(v.id) ?? [];
    const approval = approvalOf(row, latestApproved(evs), viewerUserId, (id) => names.get(id) ?? null);
    return { ...started(v), approval, timeline: timelineOf(evs, { ...row, exec_bucket: v.exec_bucket ?? null }, approval) };
  });
}
