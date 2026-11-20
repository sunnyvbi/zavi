
export type TeamMemberIdentitySummary = {
  provider: "github" | "jira" | "slack";
  external_id: string;
  external_display_name: string | null;
  confidence: number;
  source: "auto" | "admin" | "oauth_self";
  external_email: string | null;
  recent_issue_keys?: string[] | null;
  avatar_url?: string | null;
};

export type TeamMemberIdentityDetail = TeamMemberIdentitySummary & {
  external_email: string | null;
};

export type TeamMemberRow = {
  id: string;
  display_name: string;
  primary_email: string | null;
  kind: "human" | "bot" | "service_account";
  status: "active" | "deactivated" | "merged_into";
  identities: TeamMemberIdentitySummary[];
  ambiguous_count: number;
};

export type TeamMemberDetail = Omit<TeamMemberRow, "identities" | "ambiguous_count"> & {
  identities: TeamMemberIdentityDetail[];
};

export type DiscoverResponse = {
  job_id: string;
  created: boolean;
};
