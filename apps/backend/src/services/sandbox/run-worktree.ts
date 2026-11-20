
import { execCommand, refreshOriginUrlStep } from "@/services/sandbox/e2b-client";
import { logEvent } from "@/services/logging/logEvent";
import { RUNNING_HARD_CAP_HOURS } from "@/services/agents/run-hard-cap";

export function redactGitCreds(s: string): string {
  return s.replace(/https:\/\/[^@\s'"/]+:[^@\s'"/]+@/g, "https://[redacted]@");
}

const REPO_ROOT = "/home/user/repo";
const WT_PREFIX = "/home/user/wt-";
const LEASE_DIR = "/home/user/.praxis/wt-leases";
const WT_REAP_GRACE_MARGIN_MS = 15 * 60 * 1000;
export const WT_REAP_GRACE_MS =
  RUNNING_HARD_CAP_HOURS * 60 * 60 * 1000 + WT_REAP_GRACE_MARGIN_MS;
const WT_TIMEOUT_MS = 240_000;
const WT_CHECKOUT_CFG = "-c checkout.workers=1 -c checkout.thresholdForParallelism=100";
const WT_FAIL_DIAG =
  `RC=$?; if [ "$RC" -ne 0 ]; then ` +
  `echo "[wt-diag] df:"; df -h . 2>&1 | tail -2; ` +
  `echo "[wt-diag] free:"; free -m 2>&1 | tail -2; ` +
  `fi; echo RC=$RC`;

const WT_DISK_MARGIN_KB = 512 * 1024;

const WT_BLOCK_KB = 4;

export type WtProbeRefKind = "origin_base" | "head" | "none";

function parseProbeRefKind(out: string): WtProbeRefKind {
  const m = out.match(/REFKIND=(origin_base|head|none)/);
  return m ? (m[1] as WtProbeRefKind) : "none";
}

export async function preflightWorktreeDisk(
  sandbox_id: string,
  base?: string,
): Promise<
  | { ok: true; treeKb: number | null; checkoutKb: number | null; refKind: WtProbeRefKind }
  | {
      ok: false;
      error: string;
      treeKb: number;
      checkoutKb: number;
      refKind: WtProbeRefKind;
    }
> {
  const refExpr = base
    ? `REF=origin/${shq(base)}; REFKIND=origin_base; ` +
      `git -C "${REPO_ROOT}" rev-parse --verify --quiet "$REF" >/dev/null 2>&1 || { REF=HEAD; REFKIND=head; }; ` +
      `git -C "${REPO_ROOT}" rev-parse --verify --quiet "$REF" >/dev/null 2>&1 || { REF=; REFKIND=none; }; `
    : `REF=HEAD; REFKIND=head; ` +
      `git -C "${REPO_ROOT}" rev-parse --verify --quiet HEAD >/dev/null 2>&1 || { REF=; REFKIND=none; }; `;
  const lsTree =
    `git -C "${REPO_ROOT}" ls-tree -r -l "$REF" 2>/dev/null | ` +
    `awk '$2=="blob" && $4~/^[0-9]+$/ {s+=$4; n++} END {print int((s+1023)/1024)" "(n+0)}'`;
  const probe = await execCommand(
    sandbox_id,
    `${refExpr}` +
      `TB="$(${lsTree})"; ` +
      `LFS=0; grep -qs 'filter=lfs' "${REPO_ROOT}/.gitattributes" && LFS=1; ` +
      `echo "FREE=$(df -Pk "${REPO_ROOT}" 2>/dev/null | tail -1 | awk '{print $4}') ` +
      `REPO=$(du -sxk "${REPO_ROOT}" 2>/dev/null | awk '{print $1}') ` +
      `GIT=$(du -sxk "${REPO_ROOT}/.git" 2>/dev/null | awk '{print $1}') ` +
      `TRACKED=\${TB%% *} BLOBS=\${TB##* } LFS=$LFS REFKIND=$REFKIND"`,
    30_000,
  );
  const out = probe.stdout || "";
  const num = (k: string): number | null => {
    const m = out.match(new RegExp(`${k}=(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const refKind = parseProbeRefKind(out);
  const free = num("FREE");
  const repo = num("REPO");
  const git = num("GIT");
  if (free == null || repo == null || git == null || repo <= 0 || free < 0) {
    return { ok: true, treeKb: null, checkoutKb: null, refKind };
  }
  const treeKb = Math.max(repo - git, 0);
  const tracked = num("TRACKED");
  const blobs = num("BLOBS");
  if (tracked == null || blobs == null || blobs <= 0) {
    return { ok: true, treeKb, checkoutKb: null, refKind };
  }
  const checkoutKb = Math.max(tracked, blobs * WT_BLOCK_KB);
  const needKb = Math.ceil(checkoutKb * 1.1) + WT_DISK_MARGIN_KB;
  if (free < needKb) {
    const mb = (kb: number) => Math.round(kb / 1024);
    return {
      ok: false,
      treeKb,
      checkoutKb,
      refKind,
      error:
        `insufficient_disk: a second working tree needs ~${mb(needKb)}MB ` +
        `(tracked files ${mb(checkoutKb)}MB + margin) but only ${mb(free)}MB free ` +
        `on ${REPO_ROOT} fs. The sandbox is out of room and disk reclaim did not ` +
        `free enough. This is an infrastructure limit on our end, not a problem ` +
        `with the request.`,
    };
  }
  return { ok: true, treeKb, checkoutKb, refKind };
}

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function isSafeBranch(s: string): boolean {
  return typeof s === "string" && s.length > 0 && !s.startsWith("-") && /^[A-Za-z0-9._/-]+$/.test(s);
}

function safeId(run_id: string): string {
  return String(run_id ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
}
export function worktreePathFor(run_id: string): string {
  return `${WT_PREFIX}${safeId(run_id)}`;
}
function worktreeBranchFor(run_id: string): string {
  return `_mt_wt_${safeId(run_id)}`;
}
export function leasePathFor(run_id: string): string {
  return `${LEASE_DIR}/${safeId(run_id)}`;
}

export async function writeRunWorktreeMarker(
  sandbox_id: string,
  run_id: string,
  wt_path: string,
): Promise<void> {
  const id = safeId(run_id);
  if (!id) return;
  const lease = leasePathFor(run_id);
  const body = JSON.stringify({
    run_id: id,
    wt_path,
    created_at: new Date().toISOString(),
  });
  const cmd = `mkdir -p ${shq(LEASE_DIR)} && printf '%s' ${shq(body)} > ${shq(lease)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await execCommand(sandbox_id, cmd, 15_000);
      if (r.exit_code === 0) return;
    } catch {
    }
  }
  try {
    await logEvent({
      level: "warn",
      source: "run-worktree",
      code: "wt_lease_write_failed",
      run_id,
      meta: { sandbox_id },
    });
  } catch {
  }
}

export function resolveCheckoutBase(opts: {
  payload: Record<string, unknown> | null | undefined;
  defaultBase: string;
}): string {
  const { payload, defaultBase } = opts;
  const raw =
    (payload as { checkout_ref?: unknown } | null | undefined)?.checkout_ref ??
    (payload as { head_branch?: unknown } | null | undefined)?.head_branch;
  if (typeof raw === "string" && isSafeBranch(raw)) return raw;
  return defaultBase;
}

export type CreateWorktreeResult =
  | { ok: true; path: string; branch: string; fellBack?: boolean; treeKb?: number | null }
  | {
      ok: false;
      error: string;
      code?:
        | "worktree_timeout"
        | "worktree_git"
        | "worktree_insufficient_disk"
        | "invalid_run_id"
        | "invalid_base";
      treeKb?: number | null;
    };

function isWorktreeTimeout(r: {
  exit_code: number;
  stdout: string;
  ms: number;
  timed_out?: boolean;
}): boolean {
  if (r.timed_out === true) return true;
  return (
    r.exit_code !== 0 &&
    !/RC=\d+\s*$/.test((r.stdout || "").trim()) &&
    r.ms >= WT_TIMEOUT_MS - 2000
  );
}

export function isWorktreeInterrupted(r: { exit_code: number; stdout: string }): boolean {
  return r.exit_code !== 0 && !/RC=\d+\s*$/.test((r.stdout || "").trim());
}

export async function createRunWorktree(opts: {
  sandbox_id: string;
  run_id: string;
  base: string;
  fetchBase?: boolean;
  defaultBase?: string;
  tenant_id?: string | null;
  agent_slug?: string | null;
}): Promise<CreateWorktreeResult> {
  const { sandbox_id, run_id, base, fetchBase, defaultBase, tenant_id, agent_slug } =
    opts;
  const id = safeId(run_id);
  if (!id) return { ok: false, error: "invalid_run_id", code: "invalid_run_id" };
  if (!isSafeBranch(base))
    return { ok: false, error: `invalid_base: ${base}`, code: "invalid_base" };
  const path = worktreePathFor(run_id);
  const branch = worktreeBranchFor(run_id);
  const disk = await preflightWorktreeDisk(sandbox_id, base);
  void logEvent({
    level: "info",
    source: "sandbox",
    code: "sandbox.worktree_preflight",
    message: "",
    meta: {
      tree_kb: disk.treeKb ?? -1,
      checkout_kb: disk.checkoutKb ?? -1,
      probe_ref_kind: disk.refKind,
      agent_slug: agent_slug ?? undefined,
    },
  }).catch(() => undefined);
  if (!disk.ok) {
    return {
      ok: false,
      error: disk.error,
      code: "worktree_insufficient_disk",
      treeKb: disk.treeKb,
    };
  }
  const measuredTreeKb = disk.treeKb;
  const cleanup =
    `git worktree remove --force ${shq(path)} 2>/dev/null || true; ` +
    `git branch -D ${shq(branch)} 2>/dev/null || true; ` +
    `git worktree prune`;
  const fetchCmd = fetchBase
    ? `${refreshOriginUrlStep()}git fetch --no-tags origin ${shq(base)}:refs/remotes/origin/${shq(base)} 2>&1 && `
    : "";
  const inner =
    `${cleanup} && ${fetchCmd}` +
    `git ${WT_CHECKOUT_CFG} worktree add -f -B ${shq(branch)} ${shq(path)} origin/${shq(base)} 2>&1; ${WT_FAIL_DIAG}`;
  const cmd =
    `cd ${REPO_ROOT} && flock -w 60 /tmp/_praxis_wt.lock -c ${shq(inner)}`;
  let r = await execCommand(sandbox_id, cmd, WT_TIMEOUT_MS);
  if (isWorktreeTimeout(r)) {
    r = await execCommand(sandbox_id, cmd, WT_TIMEOUT_MS);
  }
  const out = r.stdout || "";
  if (r.exit_code !== 0 || !/RC=0\s*$/.test(out.trim())) {
    const missingRef =
      /couldn't find remote ref|not a valid object name|couldn't find remote ref|unknown revision or path/i.test(
        out,
      );
    if (
      fetchBase &&
      missingRef &&
      typeof defaultBase === "string" &&
      isSafeBranch(defaultBase) &&
      defaultBase !== base
    ) {
      const fallbackInner =
        `${cleanup} && ` +
        `git ${WT_CHECKOUT_CFG} worktree add -f -B ${shq(branch)} ${shq(path)} origin/${shq(defaultBase)} 2>&1; ${WT_FAIL_DIAG}`;
      const fbCmd =
        `cd ${REPO_ROOT} && flock -w 60 /tmp/_praxis_wt.lock -c ${shq(fallbackInner)}`;
      const fb = await execCommand(sandbox_id, fbCmd, WT_TIMEOUT_MS);
      const fbOut = fb.stdout || "";
      if (fb.exit_code === 0 && /RC=0\s*$/.test(fbOut.trim())) {
        await writeRunWorktreeMarker(sandbox_id, run_id, path);
        return { ok: true, path, branch, fellBack: true, treeKb: measuredTreeKb };
      }
    }
    const raw =
      [out, r.stderr].filter((s) => s && s.length > 0).join("\n") ||
      "worktree_add_failed";
    const isEnospc = /no space left on device/i.test(raw);
    const interrupted = isWorktreeInterrupted(r);
    const code: "worktree_timeout" | "worktree_git" | "worktree_insufficient_disk" =
      isEnospc
        ? "worktree_insufficient_disk"
        : isWorktreeTimeout(r) || interrupted
          ? "worktree_timeout"
          : "worktree_git";
    try {
      await logEvent({
        level: "warn",
        source: "run-worktree",
        code,
        tenant_id: tenant_id ?? null,
        run_id,
        meta: {
          agent_slug: agent_slug ?? undefined,
          ms: r.ms,
          exit_code: r.exit_code,
          timed_out: r.timed_out === true,
          has_rc_marker: /RC=\d+\s*$/.test(out.trim()),
          sandbox_id,
        },
      });
    } catch {
    }
    const red = redactGitCreds(raw);
    const error =
      red.length > 600
        ? `${red.slice(0, 160)} …[trunc]… ${red.slice(-440)}`
        : red;
    return isEnospc
      ? { ok: false, error, code, treeKb: measuredTreeKb }
      : { ok: false, error, code };
  }
  await writeRunWorktreeMarker(sandbox_id, run_id, path);
  return { ok: true, path, branch, treeKb: measuredTreeKb };
}

export async function removeRunWorktree(opts: {
  sandbox_id: string;
  run_id: string;
}): Promise<void> {
  const { sandbox_id, run_id } = opts;
  const path = worktreePathFor(run_id);
  const branch = worktreeBranchFor(run_id);
  const inner =
    `git worktree remove --force ${shq(path)} 2>/dev/null; ` +
    `git branch -D ${shq(branch)} 2>/dev/null; git worktree prune; ` +
    `rm -f ${shq(leasePathFor(run_id))} 2>/dev/null; true`;
  await execCommand(
    sandbox_id,
    `cd ${REPO_ROOT} && flock -w 60 /tmp/_praxis_wt.lock -c ${shq(inner)}`,
    WT_TIMEOUT_MS,
  );
}

export async function reapOrphanWorktrees(opts: {
  sandbox_id: string;
  keepRunIds?: readonly string[];
}): Promise<{ removed: string[] }> {
  const { sandbox_id, keepRunIds = [] } = opts;
  const keep = new Set(keepRunIds.map((r) => worktreePathFor(r)));
  const list = await execCommand(
    sandbox_id,
    `cd ${REPO_ROOT} && git worktree list --porcelain`,
    WT_TIMEOUT_MS,
  );
  if (list.exit_code !== 0) return { removed: [] };
  const paths = (list.stdout || "")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .filter((p) => p.startsWith(WT_PREFIX) && !keep.has(p));
  const graceSec = Math.ceil(WT_REAP_GRACE_MS / 1000);
  const removed: string[] = [];
  for (const p of paths) {
    const sid = p.slice(WT_PREFIX.length);
    const lease = `${LEASE_DIR}/${sid}`;
    let marker_state: "fresh" | "stale" | "missing" | "probe_error" =
      "probe_error";
    let ageMs = -1;
    try {
      const probe = await execCommand(
        sandbox_id,
        `NOW=$(date +%s); ` +
          `if M=$(stat -c %Y ${shq(lease)} 2>/dev/null); then echo "AGE=$((NOW - M))"; ` +
          `elif [ ! -e ${shq(lease)} ]; then echo MISSING; ` +
          `else echo PROBE_ERROR; fi`,
        15_000,
      );
      const out = (probe.stdout || "").trim();
      const ageMatch = out.match(/^AGE=(\d+)$/);
      if (probe.exit_code === 0 && out === "MISSING") {
        marker_state = "missing";
      } else if (probe.exit_code === 0 && ageMatch) {
        const ageSec = Number(ageMatch[1]);
        ageMs = ageSec * 1000;
        marker_state = ageSec > graceSec ? "stale" : "fresh";
      } else {
        marker_state = "probe_error";
      }
    } catch {
      marker_state = "probe_error";
    }

    if (marker_state === "fresh" || marker_state === "probe_error") {
      try {
        await logEvent({
          level: "info",
          source: "run-worktree",
          code: "wt_reap_skip_live",
          run_id: sid,
          meta: { age_ms: ageMs, marker_state },
        });
      } catch {
      }
      continue;
    }

    const innerRm = `git worktree remove --force ${shq(p)} 2>/dev/null; echo RC=$?`;
    const r = await execCommand(
      sandbox_id,
      `cd ${REPO_ROOT} && flock -w 60 /tmp/_praxis_wt.lock -c ${shq(innerRm)}`,
      WT_TIMEOUT_MS,
    );
    if (/RC=0\s*$/.test((r.stdout || "").trim())) {
      removed.push(p);
      try {
        await execCommand(sandbox_id, `rm -f ${shq(lease)} 2>/dev/null`, 10_000);
      } catch {
      }
    }
  }
  if (removed.length > 0) {
    await execCommand(
      sandbox_id,
      `cd ${REPO_ROOT} && flock -w 60 /tmp/_praxis_wt.lock -c 'git worktree prune; true'`,
      WT_TIMEOUT_MS,
    );
  }
  return { removed };
}
