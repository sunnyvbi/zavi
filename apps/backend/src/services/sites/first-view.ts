
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { SITE_REPO_DIR } from "./contract";
import { DRAFT_HOME_PATH, isFirstSiteBuildPayload } from "./first-draft";

export type FirstViewMark = "draft" | "preview" | "content";

export const FIRST_VIEW_COLUMN: Readonly<Record<FirstViewMark, "first_draft_at" | "first_preview_at" | "first_content_at">> = {
  draft: "first_draft_at",
  preview: "first_preview_at",
  content: "first_content_at",
};

export type FirstView = { draft_at: string | null; preview_at: string | null; content_at: string | null };

type Res<T> = PromiseLike<{ data: T; error: { message: string } | null }>;

export type FirstViewClient = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        eq: (col: string, val: string) => { maybeSingle: () => Res<unknown> };
      };
    };
    update: (patch: Record<string, string>) => {
      eq: (col: string, val: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            is: (col: string, val: null) => {
              select: (cols: string) => Res<unknown>;
              not: (col: string, op: "is", val: null) => { select: (cols: string) => Res<unknown> };
            };
          };
        };
      };
    };
  };
};

export type FirstViewDeps = {
  client: (tenant_id: string) => FirstViewClient;
  now: () => Date;
  log: (row: { tenant_id: string; run_id: string; mark: FirstViewMark; ms: number }) => Promise<void>;
};

const realDeps = (): FirstViewDeps => ({
  client: (tenant_id) => tenantClient(asTenantId(tenant_id)) as unknown as FirstViewClient,
  now: () => new Date(),
  log: async (row) => {
    await logEvent({
      level: "info",
      source: "sites.build",
      code: "site_build_first_view",
      tenant_id: row.tenant_id,
      run_id: row.run_id,
      message: `first_${row.mark}=${row.ms}ms`,
      meta: { ms: row.ms, build_stage: `first_${row.mark}` },
    });
  },
});

export type MarkResult = "recorded" | "already" | "no_run" | "failed";

export async function markFirstView(
  input: { tenant_id: string; site_id: string; mark: FirstViewMark },
  injected?: Partial<FirstViewDeps>,
): Promise<MarkResult> {
  const deps = { ...realDeps(), ...injected };
  const column = FIRST_VIEW_COLUMN[input.mark];
  try {
    const sb = deps.client(input.tenant_id);
    const { data: site, error: siteErr } = await sb
      .from("sites")
      .select("root_conductor_run_id")
      .eq("tenant_id", input.tenant_id)
      .eq("id", input.site_id)
      .maybeSingle();
    const runId = (site as { root_conductor_run_id?: unknown } | null)?.root_conductor_run_id;
    if (siteErr || typeof runId !== "string" || !runId) return siteErr ? "failed" : "no_run";
    const at = deps.now();
    const pending = sb
      .from("conductor_runs")
      .update({ [column]: at.toISOString() })
      .eq("tenant_id", input.tenant_id)
      .eq("id", runId)
      .eq("status", "active")
      .is(column, null);
    const { data, error } = await (input.mark === "preview"
      ? pending.select("created_at")
      : pending.not(FIRST_VIEW_COLUMN.preview, "is", null).select("created_at"));
    if (error) {
      console.warn(`[first-view] ${column} not recorded for run=${runId}: ${error.message}`);
      return "failed";
    }
    const row = (data as Array<{ created_at?: unknown }> | null)?.[0];
    if (!row) return "already";
    const created = Date.parse(String(row.created_at ?? ""));
    const ms = Number.isFinite(created) ? Math.max(0, at.getTime() - created) : -1;
    if (ms >= 0) {
      await deps
        .log({ tenant_id: input.tenant_id, run_id: runId, mark: input.mark, ms })
        .catch(() => undefined);
    }
    return "recorded";
  } catch (e) {
    console.warn(`[first-view] ${column} not recorded for site=${input.site_id}: ${(e as Error)?.message ?? e}`);
    return "failed";
  }
}

export async function readFirstView(
  client: unknown,
  tenant_id: string,
  run_id: string,
): Promise<FirstView | null> {
  try {
    const { data, error } = await (client as FirstViewClient)
      .from("conductor_runs")
      .select("first_draft_at, first_preview_at, first_content_at")
      .eq("tenant_id", tenant_id)
      .eq("id", run_id)
      .maybeSingle();
    if (error || !data) return null;
    const r = data as { first_draft_at?: unknown; first_preview_at?: unknown; first_content_at?: unknown };
    const ts = (v: unknown) => (typeof v === "string" && v ? v : null);
    return { draft_at: ts(r.first_draft_at), preview_at: ts(r.first_preview_at), content_at: ts(r.first_content_at) };
  } catch {
    return null;
  }
}

export function isSiteContentPath(path: string | undefined, repo_dir: string): boolean {
  if (!path) return false;
  let p = path.trim();
  if (p.startsWith(`${repo_dir}/`)) p = p.slice(repo_dir.length + 1);
  p = p.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (p.includes("..")) return false;
  return /^(src|public)\//.test(p) || p === "index.html";
}

export function siteFirstContentHookFor(
  payload: unknown,
  tenant_id: string,
): ((event: { tool: string; path?: string; sandbox_id?: string }) => Promise<void>) | undefined {
  if (!isFirstSiteBuildPayload(payload)) return undefined;
  const site_id = (payload as { site_id?: unknown }).site_id;
  if (typeof site_id !== "string" || !site_id.trim()) return undefined;
  return firstContentWriteHook({ tenant_id, site_id: site_id.trim(), repo_dir: SITE_REPO_DIR, home_path: DRAFT_HOME_PATH });
}

export function firstContentWriteHook(
  input: { tenant_id: string; site_id: string; repo_dir: string; home_path: string },
  mark: typeof markFirstView = markFirstView,
  changed: (sandbox_id: string, repo_dir: string, rel: string) => Promise<boolean> = fileChangedInSandbox,
): (event: { tool: string; path?: string; sandbox_id?: string }) => Promise<void> {
  let fired = false;
  return async (event) => {
    if (fired || event.tool.endsWith("run_bash") || !isSiteContentPath(event.path, input.repo_dir) || !event.sandbox_id) return;
    const rel = String(event.path)
      .trim()
      .replace(`${input.repo_dir}/`, "")
      .replace(/^(\.\/)+/, "")
      .replace(/^\/+/, "");
    if (rel !== input.home_path) return;
    if (!(await changed(event.sandbox_id, input.repo_dir, rel).catch(() => false)) || fired) return;
    fired = true;
    void mark({ tenant_id: input.tenant_id, site_id: input.site_id, mark: "content" }).catch(() => undefined);
  };
}

const shq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;

export async function fileChangedInSandbox(sandbox_id: string, repo_dir: string, rel: string): Promise<boolean> {
  const { execCommand } = await import("@/services/sandbox/e2b-client");
  const res = await execCommand(sandbox_id, `cd ${shq(repo_dir)} 2>/dev/null && git status --porcelain -- ${shq(rel)} 2>/dev/null | head -1 || true`, 10_000);
  return res.stdout.trim().length > 0;
}
