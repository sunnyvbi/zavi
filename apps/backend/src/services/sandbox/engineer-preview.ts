
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  execCommand,
  resumeSandbox,
  getSandboxHost,
  type SandboxId,
} from "./e2b-client";
import { startPreviewServer, PREVIEW_DEFAULT_PORT, PreviewBootError } from "./preview";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import {
  buildSharedRootInstallSnippet,
  SHARED_CLONE_DIR as SHARED_REPO_DIR,
  SHARED_INSTALL_TIMEOUT_S,
} from "./shared-install";

export async function engineerPreviewEnabled(
  tenant_id: string | null | undefined,
): Promise<boolean> {
  if (!tenant_id) return false;
  try {
    return await getBoolSetting("engineer_live_preview_enabled", tenant_id);
  } catch {
    return false;
  }
}

export async function engineerPreviewGloballyEnabled(): Promise<boolean> {
  try {
    return await getBoolSetting("engineer_live_preview_enabled");
  } catch {
    return false;
  }
}

export const ENGINEER_PREVIEW_PORT = PREVIEW_DEFAULT_PORT;

const UX_EXT_RE = /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|mdx|styl)$/i;
const UX_DIR_RE =
  /(^|\/)(components?|pages?|app|views?|screens?|ui|styles?|layouts?|public|assets|templates?)(\/|$)/i;
const WEB_APP_RE = /(^|\/)apps\/web(\/|$)/i;

export function isUxChangingDiff(
  files: ReadonlyArray<{ path?: unknown }>,
): boolean {
  for (const f of files) {
    const p = typeof f?.path === "string" ? f.path : "";
    if (!p) continue;
    if (UX_EXT_RE.test(p)) return true;
    if (WEB_APP_RE.test(p)) return true;
    if (UX_DIR_RE.test(p)) return true;
  }
  return false;
}

const PREVIEW_PATH_MAX = 300;

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

export function sanitizePreviewPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  if (hasControlChar(raw)) return null;

  const s = raw.trim();
  if (!s || s.length > PREVIEW_PATH_MAX) return null;

  if (!s.startsWith("/")) return null;
  if (s.startsWith("//")) return null;
  if (s.includes("\\")) return null;
  if (hasControlChar(s)) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    return null;
  }
  if (s.includes("..") || decoded.includes("..")) return null;
  if (decoded.includes("\\")) return null;
  if (hasControlChar(decoded)) return null;

  const SENTINEL = "https://preview.invalid";
  let u: URL;
  try {
    u = new URL(s, `${SENTINEL}/`);
  } catch {
    return null;
  }
  if (u.origin !== SENTINEL) return null;

  const out = `${u.pathname}${u.search}`;
  if (!out.startsWith("/") || out.startsWith("//")) return null;
  if (out.length > PREVIEW_PATH_MAX) return null;
  return out;
}

const APP_ROUTER_PAGE_RE = /(?:^|\/)app\/(.*)\/page\.(?:tsx|jsx|ts|js)$/i;
const APP_ROUTER_ROOT_PAGE_RE = /(?:^|\/)app\/page\.(?:tsx|jsx|ts|js)$/i;
const PAGES_ROUTER_RE = /(?:^|\/)pages\/(.+)\.(?:tsx|jsx|ts|js)$/i;
const DYNAMIC_SEG_RE = /\[.*\]/;
const ROUTE_GROUP_SEG_RE = /^\(.*\)$/;
const PAGES_NON_ROUTE_RE = /^(_app|_document|_error|api\/)/i;

function fileToRoute(path: string): string | null {
  if (APP_ROUTER_ROOT_PAGE_RE.test(path)) return "/";

  const app = path.match(APP_ROUTER_PAGE_RE);
  if (app) {
    const segs = app[1]
      .split("/")
      .filter((s) => s.length > 0 && !ROUTE_GROUP_SEG_RE.test(s));
    if (segs.some((s) => DYNAMIC_SEG_RE.test(s))) return null;
    return segs.length === 0 ? "/" : `/${segs.join("/")}`;
  }

  const pages = path.match(PAGES_ROUTER_RE);
  if (pages) {
    const rest = pages[1];
    if (PAGES_NON_ROUTE_RE.test(rest)) return null;
    const segs = rest.split("/").filter((s) => s.length > 0);
    if (segs.some((s) => DYNAMIC_SEG_RE.test(s))) return null;
    if (segs[segs.length - 1]?.toLowerCase() === "index") segs.pop();
    return segs.length === 0 ? "/" : `/${segs.join("/")}`;
  }

  return null;
}

export function derivePreviewPathFromFiles(
  files: ReadonlyArray<{ path?: unknown }>,
): string | null {
  const routes = new Set<string>();
  for (const f of files) {
    const p = typeof f?.path === "string" ? f.path : "";
    if (!p) continue;
    const r = fileToRoute(p);
    if (r) routes.add(r);
  }
  if (routes.size !== 1) return null;
  return sanitizePreviewPath([...routes][0]);
}

const JSX_TEXT_RE = />\s*([A-Za-z][A-Za-z0-9 '&,.!?()-]{2,39})\s*</g;
const GENERIC_MARKERS = new Set([
  "loading", "error", "submit", "cancel", "save", "close", "back", "next",
  "yes", "no", "ok", "home", "login", "log in", "sign in", "sign up",
  "get started", "learn more", "continue", "search", "menu",
]);
const MAX_MARKERS = 5;

export function deriveMarkersForPath(
  files: ReadonlyArray<{ path?: unknown; content?: unknown }>,
  preview_path: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const p = typeof f?.path === "string" ? f.path : "";
    const content = typeof f?.content === "string" ? f.content : "";
    if (!p || !content) continue;
    if (fileToRoute(p) !== preview_path) continue;

    for (const m of content.matchAll(JSX_TEXT_RE)) {
      const text = m[1].trim();
      const key = text.toLowerCase();
      if (GENERIC_MARKERS.has(key) || seen.has(key)) continue;
      if (text.includes("{") || text.includes("&")) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= MAX_MARKERS) return out;
    }
  }
  return out;
}

const TOKEN_TTL_MS = 65 * 60 * 1000;

function tokenSecret(): string {
  return (
    process.env.ENGINEER_PREVIEW_SIGNING_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.INNGEST_SIGNING_KEY ||
    "engineer-preview-dev-insecure-secret"
  );
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export type PreviewTokenClaims = { runId: string; tenantId: string; exp: number };

export function signPreviewToken(
  claims: { runId: string; tenantId: string },
  now: number = Date.now(),
): string {
  const payload: PreviewTokenClaims = {
    runId: claims.runId,
    tenantId: claims.tenantId,
    exp: now + TOKEN_TTL_MS,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", tokenSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyPreviewToken(
  token: string | null | undefined,
  now: number = Date.now(),
): PreviewTokenClaims | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".", 2);
  if (!body || !sig) return null;
  const expected = b64url(createHmac("sha256", tokenSecret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: PreviewTokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(body).toString("utf8")) as PreviewTokenClaims;
  } catch {
    return null;
  }
  if (
    !claims ||
    typeof claims.runId !== "string" ||
    typeof claims.tenantId !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (now > claims.exp) return null;
  return claims;
}

export function rewriteHtmlForProxy(html: string, prefix: string): string {
  const base = `${prefix}/`;
  const hadBase = /<base\s/i.test(html);
  let out = html;
  out = out.replace(
    /\b(href|src|action)=("|')\/(?!\/)([^"']*)\2/gi,
    (_m, attr, q, rest) => `${attr}=${q}${base}${rest}${q}`,
  );
  out = out.replace(/\bsrcset=("|')([^"']*)\1/gi, (_m, q, val) => {
    const fixed = String(val)
      .split(",")
      .map((part) => {
        const t = part.trim();
        return t.startsWith("/") && !t.startsWith("//") ? `${base}${t.slice(1)}` : t;
      })
      .join(", ");
    return `srcset=${q}${fixed}${q}`;
  });
  if (!hadBase) {
    out = out.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<base href="${base}">`);
  }
  return out;
}

const PREVIEW_DIR_PREFIX = "/home/user/preview-";

const SHARED_CLONE_DIR = SHARED_REPO_DIR;

export function engineerPreviewSourceDir(input: {
  worktree_dir: string | null | undefined;
  provisioned_refine: boolean;
}): string | null {
  if (input.worktree_dir) return input.worktree_dir;
  return input.provisioned_refine ? SHARED_CLONE_DIR : null;
}

export const ENGINEER_PREVIEW_INSTALL_TIMEOUT_S = SHARED_INSTALL_TIMEOUT_S;

const COPY_TIMEOUT_MS = (ENGINEER_PREVIEW_INSTALL_TIMEOUT_S + 60) * 1000;

export function previewDirFor(run_id: string): string {
  const safe = String(run_id ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
  return `${PREVIEW_DIR_PREFIX}${safe}`;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function buildPreviewCopyScript(opts: {
  worktree_dir: string;
  preview_dir: string;
  shared_repo?: string;
  allow_npm_install?: boolean;
  install_timeout_s?: number;
}): string {
  const src = opts.worktree_dir;
  const dst = opts.preview_dir;
  const shared = opts.shared_repo ?? SHARED_CLONE_DIR;
  const installTimeout = opts.install_timeout_s ?? ENGINEER_PREVIEW_INSTALL_TIMEOUT_S;
  const rootInstall = buildSharedRootInstallSnippet({
    shared_repo: shared,
    install_timeout_s: installTimeout,
  });
  const npmInstall = opts.allow_npm_install
    ? `(cd ${shq(dst)} && npm install --no-audit --no-fund --silent >/dev/null 2>&1) || true`
    : `:`;
  return [
    `set +e`,
    `rm -rf ${shq(dst)} 2>/dev/null`,
    `mkdir -p ${shq(dst)}`,
    rootInstall,
    `( cd ${shq(src)} && tar cf - --exclude=node_modules --exclude=.git . ) | ( cd ${shq(dst)} && tar xf - ) 2>/dev/null`,
    `if [ ! -e ${shq(dst)}/node_modules ]; then`,
    `  if [ -d ${shq(shared)}/node_modules ]; then ln -s ${shq(shared)}/node_modules ${shq(dst)}/node_modules;`,
    `  elif [ -d ${shq(src)}/node_modules ]; then ln -s ${shq(src)}/node_modules ${shq(dst)}/node_modules;`,
    `  else ${npmInstall}; fi`,
    `fi`,
    `if [ -e ${shq(dst)}/node_modules ]; then`,
    `  echo __PREVCOPY__OK`,
    `else`,
    `  CODE="$(grep -oE 'npm ERR! code [A-Z0-9_]+' "$NPMLOG" 2>/dev/null | tail -1 | grep -oE '[A-Z0-9_]+$')"`,
    `  if [ -z "$CODE" ]; then [ -s "$NPMLOG" ] && CODE=no_npm_err || CODE=install_skipped; fi`,
    `  echo "__PREVCOPY__NOMODULES:$CODE"`,
    `fi`,
  ].join("\n");
}

export type StartEngineerPreviewResult = {
  url: string;
  port: number;
  preview_dir: string;
};

export async function startEngineerPreview(opts: {
  sandbox_id: string;
  worktree_dir: string;
  run_id: string;
  port?: number;
  boot_timeout_seconds?: number;
  start_cmd?: string;
}): Promise<StartEngineerPreviewResult> {
  const port = opts.port ?? ENGINEER_PREVIEW_PORT;
  const previewDir = previewDirFor(opts.run_id);
  const allowNpm =
    (process.env.ENGINEER_PREVIEW_NPM_INSTALL ?? "").trim() === "1";
  const copyScript = buildPreviewCopyScript({
    worktree_dir: opts.worktree_dir,
    preview_dir: previewDir,
    shared_repo: SHARED_CLONE_DIR,
    allow_npm_install: allowNpm,
    install_timeout_s: ENGINEER_PREVIEW_INSTALL_TIMEOUT_S,
  });
  const copyRes = await execCommand(opts.sandbox_id, copyScript, COPY_TIMEOUT_MS);
  if (!/__PREVCOPY__OK/.test(copyRes.stdout)) {
    const m = copyRes.stdout.match(/__PREVCOPY__NOMODULES:([A-Za-z0-9_]+)/);
    const code = m ? m[1] : "unknown";
    throw new PreviewBootError(
      `engineer preview copy prep failed (no node_modules, code=${code})`,
      `no_node_modules:${code}`,
    );
  }
  const { url, port: boundPort } = await startPreviewServer(opts.sandbox_id, port, {
    repo_dir: previewDir,
    allow_npm_install: allowNpm,
    shared_root: SHARED_CLONE_DIR,
    install_timeout_s: ENGINEER_PREVIEW_INSTALL_TIMEOUT_S,
    sanitize_secret_env: true,
    ...(opts.boot_timeout_seconds ? { boot_timeout_seconds: opts.boot_timeout_seconds } : {}),
    ...(opts.start_cmd ? { start_cmd: opts.start_cmd } : {}),
  });
  return { url, port: boundPort, preview_dir: previewDir };
}

const BOOT_ORCHESTRATION_TIMEOUT_MS = COPY_TIMEOUT_MS + 120_000;

export type BootEngineerPreviewInput = {
  sandbox_id: string;
  tenant_id: string;
  repo_full_name: string;
  run_id: string;
  worktree_dir: string | null | undefined;
  files: ReadonlyArray<{ path?: unknown; content?: unknown }>;
  agent_preview_path?: unknown;
};

async function previewRowId(
  tenant_id: string,
  repo_full_name: string,
): Promise<string | null> {
  const { data } = await serviceClient()
    .from("tenant_sandbox")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("repo_full_name", repo_full_name)
    .maybeSingle<{ id: string }>();
  return data?.id ?? null;
}

export type LiveEditPreviewRow = {
  id: string;
  e2b_sandbox_id: string | null;
  preview_status: string | null;
  preview_url: string | null;
  preview_port: number | null;
  preview_run_id?: string | null;
};

export async function loadLiveEditPreviewRow(
  tenant_id: string,
  repo_full_name: string,
): Promise<LiveEditPreviewRow | null> {
  const { data, error } = await serviceClient()
    .from("tenant_sandbox")
    .select("id, e2b_sandbox_id, preview_status, preview_url, preview_port, preview_run_id")
    .eq("tenant_id", tenant_id)
    .eq("repo_full_name", repo_full_name)
    .maybeSingle();
  if (error) throw new Error(`tenant_sandbox read failed: ${error.message}`);
  return (data as LiveEditPreviewRow | null) ?? null;
}

export async function clearLiveEditPreview(row_id: string): Promise<void> {
  const { error } = await serviceClient().rpc("clear_sandbox_preview", {
    p_id: row_id,
    p_final_status: "dead",
  });
  if (error) throw new Error(`clear_sandbox_preview failed: ${error.message}`);
}

export async function touchLiveEditPreview(row_id: string): Promise<void> {
  const { error } = await serviceClient().rpc("touch_sandbox_preview_viewed", { p_id: row_id });
  if (error) throw new Error(`touch_sandbox_preview_viewed failed: ${error.message}`);
}

export async function countOtherLiveEditPreviews(
  exclude_row_id: string,
  run_prefix: string,
): Promise<number> {
  const { count, error } = await serviceClient()
    .from("tenant_sandbox")
    .select("id", { count: "exact", head: true })
    .like("preview_run_id", `${run_prefix}%`)
    .in("preview_status", ["live", "starting"])
    .neq("id", exclude_row_id);
  if (error) throw new Error(`live-edit fleet count failed: ${error.message}`);
  return count ?? 0;
}

export async function setLiveEditPreview(input: {
  row_id: string;
  url: string | null;
  port: number;
  status: "starting" | "live";
  run_marker: string;
}): Promise<void> {
  const { error } = await serviceClient().rpc("set_engineer_sandbox_preview", {
    p_id: input.row_id,
    p_url: input.url,
    p_port: input.port,
    p_status: input.status,
    p_run_id: input.run_marker,
  });
  if (error) throw new Error(`set_engineer_sandbox_preview failed: ${error.message}`);
}

export async function bootEngineerPreviewForRun(
  input: BootEngineerPreviewInput,
): Promise<{ booted: boolean; reason: string }> {
  if (!(await engineerPreviewEnabled(input.tenant_id))) {
    return { booted: false, reason: "disabled" };
  }
  if (!input.worktree_dir || !input.worktree_dir.startsWith("/home/user/")) {
    return { booted: false, reason: "no_worktree" };
  }
  if (!isUxChangingDiff(input.files)) {
    return { booted: false, reason: "not_ux_changing" };
  }

  const rowId = await previewRowId(input.tenant_id, input.repo_full_name).catch(
    () => null,
  );
  if (!rowId) return { booted: false, reason: "no_sandbox_row" };

  const previewPath =
    sanitizePreviewPath(input.agent_preview_path) ??
    derivePreviewPathFromFiles(input.files);

  const sb = serviceClient();
  try {
    await sb.rpc("set_engineer_sandbox_preview", {
      p_id: rowId,
      p_url: null,
      p_port: ENGINEER_PREVIEW_PORT,
      p_status: "starting",
      p_run_id: input.run_id,
      p_path: previewPath,
    });
  } catch {
  }

  try {
    const result = await Promise.race([
      startEngineerPreview({
        sandbox_id: input.sandbox_id,
        worktree_dir: input.worktree_dir,
        run_id: input.run_id,
        boot_timeout_seconds: 45,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("engineer preview boot orchestration timeout")),
          BOOT_ORCHESTRATION_TIMEOUT_MS,
        ),
      ),
    ]);
    await sb.rpc("set_engineer_sandbox_preview", {
      p_id: rowId,
      p_url: result.url,
      p_port: result.port,
      p_status: "live",
      p_run_id: input.run_id,
      p_path: previewPath,
    });

    if (previewPath) {
      try {
        const { probeEngineerPreviewPath } = await import("@/services/pipeline/preview-probe");
        const verdict = await probeEngineerPreviewPath({
          preview_url: result.url,
          preview_path: previewPath,
          markers: deriveMarkersForPath(input.files, previewPath),
        });
        await sb.rpc("set_engineer_sandbox_preview", {
          p_id: rowId,
          p_url: result.url,
          p_port: result.port,
          p_status: "live",
          p_run_id: input.run_id,
          p_path: previewPath,
          p_outcome: verdict.outcome,
          p_off_target_reason: verdict.reason,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[engineer preview] deep-link probe failed for run=${input.run_id}: ${(e as Error).message ?? e}`,
        );
      }
    }
    return { booted: true, reason: "live" };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[engineer preview] boot failed for ${input.repo_full_name} run=${input.run_id}: ${(e as Error).message ?? e}`,
    );
    let deadReason: string;
    if (e instanceof PreviewBootError) {
      deadReason = e.deadReason;
    } else {
      const msg = String((e as Error)?.message ?? "");
      deadReason = /orchestration timeout/i.test(msg)
        ? "boot_orchestration_timeout"
        : /instant preview disabled/i.test(msg)
          ? "preview_disabled"
          : "boot_error";
    }
    try {
      await sb.rpc("expire_engineer_sandbox_preview", {
        p_id: rowId,
        p_reason: deadReason,
      });
    } catch {
    }
    return { booted: false, reason: "boot_failed" };
  }
}

async function probePreviewPort(
  sandbox_id: SandboxId,
  port: number,
): Promise<boolean> {
  const res = await execCommand(
    sandbox_id,
    `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:${port}/ 2>/dev/null || echo 000`,
    15_000,
  ).catch(() => null);
  const code = (res?.stdout ?? "").trim().slice(-3);
  return /^[1-5]\d\d$/.test(code) && code !== "000";
}

export type RestartEngineerPreviewResult = {
  restarted: boolean;
  reason: string;
};

export async function restartEngineerPreview(opts: {
  row_id: string;
  sandbox_id: string;
  run_id: string;
  port?: number;
}): Promise<RestartEngineerPreviewResult> {
  const sb = serviceClient();
  const port = opts.port ?? ENGINEER_PREVIEW_PORT;

  await sb.rpc("set_engineer_sandbox_preview", {
    p_id: opts.row_id,
    p_url: null,
    p_port: port,
    p_status: "starting",
    p_run_id: opts.run_id,
  });

  const fail = async (reason: string): Promise<RestartEngineerPreviewResult> => {
    try {
      await sb.rpc("expire_engineer_sandbox_preview", {
        p_id: opts.row_id,
        p_reason: reason,
      });
    } catch {
    }
    return { restarted: false, reason };
  };

  try {
    await resumeSandbox(opts.sandbox_id);
  } catch {
    return fail("restart_failed:sandbox_gone");
  }

  if (!(await probePreviewPort(opts.sandbox_id, port))) {
    return fail("restart_failed:port_unbound");
  }

  let url: string;
  try {
    url = await getSandboxHost(opts.sandbox_id, port);
  } catch {
    return fail("restart_failed:no_host");
  }

  await sb.rpc("set_engineer_sandbox_preview", {
    p_id: opts.row_id,
    p_url: url,
    p_port: port,
    p_status: "live",
    p_run_id: opts.run_id,
  });
  return { restarted: true, reason: "live" };
}
