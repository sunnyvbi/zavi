
import { createHmac } from "node:crypto";

const CF = "https://api.cloudflare.com/client/v4";
const FINGERPRINT_TABLE = "platform_worker_secret_fingerprints";
const ALERT_SOURCE = "platform-worker-secrets";
const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const REQUEST_TIMEOUT_MS = 15_000;

type Env = Record<string, string | undefined>;

export type WorkerSecretSpec = {
  workerEnv: string;
  secret: string;
  sourceEnv: string;
};

export const PLATFORM_WORKER_SECRETS: readonly WorkerSecretSpec[] = [
  { workerEnv: "ZAVI_STATIC_WORKER_NAME", secret: "PREVIEW_HMAC_SECRET", sourceEnv: "SITE_PREVIEW_HMAC_SECRET" },
  { workerEnv: "ZAVI_SITE_GATEWAY_WORKER_NAME", secret: "PREVIEW_HMAC_SECRET", sourceEnv: "SITE_PREVIEW_HMAC_SECRET" },
  { workerEnv: "ZAVI_STATIC_WORKER_NAME", secret: "WAKE_HMAC_SECRET", sourceEnv: "SITE_WAKE_HMAC_SECRET" },
  { workerEnv: "ZAVI_SITE_GATEWAY_WORKER_NAME", secret: "BROKER_HMAC_SECRET", sourceEnv: "SITE_GATEWAY_BROKER_SECRET" },
  { workerEnv: "ZAVI_SITE_GATEWAY_WORKER_NAME", secret: "FN_DISPATCH_SECRET", sourceEnv: "SITE_FN_DISPATCH_SECRET" },
  { workerEnv: "ZAVI_FN_DISPATCHER_WORKER_NAME", secret: "FN_DISPATCH_SECRET", sourceEnv: "SITE_FN_DISPATCH_SECRET" },
  { workerEnv: "ZAVI_SITE_GATEWAY_WORKER_NAME", secret: "FN_ASSERTION_SECRET", sourceEnv: "SITE_FN_ASSERTION_SECRET" },
  { workerEnv: "ZAVI_FN_OUTBOUND_WORKER_NAME", secret: "FN_ASSERTION_SECRET", sourceEnv: "SITE_FN_ASSERTION_SECRET" },
  { workerEnv: "SITE_FN_TAIL_WORKER", secret: "FN_LOG_SECRET", sourceEnv: "SITE_FN_LOG_SECRET" },
];

export type SecretAction =
  | "unchanged"
  | "put"
  | "would_put"
  | "error";

export type PutReason = "absent_on_worker" | "changed" | "no_fingerprint" | "forced";

export type SecretOutcome = {
  worker: string;
  secret: string;
  action: SecretAction;
  reason?: PutReason;
  error?: string;
};

export type WorkerOutcome = {
  worker: string;
  status: "ok" | "missing_worker" | "refused" | "error";
  error?: string;
};

export type ConvergeResult =
  | { ok: false; skipped: "not_configured"; missing: string[] }
  | {
      ok: boolean;
      skipped?: undefined;
      dry_run: boolean;
      workers: WorkerOutcome[];
      secrets: SecretOutcome[];
      counts: { put: number; would_put: number; unchanged: number; errors: number; missing_workers: number };
    };

export type FingerprintStore = {
  load(accountId: string): Promise<Map<string, string>>;
  save(accountId: string, worker: string, secret: string, fingerprint: string): Promise<void>;
};

export type ConvergeDeps = {
  env?: Env;
  fetch?: typeof fetch;
  store?: FingerprintStore;
  alert?: (code: string, msg: string) => Promise<void>;
  log?: (line: string) => void;
};

export type ConvergeOptions = { dryRun?: boolean; force?: boolean };

const fpKey = (worker: string, secret: string) => `${worker}\u0000${secret}`;

export function secretFingerprint(key: string, accountId: string, worker: string, secret: string, value: string): string {
  return createHmac("sha256", key).update(`zavi-worker-secret:v1\u0000${accountId}\u0000${worker}\u0000${secret}\u0000${value}`).digest("hex");
}

export function workerEnvRefusal(worker: string, env: Env): string | null {
  const staging = (env.EXECUTION_ENV ?? "").trim().toLowerCase() === "staging";
  const devName = worker.endsWith("-dev");
  if (staging && !devName) return `staging backend refuses non -dev Worker ${worker}`;
  if (!staging && devName) return `non-staging backend refuses -dev Worker ${worker}`;
  return null;
}

export function cloudflareConfig(env: Env): { ok: true; accountId: string; token: string } | { ok: false; missing: string[] } {
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const token = (env.CLOUDFLARE_WFP_API_TOKEN ?? "").trim() || (env.CLOUDFLARE_STATIC_API_TOKEN ?? "").trim();
  const missing = [...(accountId ? [] : ["CLOUDFLARE_ACCOUNT_ID"]), ...(token ? [] : ["CLOUDFLARE_WFP_API_TOKEN"])];
  return missing.length ? { ok: false, missing } : { ok: true, accountId, token };
}

type CfError = { status: number; codes: number[]; message: string };

async function cfCall(
  f: typeof fetch,
  token: string,
  method: "GET" | "PUT",
  url: string,
  body?: unknown,
): Promise<{ ok: true; result: unknown } | { ok: false; err: CfError }> {
  let res: Response;
  try {
    res = await f(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, err: { status: 0, codes: [], message: `network: ${(e as Error).name}` } };
  }
  let json: { success?: boolean; result?: unknown; errors?: Array<{ code?: number; message?: string }> } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
  }
  if (res.ok && json.success !== false) return { ok: true, result: json.result };
  const errors = json.errors ?? [];
  return {
    ok: false,
    err: {
      status: res.status,
      codes: errors.map((e) => Number(e.code)).filter((n) => Number.isFinite(n)),
      message: errors.map((e) => String(e.message ?? "")).join("; ") || `HTTP ${res.status}`,
    },
  };
}

const isScriptMissing = (e: CfError) => e.status === 404 || e.codes.includes(10007);

export async function convergePlatformWorkerSecrets(opts: ConvergeOptions = {}, deps: ConvergeDeps = {}): Promise<ConvergeResult> {
  const env = deps.env ?? process.env;
  const f = deps.fetch ?? fetch;
  const log = deps.log ?? ((l: string) => console.log(l));
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;

  const byWorker = new Map<string, Array<{ secret: string; value: string; sourceEnv: string }>>();
  const refusedWorkers: WorkerOutcome[] = [];
  const secrets: SecretOutcome[] = [];
  for (const spec of PLATFORM_WORKER_SECRETS) {
    const worker = (env[spec.workerEnv] ?? "").trim();
    const value = env[spec.sourceEnv] ?? "";
    if (!worker || !value.trim()) continue;
    if (!WORKER_NAME_RE.test(worker)) {
      if (!refusedWorkers.some((w) => w.worker === worker)) refusedWorkers.push({ worker, status: "refused", error: `${spec.workerEnv} is not a valid Worker name` });
      continue;
    }
    if (!SECRET_NAME_RE.test(spec.secret)) throw new Error(`bad secret name in PLATFORM_WORKER_SECRETS: ${spec.secret}`);
    if (value !== value.trim()) {
      secrets.push({ worker, secret: spec.secret, action: "error", error: `${spec.sourceEnv} has leading/trailing whitespace` });
      continue;
    }
    const list = byWorker.get(worker) ?? [];
    if (!list.some((s) => s.secret === spec.secret)) list.push({ secret: spec.secret, value, sourceEnv: spec.sourceEnv });
    byWorker.set(worker, list);
  }

  if (byWorker.size === 0 && refusedWorkers.length === 0 && secrets.length === 0) {
    return { ok: true, dry_run: dryRun, workers: [], secrets: [], counts: { put: 0, would_put: 0, unchanged: 0, errors: 0, missing_workers: 0 } };
  }

  const cfg = cloudflareConfig(env);
  if (!cfg.ok) {
    log(`[worker-secrets] NOT converged: Cloudflare not configured (missing ${cfg.missing.join(", ")})`);
    if (!dryRun && deps.alert) {
      await deps
        .alert("sites.worker_secrets.failed", `platform Worker secrets cannot be converged: missing ${cfg.missing.join(", ")} in the backend env`)
        .catch((e) => log(`[worker-secrets] alert failed: ${(e as Error).message.slice(0, 120)}`));
    }
    return { ok: false, skipped: "not_configured", missing: cfg.missing };
  }
  const { accountId, token } = cfg;
  const fpKeyMaterial = (env.PLATFORM_SECRET_FINGERPRINT_KEY ?? "").trim() || token;
  const sensitive = [
    token,
    (env.CLOUDFLARE_WFP_API_TOKEN ?? "").trim(),
    (env.CLOUDFLARE_STATIC_API_TOKEN ?? "").trim(),
    fpKeyMaterial,
    ...PLATFORM_WORKER_SECRETS.map((sp) => env[sp.sourceEnv] ?? ""),
  ].filter((v) => v.length >= 8);
  const scrub = (msg: string) => redactValues(msg, sensitive).slice(0, 200);
  const store = deps.store ?? defaultFingerprintStore();

  let stored = new Map<string, string>();
  let storeOk = true;
  try {
    stored = await store.load(accountId);
  } catch (e) {
    storeOk = false;
    log(`[worker-secrets] fingerprint store unreadable: ${(e as Error).message.slice(0, 200)}`);
  }

  const workers: WorkerOutcome[] = [...refusedWorkers];
  for (const [worker, list] of byWorker) {
    const refusal = workerEnvRefusal(worker, env);
    if (refusal) {
      workers.push({ worker, status: "refused", error: refusal });
      for (const s of list) secrets.push({ worker, secret: s.secret, action: "error", error: refusal });
      continue;
    }
    const base = `${CF}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(worker)}/secrets`;
    const listed = await cfCall(f, token, "GET", base);
    if (!listed.ok) {
      const missing = isScriptMissing(listed.err);
      workers.push({ worker, status: missing ? "missing_worker" : "error", error: missing ? "Worker does not exist yet (deploy it first)" : scrub(listed.err.message) });
      for (const s of list) secrets.push({ worker, secret: s.secret, action: "error", error: missing ? "worker_missing" : "list_failed" });
      continue;
    }
    const present = new Set(
      (Array.isArray(listed.result) ? listed.result : [])
        .map((r) => (r && typeof r === "object" ? String((r as { name?: unknown }).name ?? "") : ""))
        .filter(Boolean),
    );
    let workerErr: string | undefined;
    for (const s of list) {
      const fp = secretFingerprint(fpKeyMaterial, accountId, worker, s.secret, s.value);
      const prev = stored.get(fpKey(worker, s.secret));
      const reason: PutReason | null = force
        ? "forced"
        : !present.has(s.secret)
          ? "absent_on_worker"
          : prev === undefined
            ? "no_fingerprint"
            : prev !== fp
              ? "changed"
              : null;
      if (!reason) {
        secrets.push({ worker, secret: s.secret, action: "unchanged" });
        continue;
      }
      if (dryRun) {
        secrets.push({ worker, secret: s.secret, action: "would_put", reason });
        continue;
      }
      if (!storeOk) {
        secrets.push({ worker, secret: s.secret, action: "error", reason, error: "fingerprint_store_unavailable" });
        continue;
      }
      const put = await cfCall(f, token, "PUT", base, { name: s.secret, text: s.value, type: "secret_text" });
      if (!put.ok) {
        workerErr = scrub(put.err.message);
        secrets.push({ worker, secret: s.secret, action: "error", reason, error: `put_failed: ${workerErr}` });
        continue;
      }
      try {
        await store.save(accountId, worker, s.secret, fp);
      } catch (e) {
        secrets.push({ worker, secret: s.secret, action: "put", reason, error: `fingerprint_save_failed: ${scrub((e as Error).message).slice(0, 120)}` });
        continue;
      }
      secrets.push({ worker, secret: s.secret, action: "put", reason });
    }
    workers.push({ worker, status: workerErr ? "error" : "ok", ...(workerErr ? { error: workerErr } : {}) });
  }

  const counts = {
    put: secrets.filter((s) => s.action === "put").length,
    would_put: secrets.filter((s) => s.action === "would_put").length,
    unchanged: secrets.filter((s) => s.action === "unchanged").length,
    errors: secrets.filter((s) => s.action === "error" || s.error).length + workers.filter((w) => w.status === "refused" && !byWorker.has(w.worker)).length,
    missing_workers: workers.filter((w) => w.status === "missing_worker").length,
  };
  const ok = counts.errors === 0 && workers.every((w) => w.status === "ok");

  for (const s of secrets) {
    if (s.action === "unchanged") continue;
    log(`[worker-secrets] ${s.worker} ${s.secret}: ${s.action}${s.reason ? ` (${s.reason})` : ""}${s.error ? ` error=${s.error}` : ""}`);
  }
  log(
    `[worker-secrets] ${dryRun ? "dry run" : "converged"}: ${counts.put} put, ${counts.would_put} would put, ${counts.unchanged} unchanged, ${counts.errors} error(s), ${counts.missing_workers} missing Worker(s)`,
  );

  if (!ok && !dryRun && deps.alert !== undefined) {
    const bad = workers.filter((w) => w.status !== "ok").map((w) => `${w.worker}: ${w.status}${w.error ? ` (${w.error})` : ""}`);
    const badSecrets = secrets.filter((s) => s.action === "error" || s.error).map((s) => `${s.worker}/${s.secret}: ${s.error}`);
    const missingOnly = workers.every((w) => w.status === "ok" || w.status === "missing_worker") && badSecrets.every((b) => b.endsWith("worker_missing"));
    await deps
      .alert(
        missingOnly ? "sites.worker_secrets.worker_missing" : "sites.worker_secrets.failed",
        `platform Worker secrets not converged (${accountId.slice(0, 6)}…): ${[...bad, ...badSecrets].join("; ").slice(0, 900)}. ` +
          (missingOnly
            ? "A Worker is not deployed yet: run the deploy (CI deploys the site Workers), then restart or run admin > Scripts > platform-worker-secrets."
            : "Retried on the next boot; fix the cause, then run admin > Scripts > platform-worker-secrets."),
      )
      .catch((e) => log(`[worker-secrets] alert failed: ${(e as Error).message.slice(0, 120)}`));
  }

  return { ok, dry_run: dryRun, workers, secrets, counts };
}

export function redactValues(msg: string, values: string[]): string {
  let out = msg;
  for (const v of values) if (v && out.includes(v)) out = out.split(v).join("[redacted]");
  return out;
}

export function defaultFingerprintStore(): FingerprintStore {
  return {
    async load(accountId) {
      const { globalClient } = await import("@/services/tenant-client");
      const { data, error } = await globalClient()
        .from(FINGERPRINT_TABLE)
        .select("worker_name, secret_name, fingerprint")
        .eq("account_id", accountId)
        .limit(500);
      if (error) throw new Error(`load fingerprints: ${error.message}`);
      const m = new Map<string, string>();
      for (const r of (data ?? []) as Array<{ worker_name: string; secret_name: string; fingerprint: string }>) {
        m.set(fpKey(r.worker_name, r.secret_name), r.fingerprint);
      }
      return m;
    },
    async save(accountId, worker, secret, fingerprint) {
      const { globalClient } = await import("@/services/tenant-client");
      const { error } = await globalClient()
        .from(FINGERPRINT_TABLE)
        .upsert(
          { account_id: accountId, worker_name: worker, secret_name: secret, fingerprint, updated_at: new Date().toISOString() },
          { onConflict: "account_id,worker_name,secret_name" },
        );
      if (error) throw new Error(`save fingerprint: ${error.message}`);
    },
  };
}

export async function productionWorkerSecretsAlert(code: string, msg: string): Promise<void> {
  const { alert } = await import("@/services/logging/alert");
  await alert({ msg, source: ALERT_SOURCE, code });
}

export async function convergePlatformWorkerSecretsOnBoot(deps: ConvergeDeps = {}): Promise<ConvergeResult | null> {
  try {
    return await convergePlatformWorkerSecrets({}, { alert: productionWorkerSecretsAlert, ...deps });
  } catch (e) {
    console.error(`[worker-secrets] boot convergence crashed (non-fatal): ${(e as Error).message.slice(0, 200)}`);
    return null;
  }
}
