import { randomBytes } from "node:crypto";
import { SITE_REPO_DIR, type SiteSandbox } from "./contract";

export const SITE_REPO_FULL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
export const SITE_FETCH_REF = "refs/zavi/fetched";
const SHA_RE = /^[0-9a-f]{7,40}$/;
const STAGING_RE = /^\/tmp\/zavi-fetch-[0-9a-f]{12}-[0-9a-f]{16}$/;

function clip(s: string, n: number): string {
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) throw new Error("site commit: invalid sha");
}

export function siteFetchStagingDir(sha: string, nonce: string = randomBytes(8).toString("hex")): string {
  assertSha(sha);
  const d = `/tmp/zavi-fetch-${sha.slice(0, 12).padEnd(12, "0")}-${nonce}`;
  if (!STAGING_RE.test(d)) throw new Error("site commit: invalid staging dir");
  return d;
}

export function rootFetchCmd(repo: string, sha: string, dir: string): string {
  if (!SITE_REPO_FULL_RE.test(repo)) throw new Error("site commit: invalid repo");
  assertSha(sha);
  const d = dir;
  return [
    "set +e;",
    `mkdir -m 700 '${d}' && git init --bare -q --template= '${d}' &&`,
    `git -C '${d}' fetch --quiet --no-tags https://github.com/${repo}.git ${sha} &&`,
    `git -C '${d}' update-ref ${SITE_FETCH_REF} ${sha};`,
    "rc=$?;",
    `if [ $rc -eq 0 ]; then chown -R user:user '${d}' || rc=1; fi;`,
    `if [ $rc -ne 0 ]; then rm -rf '${d}'; fi;`,
    "exit $rc",
  ].join(" ");
}

export function userImportCmd(sha: string, dir: string): string {
  assertSha(sha);
  const d = dir;
  return [
    "set +e;",
    `git fetch --quiet --no-tags '${d}' ${SITE_FETCH_REF};`,
    "rc=$?;",
    `rm -rf '${d}';`,
    `git cat-file -e ${sha}^{commit} || rc=1;`,
    "exit $rc",
  ].join(" ");
}

export async function ensureSiteCommit(
  sandbox: SiteSandbox,
  repoFullName: string | null | undefined,
  sha: string,
  token: string | null,
): Promise<void> {
  if (!SHA_RE.test(sha)) throw new Error("could not fetch commit: invalid sha");
  const probe = await sandbox.run(`git cat-file -e ${sha}^{commit}`, { cwd: SITE_REPO_DIR, timeoutMs: 60_000 });
  if (probe.exitCode === 0) return;
  const repo = (repoFullName ?? "").trim();
  if (!SITE_REPO_FULL_RE.test(repo)) throw new Error(`could not fetch commit ${sha.slice(0, 7)}: the site has no valid repo`);
  if (!token) {
    const r = await sandbox.run(`git fetch --quiet --no-tags https://github.com/${repo}.git ${sha}`, {
      cwd: SITE_REPO_DIR,
      timeoutMs: 120_000,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    if (r.exitCode !== 0) throw new Error(`could not fetch commit ${sha.slice(0, 7)}: ${clip(r.stderr, 300)}`);
    return;
  }
  const dir = siteFetchStagingDir(sha);
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const fetched = await sandbox.run(rootFetchCmd(repo, sha, dir), {
    cwd: "/",
    timeoutMs: 120_000,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      HOME: "/root",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/dev/null",
    },
    redact: [token, basic],
    user: "root",
  });
  if (fetched.exitCode !== 0) throw new Error(`could not fetch commit ${sha.slice(0, 7)}: ${clip(fetched.stderr, 300)}`);
  const imported = await sandbox.run(userImportCmd(sha, dir), { cwd: SITE_REPO_DIR, timeoutMs: 120_000 }).catch(async (e: unknown) => {
    await sandbox.run(`rm -rf '${dir}'`, { cwd: "/", timeoutMs: 30_000 }).catch(() => undefined);
    throw e;
  });
  if (imported.exitCode !== 0) throw new Error(`could not fetch commit ${sha.slice(0, 7)}: ${clip(imported.stderr, 300)}`);
}
