
import type { ClassifyVerdict, RosterAgent } from "../routing";

export const ROSTER_WITH_OPERATOR: RosterAgent[] = [
  { slug: "operator", name: "Operator", description: "Front-door teammate." },
  { slug: "engineer", name: "CTO Engineer", description: "Reads code, drafts PRs." },
  { slug: "performance-marketer", name: "Ads Manager", description: "Manages ad campaigns." },
  { slug: "chief-of-staff", name: "Chief of Staff", description: "Synthesizes focus." },
];

export const ROSTER_NO_OPERATOR: RosterAgent[] = [
  { slug: "engineer", name: "CTO Engineer", description: "Reads code, drafts PRs." },
  { slug: "performance-marketer", name: "Ads Manager", description: "Manages ad campaigns." },
];

export const ROSTER_EMPTY: RosterAgent[] = [];

export type ExpectedRoute =
  | { kind: "enqueue_direct"; agent_slug: string }
  | { kind: "route_operator"; reason: "classify_null" | "tier3" }
  | {
      kind: "post_and_terminate";
      success_emoji_on_post_ok: boolean;
      text_includes?: string;
    }
  | {
      kind: "low_conf_operator_dispatch";
      placeholder_includes?: string;
    };

export type RoutingGolden = {
  name: string;
  roster: "with_operator" | "no_operator" | "empty";
  scenario:
    | "explicit_slug"
    | "tier1"
    | "tier2"
    | "tier3_valid"
    | "tier3_hallucinated"
    | "low_confidence"
    | "classify_null"
    | "workspace_default";
  incident?: "empty_roster_outage" | "operator_connector_blindness";
  active: RosterAgent[];
  decision: ClassifyVerdict | null;
  explicit?: string;
  workspaceDefaultSlug?: string;
  expected: ExpectedRoute;
};

export const GOLDENS: RoutingGolden[] = [

  {
    name: "with_operator · explicit @engineer → direct",
    roster: "with_operator",
    scenario: "explicit_slug",
    active: ROSTER_WITH_OPERATOR,
    explicit: "engineer",
    decision: { tier: 3, agent_slug: "engineer", confidence: "high" },
    expected: { kind: "enqueue_direct", agent_slug: "engineer" },
  },
  {
    name: "with_operator · Tier1 knowledge answer → post (OK emoji)",
    roster: "with_operator",
    scenario: "tier1",
    active: ROSTER_WITH_OPERATOR,
    decision: {
      tier: 1,
      reply: "Zavi is an AI cofounder team for any company.",
      confidence: "high",
    },
    expected: {
      kind: "post_and_terminate",
      success_emoji_on_post_ok: true,
      text_includes: "AI cofounder team",
    },
  },
  {
    name: "with_operator · Tier2 tool-grounded answer → post (OK emoji)",
    roster: "with_operator",
    scenario: "tier2",
    active: ROSTER_WITH_OPERATOR,
    decision: { tier: 2, reply: "There are 3 open P1 issues.", confidence: "high" },
    expected: {
      kind: "post_and_terminate",
      success_emoji_on_post_ok: true,
      text_includes: "3 open P1",
    },
  },
  {
    name: "with_operator · Tier3 valid slug (no explicit) → operator",
    roster: "with_operator",
    scenario: "tier3_valid",
    active: ROSTER_WITH_OPERATOR,
    decision: { tier: 3, agent_slug: "engineer", confidence: "high" },
    expected: { kind: "route_operator", reason: "tier3" },
  },
  {
    name: "with_operator · Tier3 hallucinated slug → operator (no dead-end)",
    roster: "with_operator",
    scenario: "tier3_hallucinated",
    active: ROSTER_WITH_OPERATOR,
    decision: { tier: 3, agent_slug: "nonexistent-agent", confidence: "high" },
    expected: { kind: "route_operator", reason: "tier3" },
  },
  {
    name: "with_operator · low-confidence Tier1 (suggested slug) → operator dispatch",
    roster: "with_operator",
    scenario: "low_confidence",
    active: ROSTER_WITH_OPERATOR,
    decision: { tier: 1, confidence: "low", suggested_agent_slug: "engineer" },
    expected: {
      kind: "low_conf_operator_dispatch",
      placeholder_includes: "On it",
    },
  },
  {
    name: "with_operator · low-confidence Tier2 (no suggested) → operator dispatch",
    roster: "with_operator",
    scenario: "low_confidence",
    active: ROSTER_WITH_OPERATOR,
    decision: { tier: 2, confidence: "low" },
    expected: {
      kind: "low_conf_operator_dispatch",
      placeholder_includes: "On it",
    },
  },
  {
    name: "with_operator · classify-null → operator",
    roster: "with_operator",
    scenario: "classify_null",
    active: ROSTER_WITH_OPERATOR,
    decision: null,
    expected: { kind: "route_operator", reason: "classify_null" },
  },

  {
    name: "no_operator · explicit @performance-marketer → direct",
    roster: "no_operator",
    scenario: "explicit_slug",
    active: ROSTER_NO_OPERATOR,
    explicit: "performance-marketer",
    decision: { tier: 3, agent_slug: "performance-marketer", confidence: "high" },
    expected: { kind: "enqueue_direct", agent_slug: "performance-marketer" },
  },
  {
    name: "no_operator · Tier1 answer → post (OK emoji)",
    roster: "no_operator",
    scenario: "tier1",
    active: ROSTER_NO_OPERATOR,
    decision: { tier: 1, reply: "Generic Zavi overview answer.", confidence: "high" },
    expected: {
      kind: "post_and_terminate",
      success_emoji_on_post_ok: true,
      text_includes: "Zavi overview",
    },
  },
  {
    name: "no_operator · Tier2 answer → post (OK emoji)",
    roster: "no_operator",
    scenario: "tier2",
    active: ROSTER_NO_OPERATOR,
    decision: { tier: 2, reply: "2 PRs are open.", confidence: "high" },
    expected: {
      kind: "post_and_terminate",
      success_emoji_on_post_ok: true,
      text_includes: "2 PRs",
    },
  },
  {
    name: "no_operator · Tier3 valid slug → legacy direct dispatch",
    roster: "no_operator",
    scenario: "tier3_valid",
    active: ROSTER_NO_OPERATOR,
    decision: { tier: 3, agent_slug: "engineer", confidence: "high" },
    expected: { kind: "enqueue_direct", agent_slug: "engineer" },
  },
  {
    name: "no_operator · Tier3 hallucinated slug → honest fallback (WARN emoji)",
    roster: "no_operator",
    scenario: "tier3_hallucinated",
    active: ROSTER_NO_OPERATOR,
    decision: { tier: 3, agent_slug: "nonexistent-agent", confidence: "high" },
    expected: { kind: "post_and_terminate", success_emoji_on_post_ok: false },
  },
  {
    name: "no_operator · low-confidence Tier2 → honest fallback text (OK emoji)",
    roster: "no_operator",
    scenario: "low_confidence",
    active: ROSTER_NO_OPERATOR,
    decision: { tier: 2, confidence: "low" },
    expected: {
      kind: "post_and_terminate",
      success_emoji_on_post_ok: true,
      text_includes: "@Zavi @<agent-slug>",
    },
  },
  {
    name: "no_operator · classify-null → honest 'couldn't tell' (WARN emoji)",
    roster: "no_operator",
    scenario: "classify_null",
    active: ROSTER_NO_OPERATOR,
    decision: null,
    expected: {
      kind: "post_and_terminate",
      success_emoji_on_post_ok: false,
      text_includes: "couldn't tell who should pick this up",
    },
  },

  {
    name: "empty · classify-null → honest fallback (no agents, WARN emoji)",
    roster: "empty",
    scenario: "classify_null",
    active: ROSTER_EMPTY,
    decision: null,
    incident: "empty_roster_outage",
    expected: {
      kind: "post_and_terminate",
      success_emoji_on_post_ok: false,
      text_includes: "couldn't tell who should pick this up",
    },
  },
  {
    name: "empty · low-confidence Tier1 → 'no agents configured' (OK emoji)",
    roster: "empty",
    scenario: "low_confidence",
    active: ROSTER_EMPTY,
    decision: { tier: 1, confidence: "low" },
    incident: "empty_roster_outage",
    expected: {
      kind: "post_and_terminate",
      success_emoji_on_post_ok: true,
      text_includes: "No agents are configured for this workspace yet",
    },
  },
  {
    name: "empty · Tier3 slug against empty roster → honest fallback (WARN emoji)",
    roster: "empty",
    scenario: "tier3_hallucinated",
    active: ROSTER_EMPTY,
    decision: { tier: 3, agent_slug: "engineer", confidence: "high" },
    incident: "empty_roster_outage",
    expected: { kind: "post_and_terminate", success_emoji_on_post_ok: false },
  },

  {
    name: "INCIDENT connector-blindness · meta-ads Tier3 → operator (not dead-end)",
    roster: "with_operator",
    scenario: "tier3_valid",
    incident: "operator_connector_blindness",
    active: ROSTER_WITH_OPERATOR,
    decision: { tier: 3, agent_slug: "performance-marketer", confidence: "high" },
    expected: { kind: "route_operator", reason: "tier3" },
  },
  {
    name: "INCIDENT connector-blindness · meta-ads Tier3 hallucinated → operator",
    roster: "with_operator",
    scenario: "tier3_hallucinated",
    incident: "operator_connector_blindness",
    active: ROSTER_WITH_OPERATOR,
    decision: { tier: 3, agent_slug: "meta-ads-agent", confidence: "high" },
    expected: { kind: "route_operator", reason: "tier3" },
  },

  {
    name: "workspace_default · low-conf Tier2 in support Slack → support-lead (workspace default)",
    roster: "with_operator",
    scenario: "workspace_default",
    active: [
      ...ROSTER_WITH_OPERATOR,
      { slug: "support-lead", name: "Support Lead", description: "Handles support." },
    ],
    decision: { tier: 2, reply: "", confidence: "low" },
    workspaceDefaultSlug: "support-lead",
    expected: { kind: "enqueue_direct", agent_slug: "support-lead" },
  },

  {
    name: "workspace_default · explicit @engineer in support Slack → engineer (explicit beats default)",
    roster: "with_operator",
    scenario: "workspace_default",
    active: [
      ...ROSTER_WITH_OPERATOR,
      { slug: "support-lead", name: "Support Lead", description: "Handles support." },
    ],
    explicit: "engineer",
    decision: { tier: 3, agent_slug: "engineer", confidence: "high" },
    workspaceDefaultSlug: "support-lead",
    expected: { kind: "enqueue_direct", agent_slug: "engineer" },
  },

  {
    name: "workspace_default · high-conf off-purpose Tier3 in dev Slack → classified agent (beats default)",
    roster: "with_operator",
    scenario: "workspace_default",
    active: ROSTER_WITH_OPERATOR,
    decision: { tier: 3, agent_slug: "performance-marketer", confidence: "high" },
    workspaceDefaultSlug: "engineer",
    expected: { kind: "enqueue_direct", agent_slug: "performance-marketer" },
  },
];
