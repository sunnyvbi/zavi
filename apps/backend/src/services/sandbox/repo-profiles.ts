
import crypto from "node:crypto";
import { serviceClient } from "@/services/supabase";
import {
  mintInstallationToken,
  getRepoMetadata,
  getRepoLanguages,
  listRepoRootEntries,
} from "@/services/connectors/github/oauth";
import {
  getScopedRepos,
  getScopedRepoFullNames,
  resolveScopedRepos,
} from "@/services/connectors/github/scoped-repos";

export type RepoKind = "ios" | "android" | "web" | "backend" | "unknown";

export type RepoProfile = {
  repo_full_name: string;
  kind: RepoKind;
  kinds: RepoKind[];
  language_stats: Record<string, number>;
  frameworks: string[];
  topics: string[];
  description: string | null;
  default_branch: string | null;
  manifest_paths: string[];
  profile_status: "pending" | "ready" | "error";
};

export class CrossTenantRepoError extends Error {
  constructor(public readonly repo_full_name: string) {
    super(
      `assertTenantConnectedRepo: repo "${repo_full_name}" is not in this tenant's connected GitHub repos — refusing the operation.`,
    );
    this.name = "CrossTenantRepoError";
  }
}

async function readGithubConnector(tenant_id: string): Promise<{
  installation_id: number;
  connectedRepos: string[];
} | null> {
  const { data, error } = await serviceClient()
    .from("connector_metadata")
    .select("installation_id, repo_full_names")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (error) {
    throw new Error(`repo-profiles: connector_metadata read failed: ${error.message}`);
  }
  const meta = data as {
    installation_id?: number;
    repo_full_names?: string[];
  } | null;
  if (!meta?.installation_id) return null;
  const connectedRepos = (meta.repo_full_names ?? []).filter(
    (r): r is string => typeof r === "string" && r.length > 0,
  );
  return { installation_id: meta.installation_id, connectedRepos };
}

export async function readTenantDefaultRepo(
  tenant_id: string,
): Promise<string | null> {
  if (!tenant_id) return null;
  const { data, error } = await serviceClient()
    .from("connector_metadata")
    .select("default_repo_full_name")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (error) {
    console.warn(
      `[repo-profiles] default-repo read failed for ${tenant_id}: ${error.message}`,
    );
    return null;
  }
  const v = (data as { default_repo_full_name?: unknown } | null)
    ?.default_repo_full_name;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function assertTenantConnectedRepo(
  tenant_id: string,
  repo_full_name: string,
): Promise<void> {
  if (!tenant_id || !repo_full_name) {
    throw new CrossTenantRepoError(repo_full_name || "(empty)");
  }
  const conn = await readGithubConnector(tenant_id);
  if (!conn || !conn.connectedRepos.includes(repo_full_name)) {
    throw new CrossTenantRepoError(repo_full_name);
  }
}

const ROOT_MANIFESTS = [
  "Podfile",
  "package.json",
  "build.gradle",
  "build.gradle.kts",
  "AndroidManifest.xml",
  "go.mod",
  "Gemfile",
  "requirements.txt",
  "pubspec.yaml",
] as const;

const SUBDIR_KIND_PATTERNS: ReadonlyArray<[RegExp, RepoKind]> = [
  [/^(backend|api|server|workers?|functions|service|svc)$/i, "backend"],
  [/^(web|www|frontend|site|client|dashboard|admin|marketing|landing|docs?)$/i, "web"],
  [/^(ios|apple)$/i, "ios"],
  [/^(android)$/i, "android"],
];

export function deriveSubKinds(subEntries: readonly string[]): RepoKind[] {
  const out = new Set<RepoKind>();
  for (const name of subEntries) {
    for (const [re, kind] of SUBDIR_KIND_PATTERNS) {
      if (re.test(name)) {
        out.add(kind);
        break;
      }
    }
  }
  return Array.from(out);
}

export function deriveKind(args: {
  rootEntries: readonly string[];
  languages: Record<string, number>;
  subEntries?: readonly string[];
}): {
  kind: RepoKind;
  kinds: RepoKind[];
  frameworks: string[];
  manifest_paths: string[];
} {
  const entries = new Set(args.rootEntries);
  const has = (name: string) => entries.has(name);
  const hasSuffix = (suffix: string) =>
    args.rootEntries.some((e) => e.endsWith(suffix));

  const manifest_paths: string[] = [];
  for (const m of ROOT_MANIFESTS) if (has(m)) manifest_paths.push(m);
  if (hasSuffix(".xcodeproj")) manifest_paths.push(".xcodeproj");
  if (hasSuffix(".xcworkspace")) manifest_paths.push(".xcworkspace");

  const frameworks = new Set<string>();

  const iosSignal =
    has("Podfile") || hasSuffix(".xcodeproj") || hasSuffix(".xcworkspace");
  const androidSignal =
    has("build.gradle") || has("build.gradle.kts") || has("AndroidManifest.xml");
  const webSignal = has("package.json");
  const goSignal = has("go.mod");
  const rubyBackendSignal = has("Gemfile");
  const pyBackendSignal = has("requirements.txt");

  if (iosSignal) frameworks.add("cocoapods");
  if (androidSignal) frameworks.add("gradle");
  if (goSignal) frameworks.add("go");
  if (rubyBackendSignal) frameworks.add("rails");
  if (pyBackendSignal) frameworks.add("python");

  const langs = args.languages || {};
  const topLang = Object.entries(langs).sort((a, b) => b[1] - a[1])[0]?.[0];
  const swiftBytes = (langs["Swift"] ?? 0) + (langs["Objective-C"] ?? 0);
  const kotlinBytes = (langs["Kotlin"] ?? 0) + (langs["Java"] ?? 0);
  const tsBytes =
    (langs["TypeScript"] ?? 0) + (langs["JavaScript"] ?? 0);

  let kind: RepoKind = "unknown";

  if (iosSignal || swiftBytes > Math.max(tsBytes, kotlinBytes)) {
    kind = "ios";
  } else if (androidSignal || kotlinBytes > Math.max(tsBytes, swiftBytes)) {
    kind = "android";
  } else if (webSignal) {
    kind = "web";
    frameworks.add("node");
  } else if (goSignal || rubyBackendSignal || pyBackendSignal) {
    kind = "backend";
  } else if (topLang === "Swift" || topLang === "Objective-C") {
    kind = "ios";
  } else if (topLang === "Kotlin" || topLang === "Java") {
    kind = "android";
  } else if (topLang === "TypeScript" || topLang === "JavaScript") {
    kind = "web";
  } else if (topLang === "Go" || topLang === "Ruby" || topLang === "Python") {
    kind = "backend";
  }

  const kinds = new Set<RepoKind>();
  if (kind !== "unknown") kinds.add(kind);
  for (const k of deriveSubKinds(args.subEntries ?? [])) kinds.add(k);
  if (kinds.size === 0) kinds.add(kind);

  return {
    kind,
    kinds: Array.from(kinds),
    frameworks: Array.from(frameworks),
    manifest_paths,
  };
}

function computeFingerprint(args: {
  repo_full_name: string;
  default_branch: string;
  manifest_paths: readonly string[];
  subEntries?: readonly string[];
}): string {
  const basis = [
    args.repo_full_name,
    args.default_branch,
    [...args.manifest_paths].sort().join(","),
    [...(args.subEntries ?? [])].sort().join(","),
  ].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

export async function seedPendingProfiles(args: {
  tenant_id: string;
  repos: readonly string[];
}): Promise<void> {
  const sb = serviceClient();

  let allowed: readonly string[] = args.repos;
  try {
    const resolved = await resolveScopedRepos(args.tenant_id);
    if (resolved.mode === "deny" || resolved.selectionRequired) {
      allowed = [];
    } else if (resolved.mode === "scoped") {
      const scopedSet = new Set(resolved.repos);
      allowed = args.repos.filter((r) => scopedSet.has(r));
    }
  } catch (e) {
    console.warn(
      `[repo-profiles] scope check failed during seed for ${args.tenant_id}: ${(e as Error).message} — seeding nothing (fail closed)`,
    );
    allowed = [];
  }

  for (const repo of allowed) {
    try {
      await assertTenantConnectedRepo(args.tenant_id, repo);
      const { error } = await sb.rpc("seed_repo_profile_pending", {
        p_tenant_id: args.tenant_id,
        p_repo_full_name: repo,
      });
      if (error) {
        console.warn(
          `[repo-profiles] seed pending failed for ${args.tenant_id}/${repo}: ${error.message}`,
        );
      }
    } catch (e) {
      console.warn(
        `[repo-profiles] seed pending skipped for ${args.tenant_id}/${repo}: ${(e as Error).message}`,
      );
    }
  }
}

export async function buildRepoProfile(args: {
  tenant_id: string;
  installation_id: number;
  repo_full_name: string;
}): Promise<"ready" | "error" | "skipped"> {
  const sb = serviceClient();
  const { tenant_id, installation_id, repo_full_name } = args;

  try {
    let scopedRepos: string[];
    try {
      scopedRepos = await getScopedRepoFullNames(tenant_id);
    } catch (scopeErr) {
      console.warn(
        `[repo-profiles] scope read failed for ${tenant_id}/${repo_full_name}: ${(scopeErr as Error).message} — skipping (no row written)`,
      );
      return "skipped";
    }
    if (!scopedRepos.includes(repo_full_name)) {
      console.warn(
        `[repo-profiles] skipped scoped-out repo ${tenant_id}/${repo_full_name} (no row written)`,
      );
      return "skipped";
    }

    await assertTenantConnectedRepo(tenant_id, repo_full_name);

    const [owner, repo] = repo_full_name.split("/");
    if (!owner || !repo) {
      throw new Error(`repo_full_name "${repo_full_name}" must be 'owner/name'`);
    }

    const token = await mintInstallationToken({
      tenant_id,
      installation_id,
      repo_full_name,
    });

    const meta = await getRepoMetadata({ token, owner, repo });
    const languages = await getRepoLanguages({ token, owner, repo });
    const rootEntries = await listRepoRootEntries({
      token,
      owner,
      repo,
      ref: meta.default_branch,
    });

    const MONOREPO_CONTAINERS = ["apps", "packages"] as const;
    const subEntries: string[] = [];
    for (const container of MONOREPO_CONTAINERS) {
      if (!rootEntries.includes(container)) continue;
      try {
        const entries = await listRepoRootEntries({
          token,
          owner,
          repo,
          ref: meta.default_branch,
          path: container,
          onlyType: "dir",
        });
        subEntries.push(...entries);
      } catch (subErr) {
        console.warn(
          `[repo-profiles] sub-listing ${container}/ failed for ${repo_full_name}: ${(subErr as Error).message} — root-only kind`,
        );
      }
    }

    const { kind, kinds, frameworks, manifest_paths } = deriveKind({
      rootEntries,
      languages,
      subEntries,
    });
    const fingerprint = computeFingerprint({
      repo_full_name,
      default_branch: meta.default_branch,
      manifest_paths,
      subEntries,
    });

    const { error } = await sb.rpc("upsert_repo_profile", {
      p_tenant_id: tenant_id,
      p_repo_full_name: repo_full_name,
      p_kind: kind,
      p_kinds: kinds,
      p_language_stats: languages,
      p_frameworks: frameworks,
      p_topics: meta.topics,
      p_description: meta.description,
      p_default_branch: meta.default_branch,
      p_manifest_paths: manifest_paths,
      p_fingerprint: fingerprint,
      p_profile_status: "ready",
      p_last_error: null,
      p_retry_after: null,
      p_built_at: new Date().toISOString(),
    });
    if (error) {
      throw new Error(`upsert_repo_profile RPC failed: ${error.message}`);
    }
    return "ready";
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    if (e instanceof CrossTenantRepoError) {
      console.warn(
        `[repo-profiles] refused to profile non-connected repo ${tenant_id}/${repo_full_name} (no row written): ${msg}`,
      );
      return "error";
    }
    try {
      const retryAfter = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await sb.rpc("upsert_repo_profile", {
        p_tenant_id: tenant_id,
        p_repo_full_name: repo_full_name,
        p_profile_status: "error",
        p_last_error: msg,
        p_retry_after: retryAfter,
      });
    } catch {
    }
    console.warn(
      `[repo-profiles] build failed for ${tenant_id}/${repo_full_name}: ${msg}`,
    );
    return "error";
  }
}

export async function buildTenantRepoProfiles(args: {
  tenant_id: string;
  only_repos?: string[];
}): Promise<Record<string, "ready" | "error" | "skipped">> {
  const out: Record<string, "ready" | "error" | "skipped"> = {};
  let conn: { installation_id: number; connectedRepos: string[] } | null = null;
  try {
    conn = await readGithubConnector(args.tenant_id);
  } catch (e) {
    console.warn(
      `[repo-profiles] connector read failed for ${args.tenant_id}: ${(e as Error).message}`,
    );
    return out;
  }
  if (!conn) return out;

  let scopedRepos: string[];
  try {
    const scoped = await getScopedRepos(args.tenant_id);
    if (scoped.selectionRequired) {
      return out;
    }
    scopedRepos = scoped.repos;
  } catch (e) {
    console.warn(
      `[repo-profiles] scope read failed for ${args.tenant_id}: ${(e as Error).message} — building nothing (fail closed)`,
    );
    scopedRepos = [];
  }

  const scopedSet = new Set(scopedRepos);
  const inScopeConnected = conn.connectedRepos.filter((r) => scopedSet.has(r));
  const targets =
    args.only_repos && args.only_repos.length > 0
      ? inScopeConnected.filter((r) => args.only_repos!.includes(r))
      : inScopeConnected;

  for (const repo of targets) {
    out[repo] = await buildRepoProfile({
      tenant_id: args.tenant_id,
      installation_id: conn.installation_id,
      repo_full_name: repo,
    });
  }
  return out;
}

export async function readReadyProfiles(args: {
  tenant_id: string;
  repos: readonly string[];
}): Promise<RepoProfile[]> {
  const { tenant_id, repos } = args;
  if (repos.length === 0) return [];
  const allowed: string[] = [];
  for (const r of repos) {
    try {
      await assertTenantConnectedRepo(tenant_id, r);
      allowed.push(r);
    } catch {
    }
  }
  if (allowed.length === 0) return [];

  const { data, error } = await serviceClient()
    .from("repo_profiles")
    .select(
      "repo_full_name, kind, kinds, language_stats, frameworks, topics, description, default_branch, manifest_paths, profile_status",
    )
    .eq("tenant_id", tenant_id)
    .in("repo_full_name", allowed)
    .eq("profile_status", "ready");
  if (error) {
    console.warn(
      `[repo-profiles] read failed for ${tenant_id}: ${error.message}`,
    );
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    repo_full_name: String(row.repo_full_name),
    kind: (row.kind as RepoKind) ?? "unknown",
    kinds: normalizeKinds(row.kinds, (row.kind as RepoKind) ?? "unknown"),
    language_stats: (row.language_stats as Record<string, number>) ?? {},
    frameworks: (row.frameworks as string[]) ?? [],
    topics: (row.topics as string[]) ?? [],
    description: (row.description as string | null) ?? null,
    default_branch: (row.default_branch as string | null) ?? null,
    manifest_paths: (row.manifest_paths as string[]) ?? [],
    profile_status: "ready" as const,
  }));
}

function normalizeKinds(raw: unknown, fallback: RepoKind): RepoKind[] {
  const arr = Array.isArray(raw)
    ? raw.filter((k): k is RepoKind => typeof k === "string" && k.length > 0)
    : [];
  return arr.length > 0 ? (arr as RepoKind[]) : [fallback];
}
