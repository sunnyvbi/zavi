
export type RosterAgent = { slug: string; name?: string; description?: string };

export type ClassifyVerdict = {
  tier: 1 | 2 | 3;
  reply?: string;
  agent_slug?: string;
  suggested_agent_slug?: string;
  confidence?: "high" | "low";
};

export const OPERATOR_SLUG = "operator";

export type SlackRoute =
  | {
      kind: "enqueue_direct";
      agent_slug: string;
      result: Record<string, unknown>;
    }
  | {
      kind: "route_operator";
      result: Record<string, unknown>;
    }
  | {
      kind: "post_and_terminate";
      text: string;
      success_emoji_on_post_ok: boolean;
      result: Record<string, unknown>;
    }
  | {
      kind: "low_conf_operator_dispatch";
      placeholder_text: string;
      result: Record<string, unknown>;
    }
  | {
      kind: "ack_and_route_operator";
      placeholder_text: string;
      result: Record<string, unknown>;
    };

export function parseExplicitSlug(
  text: string,
  slugs: Set<string>,
): string | undefined {
  const stripped = text.replace(/^\s*<@[A-Z0-9]+>\s*/i, "").trim();
  const first = stripped.split(/\s+/)[0] ?? "";
  const m = first.match(/^@?([a-z0-9-]{1,64})$/i);
  if (!m) return undefined;
  const cand = m[1].toLowerCase();
  return slugs.has(cand) ? cand : undefined;
}

export const LOW_CONF_OPERATOR_PLACEHOLDER =
  "On it. Pulling your context together now.";

export function buildLowConfidenceReply(
  active: Array<{ slug: string }>,
  suggested: string | undefined,
): string {
  const slugs = new Set(active.map((a) => a.slug));
  if (suggested && slugs.has(suggested)) {
    return `I don't know. Closest match would be \`${suggested}\`. Want me to route?`;
  }
  if (active.length === 0) {
    return "I don't know. No agents are configured for this workspace yet. Fork one from the templates first.";
  }
  return "I don't know. Try `@Zavi @<agent-slug> ...` to route explicitly.";
}

export type DecideInput = {
  decision: ClassifyVerdict | null;
  explicit?: string;
  active: RosterAgent[];
  workspaceDefaultSlug?: string;
  operatorWillRun?: boolean;
};

export function decideSlackRoute(input: DecideInput): SlackRoute {
  const { decision, explicit, active, workspaceDefaultSlug, operatorWillRun } = input;
  const slugs = new Set(active.map((a) => a.slug));
  const operatorVisible = slugs.has(OPERATOR_SLUG);

  const wsDefault =
    workspaceDefaultSlug && slugs.has(workspaceDefaultSlug)
      ? workspaceDefaultSlug
      : undefined;
  const routeToWorkspaceDefault = (reason: string): SlackRoute => ({
    kind: "enqueue_direct",
    agent_slug: wsDefault as string,
    result: { routed: wsDefault, route: "workspace_default", reason },
  });

  if (!decision) {
    if (wsDefault) return routeToWorkspaceDefault("classify_null");
    if (operatorVisible) {
      return {
        kind: "route_operator",
        result: { routed: "operator", reason: "classify_null" },
      };
    }
    const hint = active.length ? `e.g. \`@Zavi @${active[0].slug} ...\`` : "";
    return {
      kind: "post_and_terminate",
      text: `I couldn't tell who should pick this up. Try rephrasing, or tag a teammate directly${
        hint ? ` (${hint})` : ""
      }.`,
      success_emoji_on_post_ok: false,
      result: { skip: "classify_failed_terminal" },
    };
  }

  if (decision.tier === 3) {
    const slug = decision.agent_slug ?? "";

    if (explicit && slugs.has(explicit)) {
      return {
        kind: "enqueue_direct",
        agent_slug: explicit,
        result: { tier: 3, agent_slug: explicit, route: "explicit" },
      };
    }

    if (
      wsDefault &&
      slug &&
      slugs.has(slug) &&
      decision.confidence !== "low"
    ) {
      return {
        kind: "enqueue_direct",
        agent_slug: slug,
        result: { tier: 3, agent_slug: slug, route: "tier3_highconf_over_default" },
      };
    }

    if (wsDefault) return routeToWorkspaceDefault("tier3");

    if (operatorVisible) {
      return {
        kind: "route_operator",
        result: { routed: "operator", reason: "tier3", model_slug: slug || null },
      };
    }

    if (slugs.has(slug)) {
      return {
        kind: "enqueue_direct",
        agent_slug: slug,
        result: { tier: 3, agent_slug: slug, route: "direct_no_operator" },
      };
    }

    return {
      kind: "post_and_terminate",
      text: buildLowConfidenceReply(active, decision.suggested_agent_slug),
      success_emoji_on_post_ok: false,
      result: { tier: 3, unmatched: slug },
    };
  }

  const replyText = (decision.reply ?? "").trim();
  const useFallback = decision.confidence === "low" || replyText.length === 0;

  if (useFallback && wsDefault) {
    return routeToWorkspaceDefault("low_conf_workspace_default");
  }

  if (useFallback && operatorVisible && active.length > 0) {
    return {
      kind: "low_conf_operator_dispatch",
      placeholder_text: LOW_CONF_OPERATOR_PLACEHOLDER,
      result: {
        tier: decision.tier,
        posted: true,
        routed: "operator",
        reason: "low_conf_dispatch",
      },
    };
  }

  if (!useFallback && operatorWillRun && operatorVisible && active.length > 0) {
    return {
      kind: "ack_and_route_operator",
      placeholder_text: LOW_CONF_OPERATOR_PLACEHOLDER,
      result: {
        tier: decision.tier,
        posted: true,
        routed: "operator",
        reason: "tier12_operator_woken",
      },
    };
  }

  const text = useFallback
    ? buildLowConfidenceReply(active, decision.suggested_agent_slug)
    : decision.reply ?? "";

  return {
    kind: "post_and_terminate",
    text,
    success_emoji_on_post_ok: true,
    result: {
      tier: decision.tier,
      posted: true,
      ...(decision.confidence !== "low" && replyText.length === 0
        ? { empty_reply_rescued: true }
        : {}),
    },
  };
}
