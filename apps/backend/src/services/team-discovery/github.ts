
import {
  mintInstallationToken,
  ghInstallationHeaders,
} from "@/services/connectors/github/oauth";
import { serviceClient } from "@/services/supabase";
import type { DiscoveredIdentity } from "./types";

const GITHUB_API = "https://api.github.com";
const MAX_MEMBERS = 200;

const STATIC_BOT_LOGINS = new Set<string>([
  "dependabot",
  "renovate",
  "github-actions",
  "pull",
  "imgbot",
  "snyk-bot",
  "codecov",
  "vercel",
  "netlify",
]);

function isBotLogin(login: string, type: string): boolean {
  if (type === "Bot") return true;
  if (/\[bot\]$/i.test(login)) return true;
  const stem = login.replace(/\[bot\]$/i, "").toLowerCase();
  return STATIC_BOT_LOGINS.has(stem);
}

type GitHubMember = {
  login: string;
  id: number;
  type: string;
};

type GitHubUserDetail = {
  login: string;
  name?: string | null;
  email?: string | null;
  type: string;
  avatar_url?: string | null;
};

async function fetchInstallation(
  tenant_id: string,
): Promise<{ installation_id: number; account_login: string; account_type: string } | null> {
  const sb = serviceClient();
  const { data } = await sb
    .from("connector_metadata")
    .select("installation_id, account_login, account_type")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (!data || !data.installation_id) return null;
  return {
    installation_id: data.installation_id as number,
    account_login: (data.account_login as string) || "",
    account_type: (data.account_type as string) || "",
  };
}

export async function discoverGithubMembers(
  tenant_id: string,
): Promise<DiscoveredIdentity[]> {
  const install = await fetchInstallation(tenant_id);
  if (!install) {
    throw new Error("github not_connected");
  }
  if (install.account_type !== "Organization") {
    return [];
  }

  const token = await mintInstallationToken({
    tenant_id,
    installation_id: install.installation_id,
  });
  const headers = ghInstallationHeaders(token);

  const members: GitHubMember[] = [];
  let page = 1;
  while (members.length < MAX_MEMBERS) {
    const url = `${GITHUB_API}/orgs/${install.account_login}/members?per_page=100&page=${page}`;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      throw new Error(`github http_${r.status}`);
    }
    const arr = (await r.json()) as GitHubMember[];
    if (!Array.isArray(arr) || arr.length === 0) break;
    members.push(...arr.slice(0, MAX_MEMBERS - members.length));
    if (arr.length < 100) break;
    page += 1;
  }

  const out: DiscoveredIdentity[] = [];
  for (const m of members) {
    const ur = await fetch(`${GITHUB_API}/users/${m.login}`, { headers });
    let detail: GitHubUserDetail = { login: m.login, type: m.type };
    if (ur.ok) {
      detail = (await ur.json()) as GitHubUserDetail;
    }
    out.push({
      provider: "github",
      external_id: m.login,
      external_display_name: detail.name || m.login,
      external_email: detail.email || null,
      is_bot: isBotLogin(m.login, detail.type ?? m.type),
      avatar_url: detail.avatar_url || `https://avatars.githubusercontent.com/u/${m.id}?v=4`,
    });
  }
  return out;
}

export const __test = {
  isBotLogin,
  STATIC_BOT_LOGINS,
};
