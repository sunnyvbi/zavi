import type { ComponentType } from "react";
import type {
  ChannelActionView,
  ExactChangeRow,
  StatTile,
} from "@/lib/workspace/channelActionsApi";
import type { AdReviewChanges } from "@zavi/shared";
export type ActionItem = ChannelActionView;
export type ExtraId =
  | "campaign_table"
  | "campaign_group_table"
  | "ads_table"
  | "x_tables"
  | "reddit_kpi_tables"
  | "seo_tables"
  | "geo_tables"
  | "linkedin_tables"
  | "instagram_tables"
  | "tiktok_tables";
export type OverviewPanelId = "email_connect" | "email_coming_up" | "email_sent_emails" | "pinterest_posted_pins";
export type SettingsPanelId =
  | "email_sending_domain"
  | "email_contact_lists"
  | "email_sendgrid"
  | "email_template"
  | "email_auto_send"
  | "email_test_lists"
  | "email_learnings"
  | "email_footer"
  | "ugc_write_brief";
export type SettingsBadgeId = "email_learnings_new";
export type SettingsFieldBase = {
  id: string;
  label: string;
  help?: string;
  writesTo?: string;
};
export type SettingsField =
  | (SettingsFieldBase & {
      kind: "list";
      itemTypes?: readonly string[];
      itemTypeOptions?: {
        unsetLabel: string;
        label: (item: string) => string;
        options: readonly { value: string; label: string }[];
      };
      suggest?: string;
      stats?: readonly { key: string; label: string }[];
      pausable?: boolean;
      placeholder?: string;
    })
  | (SettingsFieldBase & { kind: "number"; min?: number; max?: number; prefix?: string; suffix?: string })
  | (SettingsFieldBase & { kind: "choice"; options: readonly { value: string; label: string }[] })
  | (SettingsFieldBase & {
      kind: "toggle";
      on?: string;
      off?: string;
      unsetIsOn?: boolean;
    })
  | (SettingsFieldBase & { kind: "text"; placeholder?: string })
  | (SettingsFieldBase & {
      kind: "mapping";
      rowHeader: string;
      columnHeader: string;
      rows: readonly { key: string; label: string }[];
      unsetLabel: string;
      options: readonly { value: string; label: string }[];
    });
export type ChannelScanState = {
  lastAt: string | null;
  fresh: boolean;
  running: boolean;
  enabled: boolean;
  budgetExhausted: boolean;
  blockedWhy?: string | null;
  lastFailed?: string | null;
};
export type ChannelScanSpec = {
  endpoint: string;
  freshnessOf: (dashboardPayload: unknown) => ChannelScanState | null;
};
export type ChannelPayloadSpec = {
  offWhen?: (dashboardPayload: unknown) => boolean;
  liveWhen?: (dashboardPayload: unknown) => boolean;
  publishWhen?: (dashboardPayload: unknown) => boolean;
  seed?: {
    endpoint: string;
    emptyWhen: (dashboardPayload: unknown) => boolean;
  };
};
export type { PlatformSpec } from "./platformSpec";
import type { PlatformSpec } from "./platformSpec";
export type SnoozeUntil = { until: string };
export type ActionHandlers = {
  onReviseAd?: (a: ActionItem, edits: AdReviewChanges & { request_id: string }) => Promise<boolean>;
  onSetStatus: (
    a: ActionItem,
    status: "acted" | "rejected" | "snoozed",
    opts?: { note?: string; until?: string; hold?: boolean; keep?: boolean; via?: "publish" | "answer_check" },
  ) => void | Promise<unknown>;
  onRedo: (a: ActionItem, note: string, kind?: "answer") => void | Promise<unknown>;
  onApprove?: (a: ActionItem) => void | Promise<unknown>;
  onCreateAudiences?: (a: ActionItem, content: string | null) => Promise<{ ok: true; line: string } | { ok: false; message: string | null }>;
  onReopen?: (a: ActionItem) => Promise<boolean>;
  inHistory?: (a: ActionItem) => boolean;
  onReviewExecute?: () => void;
  onPublish?: (a: ActionItem, content: { text: string; thread: string[] | null; image_path?: string; post_revision?: string }) => Promise<boolean>;
  onOpenChat?: (a: ActionItem, question?: string) => void;
  onOpenRedoChat?: (a: ActionItem) => void;
  onSaveText?: (a: ActionItem, text: string) => Promise<void>;
  onOpenAnswerChat?: (a: ActionItem) => void;
  onMovePlanDay?: (a: ActionItem, day: string | null, time?: string) => Promise<string | null>;
  onEmailCardChanged?: (a: ActionItem) => void;
  onWriteProofPage?: (a: ActionItem, topic: number) => void | Promise<unknown>;
};
export type ActionRedoState = "working" | "no_replacement" | "failed";
export type ActionBodyProps = {
  action: ActionItem;
  platform?: PlatformSpec;
  handlers: ActionHandlers;
  approvalBlocked?: boolean;
  hideActions?: boolean;
  busy?: boolean;
  isNew?: boolean;
  redoing?: ActionRedoState;
  settled?: boolean;
};
export type ActionBody = ComponentType<ActionBodyProps>;
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function tiles(v: unknown): StatTile[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is StatTile => !!t && typeof (t as StatTile).value === "string" && typeof (t as StatTile).caption === "string")
    .slice(0, 4);
}
export function actionText(a: ActionItem): string | null {
  return str(a.body?.step?.body);
}
export const LINKEDIN_POST_PENDING = new Set([
  "Paste the link to the company post when you review this draft.",
  "Pick the company post to promote when you review this draft.",
]);
const PROMOTED_POST = "Promoted post";
function linkedinDraftPostSet(a: DeliverableSource): boolean {
  const presentation = a.body?.step?.deliverable?.presentation;
  if (a.channel_slug !== "linkedin_ads" || presentation?.type !== "campaign_draft") return false;
  if (typeof presentation.post_urn === "string" && presentation.post_urn.trim()) return true;
  const rows = a.body?.exact_change?.rows;
  return Array.isArray(rows) && rows.some((r) => r?.item === PROMOTED_POST && typeof r.after === "string" && /^https?:\/\//i.test(r.after));
}
export type DeliverableSource = Pick<ActionItem, "channel_slug"> & Partial<Pick<ActionItem, "body">>;
export function deliverableOf(a: DeliverableSource): { kind: string; label: string | null; content: string } | null {
  const d = a.body?.step?.deliverable;
  const raw = str(d?.content);
  const content = raw && linkedinDraftPostSet(a)
    ? str(raw.split("\n").filter((line) => !LINKEDIN_POST_PENDING.has(line.trim())).join("\n"))
    : raw;
  if (!content) return null;
  return { kind: d?.kind ?? "other", label: str(d?.label), content };
}
const MULTI_PART_KINDS = new Set(["thread", "comment"]);
function splitOnRule(content: string): string[] {
  return content
    .split(/^[ \t]*---[ \t]*$/m)
    .map((p) => p.trim())
    .filter(Boolean);
}
function ruleParts(kind: string, content: string): string[] | null {
  if (!MULTI_PART_KINDS.has(kind)) return null;
  const parts = splitOnRule(content);
  return parts.length > 1 ? parts : null;
}
function explicitParts(a: ActionItem): string[] | null {
  const d = a.body?.step?.deliverable;
  if (!d || !MULTI_PART_KINDS.has(d.kind ?? "") || !Array.isArray(d.parts)) return null;
  const out: string[] = [];
  for (const p of d.parts) {
    const content = str(p?.content);
    if (!content) continue;
    const label = d.kind === "thread" ? null : str(p?.label)?.trim();
    for (const opener of splitOnRule(content)) out.push(label ? `${label}\n${opener}` : opener);
  }
  return out.length ? out : null;
}
export function postContent(a: ActionItem): { text: string; thread: string[] | null } {
  const edited = a.edited_body;
  if (edited && typeof edited.text === "string" && edited.text.trim()) {
    return { text: edited.text, thread: Array.isArray(edited.thread) && edited.thread.length ? edited.thread : null };
  }
  const thread = Array.isArray(a.body?.thread) && a.body.thread.length ? a.body.thread.filter((p): p is string => typeof p === "string") : null;
  if (thread?.length) return { text: deliverableOf(a)?.content ?? actionText(a) ?? a.title, thread };
  const d = deliverableOf(a);
  const parts = explicitParts(a) ?? (d ? ruleParts(d.kind, d.content) : null);
  if (parts) return { text: parts[0], thread: parts.slice(1) };
  return { text: d?.content ?? actionText(a) ?? a.title, thread: null };
}
export function deliverableParts(a: DeliverableSource): Array<{ label: string; content: string }> | null {
  const raw = a.body?.step?.deliverable?.parts;
  if (!Array.isArray(raw)) return null;
  const parts = raw
    .map((p, i) => ({ label: str(p?.label)?.trim() ?? `Part ${i + 1}`, content: str(p?.content) }))
    .filter((p): p is { label: string; content: string } => !!p.content);
  return parts.length >= 2 ? parts : null;
}
export function copyAllParts(parts: Array<{ label: string; content: string }>): string {
  return parts.map((p) => `${p.label}\n${p.content}`).join("\n\n");
}
export function partPostContent(a: ActionItem, content: string): { text: string; thread: string[] | null } {
  const split = ruleParts(a.body?.step?.deliverable?.kind ?? "other", content);
  return split ? { text: split[0], thread: split.slice(1) } : { text: content, thread: null };
}
export function modelSteps(a: ActionItem): string[] | null {
  const raw: unknown = a.body?.step?.how_to;
  const lines = typeof raw === "string" ? raw.split(/\r?\n/) : Array.isArray(raw) ? raw : [];
  const out = lines.filter((l): l is string => typeof l === "string").map((l) => l.trim()).filter(Boolean);
  return out.length ? out : null;
}
export function execInFlight(a: ActionItem): boolean {
  return a.exec_status === "queued" || a.exec_status === "dispatching";
}
export type CardEvidence = {
  stats: StatTile[];
  estimate: StatTile[];
  window: { from: string; to: string } | null;
  reason: string | null;
};
export function cardEvidence(a: ActionItem): CardEvidence {
  const de = a.body?.decision_evidence;
  const ce = a.body?.step?.card_evidence;
  const src = de ?? ce ?? null;
  return {
    stats: tiles(src?.stats),
    estimate: tiles(src?.estimate),
    window: src?.window && str(src.window.from) && str(src.window.to) ? src.window : null,
    reason: str(de?.reason_text),
  };
}
export function exactChangeRows(a: ActionItem): ExactChangeRow[] {
  const rows = a.body?.exact_change?.rows;
  if (!Array.isArray(rows)) return [];
  const valid = rows.filter(
    (r): r is ExactChangeRow =>
      !!r && typeof r.item === "string" && typeof r.before === "string" && typeof r.after === "string",
  );
  if (a.channel_slug !== "linkedin_ads") return valid;
  return valid.map((r) => r.item === PROMOTED_POST && /^https?:\/\/\S+\/$/i.test(r.after) ? { ...r, after: r.after.replace(/\/+$/, "") } : r);
}
export function actionLink(a: ActionItem): string | null {
  const l = str(a.body?.link);
  return l && /^https?:\/\//i.test(l) ? l : null;
}
export function targetKindOf(a: ActionItem): string | null {
  return str(a.body?.step?.target?.kind);
}
export function cardManagerLink(a: ActionItem): string | null {
  const link = str((a.body as { link?: unknown } | null | undefined)?.link);
  return link && /^https:\/\/www\.linkedin\.com\/campaignmanager\/accounts\/\d+\/campaigns\/\d+\/summary$/.test(link) ? link : null;
}
export function cardAccountId(a: ActionItem): string | null {
  const own = str((a.body as { account_id?: unknown } | null | undefined)?.account_id);
  if (own && /^\d+$/.test(own)) return own;
  return /https:\/\/www\.linkedin\.com\/campaignmanager\/accounts\/(\d+)/.exec(JSON.stringify(a.body ?? {}))?.[1] ?? null;
}
export function mediaOf(
  a: Pick<ActionItem, "body">,
): { kind: "image" | "video"; url: string; alt: string; downloadUrl: string | null; artifactId: string | null } | null {
  const m = a.body?.media;
  const url = str(m?.url);
  if (!m || !url || !/^https?:\/\//i.test(url)) return null;
  const dl = str(m.download_url);
  return {
    kind: m.kind === "video" ? "video" : "image",
    url,
    alt: str(m.alt) ?? "",
    downloadUrl: dl && /^https?:\/\//i.test(dl) ? dl : null,
    artifactId: m.kind === "video" ? str(m.artifact_id) ?? null : null,
  };
}
const EFFORT: Record<string, string> = { minutes: "a few minutes", hours: "a few hours", days: "a few days" };
export function effortLabel(a: ActionItem): string | null {
  const e = a.body?.step?.effort;
  return typeof e === "string" ? EFFORT[e] ?? null : null;
}
export const CONFIRM_RE = /\[CONFIRM:/i;
