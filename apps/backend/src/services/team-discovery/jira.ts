
import { getConnectorToken } from "@/services/connectors/core/token";
import { getSecret } from "@/services/secrets/vault";
import type { DiscoveredIdentity } from "./types";

const MAX_MEMBERS = 200;

const RECENT_ISSUES_SCAN = 100;
const MAX_ISSUE_KEYS_PER_USER = 5;

type JiraSearchIssue = {
  key?: string;
  fields?: { assignee?: { accountId?: string } | null };
};

async function fetchRecentIssueKeysByAccount(
  cloudId: string,
  token: string,
): Promise<Map<string, string[]>> {
  const byAccount = new Map<string, string[]>();
  try {
    const r = await fetch(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jql: "assignee IS NOT EMPTY ORDER BY updated DESC",
          fields: ["assignee"],
          maxResults: RECENT_ISSUES_SCAN,
        }),
      },
    );
    if (!r.ok) return byAccount;
    const data = (await r.json()) as { issues?: JiraSearchIssue[] };
    for (const issue of data.issues ?? []) {
      const accountId = issue.fields?.assignee?.accountId;
      const key = issue.key;
      if (!accountId || !key) continue;
      const arr = byAccount.get(accountId) ?? [];
      if (arr.length < MAX_ISSUE_KEYS_PER_USER && !arr.includes(key)) {
        arr.push(key);
      }
      byAccount.set(accountId, arr);
    }
  } catch {
  }
  return byAccount;
}

type JiraUser = {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
  accountType?: string;
  active?: boolean;
  avatarUrls?: Record<string, string>;
};

export async function discoverJiraMembers(
  tenant_id: string,
): Promise<DiscoveredIdentity[]> {
  const token = await getConnectorToken(tenant_id, "jira", "jira.access_token");
  const cloudId = await getSecret(tenant_id, "jira.cloud_id");
  if (!token || !cloudId) {
    throw new Error("jira not_connected");
  }

  const out: DiscoveredIdentity[] = [];
  let startAt = 0;
  const pageSize = 100;
  while (out.length < MAX_MEMBERS) {
    const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/users/search?query=&maxResults=${pageSize}&startAt=${startAt}`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!r.ok) {
      throw new Error(`jira http_${r.status}`);
    }
    const arr = (await r.json()) as JiraUser[];
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const u of arr) {
      if (!u.accountId) continue;
      if (u.accountType && u.accountType !== "atlassian") continue;
      if (u.active === false) continue;
      out.push({
        provider: "jira",
        external_id: u.accountId,
        external_display_name: u.displayName || u.accountId,
        external_email: u.emailAddress?.trim().toLowerCase() || null,
        is_bot: false,
        avatar_url:
          u.avatarUrls?.["48x48"] ||
          u.avatarUrls?.["32x32"] ||
          (u.avatarUrls ? Object.values(u.avatarUrls)[0] : undefined) ||
          null,
      });
      if (out.length >= MAX_MEMBERS) break;
    }
    if (arr.length < pageSize) break;
    startAt += pageSize;
  }

  const issueKeysByAccount = await fetchRecentIssueKeysByAccount(cloudId, token);
  if (issueKeysByAccount.size > 0) {
    for (const identity of out) {
      const keys = issueKeysByAccount.get(identity.external_id);
      if (keys && keys.length > 0) identity.recent_issue_keys = keys;
    }
  }

  return out;
}
