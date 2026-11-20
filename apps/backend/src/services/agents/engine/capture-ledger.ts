
export type CaptureKind =
  | "dom_text"
  | "rendered"
  | "blocked"
  | "empty_shell"
  | "social_card";

export type CaptureLedgerEntry = {
  requested_url: string;
  final_url: string;
  capture: CaptureKind;
  status: number;
  truncated: boolean;
  text_snippet?: string;
};

const SNIPPET_MAX_BYTES = 16000;
const DISCOVERY_SNIPPET_MAX_BYTES = 64 * 1024;

const MAX_SNIPPET_BYTES_PER_RUN = 512_000;
const DISCOVERY_MAX_SNIPPET_BYTES_PER_RUN = 4_000_000;

const discoveryRuns = new Set<string>();

export function markDiscoveryRun(run_id: string): void {
  if (run_id) discoveryRuns.add(run_id);
}

export function isDiscoveryRun(run_id: string): boolean {
  return discoveryRuns.has(run_id);
}

function snippetMaxBytesFor(run_id: string): number {
  return discoveryRuns.has(run_id) ? DISCOVERY_SNIPPET_MAX_BYTES : SNIPPET_MAX_BYTES;
}

function maxSnippetBytesPerRunFor(run_id: string): number {
  return discoveryRuns.has(run_id)
    ? DISCOVERY_MAX_SNIPPET_BYTES_PER_RUN
    : MAX_SNIPPET_BYTES_PER_RUN;
}

const snippetBytes = new Map<string, number>();

const ledgers = new Map<string, Map<string, CaptureLedgerEntry>>();

const renderAttempts = new Map<string, Set<string>>();

const renderCounts = new Map<string, number>();

export const PER_RUN_RENDER_CAP = 8;

const MAX_RUNS_RETAINED = 200;

function ledgerFor(run_id: string): Map<string, CaptureLedgerEntry> {
  let m = ledgers.get(run_id);
  if (!m) {
    if (ledgers.size >= MAX_RUNS_RETAINED) {
      const oldest = ledgers.keys().next().value;
      if (oldest !== undefined) {
        ledgers.delete(oldest);
        snippetBytes.delete(oldest);
        discoveryRuns.delete(oldest);
      }
    }
    m = new Map();
    ledgers.set(run_id, m);
  }
  return m;
}

export function recordCapture(run_id: string, entry: CaptureLedgerEntry): void {
  if (!run_id) return;
  const m = ledgerFor(run_id);

  const prior = m.get(entry.requested_url);
  if (prior && typeof prior.text_snippet === "string") {
    snippetBytes.set(
      run_id,
      Math.max(0, (snippetBytes.get(run_id) ?? 0) - prior.text_snippet.length),
    );
  }

  const perRunCap = maxSnippetBytesPerRunFor(run_id);
  let toStore = entry;
  if (typeof entry.text_snippet === "string" && entry.text_snippet.length > 0) {
    const used = snippetBytes.get(run_id) ?? 0;
    if (used + entry.text_snippet.length > perRunCap) {
      toStore = { ...entry, text_snippet: undefined };
    } else {
      snippetBytes.set(run_id, used + entry.text_snippet.length);
    }
  }
  m.set(entry.requested_url, toStore);
}

export function hasCaptureFor(run_id: string, requested_url: string): boolean {
  return ledgers.get(run_id)?.has(requested_url) ?? false;
}

export function getCaptureLedger(run_id: string): CaptureLedgerEntry[] {
  const m = ledgers.get(run_id);
  return m ? Array.from(m.values()) : [];
}

export function unverifiedCaptures(run_id: string): CaptureLedgerEntry[] {
  return getCaptureLedger(run_id).filter(
    (e) =>
      e.capture === "blocked" ||
      e.capture === "empty_shell" ||
      e.capture === "social_card",
  );
}

export function hasRenderAttempt(run_id: string, requested_url: string): boolean {
  return renderAttempts.get(run_id)?.has(requested_url) ?? false;
}

export function markRenderAttempt(run_id: string, requested_url: string): void {
  if (!run_id) return;
  let s = renderAttempts.get(run_id);
  if (!s) {
    s = new Set();
    renderAttempts.set(run_id, s);
  }
  s.add(requested_url);
  renderCounts.set(run_id, (renderCounts.get(run_id) ?? 0) + 1);
}

export function renderCount(run_id: string): number {
  return renderCounts.get(run_id) ?? 0;
}

export function renderCapReached(run_id: string): boolean {
  return renderCount(run_id) >= PER_RUN_RENDER_CAP;
}

export function clearCaptureLedger(run_id: string): void {
  ledgers.delete(run_id);
  renderAttempts.delete(run_id);
  renderCounts.delete(run_id);
  snippetBytes.delete(run_id);
  discoveryRuns.delete(run_id);
}

type WebFetchResultShape = {
  capture?: CaptureKind;
  final_url?: string;
  status?: number;
  truncated?: boolean;
  body_text?: string;
  meta?: { status?: number; final_url?: string };
};

function safeJson(content: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(content);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function recordWebFetchCapture(
  run_id: string,
  args: unknown,
  resultContent: string,
): void {
  const requestedUrl =
    typeof (args as { url?: unknown } | null)?.url === "string"
      ? (args as { url: string }).url
      : undefined;
  if (!requestedUrl) return;
  recordCaptureFromResult(run_id, requestedUrl, resultContent);
}

export function recordCaptureFromResult(
  run_id: string,
  requestedUrl: string,
  resultContent: string,
): void {
  if (!run_id) return;
  if (!requestedUrl) return;
  const shape = (safeJson(resultContent) ?? {}) as WebFetchResultShape;
  const capture = shape.capture;
  if (!capture) return;
  const status =
    typeof shape.status === "number"
      ? shape.status
      : typeof shape.meta?.status === "number"
        ? shape.meta.status
        : 0;
  const finalUrl =
    shape.final_url ?? shape.meta?.final_url ?? requestedUrl;
  const text_snippet =
    (capture === "dom_text" || capture === "rendered") &&
    typeof shape.body_text === "string"
      ? shape.body_text.slice(0, snippetMaxBytesFor(run_id))
      : undefined;
  recordCapture(run_id, {
    requested_url: requestedUrl,
    final_url: finalUrl,
    capture,
    status,
    truncated: shape.truncated === true,
    text_snippet,
  });
}

export function normalizeUrlForMatch(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const host = u.host.toLowerCase();
    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${host}${path}${u.search}`;
  } catch {
    let s = trimmed.toLowerCase();
    if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
    return s;
  }
}

export function getCapturedText(
  run_id: string,
  requested_url: string,
): string | null {
  if (!run_id || !requested_url) return null;
  const target = normalizeUrlForMatch(requested_url);
  if (!target) return null;
  const m = ledgers.get(run_id);
  if (!m) return null;
  for (const entry of m.values()) {
    if (typeof entry.text_snippet !== "string" || entry.text_snippet.length === 0) {
      continue;
    }
    if (
      normalizeUrlForMatch(entry.requested_url) === target ||
      normalizeUrlForMatch(entry.final_url) === target
    ) {
      return entry.text_snippet;
    }
  }
  return null;
}

export function __resetCaptureLedgerForTest(): void {
  ledgers.clear();
  renderAttempts.clear();
  renderCounts.clear();
  snippetBytes.clear();
  discoveryRuns.clear();
}
