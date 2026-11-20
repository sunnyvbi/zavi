
import { CredentialNotConfigured } from "./github-repo";
import { GitHubApiError, readGitHubFailure, type GitHubFetch, type GitHubResponse } from "./github-api";
import { resolveProvisionOrg } from "./provision-org";
import { TEMPLATE_FILES } from "./templates/nextjs-supabase-tailwind/template-files.generated";

const GH = "https://api.github.com";

type FetchLike = GitHubFetch;

export type SeedTemplateDeps = {
  token?: () => string | null;
  fetchFn?: FetchLike;
  files?: Readonly<Record<string, string>>;
  commitMessage?: string;
  replaceExisting?: boolean;
  provisionOrg?: () => string;
  defaultBranch?: string;
};

export const SEED_BLOB_CONCURRENCY = 5;

export type SeedTemplateResult =
  | { seeded: true; commit_sha: string; branch: string; file_count: number; replaced?: boolean; previous_commit_sha?: string }
  | { seeded: false; reason: "already_seeded"; branch: string; file_count: number }
  | { seeded: false; reason: "repo_not_empty"; branch: string; file_count: number };

export class ReplaceExistingAppError extends Error {
  override name = "ReplaceExistingAppError";
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function ghJson<T>(res: GitHubResponse, ctx: string): Promise<T> {
  if (res.status < 200 || res.status >= 300) {
    throw new GitHubApiError(ctx, await readGitHubFailure(res));
  }
  return (await res.json()) as T;
}

export function isInlineSafeText(text: string): boolean {
  if (text.includes("\u0000")) return false;
  return Buffer.from(text, "utf-8").toString("utf-8") === text;
}

export async function seedTemplate(
  tenant_id: string,
  repo_full_name: string,
  deps: SeedTemplateDeps = {},
): Promise<SeedTemplateResult> {
  const getToken = deps.token ?? (() => process.env.GITHUB_PROVISION_TOKEN ?? null);
  const fetchFn = deps.fetchFn ?? ((globalThis as { fetch: FetchLike }).fetch);
  const files = deps.files ?? TEMPLATE_FILES;
  const message = deps.commitMessage ?? "chore: seed starter app (nextjs-supabase-tailwind)";

  const token = getToken();
  if (!token) throw new CredentialNotConfigured("GITHUB_PROVISION_TOKEN");

  const full = String(repo_full_name || "").trim();
  if (!full || !full.includes("/")) {
    throw new Error(`seedTemplate: invalid repo_full_name "${repo_full_name}" (expected "owner/repo")`);
  }

  const paths = Object.keys(files);
  if (paths.length === 0) {
    throw new Error("seedTemplate: no template files to seed");
  }

  const headers = ghHeaders(token);

  const knownBranch = (deps.defaultBranch ?? "").trim();
  const branch =
    knownBranch ||
    (
      await ghJson<{ default_branch?: string }>(
        await fetchFn(`${GH}/repos/${full}`, { headers }),
        "seedTemplate repo lookup",
      )
    ).default_branch ||
    "main";

  const ref = await ghJson<{ object: { sha: string } }>(
    await fetchFn(`${GH}/repos/${full}/git/ref/heads/${encodeURIComponent(branch)}`, { headers }),
    "seedTemplate branch ref",
  );
  const baseCommitSha = ref.object.sha;
  const baseCommit = await ghJson<{ tree: { sha: string } }>(
    await fetchFn(`${GH}/repos/${full}/git/commits/${baseCommitSha}`, { headers }),
    "seedTemplate base commit",
  );
  const baseTreeSha = baseCommit.tree.sha;

  const baseTree = await ghJson<{ tree?: Array<{ path?: string; type?: string }> }>(
    await fetchFn(`${GH}/repos/${full}/git/trees/${baseTreeSha}`, { headers }),
    "seedTemplate base tree",
  );
  const alreadyHasApp = (baseTree.tree ?? []).some(
    (e) => e?.path === "package.json" && e?.type === "blob",
  );
  const replacing = alreadyHasApp && deps.replaceExisting === true;
  if (alreadyHasApp && !replacing) {
    return { seeded: false, reason: "repo_not_empty", branch, file_count: paths.length };
  }
  try {
    if (replacing) {
      const org = (deps.provisionOrg ?? resolveProvisionOrg)().trim();
      const owner = full.split("/")[0];
      if (!org || owner.toLowerCase() !== org.toLowerCase()) {
        throw new Error(`seedTemplate: refusing to replace ${full}, it is not under the provisioning org "${org}"`);
      }
    }

    type TreeEntry = { path: string; mode: "100644"; type: "blob" } & ({ content: string } | { sha: string });
    const slots: Array<TreeEntry | null> = paths.map((path): TreeEntry | null => {
      const text = files[path];
      return isInlineSafeText(text) ? { path, mode: "100644", type: "blob", content: text } : null;
    });
    const blobIndexes = slots.flatMap((slot, i) => (slot ? [] : [i]));
    const blobErrors = new Map<number, unknown>();
    let nextBlob = 0;
    const blobWorker = async (): Promise<void> => {
      while (nextBlob < blobIndexes.length && blobErrors.size === 0) {
        const i = blobIndexes[nextBlob++];
        const path = paths[i];
        try {
          const blob = await ghJson<{ sha: string }>(
            await fetchFn(`${GH}/repos/${full}/git/blobs`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                content: Buffer.from(files[path], "utf-8").toString("base64"),
                encoding: "base64",
              }),
            }),
            `seedTemplate blob ${path}`,
          );
          slots[i] = { path, mode: "100644", type: "blob", sha: blob.sha };
        } catch (e) {
          blobErrors.set(i, e);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEED_BLOB_CONCURRENCY, blobIndexes.length) }, blobWorker));
    if (blobErrors.size > 0) throw blobErrors.get(Math.min(...blobErrors.keys()));
    const treeEntries = slots.filter((slot): slot is TreeEntry => slot !== null);

    const tree = await ghJson<{ sha: string }>(
      await fetchFn(`${GH}/repos/${full}/git/trees`, {
        method: "POST",
        headers,
        body: JSON.stringify(replacing ? { tree: treeEntries } : { base_tree: baseTreeSha, tree: treeEntries }),
      }),
      "seedTemplate tree",
    );

    if (tree.sha === baseTreeSha) {
      return { seeded: false, reason: "already_seeded", branch, file_count: paths.length };
    }

    const commit = await ghJson<{ sha: string }>(
      await fetchFn(`${GH}/repos/${full}/git/commits`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message, tree: tree.sha, parents: [baseCommitSha] }),
      }),
      "seedTemplate commit",
    );

    try {
      await ghJson<unknown>(
        await fetchFn(`${GH}/repos/${full}/git/refs/heads/${encodeURIComponent(branch)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ sha: commit.sha, force: false }),
        }),
        "seedTemplate ref update",
      );
    } catch (e) {
      const landed = await fetchFn(`${GH}/repos/${full}/git/ref/heads/${encodeURIComponent(branch)}`, { headers })
        .then(async (r) => (r.status === 200 ? ((await r.json()) as { object?: { sha?: unknown } })?.object?.sha === commit.sha : false))
        .catch(() => false);
      if (!landed) throw e;
    }

    if (replacing) {
      return { seeded: true, commit_sha: commit.sha, branch, file_count: paths.length, replaced: true, previous_commit_sha: baseCommitSha };
    }
    return { seeded: true, commit_sha: commit.sha, branch, file_count: paths.length };
  } catch (e) {
    if (replacing) throw new ReplaceExistingAppError((e as Error).message);
    throw e;
  }
}
