import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

export const API = "https://api.cloudflare.com/client/v4";
export const COMPATIBILITY_DATE = "2026-09-01";

export interface SetupConfig {
  accountId: string;
  token: string;
  bucket: string;
  workerName: string;
  kvNamespaceId?: string;
  kvTitle: string;
  zaviApi: string;
  previewDomain?: string;
}

export interface SetupDeps {
  fetch: typeof fetch;
  log: (line: string) => void;
  workerSource: () => string;
}

export interface SetupResult {
  bucket: string;
  kvNamespaceId: string;
  workerName: string;
  actions: string[];
}

const REQUIRED = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_STATIC_API_TOKEN", "ZAVI_STATIC_R2_BUCKET", "ZAVI_STATIC_WORKER_NAME"] as const;

export function readConfig(env: NodeJS.ProcessEnv, dryRun: boolean): SetupConfig {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length && !dryRun) throw new Error(`missing env: ${missing.join(", ")}`);
  const workerName = env.ZAVI_STATIC_WORKER_NAME || "<ZAVI_STATIC_WORKER_NAME>";
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID || "<CLOUDFLARE_ACCOUNT_ID>",
    token: env.CLOUDFLARE_STATIC_API_TOKEN || "",
    bucket: env.ZAVI_STATIC_R2_BUCKET || "<ZAVI_STATIC_R2_BUCKET>",
    workerName,
    kvNamespaceId: env.ZAVI_STATIC_KV_NAMESPACE_ID || undefined,
    kvTitle: env.ZAVI_STATIC_KV_TITLE || `${workerName}-hosts`,
    zaviApi: env.ZAVI_STATIC_WAKE_API || "https://api.zaviagent.com",
    previewDomain: (env.SITE_PREVIEW_DOMAIN || "").trim().toLowerCase() || undefined,
  };
}

export function compileWorker(path = resolve(__dirname, "../infra/static-host/src/worker.ts")): string {
  const out = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return out.outputText;
}

export function workerMetadata(cfg: SetupConfig, kvNamespaceId: string) {
  return {
    main_module: "worker.js",
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [
      { type: "r2_bucket", name: "SITES", bucket_name: cfg.bucket },
      { type: "kv_namespace", name: "HOSTS", namespace_id: kvNamespaceId },
      { type: "plain_text", name: "ZAVI_API", text: cfg.zaviApi },
      ...(cfg.previewDomain ? [{ type: "plain_text", name: "PREVIEW_DOMAIN", text: cfg.previewDomain }] : []),
    ],
    keep_bindings: ["secret_text"],
  };
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page: number; total_pages: number };
}

async function call<T>(deps: SetupDeps, cfg: SetupConfig, method: string, path: string, body?: BodyInit, contentType?: string): Promise<{ status: number; data: CfEnvelope<T> | null }> {
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.token}` };
  if (contentType) headers["content-type"] = contentType;
  const res = await deps.fetch(`${API}${path}`, { method, headers, body });
  let data: CfEnvelope<T> | null = null;
  try {
    data = (await res.json()) as CfEnvelope<T>;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function fail(what: string, r: { status: number; data: CfEnvelope<unknown> | null }): never {
  const msg = r.data?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || "no body";
  throw new Error(`${what} failed: HTTP ${r.status}: ${msg}`);
}

function ok(r: { status: number; data: CfEnvelope<unknown> | null }): boolean {
  return r.status >= 200 && r.status < 300 && r.data?.success !== false;
}

export function plannedCalls(cfg: SetupConfig): string[] {
  const acct = `/accounts/${cfg.accountId}`;
  const kvLine = cfg.kvNamespaceId
    ? `GET ${acct}/storage/kv/namespaces/${cfg.kvNamespaceId}  (verify ZAVI_STATIC_KV_NAMESPACE_ID)`
    : `GET ${acct}/storage/kv/namespaces?per_page=100  (find title "${cfg.kvTitle}"; POST ${acct}/storage/kv/namespaces {"title":"${cfg.kvTitle}"} if missing)`;
  return [
    `GET ${acct}/r2/buckets/${cfg.bucket}  (POST ${acct}/r2/buckets {"name":"${cfg.bucket}"} if 404)`,
    kvLine,
    `PUT ${acct}/workers/scripts/${cfg.workerName}  (multipart module upload worker.js, compatibility_date ${COMPATIBILITY_DATE}, bindings SITES=r2:${cfg.bucket} HOSTS=kv:${cfg.kvNamespaceId ?? "<resolved namespace id>"})`,
  ];
}

async function ensureBucket(cfg: SetupConfig, deps: SetupDeps, actions: string[]) {
  const acct = `/accounts/${cfg.accountId}`;
  const got = await call(deps, cfg, "GET", `${acct}/r2/buckets/${encodeURIComponent(cfg.bucket)}`);
  if (ok(got)) {
    actions.push(`r2 bucket ${cfg.bucket} exists`);
    return;
  }
  if (got.status !== 404) fail("get r2 bucket", got);
  const made = await call(deps, cfg, "POST", `${acct}/r2/buckets`, JSON.stringify({ name: cfg.bucket }), "application/json");
  if (!ok(made)) fail("create r2 bucket", made);
  actions.push(`r2 bucket ${cfg.bucket} created`);
}

async function ensureKv(cfg: SetupConfig, deps: SetupDeps, actions: string[]): Promise<string> {
  const acct = `/accounts/${cfg.accountId}`;
  if (cfg.kvNamespaceId) {
    const got = await call(deps, cfg, "GET", `${acct}/storage/kv/namespaces/${encodeURIComponent(cfg.kvNamespaceId)}`);
    if (!ok(got)) fail(`get kv namespace ${cfg.kvNamespaceId}`, got);
    actions.push(`kv namespace ${cfg.kvNamespaceId} exists`);
    return cfg.kvNamespaceId;
  }
  for (let page = 1; ; page++) {
    const list = await call<{ id: string; title: string }[]>(deps, cfg, "GET", `${acct}/storage/kv/namespaces?per_page=100&page=${page}`);
    if (!ok(list) || !list.data) fail("list kv namespaces", list);
    const hit = list.data.result.find((n) => n.title === cfg.kvTitle);
    if (hit) {
      actions.push(`kv namespace ${cfg.kvTitle} exists (${hit.id})`);
      return hit.id;
    }
    const info = list.data.result_info;
    if (!info || page >= info.total_pages || list.data.result.length === 0) break;
  }
  const made = await call<{ id: string }>(deps, cfg, "POST", `${acct}/storage/kv/namespaces`, JSON.stringify({ title: cfg.kvTitle }), "application/json");
  if (!ok(made) || !made.data?.result?.id) fail("create kv namespace", made);
  actions.push(`kv namespace ${cfg.kvTitle} created (${made.data.result.id})`);
  return made.data.result.id;
}

async function uploadWorker(cfg: SetupConfig, deps: SetupDeps, kvId: string, actions: string[]) {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(workerMetadata(cfg, kvId))], { type: "application/json" }));
  form.append("worker.js", new Blob([deps.workerSource()], { type: "application/javascript+module" }), "worker.js");
  const put = await call(deps, cfg, "PUT", `/accounts/${cfg.accountId}/workers/scripts/${encodeURIComponent(cfg.workerName)}`, form);
  if (!ok(put)) fail("upload worker", put);
  actions.push(`worker ${cfg.workerName} uploaded`);
}

export async function runSetup(cfg: SetupConfig, deps: SetupDeps, dryRun: boolean): Promise<SetupResult | null> {
  if (dryRun) {
    deps.log("dry run: no Cloudflare calls will be made. Planned calls:");
    for (const line of plannedCalls(cfg)) deps.log(`  ${line}`);
    deps.log(`worker.js compiled: ${deps.workerSource().length} bytes`);
    return null;
  }
  const actions: string[] = [];
  await ensureBucket(cfg, deps, actions);
  const kvId = await ensureKv(cfg, deps, actions);
  await uploadWorker(cfg, deps, kvId, actions);
  for (const a of actions) deps.log(a);
  deps.log(`ZAVI_STATIC_R2_BUCKET=${cfg.bucket}`);
  deps.log(`ZAVI_STATIC_KV_NAMESPACE_ID=${kvId}`);
  deps.log(`ZAVI_STATIC_WORKER_NAME=${cfg.workerName}`);
  return { bucket: cfg.bucket, kvNamespaceId: kvId, workerName: cfg.workerName, actions };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const cfg = readConfig(process.env, dryRun);
  await runSetup(cfg, { fetch, log: (l) => console.log(l), workerSource: () => compileWorker() }, dryRun);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
