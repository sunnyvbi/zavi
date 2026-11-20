
import { execCommand } from "@/services/sandbox/e2b-client";
import type { SandboxId } from "@/services/sandbox/e2b-client";
import {
  parseFailingTestNames,
  newlyFailing,
  type FailingTest,
} from "./engineer-test-names";

const BASE_RUN_TIMEOUT_MS = 10 * 60_000;

export type TestAttribution = (
  | {
      kind: "attributed";
      new_failures: FailingTest[];
      pre_existing: FailingTest[];
    }
  | {
      kind: "unknown";
      why: string;
    }
) & {
  restore_failed?: true;
};

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function attributeTestFailures(opts: {
  sandbox_id: SandboxId;
  worktree_path: string;
  command: string | undefined;
  head_failures: FailingTest[] | undefined;
  head_confidence: "high" | "none" | undefined;
}): Promise<TestAttribution> {
  const { sandbox_id, worktree_path, command, head_failures, head_confidence } = opts;

  if (!command) {
    return { kind: "unknown", why: "no test command was captured from the run" };
  }
  if (head_confidence !== "high" || !head_failures || head_failures.length === 0) {
    return {
      kind: "unknown",
      why: "could not enumerate which tests failed on this change",
    };
  }

  const cd = `cd ${q(worktree_path)}`;

  const snap = await snapshotAgentTree(sandbox_id, cd);
  if (!snap) {
    return {
      kind: "unknown",
      why: "could not snapshot the agent's changes before comparing against the base",
    };
  }
  if ("refused" in snap) return { kind: "unknown", why: snap.refused };

  const reset = await execCommand(sandbox_id, `${cd} && ${TO_BASE}`, 120_000);
  if (reset.exit_code !== 0) {
    const restored = await restoreAgentTree(sandbox_id, cd, snap, worktree_path);
    return {
      kind: "unknown",
      why: "could not set the working tree to the base commit for comparison",
      ...(restored ? {} : { restore_failed: true as const }),
    };
  }

  let result: TestAttribution;
  try {
    const base = await execCommand(sandbox_id, `${cd} && ${command}`, BASE_RUN_TIMEOUT_MS);
    const baseParse = parseFailingTestNames(`${base.stdout}\n${base.stderr ?? ""}`);

    if (base.exit_code === 0) {
      result = { kind: "attributed", new_failures: [...head_failures], pre_existing: [] };
    } else {
      const headParse = {
        runner: "unknown" as const,
        names: head_failures,
        confidence: "high" as const,
      };
      const fresh = newlyFailing(headParse, baseParse);
      if (fresh === null) {
        result = {
          kind: "unknown",
          why: "the base branch's tests also fail, but we could not enumerate which ones",
        };
      } else {
        const preExisting = head_failures.filter((n) => !fresh.includes(n));
        result = { kind: "attributed", new_failures: fresh, pre_existing: preExisting };
      }
    }
  } catch (e) {
    await restoreAgentTree(sandbox_id, cd, snap, worktree_path);
    throw e;
  }

  const restored = await restoreAgentTree(sandbox_id, cd, snap, worktree_path);
  return restored ? result : { ...result, restore_failed: true };
}

const TO_BASE = "git reset -q --hard && git clean -fdq";

type AgentTreeSnapshot = {
  dir: string;
  tree: string;
  head: string;
};

const OBJECT_ID = /^[0-9a-f]{40,64}$/i;

const LOSSY_ATTRIBUTES = String.raw`(^|[[:space:]])(filter|working-tree-encoding)=|eol=crlf`;
const PREFLIGHT = [
  `if [ -e .gitmodules ] || git cat-file -e HEAD:.gitmodules 2>/dev/null || git ls-files -s | grep -q '^160000 '; then echo "__ATTR_REFUSE__ submodules"; exit 0; fi`,
  `case "$(git config --get core.autocrlf | tr '[:upper:]' '[:lower:]')" in true|yes|on|1|input) echo "__ATTR_REFUSE__ autocrlf"; exit 0;; esac`,
  `if git grep --untracked -qE '${LOSSY_ATTRIBUTES}' -- '.gitattributes' ':(glob)**/.gitattributes' || grep -qsE '${LOSSY_ATTRIBUTES}' "$(git rev-parse --git-path info/attributes)"; then echo "__ATTR_REFUSE__ attributes"; exit 0; fi`,
].join("; ");

export function snapshotCommand(cd: string): string {
  return [
    cd,
    `{ ${PREFLIGHT}; }`,
    `D=$(mktemp -d /tmp/zavi-attr-XXXXXX)`,
    `trap 'rm -rf "$D"' EXIT`,
    `IDX=$(git rev-parse --git-path index)`,
    `cp "$IDX" "$D/real-index"`,
    `cp "$IDX" "$D/snap-index"`,
    `GIT_INDEX_FILE="$D/snap-index" git add -A`,
    `T=$(GIT_INDEX_FILE="$D/snap-index" git write-tree)`,
    `H=$(git rev-parse HEAD)`,
    `echo "__ATTR_SNAP__ $D $T $H"`,
    `trap - EXIT`,
  ].join(" && ");
}

export function restoreCommand(cd: string, snap: AgentTreeSnapshot): string {
  const check = `${snap.dir}/check-index`;
  return [
    cd,
    `test "$(git rev-parse HEAD)" = ${q(snap.head)}`,
    TO_BASE,
    `git read-tree --reset -u ${q(snap.tree)}`,
    `cp ${q(`${snap.dir}/real-index`)} "$(git rev-parse --git-path index)"`,
    `cp ${q(`${snap.dir}/real-index`)} ${q(check)}`,
    `GIT_INDEX_FILE=${q(check)} git add -A`,
    `echo "__ATTR_CHECK__ $(GIT_INDEX_FILE=${q(check)} git write-tree) $(git rev-parse HEAD)"`,
  ].join(" && ");
}

const REFUSAL_WHY: Record<string, string> = {
  submodules: "this repo has submodules, which the base comparison cannot snapshot",
  autocrlf: "this repo converts line endings on checkout, so the base comparison could change the agent's files",
  attributes: "this repo filters or re-encodes files on checkout, so the base comparison could change the agent's files",
};

async function snapshotAgentTree(
  sandbox_id: SandboxId,
  cd: string,
): Promise<AgentTreeSnapshot | { refused: string } | null> {
  const r = await execCommand(sandbox_id, snapshotCommand(cd), 120_000);
  if (r.exit_code !== 0) return null;
  const refused = (r.stdout ?? "").match(/__ATTR_REFUSE__ (\w+)/);
  if (refused) return { refused: REFUSAL_WHY[refused[1]] ?? "this repo cannot be snapshotted safely" };
  const m = (r.stdout ?? "").match(/__ATTR_SNAP__ (\/tmp\/zavi-attr-[A-Za-z0-9]+) (\S+) (\S+)/);
  if (!m || !OBJECT_ID.test(m[2]) || !OBJECT_ID.test(m[3])) return null;
  return { dir: m[1], tree: m[2], head: m[3] };
}

async function restoreAgentTree(
  sandbox_id: SandboxId,
  cd: string,
  snap: AgentTreeSnapshot,
  worktree_path: string,
): Promise<boolean> {
  const restore = restoreCommand(cd, snap);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await execCommand(sandbox_id, restore, 120_000).catch(() => null);
    const m = (r?.stdout ?? "").match(/__ATTR_CHECK__ (\S+) (\S+)/);
    if (r && r.exit_code === 0 && m && m[1] === snap.tree && m[2] === snap.head) {
      await execCommand(sandbox_id, `rm -rf ${q(snap.dir)}`, 30_000).catch(() => undefined);
      return true;
    }
  }
  console.error(
    `[engineer baseline] could not restore the agent's changes in ${worktree_path}. ` +
      `Their tree ${snap.tree} is still in the object store (git read-tree --reset -u ` +
      `${snap.tree}); the real index copy is at ${snap.dir}/real-index. This PR's contents ` +
      `were already captured in memory and are unaffected; the sandbox worktree must not be trusted.`,
  );
  return false;
}

export function attributionSentence(a: TestAttribution, baseBranch: string): string {
  if (a.kind === "unknown") {
    return `Some tests are failing. I couldn't work out whether my change caused them (${a.why}), so check before merging.`;
  }
  const nNew = a.new_failures.length;
  const nOld = a.pre_existing.length;

  if (nNew === 0) {
    return nOld === 1
      ? `1 test is failing, but it was already failing on \`${baseBranch}\` before I started. My change didn't break it.`
      : `${nOld} tests are failing, but they were all already failing on \`${baseBranch}\` before I started. My change didn't break them.`;
  }

  const newList = a.new_failures.slice(0, 3).map((n) => `\`${n}\``).join(", ");
  const more = nNew > 3 ? ` (+${nNew - 3} more)` : "";
  const inherited =
    nOld > 0
      ? ` ${nOld} other${nOld === 1 ? "" : "s"} ${nOld === 1 ? "was" : "were"} already failing on \`${baseBranch}\` before I started.`
      : "";

  return nNew === 1
    ? `I broke a test: ${newList}${more}. It passed on \`${baseBranch}\` and fails with my change.${inherited}`
    : `I broke ${nNew} tests: ${newList}${more}. They passed on \`${baseBranch}\` and fail with my change.${inherited}`;
}
