
import { adminApiFetch } from "./api-admin";

export type FieldMeta = {
  name: string;
  type: "string" | "number" | "boolean" | "file";
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  default?: string | number | boolean;
  accept?: string;
};

export type ScriptInfo = {
  key: string;
  group: string;
  label: string;
  description: string;
  fields: FieldMeta[];
  applies: boolean;
  long_running: boolean;
  confirm_hint: string | null;
};

export type ScriptRun = {
  id: string;
  script_key: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "failed";
  run_by_email: string;
  started_at: string;
  finished_at: string | null;
  progress: Record<string, unknown>;
  summary: Record<string, unknown> | null;
  error: string | null;
};

export class ScriptApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (body?.error ?? {}) as Record<string, unknown>;
    throw new ScriptApiError(String(e.message ?? `HTTP ${res.status}`), res.status, String(e.code ?? "error"), e);
  }
  return body as T;
}

export async function fetchScripts(): Promise<{ scripts: ScriptInfo[]; runs: Record<string, ScriptRun[]> }> {
  return readJson(await adminApiFetch("/api/admin/scripts"));
}

export async function fetchRun(id: string): Promise<ScriptRun> {
  return (await readJson<{ run: ScriptRun }>(await adminApiFetch(`/api/admin/scripts/runs/${encodeURIComponent(id)}`))).run;
}

export type RunResponse = { mode: "dry_run" | "apply"; result?: unknown; run_id?: string; async?: boolean };

export async function runScript(
  key: string,
  mode: "dry_run" | "apply",
  args: Record<string, unknown>,
  opts: { confirm?: string; previewToken?: string; file?: File | null } = {},
): Promise<RunResponse> {
  const path = `/api/admin/scripts/${encodeURIComponent(key)}/run`;
  if (opts.file) {
    const form = new FormData();
    form.set("mode", mode);
    for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null && v !== "") form.set(k, String(v));
    if (opts.confirm) form.set("confirm", opts.confirm);
    if (opts.previewToken) form.set("preview_token", opts.previewToken);
    form.set("file", opts.file, opts.file.name);
    return readJson(await adminApiFetch(path, { method: "POST", body: form }));
  }
  return readJson(await adminApiFetch(path, { method: "POST", body: JSON.stringify({ mode, args, confirm: opts.confirm, preview_token: opts.previewToken }) }));
}
