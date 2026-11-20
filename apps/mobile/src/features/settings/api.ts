import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { useWorkspace } from "../workspaces/WorkspaceProvider";

export type MemberRole = "owner" | "admin" | "member" | "viewer";
export type EditableRole = "admin" | "member" | "viewer";

export const ROLE_HELP: Record<EditableRole, string> = {
  admin: "Everything a member can do, plus billing, team and connections.",
  member: "Works with Zavi on every channel. Can't change billing, team or connections.",
  viewer: "Read-only. Sees the workspace but can't start work or approve anything.",
};

function asMemberRole(role: string | null | undefined): MemberRole | null {
  return role === "owner" || role === "admin" || role === "member" || role === "viewer"
    ? role
    : null;
}

export function useMyRole(): MemberRole | null {
  const { tenants, activeTenantId } = useWorkspace();
  return asMemberRole(tenants.find((t) => t.tenant_id === activeTenantId)?.role);
}

export function useIsOwner(): boolean {
  return useMyRole() === "owner";
}

export function useCanManage(): boolean {
  const role = useMyRole();
  return role === "owner" || role === "admin";
}

export const FACT_ORDER = [
  "company_name",
  "domain",
  "what_we_sell",
  "who_we_serve",
  "competitors",
  "markets",
  "company_goals",
] as const;

export type FactKey = (typeof FACT_ORDER)[number];
export type Facts = Record<FactKey, string>;

export const FACT_LABEL: Record<FactKey, string> = {
  company_name: "Company name",
  domain: "Website",
  what_we_sell: "What you sell",
  who_we_serve: "Who you serve",
  competitors: "Competitors",
  markets: "Markets",
  company_goals: "Goals",
};

export const FACT_HINT: Record<FactKey, string> = {
  company_name: "The name agents use in copy, e.g. Upcar.",
  domain: "Your live site, e.g. https://www.yourcompany.com.",
  what_we_sell: "One line, e.g. P2P car rental marketplace.",
  who_we_serve: "One line, e.g. car owners who want to earn, and renters.",
  competitors: "Names only, comma separated. Anything that looks like a price is dropped.",
  markets: "Cities, regions or countries you operate in.",
  company_goals: "One or two lines on what the company is trying to achieve this year.",
};

export const FACT_MAX: Record<FactKey, number> = {
  company_name: 500,
  domain: 500,
  what_we_sell: 500,
  who_we_serve: 500,
  competitors: 1300,
  markets: 500,
  company_goals: 500,
};

export const emptyFacts = (): Facts =>
  Object.fromEntries(FACT_ORDER.map((k) => [k, ""])) as Facts;

type FactsResponse = { facts: { key: string; value_text: string | null }[] };

export type SaveFactsResult = {
  ok: boolean;
  written?: string[];
  cleared?: string[];
  rejected?: { key: string; dropped: string[] }[];
  canonicalized?: string[];
};

export function useCompanyFacts() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["company-facts", tenant],
    enabled: tenant !== "none",
    queryFn: async () => {
      const res = await apiJson<FactsResponse>("/api/connectors/company-facts");
      const out = emptyFacts();
      for (const f of res.facts ?? []) {
        if ((FACT_ORDER as readonly string[]).includes(f.key)) {
          out[f.key as FactKey] = f.value_text ?? "";
        }
      }
      return out;
    },
  });
}

export function saveCompanyFacts(facts: Partial<Facts>): Promise<SaveFactsResult> {
  return apiJson<SaveFactsResult>("/api/connectors/company-facts", {
    method: "POST",
    body: JSON.stringify({
      facts: Object.entries(facts).map(([key, value]) => ({ key, value: (value ?? "").trim() })),
    }),
  });
}

export function useSaveCompanyFacts() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: saveCompanyFacts,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-facts", tenant] }),
  });
}

export type Member = {
  user_id: string;
  email: string;
  role: MemberRole | string;
  joined_at: string;
};

export type Invite = {
  id: string;
  email: string;
  role: string;
  invited_at: string;
};

export function useMembers() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["members", tenant],
    enabled: tenant !== "none",
    queryFn: async () => (await apiJson<{ members: Member[] }>("/api/v1/members")).members ?? [],
  });
}

export function useInvites(enabled: boolean) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["invites", tenant],
    enabled: enabled && tenant !== "none",
    queryFn: async () =>
      (await apiJson<{ invites: Invite[] }>("/api/v1/members/invites")).invites ?? [],
  });
}

export function useCreateInvite() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: (input: { email: string; role: "admin" | "member" | "viewer" }) =>
      apiJson<{ invite_id: string }>("/api/v1/members/invite", {
        method: "POST",
        body: JSON.stringify({ email: input.email.trim().toLowerCase(), role: input.role }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites", tenant] }),
  });
}

export function useRevokeInvite() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: (inviteId: string) =>
      apiJson<{ ok: true }>(`/api/v1/members/invites/${encodeURIComponent(inviteId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites", tenant] }),
  });
}

export function useSetMemberRole() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: (input: { userId: string; role: EditableRole }) =>
      apiJson<{ ok: true }>(`/api/v1/members/${encodeURIComponent(input.userId)}/role`, {
        method: "POST",
        body: JSON.stringify({ role: input.role }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", tenant] }),
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: (userId: string) =>
      apiJson<{ ok: true }>(`/api/v1/members/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", tenant] }),
  });
}

export function useTransferOwnership() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const { refresh } = useWorkspace();
  return useMutation({
    mutationFn: (userId: string) =>
      apiJson<{ ok: true }>(
        `/api/v1/members/${encodeURIComponent(userId)}/transfer-ownership`,
        {
          method: "POST",
          body: "{}",
        },
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["members", tenant] });
      await refresh();
    },
  });
}

export type Credits = {
  enforced: boolean;
  unlimited: boolean;
  plan: string | null;
  tier: string | null;
  period_start: string | null;
  period_end: string | null;
  included_allowance: number;
  included_used: number;
  included_remaining: number;
  daily_allowance: number;
  daily_used: number;
  daily_remaining: number;
  purchased_balance: number;
  reserved: number;
  effective_available: number;
  effective_available_display: number;
  effective_available_usd: number;
  pct_used: number;
  soft_warn: boolean;
};

export function effectiveTier(c: Pick<Credits, "plan" | "tier">): string {
  if (!c.plan || c.plan === "free") return "free";
  return c.tier ?? "free";
}

export function useCredits() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["credits", tenant],
    enabled: tenant !== "none",
    queryFn: () => apiJson<Credits>("/api/billing/credits"),
  });
}

export type UsageWindow = 7 | 30 | 90;

export type UsageBreakdown = {
  window_days: number;
  period_start: string;
  period_end: string;
  total_credits: number;
  daily: { date: string; credits: number }[];
  by_agent: { agent_slug: string; credits: number }[];
};

export function useUsageBreakdown(days: UsageWindow) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["usage-breakdown", tenant, days],
    enabled: tenant !== "none",
    queryFn: () => apiJson<UsageBreakdown>(`/api/billing/usage-breakdown?days=${days}`),
  });
}

export type Invoice = {
  id: string;
  number: string | null;
  created: number;
  amount_due_usd: number;
  status: string | null;
  pdf_url: string | null;
};

export function useInvoices() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["invoices", tenant],
    enabled: tenant !== "none",
    queryFn: async () => (await apiJson<{ invoices: Invoice[] }>("/api/billing/invoices")).invoices ?? [],
  });
}

export type ChannelPrefKey =
  | "slack_approval_push_enabled"
  | "autopilot_digest_push_enabled"
  | "slack_connector_alert_enabled"
  | "autopilot_digest_email_enabled"
  | "material_news_enabled";

export type ChannelPrefs = Partial<Record<ChannelPrefKey, boolean>>;

export type ChannelGroup = {
  surface: string;
  dest: string;
  rows: { key: ChannelPrefKey; label: string; help: string }[];
  quiet?: string;
};

export const CHANNEL_GROUPS: ChannelGroup[] = [
  {
    surface: "Slack",
    dest: "#zavi",
    rows: [
      {
        key: "slack_approval_push_enabled",
        label: "Approvals",
        help: "When an agent needs your yes before it can carry on.",
      },
      {
        key: "autopilot_digest_push_enabled",
        label: "Daily digest",
        help: "What your AI team did overnight, once each morning.",
      },
      {
        key: "slack_connector_alert_enabled",
        label: "Connector alerts",
        help: "A connection is expiring or broke.",
      },
    ],
  },
  {
    surface: "Email",
    dest: "the owner",
    rows: [
      {
        key: "autopilot_digest_email_enabled",
        label: "Daily digest",
        help: "The same morning brief, in your inbox.",
      },
      {
        key: "material_news_enabled",
        label: "Market moves",
        help: "Competitor and market news worth knowing about.",
      },
    ],
  },
  {
    surface: "Telegram · Discord · WhatsApp",
    dest: "replies only",
    rows: [],
    quiet:
      "Zavi pushes nothing to these. It answers messages you send it there, including a note when a run you started needs your approval.",
  },
];

export function useChannelPrefs() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["channel-prefs", tenant],
    enabled: tenant !== "none",
    queryFn: async () =>
      (await apiJson<{ prefs: ChannelPrefs }>("/api/workspace/notification-prefs")).prefs ?? {},
  });
}

export function useUpdateChannelPrefs() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const key = ["channel-prefs", tenant] as const;
  return useMutation({
    mutationFn: async (patch: ChannelPrefs) =>
      (
        await apiJson<{ prefs: ChannelPrefs }>("/api/workspace/notification-prefs", {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
      ).prefs,
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ChannelPrefs>(key);
      qc.setQueryData<ChannelPrefs>(key, { ...(prev ?? {}), ...patch });
      return { prev };
    },
    onError: (_e, _patch, ctx) => {
      qc.setQueryData(key, ctx?.prev);
    },
    onSuccess: (prefs) => {
      qc.setQueryData(key, prefs);
    },
  });
}
