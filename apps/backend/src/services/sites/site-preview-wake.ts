
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { SiteRow } from "./contract";
import { SITE_REPO_DIR } from "./contract";

type ExecResult = { stdout: string; stderr: string; exit_code: number; timed_out?: boolean };

export type SitePreviewWakeDeps = {
  sandboxIdOf: (tenant_id: string, repo_full_name: string) => Promise<string | null>;
  headTree: (repo_full_name: string) => Promise<{ sha: string; tree: string } | { error: string }>;
  exec: (sandbox_id: string, cmd: string, timeoutMs: number) => Promise<ExecResult>;
  kick: (tenant_id: string, repo_full_name: string) => Promise<void>;
  restart: (input: { tenant_id: string; run_id: string; site: SiteRow; sha: string; awaitReadiness: true }) => Promise<void>;
  previewChanged?: (tenant_id: string, site_id: string) => Promise<void>;
  log?: (line: Record<string, unknown>) => void;
};

export type PreviewTreeState =
  | { state: "same"; sha: string }
  | { state: "stale"; sha: string; box_tree: string; head_tree: string }
  | { state: "unknown"; reason: string };

export const WORKING_TREE_HASH_TIMEOUT_MS = 60_000;
export const HEAD_TREE_TIMEOUT_MS = 20_000;

export const WORKING_TREE_HASH_CMD = [
  `cd ${SITE_REPO_DIR}`,
  `__zidx=$(mktemp)`,
  `rm -f "$__zidx"`,
  `{ if git rev-parse -q --verify HEAD >/dev/null; then GIT_INDEX_FILE="$__zidx" git read-tree HEAD; fi; }`,
  `GIT_INDEX_FILE="$__zidx" git add -A .`,
  `__t=$(GIT_INDEX_FILE="$__zidx" git write-tree)`,
  `rm -f "$__zidx"`,
  `echo "__tree=$__t"`,
].join(" && ");

const TREE_RE = /^[0-9a-f]{40}$/;

export async function previewTreeState(
  input: { sandbox_id: string; repo_full_name: string },
  deps: Pick<SitePreviewWakeDeps, "headTree" | "exec">,
): Promise<PreviewTreeState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ error: `no answer in ${HEAD_TREE_TIMEOUT_MS}ms` }), HEAD_TREE_TIMEOUT_MS);
  });
  const head = await Promise.race([
    deps.headTree(input.repo_full_name).catch((e: unknown) => ({ error: String((e as Error)?.message ?? e) })),
    late,
  ]).finally(() => clearTimeout(timer));
  if (!("sha" in head)) return { state: "unknown", reason: `head: ${head.error.slice(0, 200)}` };
  const r = await deps.exec(input.sandbox_id, WORKING_TREE_HASH_CMD, WORKING_TREE_HASH_TIMEOUT_MS).catch(() => null);
  if (!r) return { state: "unknown", reason: "box: exec failed" };
  const box = (r.stdout.match(/^__tree=([0-9a-f]+)$/m)?.[1] ?? "").toLowerCase();
  if (r.timed_out || r.exit_code !== 0 || !TREE_RE.test(box)) {
    return { state: "unknown", reason: `box: ${r.timed_out ? "timed out" : `exit ${r.exit_code}`}` };
  }
  const head_tree = head.tree.toLowerCase();
  return box === head_tree ? { state: "same", sha: head.sha } : { state: "stale", sha: head.sha, box_tree: box, head_tree };
}

const realDeps: SitePreviewWakeDeps = {
  async sandboxIdOf(tenant_id, repo_full_name) {
    const { data, error } = await (tenantClient(asTenantId(tenant_id))
      .from("tenant_sandbox")
      .select("e2b_sandbox_id") as any)
      .eq("repo_full_name", repo_full_name)
      .maybeSingle();
    if (error) throw new Error(`tenant_sandbox read failed: ${error.message ?? "unknown error"}`);
    return (data as { e2b_sandbox_id?: string | null } | null)?.e2b_sandbox_id ?? null;
  },
  headTree: async (repo) => (await import("@/services/provisioning/github-repo")).readProvisionedRepoHeadTree(repo, "main"),
  exec: async (id, cmd, t) => (await import("@/services/sandbox/e2b-client")).execCommand(id, cmd, t),
  async kick(tenant_id, repo_full_name) {
    const { kickSandboxPreview } = await import("@/services/agents/conductor-driver");
    const node = { payload: { target: { github_full_name: repo_full_name } } } as unknown as Parameters<typeof kickSandboxPreview>[0]["node"];
    await kickSandboxPreview({ tenant_id, node, site: true });
  },
  restart: async (input) => (await import("./site-preview-restart")).restartSitePreview(input),
  previewChanged: async (tenant_id, site_id) => (await import("./site-preview-snapshot-capture")).notePreviewChanged(tenant_id, site_id),
};

export async function wakeSitePreview(
  input: { tenant_id: string; run_id: string; site: SiteRow },
  injected?: Partial<SitePreviewWakeDeps>,
): Promise<"woken" | "recreated"> {
  const deps: SitePreviewWakeDeps = { ...realDeps, ...injected };
  const log = deps.log ?? ((l) => console.log(JSON.stringify(l)));
  const { tenant_id, run_id, site } = input;
  const repo = (site.github_full_name ?? "").trim();
  if (site.tenant_id !== tenant_id || !repo) throw new Error("site preview wake: the site has no repo of this workspace");
  const sandbox_id = await deps.sandboxIdOf(tenant_id, repo).catch((e: unknown) => {
    log({ evt: "site_preview_wake_tree", tenant_id, site_id: site.id, outcome: "unknown", reason: `row: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
    return null;
  });
  if (sandbox_id) {
    const tree = await previewTreeState({ sandbox_id, repo_full_name: repo }, deps);
    const base = { evt: "site_preview_wake_tree", tenant_id, site_id: site.id };
    if (tree.state === "stale") {
      log({ ...base, outcome: "stale", head: tree.sha.slice(0, 7), box_tree: tree.box_tree.slice(0, 7), head_tree: tree.head_tree.slice(0, 7) });
      await deps.previewChanged?.(tenant_id, site.id).catch(() => undefined);
      await deps.restart({ tenant_id, run_id, site, sha: tree.sha, awaitReadiness: true });
      await deps.previewChanged?.(tenant_id, site.id).catch(() => undefined);
      return "recreated";
    }
    if (tree.state === "unknown") log({ ...base, outcome: "unknown", reason: tree.reason });
  }
  await deps.kick(tenant_id, repo);
  return "woken";
}
