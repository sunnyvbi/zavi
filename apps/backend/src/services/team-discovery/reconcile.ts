
import type { DiscoveredIdentity } from "./types";

export type SlackIqExtraColumns = {
  slack_iq_role?: string | null;
  owned_areas?: string[] | null;
  active_channels?: string[] | null;
  last_active_at?: string | null;
  expertise_summary?: string | null;
};

export type ReconciledCluster = {
  display_name: string;
  primary_email: string | null;
  kind: "human" | "bot";
  iqExtras?: SlackIqExtraColumns;
  identities: Array<{
    provider: "github" | "jira" | "slack";
    external_id: string;
    external_email: string | null;
    external_display_name: string | null;
    confidence: number;
    team_id?: string | null;
    recent_issue_keys?: string[] | null;
    avatar_url?: string | null;
  }>;
};

function normalizeEmail(email: string | null): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  if (trimmed.endsWith("@users.noreply.github.com")) return null;
  return trimmed;
}

function normalizeNameToken(name: string | null): string | null {
  if (!name) return null;
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return null;
  const firstToken = trimmed.split(/\s+/)[0];
  const letterCount = (firstToken.match(/\p{L}/gu) ?? []).length;
  if (letterCount < 2) return null;
  return firstToken;
}

function bestDisplayName(identities: DiscoveredIdentity[]): string {
  let best = "";
  for (const i of identities) {
    const n = (i.external_display_name ?? "").trim();
    if (n.length > best.length) best = n;
  }
  if (best) return best;
  return identities[0]?.external_id ?? "unknown";
}

export function reconcile(input: DiscoveredIdentity[]): ReconciledCluster[] {
  const bots = input.filter((i) => i.is_bot);
  const humans = input.filter((i) => !i.is_bot);

  const emailGroups = new Map<string, DiscoveredIdentity[]>();
  const unmatched: DiscoveredIdentity[] = [];
  for (const h of humans) {
    const e = normalizeEmail(h.external_email);
    if (!e) {
      unmatched.push(h);
      continue;
    }
    const arr = emailGroups.get(e) ?? [];
    arr.push(h);
    emailGroups.set(e, arr);
  }

  const clusters: ReconciledCluster[] = [];

  for (const [email, group] of emailGroups) {
    if (group.length === 1) {
      unmatched.push(group[0]);
      continue;
    }
    clusters.push({
      display_name: bestDisplayName(group),
      primary_email: email,
      kind: "human",
      identities: group.map((g) => ({
        provider: g.provider,
        external_id: g.external_id,
        external_email: normalizeEmail(g.external_email),
        external_display_name: g.external_display_name,
        confidence: 1.0,
        team_id: g.team_id ?? null,
        recent_issue_keys: g.recent_issue_keys ?? null,
        avatar_url: g.avatar_url ?? null,
      })),
    });
  }

  const nameGroups = new Map<string, DiscoveredIdentity[]>();
  const stillUnmatched: DiscoveredIdentity[] = [];
  for (const h of unmatched) {
    const t = normalizeNameToken(h.external_display_name);
    if (!t) {
      stillUnmatched.push(h);
      continue;
    }
    const arr = nameGroups.get(t) ?? [];
    arr.push(h);
    nameGroups.set(t, arr);
  }

  for (const [, group] of nameGroups) {
    const providers = new Set(group.map((g) => g.provider));
    const emails = new Set(
      group.map((g) => normalizeEmail(g.external_email)).filter((e): e is string => e !== null),
    );
    const canCluster = group.length >= 2 && providers.size >= 2 && emails.size <= 1;
    if (!canCluster) {
      for (const h of group) stillUnmatched.push(h);
      continue;
    }
    const primaryEmail = emails.size === 1 ? [...emails][0] : null;
    clusters.push({
      display_name: bestDisplayName(group),
      primary_email: primaryEmail,
      kind: "human",
      identities: group.map((g) => ({
        provider: g.provider,
        external_id: g.external_id,
        external_email: normalizeEmail(g.external_email),
        external_display_name: g.external_display_name,
        confidence: 0.8,
        team_id: g.team_id ?? null,
        recent_issue_keys: g.recent_issue_keys ?? null,
        avatar_url: g.avatar_url ?? null,
      })),
    });
  }

  for (const h of stillUnmatched) {
    clusters.push({
      display_name: bestDisplayName([h]),
      primary_email: normalizeEmail(h.external_email),
      kind: "human",
      identities: [
        {
          provider: h.provider,
          external_id: h.external_id,
          external_email: normalizeEmail(h.external_email),
          external_display_name: h.external_display_name,
          confidence: 1.0,
          team_id: h.team_id ?? null,
          recent_issue_keys: h.recent_issue_keys ?? null,
          avatar_url: h.avatar_url ?? null,
        },
      ],
    });
  }

  for (const b of bots) {
    clusters.push({
      display_name: bestDisplayName([b]),
      primary_email: normalizeEmail(b.external_email),
      kind: "bot",
      identities: [
        {
          provider: b.provider,
          external_id: b.external_id,
          external_email: normalizeEmail(b.external_email),
          external_display_name: b.external_display_name,
          confidence: 1.0,
          team_id: b.team_id ?? null,
          recent_issue_keys: b.recent_issue_keys ?? null,
          avatar_url: b.avatar_url ?? null,
        },
      ],
    });
  }

  return clusters;
}

export function buildIqExtraColumns(
  extras: SlackIqExtraColumns | undefined,
): Partial<Record<keyof SlackIqExtraColumns, unknown>> {
  if (!extras) return {};
  const out: Partial<Record<keyof SlackIqExtraColumns, unknown>> = {};
  if ("slack_iq_role" in extras) out.slack_iq_role = extras.slack_iq_role ?? null;
  if ("owned_areas" in extras) out.owned_areas = extras.owned_areas ?? null;
  if ("active_channels" in extras) {
    const ac = extras.active_channels;
    out.active_channels = ac === null || ac === undefined ? null : ac.slice(0, 20);
  }
  if ("last_active_at" in extras) out.last_active_at = extras.last_active_at ?? null;
  if ("expertise_summary" in extras) out.expertise_summary = extras.expertise_summary ?? null;
  return out;
}

export const __test = { normalizeEmail, bestDisplayName, normalizeNameToken };
