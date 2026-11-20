
import { CredentialNotConfigured } from "./github-repo";
import { stripPickerFromExport } from "./picker-asset";

const GH = "https://api.github.com";

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers?: { get(name: string): string | null };
}>;

export type ExportToOwnGitHubDeps = {
  umbrellaToken?: () => string | null;
  mintInstallationToken?: (args: {
    tenant_id: string;
    installation_id: number;
  }) => Promise<string>;
  fetchFn?: FetchLike;
  commitMessage?: string;
};

export type ExportToOwnGitHubInput = {
  tenant_id: string;
  source_full_name: string;
  dest_owner: string;
  dest_account_type: string;
  installation_id: number;
  dest_repo_name?: string;
};

export type ExportToOwnGitHubResult =
  | {
      exported: true;
      dest_full_name: string;
      dest_url: string;
      branch: string;
      commit_sha: string;
      source_sha: string;
      file_count: number;
      created_dest_repo: boolean;
    }
  | {
      exported: false;
      reason: "already_exported";
      dest_full_name: string;
      dest_url: string;
      branch: string;
      source_sha: string;
      file_count: number;
      created_dest_repo: boolean;
    };

function umbrellaHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function installHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function ghJson<T>(
  res: { status: number; json: () => Promise<unknown>; text: () => Promise<string> },
  ctx: string,
): Promise<T> {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${ctx} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}

type SourceTreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
};

export type BlobMode = "100644" | "100755" | "120000";

export const EXPORT_BLOB_CONCURRENCY = 8;
export const EXPORT_WRITE_CONCURRENCY = 1;
const UMBRELLA_WRITE_CONCURRENCY = 4;

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function blobMode(mode: string): BlobMode {
  return mode === "100755" || mode === "120000" ? mode : "100644";
}

export async function readSourceFiles(
  source_full_name: string,
  token: string,
  fetchFn: FetchLike,
): Promise<{ branch: string; source_sha: string; files: Map<string, string>; modes: Map<string, BlobMode> }> {
  const headers = umbrellaHeaders(token);
  const { branch, sha: source_sha } = await readSourceHead(source_full_name, token, fetchFn);
  const commit = await ghJson<{ tree: { sha: string } }>(
    await fetchFn(`${GH}/repos/${source_full_name}/git/commits/${source_sha}`, { headers }),
    "export source commit",
  );

  const tree = await ghJson<{ tree: SourceTreeEntry[]; truncated?: boolean }>(
    await fetchFn(
      `${GH}/repos/${source_full_name}/git/trees/${commit.tree.sha}?recursive=1`,
      { headers },
    ),
    "export source tree",
  );
  if (tree.truncated) {
    throw new Error(
      `export source tree truncated for ${source_full_name} (repo too large for one-shot recursive tree)`,
    );
  }

  const blobs = tree.tree.filter((e) => e.type === "blob");
  if (blobs.length === 0) {
    throw new Error(`export source repo ${source_full_name} has no files to export`);
  }

  const files = new Map<string, string>();
  const modes = new Map<string, BlobMode>();
  const contents = await mapLimit(blobs, EXPORT_BLOB_CONCURRENCY, async (entry) =>
    ghJson<{ content: string; encoding: string }>(
      await fetchFn(`${GH}/repos/${source_full_name}/git/blobs/${entry.sha}`, { headers }),
      `export source blob ${entry.path}`,
    ),
  );
  for (const [i, entry] of blobs.entries()) {
    const blob = contents[i];
    const raw = Buffer.from(blob.content, (blob.encoding as BufferEncoding) || "base64");
    files.set(entry.path, raw.toString("base64"));
    modes.set(entry.path, blobMode(entry.mode));
  }
  return { branch, source_sha, files, modes };
}

export async function readSourceHead(
  source_full_name: string,
  token: string,
  fetchFn: FetchLike,
): Promise<{ branch: string; sha: string }> {
  const headers = umbrellaHeaders(token);
  const repo = await ghJson<{ default_branch?: string }>(
    await fetchFn(`${GH}/repos/${source_full_name}`, { headers }),
    "export source repo lookup",
  );
  const branch = repo.default_branch || "main";
  const ref = await ghJson<{ object: { sha: string } }>(
    await fetchFn(`${GH}/repos/${source_full_name}/git/ref/heads/${encodeURIComponent(branch)}`, {
      headers,
    }),
    "export source branch ref",
  );
  return { branch, sha: ref.object.sha };
}

export class DestRepoMissing extends Error {
  constructor(
    readonly owner: string,
    readonly repo_name: string,
  ) {
    super(
      `dest_user_repo_must_exist: cannot auto-create "${owner}/${repo_name}" in that GitHub account. ` +
        `Create a repo named "${repo_name}" under ${owner} on GitHub (it can be empty), ` +
        `give the Zavi GitHub App access to it, then re-run the export.`,
    );
  }
}

export async function destRepoExists(
  args: { dest_owner: string; dest_repo_name: string; installToken: string },
  fetchFn: FetchLike,
): Promise<boolean> {
  const res = await fetchFn(`${GH}/repos/${args.dest_owner}/${args.dest_repo_name}`, {
    headers: installHeaders(args.installToken),
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`export dest repo lookup failed (${res.status}): ${await res.text()}`);
}

async function ensureDestRepo(
  args: {
    dest_owner: string;
    dest_account_type: string;
    dest_repo_name: string;
    installToken: string;
  },
  fetchFn: FetchLike,
): Promise<{ full_name: string; html_url: string; default_branch: string; created: boolean }> {
  const headers = installHeaders(args.installToken);
  const full = `${args.dest_owner}/${args.dest_repo_name}`;

  const existing = await fetchFn(`${GH}/repos/${full}`, { headers });
  if (existing.status === 200) {
    const body = (await existing.json()) as {
      full_name?: string;
      html_url?: string;
      default_branch?: string;
    };
    return {
      full_name: body.full_name ?? full,
      html_url: body.html_url ?? `https://github.com/${full}`,
      default_branch: body.default_branch ?? "main",
      created: false,
    };
  }
  if (existing.status !== 404) {
    throw new Error(`export dest repo lookup failed (${existing.status}): ${await existing.text()}`);
  }

  if (args.dest_account_type !== "Organization") {
    throw new DestRepoMissing(args.dest_owner, args.dest_repo_name);
  }

  const created = await fetchFn(`${GH}/orgs/${args.dest_owner}/repos`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: args.dest_repo_name, private: true, auto_init: true }),
  });
  if (created.status === 403 || created.status === 404) {
    throw new DestRepoMissing(args.dest_owner, args.dest_repo_name);
  }
  if (created.status !== 201) {
    throw new Error(`export dest repo create failed (${created.status}): ${await created.text()}`);
  }
  const body = (await created.json()) as {
    full_name?: string;
    html_url?: string;
    default_branch?: string;
  };
  return {
    full_name: body.full_name ?? full,
    html_url: body.html_url ?? `https://github.com/${full}`,
    default_branch: body.default_branch ?? "main",
    created: true,
  };
}

const EXPORT_COMMIT_PREFIX = "chore: export product from";

const SCAFFOLD_PATHS = new Set([
  "README",
  "README.md",
  "LICENSE",
  "LICENSE.md",
  ".gitignore",
  ".gitattributes",
]);

async function readDestHead(
  full: string,
  branch: string,
  headers: Record<string, string>,
  fetchFn: FetchLike,
): Promise<{ commit_sha: string; tree_sha: string } | null> {
  const refRes = await fetchFn(`${GH}/repos/${full}/git/ref/heads/${encodeURIComponent(branch)}`, {
    headers,
  });
  if (refRes.status === 409) return null;
  const ref = await ghJson<{ object: { sha: string } }>(refRes, "export dest branch ref");
  const commit = await ghJson<{ tree: { sha: string } }>(
    await fetchFn(`${GH}/repos/${full}/git/commits/${ref.object.sha}`, { headers }),
    "export dest base commit",
  );
  return { commit_sha: ref.object.sha, tree_sha: commit.tree.sha };
}

async function seedEmptyDest(
  full: string,
  files: Map<string, string>,
  commitMessage: string,
  headers: Record<string, string>,
  fetchFn: FetchLike,
): Promise<void> {
  const first = files.entries().next().value;
  if (!first) throw new Error(`export has no files to seed ${full} with`);
  const [path, content] = first;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  await ghJson<unknown>(
    await fetchFn(`${GH}/repos/${full}/contents/${encodedPath}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ message: commitMessage, content }),
    }),
    "export dest seed empty repo",
  );
}

async function assertDestSafeToReplace(
  full: string,
  branch: string,
  treeSha: string,
  commitMessage: string,
  headers: Record<string, string>,
  fetchFn: FetchLike,
): Promise<void> {
  const tree = await ghJson<{ tree: Array<{ path: string }> }>(
    await fetchFn(`${GH}/repos/${full}/git/trees/${treeSha}`, { headers }),
    "export dest tree read",
  );
  const foreign = tree.tree.map((e) => e.path).filter((p) => !SCAFFOLD_PATHS.has(p));
  if (foreign.length === 0) return;

  const commits = await ghJson<Array<{ commit: { message: string } }>>(
    await fetchFn(
      `${GH}/repos/${full}/commits?sha=${encodeURIComponent(branch)}&per_page=100`,
      { headers },
    ),
    "export dest history read",
  );
  const isExport = (c: { commit: { message: string } }) =>
    c.commit.message.startsWith(EXPORT_COMMIT_PREFIX) || c.commit.message === commitMessage;
  const lastExportIdx = commits.findIndex(isExport);
  if (lastExportIdx === 0) return;
  if (lastExportIdx > 0) {
    throw new Error(
      `dest_repo_changed_since_export: "${full}" has ${lastExportIdx} commit${lastExportIdx === 1 ? "" : "s"} ` +
        `on ${branch} since Zavi's last export. Exporting again would replace those changes. ` +
        `Export into a new or empty repo, or move your changes to a branch first.`,
    );
  }

  throw new Error(
    `dest_repo_not_empty: "${full}" already has files Zavi did not put there ` +
      `(${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? ", …" : ""}). ` +
      `Export into a new or empty repo so none of your existing code is replaced.`,
  );
}

export async function pushFilesToDest(
  args: {
    dest_full_name: string;
    dest_branch: string;
    files: Map<string, string>;
    modes?: Map<string, BlobMode>;
    installToken: string;
    commitMessage: string;
    guardExistingFiles: boolean;
    auth?: "installation" | "umbrella";
  },
  fetchFn: FetchLike,
): Promise<{ pushed: boolean; commit_sha: string; tree_sha: string }> {
  const headers = args.auth === "umbrella" ? umbrellaHeaders(args.installToken) : installHeaders(args.installToken);
  const writeConcurrency = args.auth === "umbrella" ? UMBRELLA_WRITE_CONCURRENCY : EXPORT_WRITE_CONCURRENCY;
  const full = args.dest_full_name;
  const branch = args.dest_branch;

  let head = await readDestHead(full, branch, headers, fetchFn);
  if (!head) {
    await seedEmptyDest(full, args.files, args.commitMessage, headers, fetchFn);
    head = await readDestHead(full, branch, headers, fetchFn);
    if (!head) throw new Error(`export dest ${full} is still empty after seeding its first commit`);
  } else if (args.guardExistingFiles) {
    await assertDestSafeToReplace(full, branch, head.tree_sha, args.commitMessage, headers, fetchFn);
  }
  const baseCommitSha = head.commit_sha;
  const baseTreeSha = head.tree_sha;

  const treeEntries = await mapLimit([...args.files], writeConcurrency, async ([path, contentB64]) => {
    const blob = await ghJson<{ sha: string }>(
      await fetchFn(`${GH}/repos/${full}/git/blobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: contentB64, encoding: "base64" }),
      }),
      `export dest blob ${path}`,
    );
    return { path, mode: args.modes?.get(path) ?? ("100644" as BlobMode), type: "blob" as const, sha: blob.sha };
  });

  const tree = await ghJson<{ sha: string }>(
    await fetchFn(`${GH}/repos/${full}/git/trees`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tree: treeEntries }),
    }),
    "export dest tree",
  );

  if (tree.sha === baseTreeSha) {
    return { pushed: false, commit_sha: baseCommitSha, tree_sha: tree.sha };
  }

  const commit = await ghJson<{ sha: string }>(
    await fetchFn(`${GH}/repos/${full}/git/commits`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: args.commitMessage, tree: tree.sha, parents: [baseCommitSha] }),
    }),
    "export dest commit",
  );

  const refUpdate = await fetchFn(`${GH}/repos/${full}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  if (refUpdate.status === 422) {
    throw new Error(
      `dest_repo_changed_since_export: "${full}" received a new commit while the export was running. Export again to include your latest changes on top of it.`,
    );
  }
  await ghJson<unknown>(refUpdate, "export dest ref update");

  return { pushed: true, commit_sha: commit.sha, tree_sha: tree.sha };
}

async function verifyDest(
  args: { dest_full_name: string; branch: string; expected_tree_sha: string; installToken: string },
  fetchFn: FetchLike,
): Promise<void> {
  const headers = installHeaders(args.installToken);
  const repo = await fetchFn(`${GH}/repos/${args.dest_full_name}`, { headers });
  if (repo.status !== 200) {
    throw new Error(
      `export verify failed: dest repo ${args.dest_full_name} not reachable (status ${repo.status})`,
    );
  }
  const ref = await ghJson<{ object: { sha: string } }>(
    await fetchFn(
      `${GH}/repos/${args.dest_full_name}/git/ref/heads/${encodeURIComponent(args.branch)}`,
      { headers },
    ),
    "export verify dest ref",
  );
  const commit = await ghJson<{ tree: { sha: string } }>(
    await fetchFn(`${GH}/repos/${args.dest_full_name}/git/commits/${ref.object.sha}`, { headers }),
    "export verify dest commit",
  );
  if (commit.tree.sha !== args.expected_tree_sha) {
    throw new Error(
      `export verify failed: dest tree ${commit.tree.sha} != exported tree ${args.expected_tree_sha} ` +
        `(the code did not land on ${args.dest_full_name}@${args.branch})`,
    );
  }
}

export function bareRepoName(full_name: string): string {
  const parts = String(full_name || "").split("/");
  return parts[parts.length - 1] || "";
}

export async function exportRepoToOwnGitHub(
  input: ExportToOwnGitHubInput,
  deps: ExportToOwnGitHubDeps = {},
): Promise<ExportToOwnGitHubResult> {
  const getUmbrella = deps.umbrellaToken ?? (() => process.env.GITHUB_PROVISION_TOKEN ?? null);
  const fetchFn = deps.fetchFn ?? ((globalThis as { fetch: FetchLike }).fetch);
  const mintToken =
    deps.mintInstallationToken ??
    (async (a: { tenant_id: string; installation_id: number }) => {
      const { mintInstallationToken } = await import("@/services/connectors/github/oauth");
      return mintInstallationToken(a);
    });

  const source = String(input.source_full_name || "").trim();
  if (!source || !source.includes("/")) {
    throw new Error(`exportRepoToOwnGitHub: invalid source_full_name "${input.source_full_name}"`);
  }
  const destOwner = String(input.dest_owner || "").trim();
  if (!destOwner) {
    throw new Error("exportRepoToOwnGitHub: dest_owner is required (GitHub not connected?)");
  }
  if (!Number.isFinite(input.installation_id) || input.installation_id <= 0) {
    throw new Error("exportRepoToOwnGitHub: a valid installation_id is required");
  }
  const destRepoName = (input.dest_repo_name || bareRepoName(source)).trim();
  if (!destRepoName) {
    throw new Error("exportRepoToOwnGitHub: could not derive a destination repo name");
  }

  const umbrella = getUmbrella();
  if (!umbrella) throw new CredentialNotConfigured("GITHUB_PROVISION_TOKEN");

  const installToken = await mintToken({
    tenant_id: input.tenant_id,
    installation_id: input.installation_id,
  });

  const dest = await ensureDestRepo(
    {
      dest_owner: destOwner,
      dest_account_type: input.dest_account_type,
      dest_repo_name: destRepoName,
      installToken,
    },
    fetchFn,
  );

  const { files: sourceFiles, modes, source_sha } = await readSourceFiles(source, umbrella, fetchFn);

  const files = stripPickerFromExport(sourceFiles, {
    decode: (b64) => Buffer.from(b64, "base64").toString("utf8"),
    encode: (s) => Buffer.from(s, "utf8").toString("base64"),
  });

  const push = await pushFilesToDest(
    {
      dest_full_name: dest.full_name,
      dest_branch: dest.default_branch,
      files,
      modes,
      installToken,
      commitMessage: deps.commitMessage ?? `${EXPORT_COMMIT_PREFIX} Zavi (migrate to own GitHub)`,
      guardExistingFiles: !dest.created,
    },
    fetchFn,
  );

  await verifyDest(
    {
      dest_full_name: dest.full_name,
      branch: dest.default_branch,
      expected_tree_sha: push.tree_sha,
      installToken,
    },
    fetchFn,
  );

  if (!push.pushed) {
    return {
      exported: false,
      reason: "already_exported",
      dest_full_name: dest.full_name,
      dest_url: dest.html_url,
      branch: dest.default_branch,
      source_sha,
      file_count: files.size,
      created_dest_repo: dest.created,
    };
  }
  return {
    exported: true,
    dest_full_name: dest.full_name,
    dest_url: dest.html_url,
    branch: dest.default_branch,
    commit_sha: push.commit_sha,
    source_sha,
    file_count: files.size,
    created_dest_repo: dest.created,
  };
}
