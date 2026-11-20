
import { serviceClient } from "@/services/supabase";
import { engineerPreviewEnabled } from "@/services/sandbox/engineer-preview";

export type ProbeVerdict = "pass" | "fail" | "skipped";

export type ProbeResult = {
  verdict: ProbeVerdict;
  http_status: number | null;
  evidence_md: string;
  reason: string;
};

export const PROBE_POLL_ATTEMPTS = 5;
export const PROBE_POLL_INTERVAL_MS = 1_500;
export const PROBE_FETCH_TIMEOUT_MS = 15_000;

const E2B_HOST_RE = /^https:\/\/\d+-[a-z0-9]+\.e2b\.app$/i;

export type LivePreview = { preview_status: string | null; preview_url: string | null };

export interface PreviewProbeIo {
  previewEnabled: (tenant_id: string) => Promise<boolean>;
  loadLivePreview: () => Promise<LivePreview | null>;
  fetchRoot: (
    url: string,
  ) => Promise<{ ok: true; status: number; body: string } | { ok: false; error: string }>;
  sleep: (ms: number) => Promise<void>;
}

export type ProbeBranchPreviewInput = {
  tenant_id: string;
  repo: string;
  branch: string;
  expected_markers?: string[];
};

function skip(reason: string, evidence: string, http_status: number | null = null): ProbeResult {
  return { verdict: "skipped", http_status, evidence_md: evidence.slice(0, 4000), reason };
}
function fail(reason: string, evidence: string, http_status: number | null): ProbeResult {
  return { verdict: "fail", http_status, evidence_md: evidence.slice(0, 4000), reason };
}
function pass(evidence: string, http_status: number): ProbeResult {
  return { verdict: "pass", http_status, evidence_md: evidence.slice(0, 4000), reason: "ok" };
}

export function evaluateProbeResponse(args: {
  status: number;
  body: string;
  expected_markers?: string[];
}): ProbeResult {
  const { status } = args;
  const body = typeof args.body === "string" ? args.body : "";
  const markers = (args.expected_markers ?? []).filter(
    (m) => typeof m === "string" && m.trim().length > 0,
  );

  if (status >= 500) {
    return fail("server_5xx", `Preview root returned HTTP ${status} — app failure (5xx).`, status);
  }
  const alive = status >= 200 && status < 400;
  if (!alive) {
    return skip(
      "unexpected_status",
      `Preview root returned HTTP ${status} (not 2xx/3xx/5xx) — skipping (non-blocking).`,
      status,
    );
  }
  if (markers.length > 0) {
    const missing = markers.filter((m) => !body.includes(m));
    if (missing.length > 0) {
      return fail(
        "marker_missing",
        `Preview loaded (HTTP ${status}) but expected content was NOT found: ${missing
          .map((m) => JSON.stringify(m.slice(0, 80)))
          .join(", ")}.`,
        status,
      );
    }
    return pass(
      `Preview loaded (HTTP ${status}) and all ${markers.length} expected marker(s) were present.`,
      status,
    );
  }
  return pass(`Preview loaded (HTTP ${status}) — root served OK.`, status);
}

export type PreviewOutcome = "on_target" | "off_target";
export type OffTargetReason = "auth_or_redirect" | "route_error" | "no_marker";

export type EngineerPreviewVerdict = {
  outcome: PreviewOutcome;
  reason: OffTargetReason | null;
  http_status: number | null;
};

export function evaluateEngineerPreviewOutcome(args: {
  status: number;
  body: string;
  markers: readonly string[];
}): EngineerPreviewVerdict {
  const { status } = args;
  const body = typeof args.body === "string" ? args.body : "";
  const markers = (args.markers ?? []).filter(
    (m) => typeof m === "string" && m.trim().length > 0,
  );

  if (status >= 300 && status < 400) {
    return { outcome: "off_target", reason: "auth_or_redirect", http_status: status };
  }
  if (status !== 200) {
    return { outcome: "off_target", reason: "route_error", http_status: status };
  }
  if (markers.length === 0) {
    return { outcome: "off_target", reason: "no_marker", http_status: status };
  }
  const hit = markers.some((m) => body.includes(m));
  return hit
    ? { outcome: "on_target", reason: null, http_status: status }
    : { outcome: "off_target", reason: "no_marker", http_status: status };
}

export async function probeEngineerPreviewPath(args: {
  preview_url: string;
  preview_path: string;
  markers: readonly string[];
  fetchPath?: (
    url: string,
  ) => Promise<{ ok: true; status: number; body: string } | { ok: false; error: string }>;
}): Promise<EngineerPreviewVerdict> {
  const origin = args.preview_url;
  if (!E2B_HOST_RE.test(origin)) {
    return { outcome: "off_target", reason: "route_error", http_status: null };
  }
  let target: URL;
  try {
    target = new URL(args.preview_path, `${origin}/`);
  } catch {
    return { outcome: "off_target", reason: "route_error", http_status: null };
  }
  if (target.origin !== origin) {
    return { outcome: "off_target", reason: "route_error", http_status: null };
  }

  const fetcher = args.fetchPath ?? fetchUrlServerSide;
  const res = await fetcher(target.toString()).catch(() => ({
    ok: false as const,
    error: "fetch_threw",
  }));
  if (!res.ok) {
    return { outcome: "off_target", reason: "route_error", http_status: null };
  }
  return evaluateEngineerPreviewOutcome({
    status: res.status,
    body: res.body,
    markers: args.markers,
  });
}

export async function probeBranchPreview(
  input: ProbeBranchPreviewInput,
  io: PreviewProbeIo,
): Promise<ProbeResult> {
  if (!input.tenant_id || !input.repo || !input.branch) {
    return skip("bad_input", "_Preview gate skipped — missing tenant/repo/branch._");
  }

  const enabled = await io.previewEnabled(input.tenant_id).catch(() => false);
  if (!enabled) {
    return skip("preview_disabled", "_Preview gate skipped — live preview is disabled for this tenant._");
  }

  let row: LivePreview | null = null;
  for (let attempt = 0; attempt < PROBE_POLL_ATTEMPTS; attempt++) {
    row = await io.loadLivePreview().catch(() => null);
    if (row && row.preview_status !== "starting") break;
    if (attempt < PROBE_POLL_ATTEMPTS - 1) await io.sleep(PROBE_POLL_INTERVAL_MS);
  }

  if (!row || row.preview_status !== "live" || !row.preview_url) {
    const st = row?.preview_status ?? "none";
    return skip(
      st === "starting" ? "boot_timeout" : "no_live_preview",
      `_Preview gate skipped — no live branch preview for \`${input.branch}\` (status: ${st})._`,
    );
  }

  if (!E2B_HOST_RE.test(row.preview_url)) {
    return skip("bad_origin", "_Preview gate skipped — preview origin failed the shape check._");
  }

  const fetched = await io.fetchRoot(row.preview_url).catch(() => ({
    ok: false as const,
    error: "fetch_threw",
  }));
  if (!fetched.ok) {
    return skip("fetch_error", `_Preview gate skipped — preview root was unreachable (${fetched.error})._`);
  }

  return evaluateProbeResponse({
    status: fetched.status,
    body: fetched.body,
    expected_markers: input.expected_markers,
  });
}

async function loadLivePreviewForRun(
  run_id: string,
  tenant_id: string,
): Promise<LivePreview | null> {
  const { data } = await serviceClient()
    .from("tenant_sandbox")
    .select("preview_status, preview_url")
    .eq("preview_run_id", run_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle<LivePreview>();
  return data ?? null;
}

async function fetchUrlServerSide(
  url: string,
): Promise<{ ok: true; status: number; body: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "accept-encoding": "identity", accept: "text/html,*/*" },
      signal: controller.signal,
    });
    const ct = res.headers.get("content-type") ?? "";
    const body = /text\/html/i.test(ct) ? await res.text() : "";
    return { ok: true, status: res.status, body: body.slice(0, 2_000_000) };
  } catch (e) {
    return { ok: false, error: (e as Error)?.name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRootServerSide(
  url: string,
): Promise<{ ok: true; status: number; body: string } | { ok: false; error: string }> {
  return fetchUrlServerSide(`${url.replace(/\/+$/, "")}/`);
}

export function realPreviewProbeIo(run_id: string, tenant_id: string): PreviewProbeIo {
  return {
    previewEnabled: (tid) => engineerPreviewEnabled(tid),
    loadLivePreview: () => loadLivePreviewForRun(run_id, tenant_id),
    fetchRoot: (url) => fetchRootServerSide(url),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export async function probeBranchPreviewForRun(args: {
  tenant_id: string;
  repo: string;
  branch: string;
  run_id: string;
  expected_markers?: string[];
}): Promise<ProbeResult> {
  return probeBranchPreview(
    {
      tenant_id: args.tenant_id,
      repo: args.repo,
      branch: args.branch,
      expected_markers: args.expected_markers,
    },
    realPreviewProbeIo(args.run_id, args.tenant_id),
  );
}
