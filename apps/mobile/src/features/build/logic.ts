import type { CreditWall } from "../agents/creditWall";

export type BuildSessionState = "building" | "ready" | "failed" | "replaced" | "publishing" | "publish_failed";

export type BuildSessionMeta = {
  id: string;
  title: string;
  request: string;
  state: BuildSessionState;
  run_status: string;
  created_at: string;
  last_activity_at: string;
  refine_count: number;
  is_current: boolean;
  chat_thread_ids?: string[];
};

export type BuildSessionsResponse = {
  sessions?: BuildSessionMeta[] | null;
  current_session_id?: string | null;
};

export type BuildPreviewKind = "none" | "instant" | "early" | "final";

export type BuildStageRow = {
  stage: string;
  status: string;
  error?: string | null;
};

export type BuildFailure = {
  class?: string | null;
  code?: string | null;
  message?: string | null;
  stage?: string | null;
};

export type BuildStatusResponse = {
  run: {
    id?: string;
    objective?: string | null;
    status?: string;
    spend_usd?: number | null;
    max_usd?: number | null;
    used_usd?: number | null;
    used_credits?: number | null;
    created_at?: string | null;
    updated_at?: string | null;
    stages?: BuildStageRow[] | null;
    failure?: BuildFailure | null;
  } | null;
  target?: { repo_url?: string | null; live_url?: string | null } | null;
  site?: { id?: string | null; hostname?: string | null; status?: string | null } | null;
  preview?: { url?: string | null; kind?: BuildPreviewKind } | null;
  is_current?: boolean;
  retired?: boolean;
};

export type BuildRefine = {
  id: string;
  message: string;
  status: string;
  created_at: string;
  summary?: string | null;
  failure_message?: string | null;
  kind?: "change" | "restore" | "undo";
  draft?: boolean;
  discarded?: boolean;
  awaiting_review?: boolean;
};

export type PublishStatus = { pending: number; published: number; last_published_at: string | null };

export type BuiltinUrl = {
  label: string;
  hostname: string;
  url: string;
  status: string;
  dns_ready?: boolean;
  setup_blocked?: "dns_not_configured" | null;
};

export type Visibility = "public" | "private" | "unlisted";

export type ExportRecord = {
  full_name: string;
  url: string;
  branch: string;
  file_count: number;
  exported_at: string;
};

export type ExportResult = {
  exported: boolean;
  reason?: string;
  dest: { full_name: string; url: string; branch: string; created_repo?: boolean };
  file_count: number;
};

const TERMINAL_RUN = new Set(["done", "failed", "halted", "paused", "cancelled", "canceled"]);
const STOPPED_RUN = new Set(["failed", "halted", "cancelled", "canceled"]);

export const BUILD_POLL_MS = 3000;
export const MAX_SETTLE_TICKS = 20;
export const REFINES_POLL_MS = 8000;

export function isTerminalBuildRun(status: string | null | undefined): boolean {
  return typeof status === "string" && TERMINAL_RUN.has(status);
}

export function shouldKeepPolling(
  runStatus: string | null,
  previewKind: BuildPreviewKind,
  settleTicks: number,
): boolean {
  if (runStatus === null) return false;
  if (!isTerminalBuildRun(runStatus)) return true;
  if (runStatus !== "done") return false;
  if (previewKind === "final") return false;
  return settleTicks < MAX_SETTLE_TICKS;
}

export function isRefineBusy(refines: BuildRefine[]): boolean {
  return refines.some((r) => !isTerminalBuildRun(r.status));
}

export function readPreviewUrl(preview: BuildStatusResponse["preview"]): string | null {
  if (!preview || !preview.kind || preview.kind === "none") return null;
  const u = preview.url;
  return typeof u === "string" && u.length > 0 ? u : null;
}

export function stateLabel(state: BuildSessionState): string {
  if (state === "ready") return "Ready";
  if (state === "replaced") return "Replaced by a newer build";
  if (state === "failed") return "Stopped";
  if (state === "publishing") return "Publishing";
  if (state === "publish_failed") return "Publishing didn't finish";
  return "Building";
}

function toEpoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function formatUpdated(iso: string | null | undefined, now: number): string {
  const t = toEpoch(iso);
  if (t === null) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export type SessionRowView = {
  id: string;
  title: string;
  status: string;
  updated: string;
  building: boolean;
  state: BuildSessionState;
};

export function sessionRows(body: BuildSessionsResponse | null | undefined, now: number): SessionRowView[] {
  const sessions = Array.isArray(body?.sessions) ? body!.sessions! : [];
  return sessions
    .filter((s) => s && typeof s.id === "string" && s.id)
    .map((s) => ({ s, at: toEpoch(s.last_activity_at) ?? toEpoch(s.created_at) }))
    .sort((a, b) => {
      if (a.at !== b.at) {
        if (a.at === null) return 1;
        if (b.at === null) return -1;
        return b.at - a.at;
      }
      return a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0;
    })
    .map(({ s }) => ({
      id: s.id,
      title: (s.title ?? "").trim() || "Untitled build",
      status: stateLabel(s.state),
      updated: formatUpdated(s.last_activity_at || s.created_at, now),
      building: s.state === "building" || s.state === "publishing",
      state: s.state,
    }));
}

export type RecentEntry<T> =
  | { kind: "thread"; row: T }
  | { kind: "build"; id: string; title: string; state: BuildSessionState };

export function mergeRecent<T extends { id: string; last_message_at: string | null }>(
  threads: readonly T[],
  body: BuildSessionsResponse | null | undefined,
): RecentEntry<T>[] {
  const sessions = Array.isArray(body?.sessions) ? body!.sessions! : [];
  const threadIds = new Set(threads.map((t) => t.id));
  const items: { entry: RecentEntry<T>; at: number | null; order: number; id: string }[] = [];
  threads.forEach((row, i) => items.push({ entry: { kind: "thread", row }, at: toEpoch(row.last_message_at), order: i, id: row.id }));
  for (const s of sessions) {
    if (!s || typeof s.id !== "string" || !s.id) continue;
    if ((s.chat_thread_ids ?? []).some((t) => threadIds.has(t))) continue;
    items.push({
      entry: { kind: "build", id: s.id, title: (s.title ?? "").trim() || "Untitled build", state: s.state },
      at: toEpoch(s.last_activity_at) ?? toEpoch(s.created_at),
      order: threads.length,
      id: s.id,
    });
  }
  return items
    .sort((a, b) => {
      if (a.at !== b.at) {
        if (a.at === null) return 1;
        if (b.at === null) return -1;
        return b.at - a.at;
      }
      if (a.order !== b.order) return a.order - b.order;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((i) => i.entry);
}

export const IDEA_MIN_CHARS = 8;
export const IDEA_MAX_CHARS = 4000;
export const COMPANY_MAX_CHARS = 100;
export const CHANGE_MIN_CHARS = 8;
export const CHANGE_MAX_CHARS = 1000;

export type Validation = { ok: true } | { ok: false; reason: string };

export function validateIdea(idea: string): Validation {
  const n = idea.trim().length;
  if (n < IDEA_MIN_CHARS) return { ok: false, reason: `Describe the app in at least ${IDEA_MIN_CHARS} characters.` };
  if (n > IDEA_MAX_CHARS) return { ok: false, reason: `Keep the idea under ${IDEA_MAX_CHARS} characters.` };
  return { ok: true };
}

export function validateCompanyName(name: string): Validation {
  const n = name.trim().length;
  if (n === 0) return { ok: false, reason: "Add a company name." };
  if (n > COMPANY_MAX_CHARS) return { ok: false, reason: `Keep the name under ${COMPANY_MAX_CHARS} characters.` };
  return { ok: true };
}

export function validateChange(message: string): Validation {
  const n = message.trim().length;
  if (n < CHANGE_MIN_CHARS) return { ok: false, reason: `Describe the change in at least ${CHANGE_MIN_CHARS} characters.` };
  if (n > CHANGE_MAX_CHARS) return { ok: false, reason: `Keep the change under ${CHANGE_MAX_CHARS} characters.` };
  return { ok: true };
}

export type StepState = "pending" | "active" | "done" | "failed";
export type BuildStep = { key: string; label: string; state: StepState };

const STEP_LABELS = [
  ["workspace", "Setting up your workspace"],
  ["understanding", "Understanding your request"],
  ["structure", "Creating the app structure"],
  ["interface", "Building the interface"],
  ["preview", "Preparing preview"],
  ["deploy", "Deploying"],
] as const;

const STAGE_TO_STEP_KEY: Record<string, string> = {
  provision: "workspace",
  spec: "understanding",
  scaffold: "structure",
  build: "interface",
  qa: "preview",
  deploy: "deploy",
};

function stepLabelsFor(stages: BuildStageRow[]) {
  return stages.some((s) => s.stage === "qa") ? STEP_LABELS : STEP_LABELS.filter(([key]) => key !== "preview");
}

const DONE_STAGE = new Set(["done", "success", "succeeded", "skipped"]);
const ACTIVE_STAGE = new Set(["active", "building", "dispatched", "in_progress", "provisioning", "queued", "running"]);
const FAILED_STAGE = new Set(["failed", "halted", "cancelled", "canceled"]);

export function deriveBuildSteps(stages: BuildStageRow[], runStatus: string | null, live: boolean): BuildStep[] {
  const labels = stepLabelsFor(stages);
  if (live || runStatus === "done") {
    return labels.map(([key, label]) => ({ key, label, state: "done" as const }));
  }
  const failedRun = FAILED_STAGE.has(runStatus ?? "") || runStatus === "paused";
  const failedStage = stages.find((s) => FAILED_STAGE.has(s.status));
  const activeStage = stages.find((s) => ACTIVE_STAGE.has(s.status));
  const unfinished = stages.find((s) => !DONE_STAGE.has(s.status));
  const source = failedStage ?? activeStage ?? unfinished;
  let current = source ? Math.max(0, labels.findIndex(([key]) => key === STAGE_TO_STEP_KEY[source.stage])) : 0;
  if (!source && stages.length > 0 && stages.every((s) => DONE_STAGE.has(s.status))) {
    current = labels.length - 1;
  }
  return labels.map(([key, label], index) => {
    let state: StepState = "pending";
    if (index < current) state = "done";
    if (index === current) state = failedRun ? "failed" : "active";
    return { key, label, state };
  });
}

export const BUILD_OUT_OF_CREDITS =
  "This build ran out of credits partway through. Nothing further will be charged. Top up your credits and start the build again.";
export const BUILD_OVER_BUDGET =
  "This build stopped at its safety limit before it finished. Nothing further will be charged. Start it again to continue.";
export const BUILD_PAUSED_OUT_OF_CREDITS =
  "Your build is paused: out of credits. Everything built so far is saved. Top up, then continue the build.";

export function isCreditFailure(line: string | null | undefined): boolean {
  return line === BUILD_OUT_OF_CREDITS || line === BUILD_PAUSED_OUT_OF_CREDITS;
}

export const BUILD_PROVIDER_BUSY =
  "Our AI service was busy, so the build couldn't continue. Nothing is wrong with your app. Try again in a minute.";

export const BUILD_INTERNAL_FAILURE =
  "Something went wrong on our side, so this build couldn't finish. Try again. If it keeps happening, contact support.";

export function buildFailureCopy(failure: BuildFailure | string | null | undefined): string | null {
  const f: BuildFailure | null | undefined = typeof failure === "string" ? { message: failure } : failure;
  const reason = (f?.message ?? "").trim();
  const code = typeof f?.code === "string" && f.code ? f.code : null;
  if (code === "out_of_credits") return BUILD_OUT_OF_CREDITS;
  if (code) return reason || BUILD_INTERNAL_FAILURE;
  if (!reason) return null;
  const r = reason.toLowerCase();
  if (r.includes("insufficient_credits")) return BUILD_OUT_OF_CREDITS;
  if (r.includes("over_cap") || r.includes("budget_exceeded") || r.includes("budget_halted")) return BUILD_OVER_BUDGET;
  if (r.includes("provider_capacity") || r.includes("overloaded")) return BUILD_PROVIDER_BUSY;
  return BUILD_INTERNAL_FAILURE;
}

export function pausedFailureCopy(failure: BuildFailure | string | null | undefined): string | null {
  const line = buildFailureCopy(failure);
  return line === BUILD_OUT_OF_CREDITS ? BUILD_PAUSED_OUT_OF_CREDITS : line;
}

export type BuildView = {
  status: "building" | "ready" | "paused" | "stopped";
  statusLabel: string;
  failure: string | null;
  openUrl: string | null;
  openLabel: string | null;
  live: boolean;
  superseded: boolean;
  canCancel: boolean;
  canContinue: boolean;
  canChange: boolean;
  appHost: string | null;
  spend: string | null;
};

export function cleanObjective(value: string | null | undefined): string | null {
  if (!value) return null;
  let clean = value.trim();
  if (/^build product:/i.test(clean)) {
    clean = clean.replace(/^build product:\s*/i, "").replace(/^[^—]{1,120}?\s*—\s*/, "");
  }
  clean = clean
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .trim();
  return clean || null;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

function spendLine(run: NonNullable<BuildStatusResponse["run"]>): string | null {
  const credits = run.used_credits;
  if (typeof credits === "number" && Number.isFinite(credits) && credits > 0) {
    return `${Math.round(credits).toLocaleString("en-US")} credits used`;
  }
  const usd = typeof run.used_usd === "number" ? run.used_usd : run.spend_usd;
  if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) return `$${usd.toFixed(2)} spent`;
  return null;
}

export function buildView(body: BuildStatusResponse): BuildView | null {
  const run = body.run;
  if (!run || typeof run.id !== "string") return null;
  const runStatus = typeof run.status === "string" ? run.status : "active";
  const paused = runStatus === "paused";
  const stopped = STOPPED_RUN.has(runStatus);
  const done = runStatus === "done";
  const superseded = body.is_current === false || body.retired === true;
  const liveUrl = body.target?.live_url ?? null;
  const previewUrl = readPreviewUrl(body.preview);
  const live = !!liveUrl || body.preview?.kind === "final";
  const status: BuildView["status"] = paused ? "paused" : stopped ? "stopped" : done ? "ready" : "building";
  const openUrl = liveUrl ?? previewUrl;
  return {
    status,
    statusLabel:
      status === "paused" ? "Paused" : status === "stopped" ? "Stopped" : status === "ready" ? (live ? "Live" : "Ready") : "Building",
    failure: stopped ? buildFailureCopy(run.failure) : paused ? pausedFailureCopy(run.failure) : null,
    openUrl,
    openLabel: openUrl ? (liveUrl ? "Open live site" : "Open preview") : null,
    live,
    superseded,
    canCancel: status === "building",
    canContinue: paused && !superseded,
    canChange: (done || live) && !superseded,
    appHost: !superseded && liveUrl ? hostOf(liveUrl) : null,
    spend: spendLine(run),
  };
}

const CHANGE_FAILURE_FALLBACK = "Something went wrong while making this change. Nothing on your app was affected.";

export type RefineRowView = {
  id: string;
  message: string;
  status: string;
  detail: string | null;
  tone: "ok" | "busy" | "error" | "muted";
};

export function refineRow(r: BuildRefine): RefineRowView {
  const message = (r.message ?? "").trim() || "Change";
  if (!isTerminalBuildRun(r.status)) return { id: r.id, message, status: "Working on it", detail: null, tone: "busy" };
  if (r.status === "done" && !r.failure_message) {
    const summary = (r.summary ?? "").trim() || null;
    if (r.kind === "undo" || r.kind === "restore") return { id: r.id, message, status: "Restored", detail: summary, tone: "ok" };
    if (r.discarded === true) return { id: r.id, message, status: "Discarded", detail: null, tone: "muted" };
    if (r.awaiting_review === true) return { id: r.id, message, status: "Saved, not live yet", detail: summary, tone: "muted" };
    if (r.draft === true) return { id: r.id, message, status: "Ready in your preview", detail: summary, tone: "ok" };
    return { id: r.id, message, status: "Done", detail: summary, tone: "ok" };
  }
  const text = (r.failure_message ?? "").trim();
  const detail =
    !text || text.length > 180 || /[#`*\n]|\]\(|https?:\/\//.test(text) ? CHANGE_FAILURE_FALLBACK : text;
  return { id: r.id, message, status: "Didn't ship", detail, tone: "error" };
}

export type PublishView = {
  tone: "live" | "waiting" | "off";
  title: string;
  sub: string;
  publishLabel: string | null;
  canRevert: boolean;
};

export function publishView(input: {
  builtin: BuiltinUrl | null;
  status: PublishStatus | null;
}): PublishView {
  const { builtin, status } = input;
  const pending = status?.pending ?? 0;
  const published = status?.published ?? 0;
  const addressLive = builtin?.status === "live";
  if (!builtin) {
    return {
      tone: "off",
      title: "Not published",
      sub: "Publish to put it live at a zaviagent.com address.",
      publishLabel: "Publish",
      canRevert: published > 0,
    };
  }
  if (!addressLive) {
    return {
      tone: "waiting",
      title: builtin.setup_blocked === "dns_not_configured" ? "Not live yet" : "Publishing",
      sub:
        builtin.setup_blocked === "dns_not_configured"
          ? "The address can't go live from this server yet. Try again from zaviagent.com."
          : `Setting up ${builtin.hostname || "your address"}.`,
      publishLabel: "Publish",
      canRevert: published > 0,
    };
  }
  if (pending > 0) {
    return {
      tone: "waiting",
      title: "Live",
      sub: `${pending} unpublished change${pending === 1 ? "" : "s"}`,
      publishLabel: "Publish changes",
      canRevert: published > 0,
    };
  }
  return { tone: "live", title: "Live", sub: "Your website is up to date.", publishLabel: null, canRevert: published > 0 };
}

export const BUILTIN_POLL_MS = 4000;
export const BUILTIN_POLL_MAX = 45;

export function builtinPollInterval(builtin: BuiltinUrl | null | undefined, tries: number): number | false {
  if (!builtin || builtin.status !== "verifying") return false;
  if (builtin.setup_blocked === "dns_not_configured") return false;
  return tries < BUILTIN_POLL_MAX ? BUILTIN_POLL_MS : false;
}

export type PublishOutcome =
  | { kind: "published" }
  | { kind: "setting_up"; text: string }
  | { kind: "blocked"; text: string };

export function publishOutcome(address: BuiltinUrl | null | undefined): PublishOutcome {
  if (address?.status === "live") return { kind: "published" };
  if (address?.setup_blocked === "dns_not_configured") {
    return { kind: "blocked", text: "The address can't go live from this server yet. Try again from zaviagent.com." };
  }
  return { kind: "setting_up", text: `Setting up ${address?.hostname || "your address"}…` };
}

export const VISIBILITY_OPTIONS: ReadonlyArray<{ value: Visibility; label: string; hint: string; enforced: boolean }> = [
  { value: "public", label: "Public", hint: "Anyone with the link can visit", enforced: true },
  { value: "private", label: "Private", hint: "Only people you invite", enforced: false },
  { value: "unlisted", label: "Unlisted", hint: "Hidden from search engines", enforced: false },
];

type ErrLike = { status?: unknown; code?: unknown; message?: unknown };

function parts(err: unknown): { status: number | null; code: string; message: string } {
  if (!err || typeof err !== "object") return { status: null, code: "", message: "" };
  const { status, code, message } = err as ErrLike;
  return {
    status: typeof status === "number" ? status : null,
    code: typeof code === "string" ? code : "",
    message: typeof message === "string" && !/^Request failed \(\d+\)$/.test(message) ? message.trim() : "",
  };
}

const CREDIT_CODES = new Set([
  "insufficient_credits",
  "insufficient_credits_for_build",
  "out_of_credits",
  "build_credits_exhausted",
]);

export function buildCreditWall(err: unknown, context: "build" | "change"): CreditWall | null {
  const { status, code, message } = parts(err);
  if (status === 402 && CREDIT_CODES.has(code)) {
    return {
      kind: "credits",
      message:
        message ||
        (context === "build"
          ? "Not enough credits for this build. Top up to start it."
          : "Not enough credits for this change. Top up to make it."),
    };
  }
  if (status === 403 && code === "plan_upgrade_required") {
    return { kind: "plan", message: message || "Your plan doesn't include this. Upgrade to use it." };
  }
  return null;
}

export function buildErrorMessage(err: unknown, fallback: string): string {
  const { code, message } = parts(err);
  if (code === "product_builder_disabled") return "Building apps isn't turned on for this workspace.";
  if (code === "build_already_in_progress") return "A build is already running. Stop it before starting another.";
  if (code === "rate_limited") return "Too many requests. Wait a minute and try again.";
  return message || fallback;
}

export const PUBLISH_FORBIDDEN = "Only workspace owners and admins can publish.";

export function publishErrorMessage(err: unknown, fallback: string): string {
  const { status, message } = parts(err);
  if (status === 403) return PUBLISH_FORBIDDEN;
  return message || fallback;
}

export type ExportErrorView = { text: string; needsGithub: boolean };

export function exportErrorView(err: unknown): ExportErrorView {
  const { status, code, message } = parts(err);
  if (code === "github_not_connected") {
    return {
      text: "Your app's code lives in a GitHub account Zavi manages. Connect a GitHub you own, then export again.",
      needsGithub: true,
    };
  }
  if (code === "dest_repo_must_exist") {
    const named = message.match(/named "([^"]+)" under ([^\s]+) on GitHub/);
    const repo = named?.[1] ? `a repo named ${named[1]}` : "a new repo";
    const where = named?.[2] ? ` under ${named[2]}` : "";
    return {
      text: `Zavi can't create repos in a personal GitHub account for you. Create ${repo}${where} on GitHub (it can be empty), make sure the Zavi GitHub App can access it, then export again.`,
      needsGithub: false,
    };
  }
  if (code === "export_failed" && /export dest repo create failed \((403|404)\)/.test(message)) {
    return {
      text: "Zavi can't create repos in that organization for you. Create a new repo on GitHub (it can be empty), make sure the Zavi GitHub App can access it, then export again.",
      needsGithub: false,
    };
  }
  if (code === "no_provisioned_repo") {
    return { text: message || "There's no built app to export yet.", needsGithub: false };
  }
  if (status === 503) return { text: message || "Export isn't available right now. Try again later.", needsGithub: false };
  return { text: message || "Couldn't export. Please try again.", needsGithub: false };
}

export function exportDoneLine(r: ExportResult): string {
  if (!r.exported) return `Already up to date in ${r.dest.full_name}. Nothing new to export.`;
  const created = r.dest.created_repo ? " New repo created." : " Your latest changes are in.";
  return `Exported ${r.file_count} files to ${r.dest.full_name}.${created}`;
}

export function buildRoleView(canManage: boolean): { canPublish: boolean; canExport: boolean } {
  return { canPublish: canManage, canExport: canManage };
}
