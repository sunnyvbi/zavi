
import { randomUUID } from "node:crypto";
import { SITE_REPO_DIR, type SiteRow, type SiteSandbox } from "./contract";
import { siteOriginState } from "./sandbox-resolver";
import type { SiteEditLease } from "./site-preview-lease";
import {
  commitWithChangeRecord,
  sandboxScriptCommand,
  sha256,
  type DirectTextDeps,
  type RepoAuth,
} from "./site-text-direct";

export type DirectChangeFile = {
  path: string;
  before: string | null;
  after: string;
  encoding?: "base64";
};

export type DirectChangePlan = { files: DirectChangeFile[]; label: string } | { reason: string };

export type DirectChangeResult =
  | { ok: true; commit_sha: string; conductor_run_id: string; files: string[] }
  | { ok: false; reason: string };

export type DirectChangeDeps = Omit<DirectTextDeps, "clearRows" | "gate">;

const REPO_FULL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
export const DIRECT_WRITE_PATH_RE =
  /^(?:index\.html|src\/(?:[A-Za-z0-9_@][A-Za-z0-9_.@-]*\/)*[A-Za-z0-9_@][A-Za-z0-9_.@-]*\.(?:tsx|ts|jsx|css)|public\/favicon\.svg|public\/images\/(?:logo\.svg|[a-z0-9][a-z0-9-]{0,80}\.(?:webp|json)))$/;
const SANDBOX_TIMEOUT_MS = 30_000;
const WRITE_MARK = "__ZAVI_DIRECT__";
const ORIGIN_MARK = "__ZAVI_ORIGIN__";

const WRITE_SCRIPT = String.raw`const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const input = JSON.parse(Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64").toString("utf8"));
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
const say = (m, code) => { process.stdout.write("${WRITE_MARK}" + m + "\n"); process.exit(code); };
for (const f of input.files) if (f.stage) { f.content = fs.readFileSync(f.stage, "utf8"); try { fs.unlinkSync(f.stage); } catch (e) {} }
const body = (f) => f.encoding === "base64" ? Buffer.from(f.content, "base64") : Buffer.from(f.content, "utf8");
for (const f of input.files) {
  if (typeof f.path !== "string" || f.path.includes("..") || f.path.startsWith("/")) say("bad_path", 2);
  let cur = null;
  try {
    const st = fs.lstatSync(f.path);
    if (!st.isFile()) say("not_a_file", 3);
    cur = fs.readFileSync(f.path);
  } catch (e) { if (e && e.code !== "ENOENT") say("unreadable", 3); }
  if (f.from === null) {
    if (cur !== null && hash(cur) !== hash(body(f)) && !input.lenient) say("exists", 4);
  } else if (f.remove) {
    if (cur === null) continue;
  } else if (cur === null || (hash(cur) !== f.from && hash(cur) !== hash(body(f)))) {
    if (!input.lenient) say("changed", 4);
  }
}
let written = 0;
for (const f of input.files) {
  try {
    if (f.remove) { try { fs.unlinkSync(f.path); } catch (e) {} written += 1; continue; }
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    const tmp = f.path + ".zavi-" + process.pid + ".tmp";
    let mode = 0o644;
    try { mode = fs.statSync(f.path).mode & 0o777; } catch (e) {}
    fs.writeFileSync(tmp, body(f), { mode });
    fs.renameSync(tmp, f.path);
    written += 1;
  } catch (e) {
    say("write_failed:" + written, 5);
  }
}
say("ok:" + written, 0);
`;

type SandboxWrite = { path: string; content: string; encoding?: "base64"; from: string | null; remove?: boolean; stage?: string };

export const STAGE_AT_CHARS = 48_000;
const STAGE_CHUNK_CHARS = 60_000;

async function stageLarge(sandbox: SiteSandbox, files: SandboxWrite[]): Promise<SandboxWrite[]> {
  const out: SandboxWrite[] = [];
  for (const [i, f] of files.entries()) {
    if (f.remove || f.content.length <= STAGE_AT_CHARS) {
      out.push(f);
      continue;
    }
    const b64 = f.encoding === "base64" ? f.content : Buffer.from(f.content, "utf8").toString("base64");
    const stage = `/tmp/zavi-direct-${randomUUID()}-${i}.b64`;
    for (let at = 0; at < b64.length; at += STAGE_CHUNK_CHARS) {
      const r = await sandbox.run(`printf '%s' '${b64.slice(at, at + STAGE_CHUNK_CHARS)}' >> ${stage}`, { timeoutMs: SANDBOX_TIMEOUT_MS });
      if (r.exitCode !== 0) throw new Error("stage_failed");
    }
    out.push({ ...f, content: "", encoding: "base64", stage });
  }
  return out;
}

async function writeSandbox(sandbox: SiteSandbox, raw: SandboxWrite[], lenient = false): Promise<{ ok: boolean; detail: string }> {
  const files = await stageLarge(sandbox, raw);
  const r = await sandbox.run(sandboxScriptCommand(WRITE_SCRIPT, { files, lenient }), { cwd: SITE_REPO_DIR, timeoutMs: SANDBOX_TIMEOUT_MS });
  const line = r.stdout.split("\n").find((l) => l.startsWith(WRITE_MARK));
  const detail = line ? line.slice(WRITE_MARK.length) : `exit_${r.exitCode}`;
  return { ok: r.exitCode === 0 && detail.startsWith("ok:"), detail };
}

function forward(files: DirectChangeFile[]): SandboxWrite[] {
  return files.map((f) => ({
    path: f.path,
    content: f.after,
    ...(f.encoding ? { encoding: f.encoding } : {}),
    from: f.before === null ? null : sha256(f.before),
  }));
}

function backward(files: DirectChangeFile[]): SandboxWrite[] {
  return files.map((f) =>
    f.before === null ? { path: f.path, content: "", from: "", remove: true } : { path: f.path, content: f.before, from: sha256(f.after) },
  );
}

export async function sandboxOrigin(sandbox: SiteSandbox): Promise<string | null> {
  const r = await sandbox.run(`printf '${ORIGIN_MARK}'; git remote get-url origin`, { cwd: SITE_REPO_DIR, timeoutMs: SANDBOX_TIMEOUT_MS });
  if (r.exitCode !== 0) return null;
  const line = r.stdout.split("\n").find((l) => l.startsWith(ORIGIN_MARK));
  return line ? line.slice(ORIGIN_MARK.length).trim() || null : null;
}

export async function readSandboxFiles(sandbox: SiteSandbox, paths: ReadonlyArray<string>): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  for (const p of paths) {
    const raw = await sandbox.readFile(`${SITE_REPO_DIR}/${p}`).catch(() => null);
    if (raw === null) continue;
    out.push({ path: p, content: typeof raw === "string" ? raw : raw.toString("utf8") });
  }
  return out;
}

export async function runDirectSiteChange(
  input: { tenant_id: string; site: SiteRow; kind: string; plan: (sandbox: SiteSandbox) => Promise<DirectChangePlan> },
  deps: DirectChangeDeps,
): Promise<DirectChangeResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const log = deps.log ?? ((l) => console.log(JSON.stringify(l)));
  const { tenant_id, site } = input;
  const done = (r: DirectChangeResult): DirectChangeResult => {
    log({ evt: "site_direct_change", kind: input.kind, tenant_id, site_id: site.id, ok: r.ok, reason: r.ok ? null : r.reason, ms: now() - started });
    return r;
  };
  if (site.tenant_id !== tenant_id) return done({ ok: false, reason: "not_your_site" });
  const repo = (site.github_full_name ?? "").trim();
  if (!REPO_FULL_RE.test(repo)) return done({ ok: false, reason: "no_repo" });

  const lease = await deps.claimLease(tenant_id, site.id).catch((): SiteEditLease => ({ held: "unknown" }));
  if (!("release" in lease)) return done({ ok: false, reason: lease.held === "wake" || lease.held === "restart" ? "preview_starting" : "lease_held" });
  try {
    if (await deps.hasActiveBuild(tenant_id).catch(() => true)) return done({ ok: false, reason: "build_active" });
    const gate = await deps.repoGate(tenant_id, repo).catch(() => ({ ok: false }) as { ok: boolean; site_id?: string });
    if (!gate.ok || (gate.site_id && gate.site_id !== site.id)) return done({ ok: false, reason: "repo_gate" });
    const sandbox = await deps.sandboxFor(tenant_id, site.id).catch(() => null);
    if (!sandbox) return done({ ok: false, reason: "sandbox_unavailable" });
    const origin = await sandboxOrigin(sandbox).catch(() => null);
    if (siteOriginState(origin, repo) === "foreign") return done({ ok: false, reason: "foreign_tree" });

    const plan = await input.plan(sandbox).catch((e: unknown): DirectChangePlan => ({ reason: `plan_failed:${String((e as Error)?.message ?? e).slice(0, 80)}` }));
    if ("reason" in plan) return done({ ok: false, reason: plan.reason });
    const files = plan.files;
    if (files.length === 0) return done({ ok: false, reason: "no_change" });
    if (files.some((f) => !DIRECT_WRITE_PATH_RE.test(f.path) || (f.encoding === "base64" && f.before !== null))) {
      return done({ ok: false, reason: "unsafe_path" });
    }

    const [owner, name] = repo.split("/");
    const installation_id = await deps.installation(tenant_id, repo).catch(() => null);
    if (installation_id === null) return done({ ok: false, reason: "no_installation" });
    const auth: RepoAuth = { tenant_id, installation_id, owner: owner!, repo: name! };
    const head = await deps.mainHead(auth).catch(() => null);
    if (!head) return done({ ok: false, reason: "main_unreadable" });
    const onMain = await Promise.all(
      files.map((f) => deps.readMainFile({ ...auth, sha: head, path: f.path }).then((c): string | null | undefined => c, () => undefined)),
    );
    if (onMain.some((c) => c === undefined)) return done({ ok: false, reason: "main_unreadable" });
    if (files.some((f, i) => (f.before === null ? onMain[i] !== null : onMain[i] !== f.before))) return done({ ok: false, reason: "behind_main" });

    const wrote = await writeSandbox(sandbox, forward(files)).catch((e: unknown) => ({ ok: false, detail: String((e as Error)?.message ?? e).slice(0, 120) }));
    if (!wrote.ok) {
      if (wrote.detail.startsWith("write_failed")) await writeSandbox(sandbox, backward(files), true).catch(() => undefined);
      return done({ ok: false, reason: `sandbox_write_failed:${wrote.detail}` });
    }

    const committed = await commitWithChangeRecord(
      {
        tenant_id,
        site,
        label: plan.label,
        commit: () =>
          deps.commit({
            ...auth,
            expected_parent_sha: head,
            message: plan.label,
            files: files.map((f) => ({
              path: f.path,
              action: f.before === null ? ("create" as const) : ("modify" as const),
              content: f.after,
              ...(f.encoding ? { encoding: f.encoding } : {}),
            })),
          }),
      },
      { ...deps, log },
    );
    if (!committed.ok) {
      const reverted = await writeSandbox(sandbox, backward(files), true).catch(() => ({ ok: false, detail: "revert_threw" }));
      log({ evt: "site_direct_change_persist_failed", kind: input.kind, tenant_id, site_id: site.id, reason: committed.reason, reverted: reverted.ok, error: committed.error });
      return done({ ok: false, reason: committed.reason });
    }
    const { commit_sha, conductor_run_id } = committed;
    await deps.markSiteEdited?.(tenant_id, site.id).catch(() => undefined);
    return done({ ok: true, commit_sha, conductor_run_id, files: files.map((f) => f.path) });
  } finally {
    await lease.release().catch(() => undefined);
  }
}
