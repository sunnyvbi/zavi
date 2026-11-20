
import { createHash } from "node:crypto";
import { verdictFor, type StoredVerdict } from "@/services/channels/exec-failure";
import { logEvent } from "@/services/logging/logEvent";
import { asTenantId, opsRpc, tenantRpc } from "@/services/tenant-client";
import { listRecent } from "./runs";

export const EXEC_FAILURES_SORT_KEY = "channel-exec-failures-sort";
export const PAGE_SIZE = 200;
const MAX_CONSECUTIVE_ERRORS = 20;
const MAX_ERRORS_KEPT = 50;
const SAMPLE_SIZE = 20;

export type FailedOpenRow = {
  id: string;
  tenant_id: string;
  channel_slug: string;
  exec_class: string | null;
  exec_result: unknown;
};

export type StampResult = { ok: boolean; replayed?: boolean; closed?: boolean; code?: string };

export type SortDeps = {
  list: (after: string | null, limit: number) => Promise<FailedOpenRow[]>;
  stamp: (tenantId: string, actionId: string, verdict: StoredVerdict, force: boolean) => Promise<StampResult>;
  progress: (p: SortProgress) => Promise<void>;
  log: typeof logEvent;
};

export type SortProgress = {
  cursor: string | null;
  processed: number;
  stamped: number;
  closed: number;
  skipped: number;
  differing: number;
  failed_count: number;
  errors: Array<{ id: string; code: string }>;
};

export function planRow(row: FailedOpenRow): { verdict: StoredVerdict | null; action: "skip" | "stamp" | "restamp" } {
  const verdict = verdictFor(row.exec_result, row.exec_class ?? "");
  if (!verdict) return { verdict: null, action: "skip" };
  const r = (row.exec_result && typeof row.exec_result === "object" && !Array.isArray(row.exec_result) ? row.exec_result : {}) as Record<string, unknown>;
  if (typeof r.bucket !== "string") return { verdict, action: "stamp" };
  const same = r.bucket === verdict.bucket && (r.fix ?? null) === verdict.fix && (r.platform_code ?? null) === verdict.platform_code;
  return { verdict, action: same ? "skip" : "restamp" };
}

const blankProgress = (cursor: string | null): SortProgress => ({
  cursor, processed: 0, stamped: 0, closed: 0, skipped: 0, differing: 0, failed_count: 0, errors: [],
});

export async function runExecFailureSort(
  start: { cursor: string | null; reclassify?: boolean },
  deps: Pick<SortDeps, "list" | "stamp" | "progress"> & Partial<Pick<SortDeps, "log">>,
): Promise<SortProgress> {
  const log = deps.log ?? logEvent;
  const p = blankProgress(start.cursor);
  let consecutive = 0;
  for (;;) {
    const page = await deps.list(p.cursor, PAGE_SIZE);
    if (page.length === 0) break;
    const before = { stamped: p.stamped, closed: p.closed, errors: p.failed_count };
    for (const row of page) {
      p.processed++;
      const plan = planRow(row);
      if (plan.action === "restamp") p.differing++;
      const force = plan.action === "restamp" && start.reclassify === true;
      if (plan.action === "skip" || (plan.action === "restamp" && !force) || !plan.verdict) {
        p.skipped++;
      } else {
        try {
          const out = await deps.stamp(row.tenant_id, row.id, plan.verdict, force);
          if (!out.ok) throw new Error(out.code ?? "stamp_refused");
          if (out.replayed) p.skipped++;
          else {
            p.stamped++;
            if (out.closed) p.closed++;
          }
          consecutive = 0;
        } catch (e) {
          p.failed_count++;
          p.errors = [...p.errors, { id: row.id, code: String((e as Error)?.message ?? e).slice(0, 120) }].slice(-MAX_ERRORS_KEPT);
          consecutive++;
        }
      }
      p.cursor = row.id;
      if (consecutive >= MAX_CONSECUTIVE_ERRORS) {
        await deps.progress({ ...p });
        throw new Error(`stopped after ${MAX_CONSECUTIVE_ERRORS} failed rows in a row (last: ${p.errors.at(-1)?.code ?? "unknown"}); resume continues from the cursor`);
      }
    }
    await deps.progress({ ...p });
    void log({
      level: "info",
      source: "admin_scripts.exec_failures_sort",
      code: "exec_failures_sort_page",
      message: `page of ${page.length}: stamped ${p.stamped - before.stamped}, closed ${p.closed - before.closed}, errors ${p.failed_count - before.errors}`,
    });
    if (page.length < PAGE_SIZE) break;
  }
  return p;
}

export type SortPreview = {
  remaining: number;
  differing: number;
  by_bucket: Record<string, number>;
  sample: Array<{ id: string; bucket: string; platform_code: string | null; action: "stamp" | "restamp" }>;
  preview_token: string;
};

export async function previewExecFailureSort(
  opts: { reclassify: boolean },
  list: SortDeps["list"],
): Promise<SortPreview> {
  const out: SortPreview = { remaining: 0, differing: 0, by_bucket: {}, sample: [], preview_token: "" };
  const touched: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await list(cursor, PAGE_SIZE);
    for (const row of page) {
      cursor = row.id;
      const plan = planRow(row);
      if (!plan.verdict || plan.action === "skip") continue;
      if (plan.action === "stamp") out.remaining++;
      else out.differing++;
      if (plan.action === "restamp" && !opts.reclassify) continue;
      touched.push(`${row.id}:${plan.verdict.bucket}`);
      out.by_bucket[plan.verdict.bucket] = (out.by_bucket[plan.verdict.bucket] ?? 0) + 1;
      if (out.sample.length < SAMPLE_SIZE) out.sample.push({ id: row.id, bucket: plan.verdict.bucket, platform_code: plan.verdict.platform_code, action: plan.action });
    }
    if (page.length < PAGE_SIZE) break;
  }
  out.preview_token = createHash("sha256").update(`${opts.reclassify}\n${touched.join("\n")}`).digest("hex").slice(0, 32);
  return out;
}

export function sortConfirmPhrase(p: SortPreview, reclassify: boolean): string {
  return `SORT ${p.remaining + (reclassify ? p.differing : 0)}`;
}

export async function listFailedOpen(after: string | null, limit: number): Promise<FailedOpenRow[]> {
  const { data, error } = await opsRpc("list_failed_open_channel_actions", { p_after: after, p_limit: limit });
  if (error) throw new Error(`list_failed_open_channel_actions failed: ${error.message}`);
  return (data ?? []) as FailedOpenRow[];
}

export async function stampVerdict(tenantId: string, actionId: string, verdict: StoredVerdict, force: boolean): Promise<StampResult> {
  const { note: _note, ...stamp } = verdict;
  void _note;
  const { data, error } = await tenantRpc(asTenantId(tenantId), "stamp_channel_action_exec_verdict", {
    p_action_id: actionId,
    p_verdict: stamp,
    p_force: force,
  });
  if (error) throw new Error(error.message);
  return (data ?? { ok: false, code: "no_answer" }) as StampResult;
}

export async function resumeCursor(): Promise<string | null> {
  const [latest] = await listRecent(EXEC_FAILURES_SORT_KEY, 1);
  if (!latest || latest.status !== "failed") return null;
  const c = (latest.progress ?? {}).cursor;
  return typeof c === "string" && /^[0-9a-f-]{36}$/i.test(c) ? c : null;
}
