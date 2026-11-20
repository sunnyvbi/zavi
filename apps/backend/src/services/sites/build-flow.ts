
import { staticHostingConfig } from "@/services/hosting/static-publish";
import { TEMPLATE_FILE_PATHS as VITE_STARTER_PATHS } from "@/services/provisioning/templates/vite-react-supabase/template-files.generated";
import { E2B_VITE_TEMPLATE_ALIAS, E2B_ZAVI_TEMPLATE_ALIAS } from "./contract";
import { detectDedicatedCapabilities } from "@/services/site-shards/capabilities";
import { siteWiringComplete } from "./wiring";
import { siteHostnameConfig } from "./label";
import { previewDomain } from "@/services/site-shards/preview-routing";
import { isProdBackend, PROD_SUPABASE_REF } from "@/services/config/backend-env";

export { PROD_SUPABASE_REF };

function isProdSupabase(url: string | undefined): boolean {
  return isProdBackend({ SUPABASE_URL: url });
}

function hostnameProblem(env: Record<string, string | undefined>): string | null {
  let suffix: string;
  try {
    suffix = siteHostnameConfig(env).suffix;
  } catch {
    return "valid SITE_HOSTNAME_SUFFIX / PRAXIS_PRODUCT_DOMAIN";
  }
  if (!suffix && !isProdSupabase(env.SUPABASE_URL)) {
    return "SITE_HOSTNAME_SUFFIX (required off the prod Supabase project, e.g. -dev)";
  }
  return null;
}

export const SITE_BUILD_REQUIRED_ENV = [
  "GITHUB_PROVISION_TOKEN",
  "SITE_WAKE_HMAC_SECRET",
  "SITE_PREVIEW_HMAC_SECRET",
  "SITE_PREVIEW_DOMAIN",
  "SITE_PREVIEW_ZONE_ID",
  "ZAVI_SITE_GATEWAY_WORKER_NAME",
] as const;

export const DEDICATED_SITE_REQUIRED_ENV = ["SUPABASE_MGMT_TOKEN", "SUPABASE_ORG_ID"] as const;

export const SITE_BUILD_PREREQS_ALERT_CODE = "sites.build_prereqs_missing";

function e2bKey(env: Record<string, string | undefined>): string {
  return (env.E2B_API_KEY ?? env.E2B_KEY ?? "").trim();
}

export const TEMPLATE_PROBE_OK_TTL_MS = 10 * 60_000;
export const TEMPLATE_PROBE_MISS_TTL_MS = 60_000;

export const E2B_API_URL = "https://api.e2b.dev";

const TEMPLATE_PROBE_TIMEOUT_MS = 10_000;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export async function e2bTemplateExists(
  alias: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs: number = TEMPLATE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const res = await fetchImpl(`${E2B_API_URL}/templates`, {
    method: "GET",
    headers: { "X-API-Key": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`e2b templates list failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error("e2b templates list: unexpected body");
  return body.some((t) => {
    if (!t || typeof t !== "object") return false;
    const row = t as { aliases?: unknown; templateID?: unknown };
    if (row.templateID === alias) return true;
    return Array.isArray(row.aliases) && row.aliases.includes(alias);
  });
}

export type SiteBuildPrereqs = { ok: true } | { ok: false; missing: string[] };

export type SiteBuildPrereqDeps = {
  env: () => Record<string, string | undefined>;
  staticHostingOk: () => boolean;
  starterReady: () => boolean;
  dedicatedNeeded: () => Promise<boolean>;
  wiringComplete: () => boolean;
  pooledReasons: () => Promise<string[]>;
  templateExists: (alias: string, apiKey: string) => Promise<boolean>;
  now: () => number;
  log: (line: string) => void;
  alert: (msg: string) => Promise<void>;
};

const defaultDeps: SiteBuildPrereqDeps = {
  env: () => process.env,
  staticHostingOk: () => staticHostingConfig().ok,
  starterReady: () => (VITE_STARTER_PATHS as readonly string[]).includes("package-lock.json"),
  wiringComplete: () => siteWiringComplete(),
  pooledReasons: async () => (await import("@/services/site-shards/facade")).pooledReadiness().reasons(),
  dedicatedNeeded: async () => {
    const starter = (await import("@/services/site-shards/facade")).pooledSeams().starter;
    if (!starter) return false;
    const files = starter.starterFiles();
    let raw: unknown = null;
    try {
      raw = JSON.parse(files.manifest_json);
    } catch {
      raw = null;
    }
    return detectDedicatedCapabilities({ manifestRaw: raw, paths: Object.keys(files.files) }).capabilities.length > 0;
  },
  templateExists: (alias, apiKey) => e2bTemplateExists(alias, apiKey),
  now: () => Date.now(),
  log: (line) => console.warn(line),
  alert: async (msg) => {
    const { alert } = await import("@/services/logging/alert");
    await alert({ msg, source: "site-build", code: SITE_BUILD_PREREQS_ALERT_CODE });
  },
};

export function createSiteBuildPrereqs(deps: SiteBuildPrereqDeps = defaultDeps) {
  const probes = new Map<string, { ok: boolean; expiresAt: number }>();
  let lastState: string | null = null;

  async function templateReady(alias: string, apiKey: string): Promise<boolean> {
    const now = deps.now();
    const cached = probes.get(alias);
    if (cached && cached.expiresAt > now) return cached.ok;
    let ok = false;
    try {
      ok = (await deps.templateExists(alias, apiKey)) === true;
    } catch {
      ok = false;
    }
    probes.set(alias, { ok, expiresAt: now + (ok ? TEMPLATE_PROBE_OK_TTL_MS : TEMPLATE_PROBE_MISS_TTL_MS) });
    return ok;
  }

  function record(missing: string[]): void {
    const state = missing.length ? missing.join(", ") : "ready";
    if (state === lastState) return;
    const first = lastState === null;
    lastState = state;
    if (!missing.length) {
      if (!first) deps.log("[site-build] build prerequisites ready again; new builds start");
      return;
    }
    const line = `website builds refused (retryable): missing ${state}`;
    deps.log(`[site-build] ${line}`);
    void Promise.resolve()
      .then(() => deps.alert(line))
      .catch(() => undefined);
  }

  async function missingNow(): Promise<string[]> {
    const env = deps.env();
    const missing: string[] = SITE_BUILD_REQUIRED_ENV.filter((k) => !(env[k] ?? "").trim());
    if (!e2bKey(env)) missing.push("E2B_API_KEY (or E2B_KEY)");
    if ((env.SITE_PREVIEW_DOMAIN ?? "").trim() && !previewDomain(env)) missing.push("valid SITE_PREVIEW_DOMAIN (a hostname)");
    if (!deps.staticHostingOk()) missing.push("static hosting config (CLOUDFLARE_* / ZAVI_STATIC_*)");
    if (!deps.wiringComplete()) missing.push("site providers (services/sites/wiring.ts)");
    const host = hostnameProblem(env);
    if (host) missing.push(host);
    let pooled: string[];
    try {
      pooled = await deps.pooledReasons();
    } catch {
      pooled = ["readiness_check_failed"];
    }
    for (const r of pooled) missing.push(`pooled site backend: ${r}`);
    let dedicated = false;
    try {
      dedicated = (await deps.dedicatedNeeded()) === true;
    } catch {
      dedicated = false;
    }
    const images: string[] = [E2B_ZAVI_TEMPLATE_ALIAS];
    if (dedicated) {
      for (const k of DEDICATED_SITE_REQUIRED_ENV) if (!(env[k] ?? "").trim()) missing.push(k);
      if (!deps.starterReady()) missing.push("vite starter package-lock.json (run scripts/generate-vite-starter-lockfile.ts)");
      images.push(E2B_VITE_TEMPLATE_ALIAS);
    }
    if (!missing.length) {
      for (const alias of images) if (!(await templateReady(alias, e2bKey(env)))) missing.push(`e2b template ${alias}`);
    }
    return missing;
  }

  async function checkSiteBuildPrereqs(): Promise<SiteBuildPrereqs> {
    let missing: string[];
    try {
      missing = await missingNow();
    } catch {
      missing = ["prerequisite check failed"];
    }
    record(missing);
    return missing.length ? { ok: false, missing } : { ok: true };
  }

  return { checkSiteBuildPrereqs };
}

const defaultChecker = createSiteBuildPrereqs();

export function checkSiteBuildPrereqs(): Promise<SiteBuildPrereqs> {
  return defaultChecker.checkSiteBuildPrereqs();
}
