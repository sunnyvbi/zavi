
import type { Request, Response } from "express";
import { getChannel } from "@zavi/shared";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

export const SCOPES = ["real", "all", "test"] as const;
export type Scope = (typeof SCOPES)[number];

export type Counts = { total: number; d30: number; d7: number; d1: number; tenants: number };

export type RpcCountRow = {
  level: "group" | "action" | "dim";
  grp: string;
  action: string | null;
  dim: string | null;
  total: number | string;
  d30: number | string;
  d7: number | string;
  d1: number | string;
  tenants: number | string;
};
export type RpcDailyRow = { day: string; grp: string; n: number | string };
export type RpcResult = {
  tenants_in_scope: number | string;
  counts: RpcCountRow[] | null;
  daily: RpcDailyRow[] | null;
};

type DimKind = "channel" | "agent" | "action_type" | "decision_family" | "kind";

type ActionDef = { key: string; label: string; hint: string; dim?: DimKind };
type GroupDef = { key: string; label: string; description: string; actions: ActionDef[] };

const DIM_NOUN: Record<DimKind, readonly [string, string]> = {
  channel: ["channel", "channels"],
  agent: ["agent", "agents"],
  action_type: ["type", "types"],
  decision_family: ["area", "areas"],
  kind: ["kind", "kinds"],
};

export const CATALOG: readonly GroupDef[] = [
  {
    key: "channels",
    label: "Channels",
    description: "Growth-channel runs, by channel.",
    actions: [
      {
        key: "channel.run",
        label: "Channel runs",
        hint: "One row per channel run, any trigger and any outcome.",
        dim: "channel",
      },
    ],
  },
  {
    key: "channel_actions",
    label: "Channel actions",
    description: "Actions the channels proposed to founders, by action type.",
    actions: [
      {
        key: "channel_action.proposed",
        label: "Actions proposed",
        hint: "channel_actions rows, plus the older channel.recipe_step cards from before the switch.",
        dim: "action_type",
      },
    ],
  },
  {
    key: "founder",
    label: "Founder decisions",
    description: "What founders did with proposed actions and approval cards.",
    actions: [
      { key: "founder.acted", label: "Marked done", hint: "Founder marked a channel action done.", dim: "channel" },
      { key: "founder.approved", label: "Approved to run", hint: "Founder approved an executable channel action.", dim: "channel" },
      { key: "founder.rejected", label: "Rejected", hint: "Founder rejected a channel action.", dim: "channel" },
      { key: "founder.snoozed", label: "Snoozed", hint: "Founder snoozed a channel action.", dim: "channel" },
      { key: "founder.redo_requested", label: "Asked for a redo", hint: "Founder asked the channel to redo an action.", dim: "channel" },
      {
        key: "decision.approved",
        label: "Approval cards approved",
        hint: "Decisions approved or acted on. Dated by approval time when recorded.",
        dim: "decision_family",
      },
      {
        key: "decision.rejected",
        label: "Approval cards rejected",
        hint: "Decisions rejected. Dated by rejection time when recorded.",
        dim: "decision_family",
      },
    ],
  },
  {
    key: "published",
    label: "Published",
    description: "Things Zavi put live on a tenant's behalf.",
    actions: [
      {
        key: "published.social_post",
        label: "Social posts published",
        hint: "Approved posts that went live, by platform.",
        dim: "kind",
      },
      {
        key: "published.action_executed",
        label: "Actions executed",
        hint: "Approved channel actions Zavi carried out (ad changes), by channel.",
        dim: "channel",
      },
    ],
  },
  {
    key: "media",
    label: "Media generated",
    description: "Images and videos Zavi generated.",
    actions: [
      {
        key: "media.image",
        label: "Images",
        hint: "Generated images and social image panels. Screenshots and uploads are not counted.",
        dim: "kind",
      },
      {
        key: "media.video",
        label: "Videos",
        hint: "Generated videos. A launch video counts once, however many sizes it rendered.",
        dim: "kind",
      },
    ],
  },
  {
    key: "documents",
    label: "Documents",
    description: "Files Zavi produced for tenants. User uploads are not counted.",
    actions: [
      { key: "doc.pdf", label: "PDFs", hint: "PDF reports, decks and other PDF files.", dim: "kind" },
      { key: "doc.html", label: "Docs & blog posts", hint: "HTML documents and blog posts." },
      { key: "doc.spreadsheet", label: "Spreadsheets", hint: "CSV and XLSX files." },
      { key: "doc.dashboard", label: "Dashboards", hint: "Interactive dashboard blocks shown in chat." },
    ],
  },
  {
    key: "prototypes",
    label: "Wireframes & pages",
    description: "Clickable wireframes, design previews and shared pages.",
    actions: [
      { key: "proto.wireframe", label: "Wireframes", hint: "Clickable HTML wireframes published as a link." },
      { key: "proto.html_preview", label: "Design previews", hint: "Engineer design mocks that rendered before a build." },
      { key: "proto.shared_page", label: "Shared pages", hint: "Pages published with render_artifact." },
    ],
  },
  {
    key: "agents",
    label: "Agent runs",
    description: "Non-channel agent runs, split by who started them.",
    actions: [
      {
        key: "agent.run_person",
        label: "Started by a person",
        hint: "Chat, Slack, Teams, email, MCP or a manual run.",
        dim: "agent",
      },
      {
        key: "agent.run_auto",
        label: "Started automatically",
        hint: "Schedules, agent-to-agent handoffs, webhooks and other machinery.",
        dim: "agent",
      },
    ],
  },
  {
    key: "chat",
    label: "Chat",
    description: "Messages founders sent to Zavi.",
    actions: [{ key: "chat.message", label: "Messages sent", hint: "User messages in agent threads." }],
  },
];

const ACTION_TYPE_LABEL: Record<string, string> = {
  text_post: "Text post",
  image_post: "Image post",
  video_post: "Video post",
  reply: "Reply",
  send_message: "Send message",
  create_ad: "Create ad",
  update_ad: "Update ad",
  pause_ad: "Pause ad",
  fix: "Fix",
  check: "Check",
  setup: "Setup",
  page: "Page",
  other: "Other",
  legacy: "Before the switch (no type)",
};

const KIND_LABEL: Record<string, string> = {
  ai_image: "AI image",
  text_panel: "Social panel (no AI photo)",
  talking_head: "Talking head",
  cinematic: "Cinematic",
  social: "Social clip",
  launch_video: "Launch video",
  report: "Report",
  deck: "Deck",
  other: "Other",
  x: "X",
};

function humanize(key: string): string {
  const s = key.replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

export function dimLabel(kind: DimKind | undefined, key: string): string {
  if (kind === "channel") return getChannel(key)?.name ?? key;
  if (kind === "action_type") return ACTION_TYPE_LABEL[key] ?? humanize(key);
  if (kind === "kind") return KIND_LABEL[key] ?? humanize(key);
  return key;
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const counts = (r: RpcCountRow | undefined): Counts => ({
  total: num(r?.total),
  d30: num(r?.d30),
  d7: num(r?.d7),
  d1: num(r?.d1),
  tenants: num(r?.tenants),
});

export type TrackerAction = Counts & {
  key: string;
  label: string;
  hint: string;
  breakdown_label: string | null;
  breakdown: Array<Counts & { key: string; label: string }>;
};
export type TrackerGroup = Counts & {
  key: string;
  label: string;
  description: string;
  actions: TrackerAction[];
};
export type TrackerDaily = { day: string; total: number; groups: Record<string, number> };

export function shapeActionTracker(
  rpc: RpcResult,
  days: number,
  today: string,
): { tenants_in_scope: number; groups: TrackerGroup[]; daily: TrackerDaily[] } {
  const rows = rpc.counts ?? [];
  const groupRow = new Map<string, RpcCountRow>();
  const actionRow = new Map<string, RpcCountRow>();
  const dimRows = new Map<string, RpcCountRow[]>();
  for (const r of rows) {
    if (r.level === "group") groupRow.set(r.grp, r);
    else if (r.level === "action" && r.action) actionRow.set(r.action, r);
    else if (r.level === "dim" && r.action && r.dim) {
      const list = dimRows.get(r.action) ?? [];
      list.push(r);
      dimRows.set(r.action, list);
    }
  }

  const buildAction = (def: ActionDef): TrackerAction => {
    const breakdown = (dimRows.get(def.key) ?? [])
      .map((d) => ({ key: d.dim as string, label: dimLabel(def.dim, d.dim as string), ...counts(d) }))
      .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
    return {
      key: def.key,
      label: def.label,
      hint: def.hint,
      breakdown_label: def.dim ? DIM_NOUN[def.dim][breakdown.length === 1 ? 0 : 1] : null,
      breakdown,
      ...counts(actionRow.get(def.key)),
    };
  };

  const known = new Set<string>();
  for (const g of CATALOG) for (const a of g.actions) known.add(a.key);
  const catalogGroups = new Set(CATALOG.map((g) => g.key));

  const extraByGroup = new Map<string, string[]>();
  const orphans: string[] = [];
  for (const [key, row] of actionRow) {
    if (known.has(key)) continue;
    if (catalogGroups.has(row.grp)) {
      const list = extraByGroup.get(row.grp) ?? [];
      list.push(key);
      extraByGroup.set(row.grp, list);
    } else {
      orphans.push(key);
    }
  }
  const uncatalogued = (key: string): ActionDef => ({
    key,
    label: key,
    hint: "Not in the catalog yet.",
    dim: "kind",
  });

  const groups: TrackerGroup[] = CATALOG.map((g) => {
    const extra = (extraByGroup.get(g.key) ?? []).sort().map(uncatalogued);
    return {
      key: g.key,
      label: g.label,
      description: g.description,
      actions: [...g.actions, ...extra].map(buildAction),
      ...counts(groupRow.get(g.key)),
    };
  });

  const unknown = orphans.sort();
  if (unknown.length > 0) {
    const actions = unknown.map((k) => buildAction(uncatalogued(k)));
    const sum = (f: keyof Counts) => actions.reduce((s, a) => s + a[f], 0);
    groups.push({
      key: "other",
      label: "Other",
      description: "Counted by the database but not yet named here.",
      actions,
      total: sum("total"),
      d30: sum("d30"),
      d7: sum("d7"),
      d1: sum("d1"),
      tenants: Math.max(0, ...actions.map((a) => a.tenants)),
    });
  }

  const byDay = new Map<string, Record<string, number>>();
  for (const d of rpc.daily ?? []) {
    const day = String(d.day).slice(0, 10);
    const grp = CATALOG.some((g) => g.key === d.grp) ? d.grp : "other";
    const bucket = byDay.get(day) ?? {};
    bucket[grp] = (bucket[grp] ?? 0) + num(d.n);
    byDay.set(day, bucket);
  }
  const end = Date.parse(`${today}T00:00:00Z`);
  const daily: TrackerDaily[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    const g = byDay.get(day) ?? {};
    daily.push({ day, total: Object.values(g).reduce((s, n) => s + n, 0), groups: g });
  }

  return { tenants_in_scope: num(rpc.tenants_in_scope), groups, daily };
}

export async function staffActionTracker(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const rawScope = String(req.query.scope ?? "real");
  const scope: Scope = (SCOPES as readonly string[]).includes(rawScope) ? (rawScope as Scope) : "real";
  const rawDays = Number.parseInt(String(req.query.days ?? "30"), 10);
  const days = Number.isFinite(rawDays) ? Math.min(90, Math.max(7, rawDays)) : 30;

  const sb = staffCrossTenantClient("admin/action-tracker: cross-tenant staff aggregate action counts");
  const { data, error } = await sb.rpc("admin_action_counts", {
    p_scope: scope,
    p_days: days,
  });
  if (error) {
    res.status(500).json({ error: { code: "action_tracker_failed", message: error.message } });
    return;
  }

  const now = new Date();
  const shaped = shapeActionTracker((data ?? {}) as RpcResult, days, now.toISOString().slice(0, 10));
  res.json({ scope, days, generated_at: now.toISOString(), ...shaped });
}
