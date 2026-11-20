"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { startConnectFlow } from "@/app/connectors/ConnectButton";
import {
  exportErrorCopy,
  githubNewRepoUrl,
  repoNameFromUrl,
} from "@/lib/workspace/exportGithubCopy";

type ExportSuccess = {
  ok: true;
  exported: boolean;
  reason: string;
  dest: { full_name: string; url: string; branch: string; created_repo: boolean };
  file_count: number;
  commit_sha: string | null;
  up_to_date?: boolean | null;
};

type NeedsRepo = {
  phase: "needs_repo";
  owner: string;
  repoName: string;
  accessUrl: string | null;
  watching: boolean;
  gaveUp: boolean;
  exporting: boolean;
};

type ExportState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "waiting"; before: ExportRecord | null }
  | { phase: "done"; result: ExportSuccess }
  | { phase: "error"; code: string; message: string }
  | NeedsRepo;

type Outcome =
  | { kind: "done"; result: ExportSuccess }
  | { kind: "in_progress" }
  | { kind: "missing"; owner: string; repoName: string; accessUrl: string | null }
  | { kind: "error"; code: string; message: string };

export const REPO_WATCH_INTERVAL_MS = 4000;
export const REPO_WATCH_LIMIT_MS = 10 * 60 * 1000;
export const EXPORT_WAIT_INTERVAL_MS = 3000;
export const EXPORT_WAIT_LIMIT_MS = 5 * 60 * 1000;
export const UP_TO_DATE_RECHECK_MS = 5000;
export const UP_TO_DATE_RECHECK_LIMIT_MS = 3 * 60 * 1000;
export const REVISION_RECHECK_MS = 1000;
export const REVISION_RECHECK_TRIES = 12;

export type ExportRecord = {
  full_name: string;
  url: string;
  branch: string;
  commit_sha: string | null;
  file_count: number;
  exported_at: string;
};

type LastExport = {
  record: ExportRecord | null;
  source: string | null;
  upToDate: boolean | null;
  error?: { code: string; message: string };
};

async function fetchLastExport(buildId: string | null): Promise<LastExport> {
  try {
    const q = buildId ? `?conductor_run_id=${encodeURIComponent(buildId)}` : "";
    const res = await apiFetch(`/api/workspace/export-github${q}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      const code = body?.error?.code;
      if (buildId && code && res.status !== 401 && res.status !== 403) {
        return { record: null, source: null, upToDate: null, error: { code, message: body?.error?.message ?? `HTTP ${res.status}` } };
      }
      return { record: null, source: null, upToDate: null };
    }
    const body = (await res.json()) as { export?: ExportRecord | null; source?: string | null; up_to_date?: boolean | null };
    return {
      record: body?.export ?? null,
      source: typeof body?.source === "string" ? body.source : null,
      upToDate: typeof body?.up_to_date === "boolean" ? body.up_to_date : null,
    };
  } catch {
    return { record: null, source: null, upToDate: null };
  }
}

const statusCache = new Map<string, LastExport>();
const editedSince = new Set<string>();

function withEdit(buildId: string, status: LastExport): LastExport {
  return status.record && editedSince.has(buildId) ? { ...status, upToDate: false } : status;
}

function settleEdit(buildId: string | null, status: LastExport): void {
  if (buildId && status.record && status.upToDate === false) editedSince.delete(buildId);
}

export async function prefetchExportStatus(buildId: string): Promise<void> {
  const status = await fetchLastExport(buildId);
  if (!status.error) statusCache.set(buildId, status);
}

export async function refreshExportStatusAfterEdit(buildId: string): Promise<void> {
  editedSince.add(buildId);
  const cached = statusCache.get(buildId);
  if (cached) statusCache.set(buildId, withEdit(buildId, cached));
  for (let i = 0; i < REVISION_RECHECK_TRIES; i++) {
    const status = await fetchLastExport(buildId);
    if (status.error) return;
    settleEdit(buildId, status);
    statusCache.set(buildId, withEdit(buildId, status));
    if (!status.record || status.upToDate === false) return;
    if (i < REVISION_RECHECK_TRIES - 1) await new Promise((r) => setTimeout(r, REVISION_RECHECK_MS));
  }
}

export function resetExportStatusCache(): void {
  statusCache.clear();
  editedSince.clear();
}

async function destRepoExists(destRepoName: string, buildId: string | null): Promise<boolean> {
  try {
    const q = new URLSearchParams({ dest_repo_name: destRepoName });
    if (buildId) q.set("conductor_run_id", buildId);
    const res = await apiFetch(`/api/workspace/export-github/dest?${q.toString()}`);
    if (!res.ok) return false;
    const body = (await res.json()) as { exists?: boolean };
    return body?.exists === true;
  } catch {
    return false;
  }
}

function exportedOn(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

async function postExport(destRepoName: string, buildId: string | null): Promise<Outcome> {
  try {
    const res = await apiFetch("/api/workspace/export-github", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ dest_repo_name: destRepoName || undefined, conductor_run_id: buildId ?? undefined }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: {
          code?: string;
          message?: string;
          owner?: string;
          repo_name?: string;
          access_url?: string;
        };
      } | null;
      const err = body?.error;
      if (err?.code === "idempotency_in_progress") return { kind: "in_progress" };
      if (err?.code === "dest_repo_must_exist" && err.owner && err.repo_name) {
        return {
          kind: "missing",
          owner: err.owner,
          repoName: err.repo_name,
          accessUrl: err.access_url ?? null,
        };
      }
      return {
        kind: "error",
        code: err?.code ?? `http_${res.status}`,
        message: err?.message ?? `Export failed (HTTP ${res.status}).`,
      };
    }
    return { kind: "done", result: (await res.json()) as ExportSuccess };
  } catch (e) {
    return {
      kind: "error",
      code: "network",
      message: (e as Error).message || "Network error during export.",
    };
  }
}

const exportsInFlight = new Map<string, Promise<Outcome>>();

function startExport(destRepoName: string, buildId: string | null): Promise<Outcome> {
  const running = buildId ? exportsInFlight.get(buildId) : undefined;
  if (running) return running;
  const promise = postExport(destRepoName, buildId).then((outcome) => {
    if (buildId) {
      exportsInFlight.delete(buildId);
      if (outcome.kind === "done") rememberExported(buildId, recordFromResult(outcome.result), outcome.result.up_to_date ?? null);
    }
    return outcome;
  });
  if (buildId) exportsInFlight.set(buildId, promise);
  return promise;
}

export function __resetExportsInFlight(): void {
  exportsInFlight.clear();
}

function rememberExported(buildId: string | null, record: ExportRecord, upToDate: boolean | null): void {
  if (!buildId) return;
  editedSince.delete(buildId);
  const previous = statusCache.get(buildId);
  statusCache.set(buildId, { record, source: previous?.source ?? null, upToDate });
}

function sameRecord(a: ExportRecord | null, b: ExportRecord | null): boolean {
  if (!a || !b) return a === b;
  return a.full_name === b.full_name && a.exported_at === b.exported_at && a.commit_sha === b.commit_sha;
}

function resultFromRecord(record: ExportRecord, upToDate: boolean | null): ExportSuccess {
  return {
    ok: true,
    exported: true,
    reason: "exported",
    dest: { full_name: record.full_name, url: record.url, branch: record.branch, created_repo: false },
    file_count: record.file_count,
    commit_sha: record.commit_sha,
    up_to_date: upToDate,
  };
}

function recordFromResult(r: ExportSuccess): ExportRecord {
  return {
    full_name: r.dest.full_name,
    url: r.dest.url,
    branch: r.dest.branch,
    commit_sha: r.commit_sha,
    file_count: r.file_count,
    exported_at: new Date().toISOString(),
  };
}

export function ExportToGithubButton({
  className = "mt-4 border-t border-ink/[0.08] pt-3 lg:shrink-0",
  repoName = null,
  buildId = null,
  revision = null,
}: {
  className?: string;
  buildId?: string | null;
  revision?: string | null;
  repoName?: string | null;
} = {}) {
  const [state, setState] = useState<ExportState>({ phase: "idle" });
  const [destName, setDestName] = useState(repoName ?? "");
  const [lastExport, setLastExport] = useState<ExportRecord | null>(null);
  const [upToDate, setUpToDate] = useState<boolean | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [checking, setChecking] = useState(() => !buildId || !statusCache.has(buildId));
  const nameEdited = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const applyStatus = (status: LastExport) => {
      const { record, source, upToDate: fresh } = buildId ? withEdit(buildId, status) : status;
      setLastExport(record);
      setUpToDate(record ? fresh : null);
      const bare = repoNameFromUrl(source);
      setSourceName(bare);
      if (bare && !nameEdited.current) setDestName(bare);
    };
    setState({ phase: "idle" });
    nameEdited.current = false;
    setDestName(repoName ?? "");
    const cached = buildId ? statusCache.get(buildId) : undefined;
    if (cached) applyStatus(cached);
    else {
      setLastExport(null);
      setUpToDate(null);
      setChecking(true);
    }
    void fetchLastExport(buildId).then((status) => {
      if (cancelled) return;
      if (status.error) setState({ phase: "error", code: status.error.code, message: status.error.message });
      else if (buildId) {
        settleEdit(buildId, status);
        statusCache.set(buildId, withEdit(buildId, status));
      }
      applyStatus(status);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the open build changes
  }, [buildId]);

  const currentBuild = useRef(buildId);
  currentBuild.current = buildId;

  const applyOutcome = useCallback(
    (outcome: Outcome) => {
      if (outcome.kind === "done") {
        const record = recordFromResult(outcome.result);
        const fresh = outcome.result.up_to_date ?? null;
        rememberExported(buildId, record, fresh);
        setLastExport(record);
        setUpToDate(fresh);
        setState({ phase: "done", result: outcome.result });
      } else if (outcome.kind === "in_progress") setState({ phase: "waiting", before: lastExport });
      else if (outcome.kind === "error") setState({ phase: "error", code: outcome.code, message: outcome.message });
      else setState({ phase: "needs_repo", ...outcome, watching: true, gaveUp: false, exporting: false });
    },
    [buildId, lastExport],
  );
  const applyOutcomeRef = useRef(applyOutcome);
  applyOutcomeRef.current = applyOutcome;

  useEffect(() => {
    const running = buildId ? exportsInFlight.get(buildId) : undefined;
    if (!running) return;
    let cancelled = false;
    setState({ phase: "running" });
    void running.then((outcome) => {
      if (!cancelled && currentBuild.current === buildId) applyOutcomeRef.current(outcome);
    });
    return () => {
      cancelled = true;
    };
  }, [buildId]);

  const run = useCallback(async () => {
    setState({ phase: "running" });
    const outcome = await startExport(lastExport ? lastExport.full_name.split("/")[1] : destName.trim(), buildId);
    if (currentBuild.current !== buildId) return;
    applyOutcome(outcome);
  }, [destName, buildId, lastExport, applyOutcome]);

  const connectGithub = useCallback(async () => {
    setConnecting(true);
    try {
      await startConnectFlow("github", { returnHere: true });
    } catch (e) {
      setState({ phase: "error", code: "connect_failed", message: (e as Error).message || "Could not open GitHub." });
    } finally {
      setConnecting(false);
    }
  }, []);

  const watchedRepo = state.phase === "needs_repo" && state.watching ? state.repoName : null;

  useEffect(() => {
    if (!watchedRepo) return;
    let cancelled = false;
    let inFlight = false;
    const startedAt = Date.now();
    const check = async () => {
      if (cancelled || inFlight) return;
      if (Date.now() - startedAt > REPO_WATCH_LIMIT_MS) {
        setState((s) => (s.phase === "needs_repo" ? { ...s, watching: false, gaveUp: true } : s));
        return;
      }
      inFlight = true;
      const found = await destRepoExists(watchedRepo, buildId);
      if (cancelled || !found) {
        inFlight = false;
        return;
      }
      setState((s) => (s.phase === "needs_repo" ? { ...s, exporting: true } : s));
      const outcome = await postExport(watchedRepo, buildId);
      inFlight = false;
      if (cancelled) return;
      if (outcome.kind === "missing") {
        setState((s) => (s.phase === "needs_repo" ? { ...s, exporting: false } : s));
        return;
      }
      if (outcome.kind === "done") {
        const record = recordFromResult(outcome.result);
        const fresh = outcome.result.up_to_date ?? null;
        rememberExported(buildId, record, fresh);
        setLastExport(record);
        setUpToDate(fresh);
        setState({ phase: "done", result: outcome.result });
      }
      else if (outcome.kind === "in_progress") setState({ phase: "waiting", before: null });
      else setState({ phase: "error", code: outcome.code, message: outcome.message });
    };
    const timer = window.setInterval(() => void check(), REPO_WATCH_INTERVAL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [watchedRepo, buildId]);

  const waitingFor = state.phase === "waiting" ? state.before : undefined;

  useEffect(() => {
    if (waitingFor === undefined) return;
    let cancelled = false;
    let inFlight = false;
    const startedAt = Date.now();
    const finish = (status: LastExport) => {
      settleEdit(buildId, status);
      if (buildId) statusCache.set(buildId, withEdit(buildId, status));
      setLastExport(status.record);
      setUpToDate(status.record ? (editedSince.has(buildId ?? "") ? false : status.upToDate) : null);
      if (status.record && !sameRecord(waitingFor, status.record)) {
        setState({ phase: "done", result: resultFromRecord(status.record, status.upToDate) });
      } else {
        setState({ phase: "idle" });
      }
    };
    const check = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const status = await fetchLastExport(buildId);
      inFlight = false;
      if (cancelled) return;
      if (status.error) {
        setState({ phase: "error", code: status.error.code, message: status.error.message });
        return;
      }
      if (status.record && !sameRecord(waitingFor, status.record)) {
        finish(status);
        return;
      }
      if (Date.now() - startedAt > EXPORT_WAIT_LIMIT_MS) finish(status);
    };
    const timer = window.setInterval(() => void check(), EXPORT_WAIT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [waitingFor, buildId]);

  const startWatching = useCallback(() => {
    setState((s) => (s.phase === "needs_repo" ? { ...s, watching: true, gaveUp: false } : s));
  }, []);

  const waiting = state.phase === "waiting";
  const exporting = waiting || state.phase === "running" || (state.phase === "needs_repo" && state.exporting);
  const busy = exporting || watchedRepo !== null || connecting || checking;
  const current = upToDate === true && lastExport !== null;

  const recheckRef = useRef<() => Promise<boolean>>(async () => false);
  recheckRef.current = async () => {
    if (!buildId) return false;
    const status = await fetchLastExport(buildId);
    if (status.error || !status.record || status.upToDate !== false) return false;
    editedSince.delete(buildId);
    statusCache.set(buildId, status);
    setLastExport(status.record);
    setUpToDate(false);
    return true;
  };

  useEffect(() => {
    if (!current || !buildId) return;
    let cancelled = false;
    let inFlight = false;
    const startedAt = Date.now();
    const recheck = async () => {
      if (cancelled || inFlight || Date.now() - startedAt > UP_TO_DATE_RECHECK_LIMIT_MS) return;
      inFlight = true;
      await recheckRef.current().catch(() => false);
      inFlight = false;
    };
    const timer = window.setInterval(() => void recheck(), UP_TO_DATE_RECHECK_MS);
    const onFocus = () => void recheck();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [current, buildId]);

  const seenRevision = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = seenRevision.current;
    seenRevision.current = revision;
    if (prev === undefined || revision === null || revision === prev || !buildId) return;
    editedSince.add(buildId);
    const cached = statusCache.get(buildId);
    if (cached) statusCache.set(buildId, withEdit(buildId, cached));
    setUpToDate((u) => (u === true ? false : u));
    let cancelled = false;
    let timer = 0;
    let tries = 0;
    const attempt = async () => {
      if (cancelled) return;
      tries += 1;
      const flipped = await recheckRef.current().catch(() => false);
      if (cancelled || flipped || tries >= REVISION_RECHECK_TRIES) return;
      timer = window.setTimeout(() => void attempt(), REVISION_RECHECK_MS);
    };
    void attempt();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [revision, buildId]);

  return (
    <div className={className}>
      <p className="text-[13px] leading-[1.5] text-inkMuted">
        {current
          ? "Your GitHub copy has this build's latest code."
          : lastExport
            ? "You own a copy in your GitHub. Export again any time to send your latest changes."
            : "Copy this product into your own GitHub. You keep full ownership of the repo."}
      </p>

      {lastExport && state.phase !== "done" && (
        <SuccessCard
          testId="last-export"
          title="Exported to"
          href={lastExport.url}
          repo={lastExport.full_name}
          note={exportedOn(lastExport.exported_at) ? ` on ${exportedOn(lastExport.exported_at)}` : null}
        />
      )}

      {lastExport ? (
        <div className="mt-3">
          <p className="text-[14px] font-medium text-inkSoft">Repo name</p>
          <a
            href={lastExport.url}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="export-repo-name"
            className="mt-1.5 block truncate font-mono text-[18px] font-semibold leading-7 text-ink hover:underline"
          >
            {lastExport.full_name}
          </a>
        </div>
      ) : (
        <label className="mt-3 block text-[14px] font-medium text-inkSoft">
          Repo name
          <input
            type="text"
            value={destName}
            onChange={(e) => {
              nameEdited.current = true;
              setDestName(e.target.value);
              setState((s) => (s.phase === "needs_repo" ? { phase: "idle" } : s));
            }}
            placeholder={sourceName ?? repoName ?? "Leave blank to use your build's name"}
            disabled={exporting || connecting}
            spellCheck={false}
            autoComplete="off"
            className="mt-1.5 block h-10 w-full rounded-[10px] border border-rule bg-creamDeep px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-inkLight focus:border-ink/40 disabled:opacity-60"
          />
        </label>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={run}
          disabled={busy || current}
          data-testid="export-to-github"
          className="inline-flex h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-full bg-ink px-4 text-[14px] font-semibold text-cream transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {waiting
            ? "Still exporting…"
            : exporting
              ? "Exporting…"
              : checking
              ? "Checking…"
              : current
              ? "Up to date"
              : lastExport
                ? "Export again"
                : "Export to GitHub"}
        </button>
      </div>

      {exporting && (
        <p className="mt-2 text-[13px] leading-[1.5] text-inkMuted" data-testid="exporting-note">
          {waiting
            ? "The export is still copying your code. Checking GitHub for the result…"
            : "Copying the code to GitHub. This can take a minute."}
        </p>
      )}

      {state.phase === "needs_repo" && !state.exporting && (
        <NeedsRepoPanel state={state} onCreateClick={startWatching} onRetry={startWatching} />
      )}

      {state.phase === "done" && (
        <SuccessCard
          title={state.result.exported ? `Exported ${state.result.file_count} files to` : "Already up to date in"}
          href={state.result.dest.url}
          repo={state.result.dest.full_name}
          note={
            state.result.exported
              ? state.result.dest.created_repo
                ? " New repo created."
                : " Your latest changes are in."
              : " Nothing new to export."
          }
        />
      )}

      {state.phase === "error" && (
        <div
          role="alert"
          className="mt-3 rounded-xl border border-marigold/30 bg-marigold/[0.06] px-3 py-2.5 text-[13px] leading-[1.5] text-ink"
        >
          <ExportErrorBody
            copy={exportErrorCopy(state.code, state.message, destName.trim() || sourceName || repoName)}
            onConnect={connectGithub}
            connecting={connecting}
          />
        </div>
      )}
    </div>
  );
}

const LINK = "font-semibold underline underline-offset-2";

function SuccessCard({
  testId,
  title,
  href,
  repo,
  note,
}: {
  testId?: string;
  title: string;
  href: string;
  repo: string;
  note: string | null;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="mt-3 flex items-start gap-3 rounded-xl border border-emerald-300 bg-emerald-500/10 px-3.5 py-3"
    >
      <span
        aria-hidden
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-[0_0_0_4px_rgba(16,185,129,0.15)]"
      >
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      </span>
      <p className="min-w-0 text-[13px] leading-[1.45]">
        <span className="block font-semibold text-emerald-700">{title} </span>
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="group mt-0.5 inline-flex max-w-full items-center gap-1 font-mono text-[13px] text-ink hover:underline hover:underline-offset-2"
        >
          <span className="truncate">{repo}</span>
          <ArrowUpRight
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-inkMuted transition-transform group-hover:-translate-y-px group-hover:translate-x-px"
          />
        </a>
        {note && <span className="mt-0.5 block text-[12px] text-inkMuted">{note}</span>}
      </p>
    </div>
  );
}

function NeedsRepoPanel({
  state,
  onCreateClick,
  onRetry,
}: {
  state: NeedsRepo;
  onCreateClick: () => void;
  onRetry: () => void;
}) {
  const full = `${state.owner}/${state.repoName}`;
  const accessLink = (label: string) =>
    state.accessUrl ? (
      <a href={state.accessUrl} target="_blank" rel="noreferrer noopener" className={LINK}>
        {label}
      </a>
    ) : null;
  return (
    <div role="status" className="mt-2.5 rounded-lg border border-[#ececec] bg-[#f9f9f9] px-3 py-3 text-[13px] leading-[1.5] text-ink">
      <a
        href={githubNewRepoUrl(state.owner, state.repoName)}
        target="_blank"
        rel="noreferrer noopener"
        onClick={onCreateClick}
        className="flex w-full items-center justify-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90"
      >
        <span className="truncate">
          Create <span className="font-mono">{full}</span> on GitHub
        </span>
        <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
      </a>
      {state.watching && (
        <p className="mt-2.5 flex items-center justify-center gap-2 text-inkMuted" data-testid="repo-watching">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
          <span>
            Waiting for the repo…
            {state.accessUrl && <> Created it? {accessLink("Give the Zavi GitHub App access to it")}.</>}
          </span>
        </p>
      )}
      {state.gaveUp && (
        <p className="mt-2.5 text-center text-inkMuted">
          Still can&apos;t see <span className="font-mono">{full}</span>.{" "}
          {state.accessUrl && <>{accessLink("give the Zavi GitHub App access to it")}, then </>}
          <button type="button" onClick={onRetry} className={LINK}>
            check again
          </button>
          .
        </p>
      )}
    </div>
  );
}

function ExportErrorBody({
  copy,
  onConnect,
  connecting,
}: {
  copy: ReturnType<typeof exportErrorCopy>;
  onConnect: () => void;
  connecting: boolean;
}) {
  if (copy.kind === "connect") {
    return (
      <>
        <p>Connect the GitHub account that should own the code, then export again.</p>
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          data-testid="connect-github"
          className="mt-2 inline-flex h-9 items-center justify-center rounded-full bg-ink px-4 text-[13px] font-semibold text-cream transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {connecting ? "Opening GitHub…" : "Connect GitHub"}
        </button>
      </>
    );
  }
  if (copy.kind === "create_repo") {
    const repo = copy.repoName ? (
      <span className="font-mono">{copy.repoName}</span>
    ) : (
      "a new repo"
    );
    const where = copy.owner ? (
      <>
        {" "}
        under <span className="font-mono">{copy.owner}</span>
      </>
    ) : null;
    return (
      <>
        {copy.reason === "no_create_permission"
          ? "Zavi can't create repos in that organization for you. "
          : "Zavi can't create repos in a personal GitHub account for you. "}
        <a href="https://github.com/new" target="_blank" rel="noreferrer noopener" className={LINK}>
          Create {repo}
        </a>
        {where} (it can be empty), make sure the Zavi GitHub App can access it, then export
        again.
      </>
    );
  }
  return <>{copy.message}</>;
}
