
export type DiscoveredIdentity = {
  provider: "github" | "jira" | "slack";
  external_id: string;
  external_display_name: string | null;
  external_email: string | null;
  is_bot: boolean;
  recent_issue_keys?: string[] | null;
  avatar_url?: string | null;
  team_id?: string | null;
};

export type ProviderError = {
  provider: "github" | "jira" | "slack";
  code: string;
  status?: number;
};

export type DiscoverResult = {
  identities: DiscoveredIdentity[];
  errors: ProviderError[];
};

export function sanitizeDiscoveryError(
  provider: "github" | "jira" | "slack",
  err: unknown,
): ProviderError {
  const e = err as { code?: string; status?: number; message?: string; response?: { status?: number } };
  const msg = e?.message ?? "";
  const msgLower = msg.toLowerCase();
  const httpMatch = msgLower.match(/\bhttp[_ ](\d{3})\b/);
  const status =
    typeof e?.status === "number"
      ? e.status
      : typeof e?.response?.status === "number"
        ? e.response.status
        : httpMatch
          ? parseInt(httpMatch[1], 10)
          : undefined;
  let code = "unexpected";
  if (msgLower.includes("not connected") || msgLower.includes("not_connected")) code = "not_connected";
  else if (status === 401 || status === 403) code = "auth_failed";
  else if (status === 429) code = "rate_limited";
  else if (typeof status === "number") code = `http_${status}`;
  return { provider, code, ...(status !== undefined ? { status } : {}) };
}
