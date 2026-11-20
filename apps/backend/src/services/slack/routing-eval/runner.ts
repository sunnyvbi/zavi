
import { decideSlackRoute, type SlackRoute } from "../routing";
import type { ExpectedRoute, RoutingGolden } from "./goldens";

export type ScoredCase = {
  name: string;
  incident?: RoutingGolden["incident"];
  pass: boolean;
  reason?: string;
  got: SlackRoute["kind"];
  expected: ExpectedRoute["kind"];
};

export type ScoreReport = {
  total: number;
  passed: number;
  accuracy: number;
  cases: ScoredCase[];
  incidentFailures: ScoredCase[];
};

export function matchRoute(
  got: SlackRoute,
  expected: ExpectedRoute,
): string | null {
  if (got.kind !== expected.kind) {
    return `expected kind=${expected.kind}, got kind=${got.kind}`;
  }
  if (expected.kind === "enqueue_direct" && got.kind === "enqueue_direct") {
    if (got.agent_slug !== expected.agent_slug) {
      return `expected agent_slug=${expected.agent_slug}, got ${got.agent_slug}`;
    }
  }
  if (expected.kind === "route_operator" && got.kind === "route_operator") {
    const reason = (got.result as { reason?: string }).reason;
    if (reason !== expected.reason) {
      return `expected operator reason=${expected.reason}, got ${reason}`;
    }
  }
  if (
    expected.kind === "post_and_terminate" &&
    got.kind === "post_and_terminate"
  ) {
    if (got.success_emoji_on_post_ok !== expected.success_emoji_on_post_ok) {
      return `expected success_emoji_on_post_ok=${expected.success_emoji_on_post_ok}, got ${got.success_emoji_on_post_ok}`;
    }
    if (
      expected.text_includes &&
      !got.text.includes(expected.text_includes)
    ) {
      return `expected text to include "${expected.text_includes}", got "${got.text}"`;
    }
  }
  if (
    expected.kind === "low_conf_operator_dispatch" &&
    got.kind === "low_conf_operator_dispatch"
  ) {
    if (
      expected.placeholder_includes &&
      !got.placeholder_text.includes(expected.placeholder_includes)
    ) {
      return `expected placeholder to include "${expected.placeholder_includes}", got "${got.placeholder_text}"`;
    }
  }
  return null;
}

export function scoreDeterministic(goldens: RoutingGolden[]): ScoreReport {
  const cases: ScoredCase[] = goldens.map((g) => {
    const got = decideSlackRoute({
      decision: g.decision,
      explicit: g.explicit,
      active: g.active,
      workspaceDefaultSlug: g.workspaceDefaultSlug,
    });
    const reason = matchRoute(got, g.expected);
    return {
      name: g.name,
      incident: g.incident,
      pass: reason === null,
      reason: reason ?? undefined,
      got: got.kind,
      expected: g.expected.kind,
    };
  });
  const passed = cases.filter((c) => c.pass).length;
  return {
    total: cases.length,
    passed,
    accuracy: cases.length ? passed / cases.length : 0,
    cases,
    incidentFailures: cases.filter((c) => c.incident && !c.pass),
  };
}

function syntheticMessage(g: RoutingGolden): string {
  switch (g.scenario) {
    case "tier1":
      return "What is Zavi?";
    case "tier2":
      return "How many open P1 issues are there right now?";
    case "tier3_valid":
    case "tier3_hallucinated":
      if (g.incident === "operator_connector_blindness") {
        return "Is there a bay-area meta ads campaign running right now?";
      }
      return "There's a bug in the checkout flow — can someone look at the code and open a PR?";
    case "low_confidence":
      return "asdklfj qwponxz ???";
    case "classify_null":
      return "…";
    default:
      return "hello";
  }
}

export async function scoreLiveClassifier(
  goldens: RoutingGolden[],
  classify: (input: {
    message_text: string;
    active_agents: { slug: string; name: string; description: string }[];
    explicit_mention_slug?: string;
    tenant_id: string;
    event: { channel_id: string; thread_ts: string };
  }) => Promise<RoutingGolden["decision"]>,
  tenant_id: string,
): Promise<ScoreReport> {
  const live = goldens.filter((g) => g.scenario !== "explicit_slug");
  const cases: ScoredCase[] = [];
  for (const g of live) {
    const decision = await classify({
      message_text: syntheticMessage(g),
      active_agents: g.active.map((a) => ({
        slug: a.slug,
        name: a.name ?? a.slug,
        description: a.description ?? "",
      })),
      explicit_mention_slug: g.explicit,
      tenant_id,
      event: { channel_id: "C_EVAL", thread_ts: "1.0" },
    });
    const got = decideSlackRoute({ decision, explicit: g.explicit, active: g.active });
    const reason = matchRoute(got, g.expected);
    cases.push({
      name: g.name,
      incident: g.incident,
      pass: reason === null,
      reason: reason ?? undefined,
      got: got.kind,
      expected: g.expected.kind,
    });
  }
  const passed = cases.filter((c) => c.pass).length;
  return {
    total: cases.length,
    passed,
    accuracy: cases.length ? passed / cases.length : 0,
    cases,
    incidentFailures: cases.filter((c) => c.incident && !c.pass),
  };
}
