"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Archive, GitPullRequest, SearchCheck } from "lucide-react";
import {
  useAgentDashboard,
  DashboardShell,
  SectionTitle,
  AttentionList,
  EmptyState,
  ago,
  type AgentDashboardActiveRun,
  type AttentionItem,
} from "./dashboard-ui";
import { useWorkspace } from "@/components/workspace/WorkspaceShell";
import { ProposalDiff } from "@/components/agents/ProposalDiff";
import { CollapsibleMarkdown } from "../CollapsibleMarkdown";
import { Markdown } from "../Markdown";
import { apiFetch } from "@/lib/api";
import { staffModelBodyField } from "@/lib/workspace/staffModelParam";
import { NextChevron } from "@/components/ui/NextChevron";

type QueueRow = {
  id: string;
  source: "decision" | "run";
  title: string;
  target_keyword: string | null;
  change_type: string | null;
  file_action: "create" | "modify" | "delete" | null;
  status: string;
  emitted_at: string | null;
  expires_at: string | null;
  path: string | null;
  repo: string | null;
  base_branch: string | null;
  head_branch: string | null;
  recommendation_markdown: string | null;
  draft_markdown: string | null;
  changes?: { before: string; after: string }[] | null;
  run_id?: string;
};

type Payload = {
  agent_slug?: string;
  generic?: boolean;
  refreshed_at?: string;
  active_run?: AgentDashboardActiveRun | null;
  last_audit_at?: string | null;
  kpis: {
    prs_opened: number;
    pending: number;
    drafted_last_30d: number;
    last_draft_at: string | null;
  };
  has_publish_target: boolean | null;
  queue: QueueRow[];
  attention: AttentionItem[];
};

const SLUG = "content-design";
const FULL_SITE_AUDIT_MESSAGE =
  "Run a fresh content-design review. Read the connected repo and live product, then start from real user needs across the homepage, landing/product/pricing/help/docs pages, in-product copy (buttons, empty states, errors), internal links, and content gaps. Propose up to 5 approval-ready content changes (clearer copy, a better label, structure, or removing content), each tied to a user need and evidence, with a success signal (task completion, comprehension, fewer support tickets). Prioritize improving existing surfaces over net-new posts unless a new page is clearly the highest-leverage move.";

type StatusTone =
  | "needs_ok"
  | "pr_open"
  | "passed"
  | "refresh"
  | "expired"
  | "neutral";
function statusInfo(status: string): { tone: StatusTone; label: string } {
  switch (status) {
    case "acted":
      return { tone: "pr_open", label: "PR open" };
    case "approved":
      return { tone: "pr_open", label: "Opening PR" };
    case "rejected":
      return { tone: "passed", label: "Passed" };
    case "proposed":
      return { tone: "needs_ok", label: "Needs your OK" };
    case "drafted_unqueued":
      return { tone: "refresh", label: "Needs refresh" };
    case "expired":
      return { tone: "expired", label: "Expired" };
    default:
      return { tone: "neutral", label: status };
  }
}

function StatusIcon({ tone }: { tone: StatusTone }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    width: 11,
    height: 11,
    "aria-hidden": true as const,
  };
  if (tone === "needs_ok" || tone === "expired") {
    return (
      <svg {...common} strokeWidth={2.4}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }
  if (tone === "pr_open") {
    return (
      <svg {...common} strokeWidth={2.6}>
        <path d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (tone === "passed") {
    return (
      <svg {...common} strokeWidth={2.4}>
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    );
  }
  if (tone === "refresh") {
    return (
      <svg {...common} strokeWidth={2.4}>
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v4h4" />
      </svg>
    );
  }
  return (
    <svg {...common} strokeWidth={2.4}>
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

const STATUS_PILL: Record<StatusTone, string> = {
  needs_ok: "bg-[#fff7e0] text-[#8a6d00] border-[#f1e3b0]",
  pr_open: "bg-[#e7f4ee] text-[#167f50] border-[#c4e4d4]",
  passed: "bg-[#fbe9ea] text-[#cb2029] border-[#f0c9cc]",
  refresh: "bg-[#fff3e0] text-[#b45309] border-[#f5d9a8]",
  expired: "bg-[#eef0f2] text-[#595959] border-[#dfe2e6]",
  neutral: "bg-[#f1f0ec] text-[#595959] border-[#e5e7eb]",
};

function StatusPill({ status }: { status: string }) {
  const { tone, label } = statusInfo(status);
  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${STATUS_PILL[tone]}`}
    >
      <StatusIcon tone={tone} />
      {label}
    </span>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.3}
      className={`h-4 w-4 shrink-0 text-[#8a8a8a] transition-transform ${
        expanded ? "rotate-180" : ""
      }`}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function addDaysIso(iso: string | null, days: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 24 * 60 * 60 * 1000).toISOString();
}

function extractPostTitle(proposalTitle: unknown): string | null {
  if (typeof proposalTitle !== "string") return null;
  const m = proposalTitle.match(/^content:\s*[a-z -]+\s*"(.*)"\s*$/i);
  return (m ? m[1] : proposalTitle).trim() || null;
}

function extractKeyword(proposalBody: unknown): string | null {
  if (typeof proposalBody !== "string") return null;
  const m = proposalBody.match(/targeting\s+\*\*(.+?)\*\*/i);
  return m ? m[1].trim() : null;
}

function firstFile(body: unknown): {
  path: string | null;
  action: "create" | "modify" | "delete" | null;
  content: string | null;
} {
  if (!body || typeof body !== "object") {
    return { path: null, action: null, content: null };
  }
  const files = (body as { files?: unknown }).files;
  if (!Array.isArray(files)) return { path: null, action: null, content: null };
  for (const f of files as Array<{ path?: unknown; action?: unknown; content?: unknown }>) {
    const path = typeof f.path === "string" ? f.path : null;
    const action =
      f.action === "create" || f.action === "modify" || f.action === "delete"
        ? f.action
        : null;
    const content = typeof f.content === "string" ? f.content : null;
    if (path || action || content) return { path, action, content };
  }
  return { path: null, action: null, content: null };
}

function rowFromDecision(decision: unknown): Partial<QueueRow> | null {
  if (!decision || typeof decision !== "object") return null;
  const d = decision as {
    id?: unknown;
    status?: unknown;
    emitted_at?: unknown;
    body?: Record<string, unknown> | null;
  };
  if (typeof d.id !== "string") return null;
  const b = d.body ?? {};
  const file = firstFile(b);
  const emittedAt = typeof d.emitted_at === "string" ? d.emitted_at : null;
  const detail: Partial<QueueRow> = {};
  if (typeof d.status === "string") detail.status = d.status;
  const title = extractPostTitle(b.title);
  if (title) detail.title = title;
  const keyword = extractKeyword(b.body);
  if (keyword) detail.target_keyword = keyword;
  if (typeof b.change_type === "string") detail.change_type = b.change_type;
  if (file.action) detail.file_action = file.action;
  if (emittedAt) {
    detail.emitted_at = emittedAt;
    detail.expires_at = addDaysIso(emittedAt, 7);
  }
  if (file.path) detail.path = file.path;
  if (file.content) detail.draft_markdown = file.content;
  if (typeof b.repo === "string") detail.repo = b.repo;
  if (typeof b.base_branch === "string") detail.base_branch = b.base_branch;
  if (typeof b.head_branch === "string") detail.head_branch = b.head_branch;
  if (typeof b.rendered_markdown === "string") {
    detail.recommendation_markdown = b.rendered_markdown;
  }
  return detail;
}

async function fetchDecisionDetail(id: string): Promise<Partial<QueueRow> | null> {
  const history = await apiFetch(
    `/api/approvals/history?agent_slug=${SLUG}&limit=100`,
  );
  if (history.ok) {
    const json = (await history.json()) as { decisions?: unknown[] };
    const found = (json.decisions ?? []).find(
      (d) => d && typeof d === "object" && (d as { id?: unknown }).id === id,
    );
    const row = rowFromDecision(found);
    if (row) return row;
  }

  const proposed = await apiFetch("/api/approvals?status=proposed&include=none");
  if (proposed.ok) {
    const json = (await proposed.json()) as { decisions?: unknown[] };
    const found = (json.decisions ?? []).find(
      (d) => d && typeof d === "object" && (d as { id?: unknown }).id === id,
    );
    return rowFromDecision(found);
  }

  return null;
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[#8a8a8a]">
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-[12px] text-[#0e0f11]">
        {value}
      </div>
    </div>
  );
}

function changeTypeLabel(row: QueueRow): string {
  switch (row.change_type) {
    case "new_landing_page":
      return "New landing page proposal";
    case "improve_existing_page":
      return "Existing page improvement";
    case "refresh_existing_post":
      return "Existing post refresh";
    case "add_internal_links":
      return "Internal link update";
    case "new_blog_post":
    case "new_page":
      return "New blog post proposal";
    case "component_copy":
      return "In-product copy change";
  }
  const path = row.path?.toLowerCase() ?? "";
  if (path.includes("/blog/") || path.startsWith("content/blog/")) {
    return "New blog post proposal";
  }
  if (row.file_action === "modify") return "Existing content improvement";
  return "New content proposal";
}

function goalSentence(row: QueueRow): string {
  const keyword = row.target_keyword?.trim();
  if (row.change_type === "component_copy") {
    return "Improve in-product copy so the next action is clearer for the user.";
  }
  if (row.file_action === "modify") {
    if (keyword) {
      return `Improve existing content for people who want "${keyword}".`;
    }
    return "Improve existing content so it's clearer, better structured, or better linked.";
  }
  if (row.change_type === "new_landing_page") {
    if (keyword) {
      return `Create a new page for people who want "${keyword}".`;
    }
    return "Create a new page for a user need I found.";
  }
  if (keyword) return `Write a new article for people who want "${keyword}".`;
  return "Meet a user need I found and turn the draft into a reviewable PR.";
}

function evidenceLabel(row: QueueRow): string {
  if (row.change_type === "component_copy") {
    return "Why: an unclear moment in the product";
  }
  if (row.change_type === "add_internal_links") {
    return "Why: key pages need better internal links";
  }
  if (
    row.file_action === "modify" ||
    row.change_type === "improve_existing_page" ||
    row.change_type === "refresh_existing_post"
  ) {
    return "Why: an existing page can be clearer or better structured";
  }
  if (row.change_type === "new_landing_page") {
    return "Why: a user need you don't have a page for";
  }
  const path = (row.path ?? "").toLowerCase();
  if (
    row.change_type === "new_blog_post" ||
    row.change_type === "new_page" ||
    path.includes("/blog/")
  ) {
    return "Why: a common question with no clear answer";
  }
  return "Why: a user need I found";
}

function statusSentence(row: QueueRow, expiresAt: string | null): string {
  switch (row.status) {
    case "proposed":
      return `I drafted this and need your OK before I open a PR. Please review by ${fmtDate(expiresAt)}.`;
    case "drafted_unqueued":
      return "I drafted this but couldn't package it for approval. Ask me to refresh and I'll re-queue it cleanly (or drop it if it's stale).";
    case "expired":
      return `The review window closed ${fmtDate(expiresAt)}. I can regenerate it if it still matters.`;
    case "approved":
      return "You approved it. I'm opening the PR on GitHub now.";
    case "acted":
      return "The PR is open on GitHub. It reaches your site only when you merge it, and I can't see whether you have.";
    case "rejected":
      return "You passed on this. I won't send it to your site.";
    default:
      return row.status;
  }
}

function nextAction(row: QueueRow): string {
  switch (row.status) {
    case "proposed":
      return "Review it in Needs you. Approving opens a PR you still merge.";
    case "drafted_unqueued":
      return "Ask me to refresh & re-queue it.";
    case "expired":
      return "Ask me to regenerate it if the topic still matters, otherwise leave it.";
    case "approved":
      return "Nothing yet. The PR link shows up here once it's open.";
    case "acted":
      return "Review & merge the PR on GitHub to publish.";
    case "rejected":
      return "Nothing needed.";
    default:
      return "Ask me what's next.";
  }
}

function fileActionLabel(row: QueueRow): string {
  const action = row.file_action ?? (row.change_type?.startsWith("new_") ? "create" : null);
  const path = row.path || "a markdown/MDX file in the connected repo";
  if (action === "modify") return `Modify ${path}`;
  if (action === "delete") return `Delete ${path}`;
  return `Create ${path}`;
}

function sourceTimestamp(row: QueueRow): string {
  const prefix = row.source === "run" ? "Draft recovered" : "Drafted";
  return `${prefix} ${ago(row.emitted_at)}`;
}

function isNeedsOk(row: QueueRow): boolean {
  return row.status === "proposed";
}
function isInMotion(row: QueueRow): boolean {
  return row.status === "approved" || row.status === "acted";
}
function isNeedsRefresh(row: QueueRow): boolean {
  return row.status === "drafted_unqueued";
}
function isEarlier(row: QueueRow): boolean {
  return row.status === "expired" || row.status === "rejected";
}
function isCurrentRow(row: QueueRow): boolean {
  return row.status === "proposed" || row.status === "approved";
}
function isHistoricalRow(row: QueueRow): boolean {
  return !isCurrentRow(row);
}

type SurfaceStatus = "current" | "historical" | "checked" | "needs_audit";
type AuditSurfaceId = "home" | "host" | "renter" | "trust" | "blog" | "links";

type AuditSurface = {
  id: AuditSurfaceId;
  label: string;
  rows: QueueRow[];
  status: SurfaceStatus;
};

const SURFACE_DEFS: Array<{ id: AuditSurfaceId; label: string }> = [
  { id: "home", label: "Homepage" },
  { id: "host", label: "Host landing" },
  { id: "renter", label: "Renter / product pages" },
  { id: "trust", label: "Pricing, FAQ, docs" },
  { id: "blog", label: "Blog / content" },
  { id: "links", label: "Internal links" },
];

function rowSurfaceId(row: QueueRow): AuditSurfaceId {
  const path = (row.path ?? "").toLowerCase();
  const title = row.title.toLowerCase();
  const text = `${path} ${title}`;
  if (row.change_type === "add_internal_links" || /internal[-\s]?link/.test(text)) {
    return "links";
  }
  if (path.includes("/blog/") || path.includes("/posts/") || path.includes("/content/")) {
    return "blog";
  }
  if (/host|owner|list|share|earn/.test(text)) return "host";
  if (/renter|guest|driver|book|trip|city|location/.test(text)) return "renter";
  if (/price|pricing|faq|help|docs|policy|insurance|protection|trust|terms/.test(text)) {
    return "trust";
  }
  if (/home|index|root/.test(text)) return "home";
  return "renter";
}

function statusForRows(rows: QueueRow[], hasAuditRun: boolean): SurfaceStatus {
  if (rows.some(isCurrentRow)) return "current";
  if (rows.length > 0) return "historical";
  if (hasAuditRun) return "checked";
  return "needs_audit";
}

function buildAuditSurfaces(
  queue: QueueRow[],
  lastAuditAt?: string | null,
): AuditSurface[] {
  const grouped = new Map<AuditSurfaceId, QueueRow[]>();
  const hasAuditRun = Boolean(lastAuditAt);
  for (const row of queue) {
    const id = rowSurfaceId(row);
    grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  return SURFACE_DEFS.map((surface) => {
    const rows = grouped.get(surface.id) ?? [];
    return { ...surface, rows, status: statusForRows(rows, hasAuditRun) };
  });
}

function surfaceNote(surface: AuditSurface): string {
  switch (surface.status) {
    case "current":
      return `${surface.rows.filter(isCurrentRow).length} current finding`;
    case "historical":
      return "Past drafts only";
    case "checked":
      return "Checked, nothing to change";
    case "needs_audit":
      return "Not reviewed yet";
  }
}

function TruthStrip() {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-[#efe6c6] bg-[#fffdf6] px-3.5 py-2.5 text-[13px] leading-relaxed text-[#6b6450]">
      <span
        className="mt-0.5 inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[#f0e3b0] text-[12px] font-bold text-[#8a6d00]"
        aria-hidden="true"
      >
        i
      </span>
      <div>
        No analytics connected, so{" "}
        <span className="font-semibold text-[#0e0f11]">impact is my estimate</span>{" "}
        from your site, repo &amp; product, not measured data. When you approve,{" "}
        <span className="font-semibold text-[#0e0f11]">
          I open a pull request. You review and merge it
        </span>{" "}
        to publish. I never publish on my own.
      </div>
    </div>
  );
}

function StandupHeader({
  needsOk,
  inMotion,
  needsRefresh,
  checkedAreas,
  lastAuditAt,
  hasPublishTarget,
}: {
  needsOk: number;
  inMotion: number;
  needsRefresh: number;
  checkedAreas: number;
  lastAuditAt: string | null;
  hasPublishTarget: boolean | null;
}) {
  const lead =
    needsOk > 0
      ? `I reviewed your whole product. ${needsOk} ${needsOk === 1 ? "thing needs" : "things need"} your OK${inMotion > 0 ? `, ${inMotion} already in motion` : ""}, and I checked ${checkedAreas} ${checkedAreas === 1 ? "area" : "areas"}.`
      : `I reviewed your whole product. Nothing needs your OK right now${inMotion > 0 ? `, ${inMotion} in motion` : ""}, and I checked ${checkedAreas} ${checkedAreas === 1 ? "area" : "areas"}.`;

  return (
    <section className="rounded-2xl border border-[#e5e7eb] bg-white px-6 py-4">
      <p className="m-0 text-[16px] leading-relaxed text-[#0e0f11]">{lead}</p>
      <div className="mt-1.5 text-[12px] text-[#8a8a8a]">
        Last review {ago(lastAuditAt)}
        {hasPublishTarget === true ? " · site repo connected ✓" : ""}
        {hasPublishTarget === false ? " · no site connected yet" : ""}
      </div>
      <div className="mt-4 flex flex-wrap gap-2.5">
        <Chip n={needsOk} label="need your OK" tone="needs_ok" />
        <Chip n={inMotion} label="in motion" tone="pr_open" />
        <Chip n={checkedAreas} label="areas checked" tone="neutral" />
        {needsRefresh > 0 ? (
          <Chip n={needsRefresh} label="need a refresh" tone="refresh" />
        ) : null}
      </div>
    </section>
  );
}

function Chip({ n, label, tone }: { n: number; label: string; tone: StatusTone }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-xl border border-[#f0f0f0] bg-[#fbfaf7] px-3 py-2 text-[13px] text-[#3a3d42]">
      <span
        className={`inline-flex h-1.5 w-1.5 rounded-full ${STATUS_PILL[tone].split(" ")[0]}`}
        aria-hidden="true"
      />
      <span className="text-[14px] font-semibold text-[#0e0f11]">{n}</span>
      {label}
    </span>
  );
}

function AskCard({
  row,
  onReview,
  onSendChat,
}: {
  row: QueueRow;
  onReview: (decisionId: string) => void;
  onSendChat: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hydrated, setHydrated] = useState<Partial<QueueRow> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const displayRow = { ...row, ...(hydrated ?? {}) };
  const displayExpiresAt =
    displayRow.expires_at ?? addDaysIso(displayRow.emitted_at, 7);
  const isRefresh = isNeedsRefresh(displayRow);

  useEffect(() => {
    if (!expanded) return;
    if (displayRow.draft_markdown || row.source !== "decision") return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    fetchDecisionDetail(row.id)
      .then((detail) => {
        if (cancelled) return;
        if (detail) setHydrated(detail);
        else setDetailError("Draft details were not found for this proposal.");
      })
      .catch((e) => {
        if (cancelled) return;
        setDetailError(e instanceof Error ? e.message : "Could not load draft details.");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [displayRow.draft_markdown, expanded, row.id, row.source]);

  return (
    <article
      className={`rounded-2xl border px-4 py-4 transition-colors ${
        isRefresh
          ? "border-[#f0d2d2] bg-[#fffafa] hover:border-[#e7b9b9]"
          : "border-[#f0f0f0] bg-white hover:border-[#d8d8d8]"
      }`}
    >
      <div className="flex items-start justify-between gap-3.5">
        <div className="min-w-0">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
            {changeTypeLabel(displayRow)}
          </div>
          <h4 className="m-0 min-w-0 break-words text-[16px] font-semibold leading-tight text-[#0e0f11]">
            {displayRow.title}
          </h4>
        </div>
        <StatusPill status={displayRow.status} />
      </div>

      <p className="mt-2.5 max-w-[68ch] text-[16px] leading-relaxed text-[#595959]">
        {statusSentence(displayRow, displayExpiresAt)}
      </p>

      <div className="mt-1.5 max-w-[68ch] text-[13px] leading-relaxed text-[#8a8a8a]">
        {goalSentence(displayRow)}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="inline-block rounded-md border border-[#e7e3d8] bg-[#f3f1ec] px-2 py-0.5 text-[11px] font-semibold text-[#6a6657]">
          {evidenceLabel(displayRow)}
        </span>
        <span className="text-[12px] text-[#8a8a8a]">
          → {fileActionLabel(displayRow)}
        </span>
      </div>

      {Array.isArray(displayRow.changes) && displayRow.changes.length > 0 ? (
        <div className="mt-3">
          <ProposalDiff changes={displayRow.changes} />
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {isRefresh ? (
          <button
            type="button"
            onClick={() =>
              onSendChat(
                `Refresh the content-design review and re-queue the best approval-ready change for "${displayRow.title}" cleanly for approval (drop it if it's now stale). ${FULL_SITE_AUDIT_MESSAGE}`,
              )
            }
            className="inline-flex cursor-pointer items-center justify-center rounded-cta border border-transparent bg-[#0e0f11] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#25262a]"
          >
            Ask me to refresh &amp; re-queue
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (row.source === "decision") onReview(row.id);
            }}
            className="inline-flex cursor-pointer items-center justify-center gap-1 rounded-cta border border-transparent bg-[#0e0f11] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#25262a]"
          >
            Review it in Needs you <NextChevron />
          </button>
        )}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="inline-flex cursor-pointer items-center gap-2 rounded-cta border border-[#e2e0da] bg-white px-3.5 py-2 text-[13px] font-semibold text-[#3a3d42] transition-colors hover:bg-[#f7f5f0]"
        >
          {isRefresh ? "Read the old draft" : "Read full draft"}
          <Chevron expanded={expanded} />
        </button>
        {!isRefresh ? (
          <button
            type="button"
            onClick={() =>
              onSendChat(
                `Revise the proposed content "${displayRow.title}"${displayRow.path ? ` (${displayRow.path})` : ""} and re-queue it for approval. Tighten it and make sure it's PR-ready.`,
              )
            }
            className="inline-flex cursor-pointer items-center justify-center rounded-cta border border-[#e2e0da] bg-white px-3.5 py-2 text-[13px] font-semibold text-[#3a3d42] transition-colors hover:bg-[#f7f5f0]"
          >
            Ask me to revise it
          </button>
        ) : null}
      </div>

      <div className="mt-3 text-[12px] tabular-nums text-[#8a8a8a]">
        {sourceTimestamp(displayRow)} · {nextAction(displayRow)}
      </div>

      {expanded ? (
        <div className="mt-4 border-t border-[#f0f0f0] pt-4">
          <div className="mb-4 rounded-xl border border-[#f0e2c0] bg-[#fdfaf0] px-3 py-2.5 text-[13px] leading-relaxed text-[#595959]">
            <span className="font-semibold text-[#0e0f11]">Approval handoff:</span>{" "}
            approving this opens a PR that changes the markdown/MDX file. I do not
            merge the PR or publish the page automatically.
          </div>

          <div className="grid grid-cols-1 gap-3 border-y border-[#f0f0f0] py-3 sm:grid-cols-2">
            <DetailRow label="Repo" value={displayRow.repo} />
            <DetailRow label="Base" value={displayRow.base_branch} />
            <DetailRow label="Branch" value={displayRow.head_branch} />
            <DetailRow label="Review by" value={fmtDate(displayExpiresAt)} />
          </div>

          {displayRow.recommendation_markdown ? (
            <div className="mt-4">
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[#8a8a8a]">
                My recommendation
              </div>
              <Markdown
                source={displayRow.recommendation_markdown}
                disableActionLinks
                className="text-[16px] prose-p:text-[16px] prose-li:text-[16px]"
              />
            </div>
          ) : null}

          <div className="mt-4">
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[#8a8a8a]">
              Draft preview
            </div>
            {displayRow.draft_markdown ? (
              <div className="rounded-xl border border-[#f0f0f0] bg-white p-4">
                <CollapsibleMarkdown text={displayRow.draft_markdown}>
                  <Markdown
                    source={displayRow.draft_markdown}
                    disableActionLinks
                    className="text-[16px] prose-p:text-[16px] prose-li:text-[16px] prose-h1:text-[20px] prose-h2:text-[16px] prose-h3:text-[14px]"
                  />
                </CollapsibleMarkdown>
              </div>
            ) : detailLoading ? (
              <div className="rounded-xl border border-dashed border-[#e5e7eb] bg-white px-4 py-4 text-[13px] text-[#8a8a8a]">
                Loading full draft...
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-[#e5e7eb] bg-white px-4 py-4 text-[13px] text-[#8a8a8a]">
                {detailError ?? "Full draft body is not available for this row."}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function MiniRow({ row }: { row: QueueRow }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#f0f0f0] py-2.5 last:border-b-0">
      <span className="min-w-0 truncate text-[13px] text-[#0e0f11]">
        {row.title}
      </span>
      <StatusPill status={row.status} />
    </div>
  );
}

function FoldedGroup({
  title,
  count,
  children,
  danger = false,
}: {
  title: string;
  count: number;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <details
      className={`rounded-2xl border px-4 py-3.5 ${
        danger ? "border-[#f0d2d2] bg-[#fffafa]" : "border-[#f0f0f0] bg-white"
      }`}
    >
      <summary className="cursor-pointer list-none text-[13px] font-semibold text-[#3a3d42] [&::-webkit-details-marker]:hidden">
        <span className="text-[#8a8a8a]">▸</span> {title} ({count})
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

function AuditCommandPanel({
  data,
  onRanComplete,
  onQueued,
}: {
  data: Payload;
  onRanComplete: () => void;
  onQueued: (run: AgentDashboardActiveRun) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const currentCount = data.queue.filter(isCurrentRow).length;
  const historicalCount = data.queue.filter(isHistoricalRow).length;
  const hasPublishTarget = data.has_publish_target !== false;

  const onRunAudit = useCallback(async () => {
    setErrorMsg(null);
    setStarting(true);
    try {
      const res = await apiFetch(`/api/agents/${SLUG}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: FULL_SITE_AUDIT_MESSAGE, thread_id: null, ...staffModelBodyField() }),
        idempotent: true,
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setErrorMsg(
          json?.error?.message
            ? `Couldn't start the review: ${json.error.message}`
            : `Couldn't start the review. HTTP ${res.status}.`,
        );
        return;
      }
      const json = (await res.json()) as { run_id?: unknown };
      if (typeof json.run_id === "string" && json.run_id.length > 0) {
        onQueued({
          run_id: json.run_id,
          status: "queued",
          enqueued_at: new Date().toISOString(),
          started_at: null,
        });
        onRanComplete();
      } else {
        onRanComplete();
      }
    } catch {
      setErrorMsg("Couldn't start the review. Try again.");
    } finally {
      setStarting(false);
    }
  }, [onQueued, onRanComplete]);

  return (
    <section className="rounded-xl border border-[#e5e7eb] bg-white px-4 py-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#0e0f11] text-white">
              <SearchCheck className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-[14px] font-semibold text-[#0e0f11]">
                Run a content-design review
              </h3>
              <p className="text-[13px] leading-relaxed text-[#595959]">
                I'll review the connected repo and live product, start from real
                user needs across pages and in-product copy, then queue
                approval-ready content changes tied to a user need and evidence.
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-[12px] text-[#595959]">
            <span className="inline-flex items-center gap-2 rounded-lg border border-[#f0f0f0] bg-[#fbfaf7] px-2.5 py-1">
              <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
              {currentCount} current
            </span>
            <span className="inline-flex items-center gap-2 rounded-lg border border-[#f0f0f0] bg-[#fbfaf7] px-2.5 py-1">
              <Archive className="h-3.5 w-3.5" aria-hidden="true" />
              {historicalCount} historical
            </span>
            <span className="inline-flex items-center rounded-lg border border-[#f0f0f0] bg-[#fbfaf7] px-2.5 py-1">
              Last review {ago(data.last_audit_at ?? data.kpis.last_draft_at)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
          <button
            type="button"
            onClick={onRunAudit}
            disabled={starting}
            className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-cta bg-[#0e0f11] px-4 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-[#25262a] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <SearchCheck className="h-4 w-4" aria-hidden="true" />
            {starting ? "Starting review..." : "Run review"}
          </button>
          <span className="max-w-[260px] text-right text-[12px] leading-relaxed text-[#8a8a8a]">
            {hasPublishTarget
              ? "Approval still opens a PR. Nothing merges automatically."
              : "Connect a repo to turn review output into PR proposals."}
          </span>
        </div>
      </div>

      {errorMsg ? (
        <div role="alert" className="mt-3 text-[12px] text-[#cb2029]">
          {errorMsg}
        </div>
      ) : null}
    </section>
  );
}

function HowItWorks() {
  const steps = [
    ["1", "I review your content"],
    ["2", "I propose a change for a user need"],
    ["3", "You approve"],
    ["4", "A PR opens"],
    ["5", "You merge to publish"],
  ] as const;
  return (
    <div className="rounded-2xl border border-[#f0f0f0] bg-white px-4 py-4">
      <SectionTitle>How this works</SectionTitle>
      <div className="flex flex-col gap-2.5">
        {steps.map(([n, label]) => (
          <div key={n} className="flex items-center gap-2.5 text-[13px] text-[#0e0f11]">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[#d8d8d8] bg-[#fbfaf7] text-[11px] font-semibold text-[#595959]">
              {n}
            </span>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-[#595959]">
        A draft becomes a site change only after you approve, a PR opens, and you
        merge it.
      </p>
    </div>
  );
}

function PublishTargetPanel({ has }: { has: boolean | null }) {
  if (has === null) return null;
  return (
    <div className="rounded-2xl border border-[#f0f0f0] bg-white px-4 py-4">
      <SectionTitle>Publish target</SectionTitle>
      {has ? (
        <div className="flex items-center gap-2 rounded-xl border border-[#f0f0f0] bg-[#f7f4ee] px-3 py-2.5 text-[13px] text-[#0e0f11]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            className="h-4 w-4 shrink-0"
            aria-hidden="true"
          >
            <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 00-1-2.6c3-.3 6-1.5 6-6.5a5 5 0 00-1.4-3.5 4.7 4.7 0 00-.1-3.5s-1.1-.3-3.5 1.3a12 12 0 00-6.4 0C6.3 1.7 5.2 2 5.2 2a4.7 4.7 0 00-.1 3.5A5 5 0 003.7 9c0 5 3 6.2 6 6.5a3.4 3.4 0 00-1 2.6V22" />
          </svg>
          <span>Site repo connected</span>
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-[#167f50]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              className="h-3 w-3"
              aria-hidden="true"
            >
              <path d="M5 13l4 4L19 7" />
            </svg>
            Connected
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-[#f0c9cc] bg-[#fbe9ea] px-3 py-2.5 text-[13px] text-[#cb2029]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            className="h-4 w-4 shrink-0"
            aria-hidden="true"
          >
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
          </svg>
          <span>No site connected yet</span>
        </div>
      )}
      <p className="mt-2.5 text-[12px] leading-relaxed text-[#595959]">
        Approved proposals open a PR adding or modifying markdown/MDX content in your site repo.
        I never merge or auto-publish; you review the PR.
      </p>
    </div>
  );
}

function AreasChecked({
  queue,
  lastAuditAt,
}: {
  queue: QueueRow[];
  lastAuditAt?: string | null;
}) {
  const surfaces = useMemo(
    () => buildAuditSurfaces(queue, lastAuditAt),
    [lastAuditAt, queue],
  );
  return (
    <div className="flex flex-col">
      {surfaces.map((s) => (
        <div
          key={s.id}
          className="flex items-center justify-between gap-3 border-b border-[#f0f0f0] py-2.5 last:border-b-0"
        >
          <span className="text-[13px] text-[#0e0f11]">{s.label}</span>
          <span className="text-[12px] text-[#8a8a8a]">{surfaceNote(s)}</span>
        </div>
      ))}
    </div>
  );
}

function isAuditPromptAttention(item: AttentionItem): boolean {
  return (
    item.title === "Run a fresh full-site content audit" ||
    /drafted content improvement.*not queued/i.test(item.title)
  );
}

const genericFallback = (
  <EmptyState title="No content changes proposed yet">
    Ask the content designer to run a review across the homepage,
    landing/product pages, pricing/help/docs, in-product copy, and internal
    links. Proposals appear here, each tied to a user need, before they can open
    a PR.
  </EmptyState>
);

export function ContentDesignDashboard() {
  const state = useAgentDashboard<Payload>(SLUG);
  const { openTab } = useWorkspace();
  const [optimisticActiveRun, setOptimisticActiveRun] =
    useState<AgentDashboardActiveRun | null>(null);

  const onReview = useCallback(
    (decisionId?: string) => {
      openTab({
        kind: "needs-you",
        title: "Needs you",
        payload: { kind: "needs-you", ...(decisionId ? { decision: decisionId } : {}) },
        dirty: false,
        pinned: false,
      });
    },
    [openTab],
  );

  const onSendChat = useCallback(
    async (message: string) => {
      try {
        const res = await apiFetch(`/api/agents/${SLUG}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, thread_id: null, ...staffModelBodyField() }),
          idempotent: true,
        });
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as {
            run_id?: unknown;
          } | null;
          if (typeof json?.run_id === "string" && json.run_id.length > 0) {
            setOptimisticActiveRun({
              run_id: json.run_id,
              status: "queued",
              enqueued_at: new Date().toISOString(),
              started_at: null,
            });
          }
          state.refresh();
        }
      } catch {
      }
    },
    [state],
  );

  return (
    <DashboardShell
      title="Content design"
      subtitle="Your content designer's standup: the user needs I found, what needs your OK, and what's in motion."
      agentSlug={SLUG}
      state={state}
      genericFallback={genericFallback}
      activeRun={optimisticActiveRun}
      getActiveRun={(d) => d.active_run ?? null}
      running={{
        title: "Running content-design review",
        subtitle:
          "I'm reading the connected repo and live product, finding user needs across page copy, in-product copy, and internal links before I queue approval-ready content changes.",
        steps: [
          "Reviewing product surfaces",
          "Finding user needs and content gaps",
          "Preparing approval-ready proposals",
        ],
        asideTitle: "After this finishes",
        aside: (
          <p>
            New findings will show up under “Needs your OK.” Approving opens a PR,
            and nothing merges automatically.
          </p>
        ),
      }}
      onActiveRunComplete={() => setOptimisticActiveRun(null)}
      render={(d) => {
        const dashboardAttention = d.attention.filter(
          (item) => !isAuditPromptAttention(item),
        );
        const needsOk = d.queue.filter(isNeedsOk);
        const inMotion = d.queue.filter(isInMotion);
        const needsRefresh = d.queue.filter(isNeedsRefresh);
        const earlier = d.queue.filter(isEarlier);
        const checkedAreas = buildAuditSurfaces(d.queue, d.last_audit_at).filter(
          (s) => s.status !== "needs_audit",
        ).length;

        return (
          <>
            <AuditCommandPanel
              data={d}
              onRanComplete={state.refresh}
              onQueued={setOptimisticActiveRun}
            />

            <TruthStrip />

            <StandupHeader
              needsOk={needsOk.length}
              inMotion={inMotion.length}
              needsRefresh={needsRefresh.length}
              checkedAreas={checkedAreas}
              lastAuditAt={d.last_audit_at ?? d.kpis.last_draft_at}
              hasPublishTarget={d.has_publish_target}
            />

            {dashboardAttention.length > 0 ? (
              <AttentionList items={dashboardAttention} />
            ) : null}

            <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1fr_300px]">
              <div className="flex flex-col gap-4">
                {}
                <section>
                  <SectionTitle>Needs your OK: pick the ones to ship</SectionTitle>
                  {needsOk.length > 0 ? (
                    <div className="flex flex-col gap-3">
                      {needsOk.map((row) => (
                        <AskCard
                          key={row.id}
                          row={row}
                          onReview={onReview}
                          onSendChat={onSendChat}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-[#e5e7eb] bg-white px-4 py-6 text-center">
                      <div className="text-[16px] font-semibold text-[#0e0f11]">
                        Nothing needs your OK right now
                      </div>
                      <p className="mx-auto mt-1 max-w-[520px] text-[13px] leading-relaxed text-[#8a8a8a]">
                        Run a fresh review and I'll inspect the current product
                        and queue new recommendations, each tied to a user need,
                        for you to review.
                      </p>
                    </div>
                  )}
                </section>

                {needsRefresh.length > 0 ? (
                  <FoldedGroup
                    title="Drafts I couldn't package for approval"
                    count={needsRefresh.length}
                    danger
                  >
                    <div className="flex flex-col gap-3">
                      {needsRefresh.map((row) => (
                        <AskCard
                          key={row.id}
                          row={row}
                          onReview={onReview}
                          onSendChat={onSendChat}
                        />
                      ))}
                    </div>
                  </FoldedGroup>
                ) : null}

                {inMotion.length > 0 ? (
                  <FoldedGroup title="In motion: PRs for you to merge" count={inMotion.length}>
                    {inMotion.map((row) => (
                      <MiniRow key={row.id} row={row} />
                    ))}
                  </FoldedGroup>
                ) : null}

                <FoldedGroup title="Areas I checked" count={6}>
                  <AreasChecked queue={d.queue} lastAuditAt={d.last_audit_at} />
                </FoldedGroup>

                {earlier.length > 0 ? (
                  <FoldedGroup title="Earlier work" count={earlier.length}>
                    {earlier.map((row) => (
                      <MiniRow key={row.id} row={row} />
                    ))}
                  </FoldedGroup>
                ) : null}
              </div>

              <aside className="flex flex-col gap-4">
                <HowItWorks />
                <PublishTargetPanel has={d.has_publish_target} />
              </aside>
            </div>

            {d.refreshed_at ? (
              <div className="flex items-center justify-end border-t border-[#e5e7eb] pt-3 text-[11px] text-[#8a8a8a]">
                <span>Updated {new Date(d.refreshed_at).toLocaleTimeString()}</span>
              </div>
            ) : null}
          </>
        );
      }}
    />
  );
}
