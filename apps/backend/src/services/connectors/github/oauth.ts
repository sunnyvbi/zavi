
import crypto from "node:crypto";
import { verifyHubSignature256 } from "@/services/connectors/hub-signature";
import { serviceClient } from "@/services/supabase";
import { getScopedRepoFullNames } from "@/services/connectors/github/scoped-repos";

const GITHUB_API = "https://api.github.com";

function normalizePem(raw: string): string {
  if (raw.includes("\n")) return raw;
  if (raw.includes("\\n")) return raw.replace(/\\n/g, "\n");
  const m = raw.match(/^(-----BEGIN [A-Z ]+-----)\s+([\s\S]+?)\s+(-----END [A-Z ]+-----)\s*$/);
  if (m) {
    const body = m[2].replace(/\s+/g, "");
    const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
    return `${m[1]}\n${wrapped}\n${m[3]}\n`;
  }
  return raw;
}

function appCreds(): { app_id: string; private_key: string; app_slug: string } {
  const app_id = process.env.GITHUB_APP_ID;
  const raw_key = process.env.GITHUB_APP_PRIVATE_KEY;
  const app_slug = process.env.GITHUB_APP_SLUG;
  if (!app_id || !raw_key || !app_slug) {
    throw new Error(
      "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_SLUG must be set. " +
        "Register a GitHub App at https://github.com/settings/apps and store " +
        "the keys in AWS Secrets Manager praxis-envprod-1.",
    );
  }
  return { app_id, private_key: normalizePem(raw_key), app_slug };
}

function base64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function mintAppJwt(): string {
  const { app_id, private_key } = appCreds();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: app_id,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = base64url(signer.sign(private_key));
  return `${signingInput}.${signature}`;
}

type CachedToken = { token: string; expires_at: number };
const tokenCache = new Map<string, CachedToken>();
const TOKEN_TTL_MS = 50 * 60 * 1000;

function tokenCacheKey(
  tenant_id: string,
  installation_id: number,
  repo_full_name?: string,
): string {
  return `${tenant_id}:${installation_id}:${repo_full_name ?? "*"}`;
}

export function _resetTokenCacheForTests(): void {
  tokenCache.clear();
}

const MINT_RETRY_MAX_ATTEMPTS = 3;
let _mintRetryBaseMs = 200;

export function _setMintRetryBaseMsForTests(ms: number): void {
  _mintRetryBaseMs = ms;
}

async function _sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function connectedRepoId(
  tenant_id: string,
  full_name: string,
): Promise<number | null> {
  try {
    const { data, error } = await serviceClient()
      .from("connector_metadata")
      .select("repo_ids, repo_full_names")
      .eq("tenant_id", tenant_id)
      .eq("slug", "github")
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { repo_ids?: number[] | null; repo_full_names?: string[] | null };
    const names = row.repo_full_names ?? [];
    const ids = row.repo_ids ?? [];
    const i = names.indexOf(full_name);
    const id = i >= 0 ? Number(ids[i]) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export async function mintInstallationToken(args: {
  tenant_id: string;
  installation_id: number;
  repo_full_name?: string;
  forceRefresh?: boolean;
  allow_unscoped?: boolean;
}): Promise<string> {
  if (args.repo_full_name && !args.allow_unscoped) {
    const scoped = await getScopedRepoFullNames(args.tenant_id);
    if (!scoped.includes(args.repo_full_name)) {
      throw new Error(
        `mintInstallationToken: refusing per-repo token for "${args.repo_full_name}" — ` +
          `not in tenant ${args.tenant_id}'s scoped repositories. The operator restricted ` +
          `which repos Zavi may reach (Settings → Connectors → GitHub). Pass allow_unscoped:true ` +
          `only for a provisioned/umbrella target outside the connector set.`,
      );
    }
  }
  const key = tokenCacheKey(args.tenant_id, args.installation_id, args.repo_full_name);
  if (!args.forceRefresh) {
    const hit = tokenCache.get(key);
    if (hit && hit.expires_at > Date.now()) return hit.token;
  }
  const body: Record<string, unknown> = {};
  if (args.repo_full_name) {
    const repoId = await connectedRepoId(args.tenant_id, args.repo_full_name);
    if (repoId !== null) {
      body.repository_ids = [repoId];
    } else {
      const [, repoName] = args.repo_full_name.split("/");
      if (repoName) body.repositories = [repoName];
    }
  }
  const url = `${GITHUB_API}/app/installations/${args.installation_id}/access_tokens`;
  const requestBody = Object.keys(body).length > 0 ? JSON.stringify(body) : undefined;

  let res: Response | null = null;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MINT_RETRY_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await _sleep(_mintRetryBaseMs * Math.pow(2, attempt - 2));
    }

    const jwt = mintAppJwt();

    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...ghAppHeaders(jwt), "content-type": "application/json" },
        body: requestBody,
      });
    } catch (netErr) {
      lastError =
        netErr instanceof Error ? netErr : new Error(String(netErr));
      res = null;
      if (attempt < MINT_RETRY_MAX_ATTEMPTS) continue;
      throw new Error(
        `mintInstallationToken network error after ${attempt} attempts: ${lastError.message}`,
      );
    }

    if (res.ok) break;

    const text = await res.text().catch(() => "");

    if (res.status === 404) {
      await markGithubInstallDead(args.tenant_id).catch(() => {});
      throw new Error(`mintInstallationToken HTTP 404: ${text.slice(0, 400)}`);
    }

    if (res.status === 401) {
      lastError = new Error(`mintInstallationToken HTTP 401: ${text.slice(0, 400)}`);
      if (attempt === 1) continue;
      throw lastError;
    }

    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      lastError = new Error(`mintInstallationToken HTTP ${res.status}: ${text.slice(0, 400)}`);
      if (attempt < MINT_RETRY_MAX_ATTEMPTS) continue;
      throw lastError;
    }

    throw new Error(`mintInstallationToken HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  if (!res || !res.ok) {
    throw lastError ?? new Error("mintInstallationToken: unexpected mint failure");
  }

  const json = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(key, {
    token: json.token,
    expires_at: Date.now() + TOKEN_TTL_MS,
  });
  return json.token;
}

export async function markGithubInstallDead(tenant_id: string): Promise<void> {
  const { error } = await serviceClient()
    .from("tenant_mcp_servers")
    .update({ enabled: false })
    .eq("tenant_id", tenant_id)
    .eq("server_id", "github");
  if (error) {
    console.warn(
      `[github/oauth] markGithubInstallDead: failed to disable github MCP for tenant ${tenant_id}: ${error.message}`,
    );
  }
}

function ghAppHeaders(jwt: string): Record<string, string> {
  return {
    "authorization": `Bearer ${jwt}`,
    "accept": "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "Zavi/1.0",
  };
}

export async function getRepoInstallationToken(args: {
  tenant_id: string;
  repo_full_name: string;
}): Promise<string | null> {
  const { data, error } = await serviceClient()
    .from("connector_metadata")
    .select("installation_id")
    .eq("tenant_id", args.tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (error) return null;
  const installation_id = (data as { installation_id?: number } | null)
    ?.installation_id;
  if (!installation_id) return null;
  try {
    return await mintInstallationToken({
      tenant_id: args.tenant_id,
      installation_id,
      repo_full_name: args.repo_full_name,
    });
  } catch {
    return null;
  }
}

export type InstallationDetails = {
  installation_id: number;
  account_login: string;
  account_type: string;
  app_slug: string;
};

export async function getInstallation(
  installation_id: number,
): Promise<InstallationDetails> {
  const jwt = mintAppJwt();
  const res = await fetch(`${GITHUB_API}/app/installations/${installation_id}`, {
    headers: ghAppHeaders(jwt),
  });
  if (!res.ok) {
    throw new Error(`getInstallation HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    id: number;
    account: { login: string; type: string };
    app_slug: string;
  };
  return {
    installation_id: json.id,
    account_login: json.account?.login ?? "",
    account_type: json.account?.type ?? "User",
    app_slug: json.app_slug ?? "",
  };
}

export type InstallationRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
};

export async function listInstallationRepos(args: {
  tenant_id: string;
  installation_id: number;
}): Promise<InstallationRepo[]> {
  const token = await mintInstallationToken(args);
  const withContent: InstallationRepo[] = [];
  const empty: InstallationRepo[] = [];
  let page = 1;
  for (; page <= 10; page++) {
    const res = await fetch(
      `${GITHUB_API}/installation/repositories?per_page=100&page=${page}`,
      {
        headers: ghInstallationHeaders(token),
      },
    );
    if (!res.ok) {
      throw new Error(`listInstallationRepos HTTP ${res.status} page=${page}`);
    }
    const json = (await res.json()) as {
      total_count: number;
      repositories: Array<{ id: number; name: string; full_name: string; private: boolean; size?: number }>;
    };
    for (const r of json.repositories) {
      const repo = { id: r.id, name: r.name, full_name: r.full_name, private: r.private };
      (r.size === 0 ? empty : withContent).push(repo);
    }
    if (json.repositories.length < 100) break;
  }
  return [...withContent, ...empty];
}

export async function repoIsEmpty(args: {
  tenant_id: string;
  repo_full_name: string;
}): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), 5_000);
  });
  try {
    return await Promise.race([repoHasNoBranches(args), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function repoHasNoBranches(args: {
  tenant_id: string;
  repo_full_name: string;
}): Promise<boolean> {
  try {
    const token = await getRepoInstallationToken(args);
    if (!token) return false;
    const [owner, repo] = args.repo_full_name.split("/");
    const res = await fetch(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=1`,
      { headers: ghInstallationHeaders(token), signal: AbortSignal.timeout(5_000) },
    );
    if (res.status === 409) return true;
    if (!res.ok) return false;
    const branches = (await res.json()) as unknown;
    return Array.isArray(branches) && branches.length === 0;
  } catch {
    return false;
  }
}

export function ghInstallationHeaders(token: string): Record<string, string> {
  return {
    "authorization": `token ${token}`,
    "accept": "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "Zavi/1.0",
  };
}

export type GithubRepoMeta = {
  description: string | null;
  default_branch: string;
  topics: string[];
};

export async function getRepoMetadata(args: {
  token: string;
  owner: string;
  repo: string;
}): Promise<GithubRepoMeta> {
  const base = `${GITHUB_API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`;
  const res = await fetch(base, { headers: ghInstallationHeaders(args.token) });
  if (!res.ok) {
    throw new Error(`getRepoMetadata HTTP ${res.status} for ${args.owner}/${args.repo}`);
  }
  const json = (await res.json()) as {
    description?: string | null;
    default_branch?: string;
    topics?: string[];
  };
  return {
    description: json.description ?? null,
    default_branch: json.default_branch || "main",
    topics: Array.isArray(json.topics) ? json.topics : [],
  };
}

export async function getRepoLanguages(args: {
  token: string;
  owner: string;
  repo: string;
}): Promise<Record<string, number>> {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/languages`;
  const res = await fetch(url, { headers: ghInstallationHeaders(args.token) });
  if (!res.ok) {
    throw new Error(`getRepoLanguages HTTP ${res.status} for ${args.owner}/${args.repo}`);
  }
  const json = (await res.json()) as Record<string, number>;
  return json && typeof json === "object" ? json : {};
}

export async function repoPathExists(args: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}): Promise<boolean> {
  const refQ = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : "";
  const url = `${GITHUB_API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/contents/${args.path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")}${refQ}`;
  const res = await fetch(url, { headers: ghInstallationHeaders(args.token) });
  return res.status === 200;
}

export async function listRepoRootEntries(args: {
  token: string;
  owner: string;
  repo: string;
  ref?: string;
  path?: string;
  onlyType?: "dir" | "file";
}): Promise<string[]> {
  const refQ = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : "";
  const pathSeg = args.path
    ? "/" + args.path.split("/").map(encodeURIComponent).join("/")
    : "";
  const url = `${GITHUB_API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/contents${pathSeg}${refQ}`;
  const res = await fetch(url, { headers: ghInstallationHeaders(args.token) });
  if (res.status !== 200) return [];
  const json = (await res.json()) as
    | Array<{ name?: string; type?: string }>
    | unknown;
  if (!Array.isArray(json)) return [];
  return json
    .filter((e) => {
      if (!args.onlyType) return true;
      if (!e || typeof e !== "object") return false;
      return (e as { type?: string }).type === args.onlyType;
    })
    .map((e) => (e && typeof e === "object" ? (e as { name?: string }).name : undefined))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

let cachedInstallBase: string | null = null;

async function resolveInstallBase(): Promise<string> {
  if (cachedInstallBase) return cachedInstallBase;
  try {
    const res = await fetch("https://api.github.com/app", {
      headers: ghAppHeaders(mintAppJwt()),
    });
    if (res.ok) {
      const json = (await res.json()) as { html_url?: string };
      if (json.html_url) {
        cachedInstallBase = json.html_url;
        return cachedInstallBase;
      }
    }
  } catch {
  }
  const { app_slug } = appCreds();
  return `https://github.com/apps/${app_slug}`;
}

export async function githubAppInstallStartUrl(state: string): Promise<string> {
  const base = await resolveInstallBase();
  const u = new URL(`${base.replace(/\/$/, "")}/installations/new`);
  u.searchParams.set("state", state);
  return u.toString();
}

export function verifyWebhookSignature(rawBody: Buffer, signature256: string): boolean {
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("GITHUB_APP_WEBHOOK_SECRET not set");
  }
  return verifyHubSignature256(rawBody, signature256, secret);
}

const TARBALL_BYTE_CAP = 100 * 1024 * 1024;

export async function downloadRepoTarballBase64(args: {
  tenant_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  ref?: string;
}): Promise<{ base64: string; bytes: number; sha_short: string }> {
  const token = await mintInstallationToken({
    tenant_id: args.tenant_id,
    installation_id: args.installation_id,
  });
  const ref = args.ref ?? "main";
  const url = `${GITHUB_API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/tarball/${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: ghInstallationHeaders(token),
    redirect: "follow",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `downloadRepoTarballBase64 HTTP ${res.status} for ${args.owner}/${args.repo}@${ref}: ${text.slice(0, 240)}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > TARBALL_BYTE_CAP) {
    throw new Error(
      `downloadRepoTarballBase64: ${args.owner}/${args.repo} tarball ${buf.byteLength}B exceeds ${TARBALL_BYTE_CAP}B cap`,
    );
  }
  const cd = res.headers.get("content-disposition") ?? "";
  const m = cd.match(/-(\w{7,40})\.tar\.gz/);
  const sha_short = m ? m[1].slice(0, 7) : "unknown";
  return { base64: buf.toString("base64"), bytes: buf.byteLength, sha_short };
}
