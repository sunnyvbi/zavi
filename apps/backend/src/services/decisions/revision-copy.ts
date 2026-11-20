
type DecisionLike = {
  id: string;
  decision_class: string;
  body: Record<string, unknown> | null;
};

const INSTRUCTION_CLASSES = new Set(["channel.recipe_step"]);

function stepTitle(body: Record<string, unknown> | null): string | null {
  const step = body?.step as { title?: unknown } | undefined;
  return typeof step?.title === "string" && step.title.trim()
    ? step.title.trim()
    : null;
}

function shortAction(decision: DecisionLike): string {
  const b = decision.body ?? {};
  if (
    decision.decision_class.startsWith("meta_ads.update_ad_set_budget") ||
    decision.decision_class.startsWith("meta_ads.update_campaign_budget")
  ) {
    const from = b.expected_current_daily_budget_usd;
    const to = b.daily_budget_usd;
    return `revise the budget change${from || to ? ` (${from ?? "?"} -> ${to ?? "?"}/day)` : ""}`;
  }
  if (decision.decision_class.startsWith("meta_ads.set_status")) {
    const level = typeof b.level === "string" ? b.level : "object";
    const status = typeof b.status === "string" ? b.status : "status";
    return `revise the ${status.toLowerCase()} ${level} proposal`;
  }
  if (decision.decision_class.startsWith("meta_ads.create_ad_set")) {
    return "revise the new ad set proposal";
  }
  if (decision.decision_class.startsWith("google_ads.update_campaign_budget")) {
    const from = b.expected_current_daily_budget_usd;
    const to = b.daily_budget_usd;
    return `revise the Google Ads budget change${from || to ? ` (${from ?? "?"} -> ${to ?? "?"}/day)` : ""}`;
  }
  if (decision.decision_class.startsWith("google_ads.set_status")) {
    const level = typeof b.level === "string" ? b.level.replace("_", " ") : "campaign";
    const status = typeof b.status === "string" ? b.status : "status";
    return `revise the ${status.toLowerCase()} ${level} proposal`;
  }
  if (decision.decision_class.startsWith("google_ads.create_campaign")) {
    return "revise the new Google Ads campaign proposal";
  }
  if (decision.decision_class.startsWith("google_ads.create_ad_group")) {
    return "revise the new ad group proposal";
  }
  if (decision.decision_class.startsWith("google_ads.create_ad")) {
    return "revise the new ad proposal";
  }
  if (decision.decision_class.startsWith("google_ads.add_keywords")) {
    return "revise the keyword proposal";
  }
  if (decision.decision_class.startsWith("google_ads.remove_resource")) {
    return "revise the removal proposal";
  }
  if (decision.decision_class.startsWith("google_ads.update_")) {
    return "revise the Google Ads settings change";
  }
  return "revise this proposal";
}

export function revisionPrompt(decision: DecisionLike, message: string): string {
  const body = decision.body ?? {};
  const dump = JSON.stringify(body, null, 2).slice(0, 6000);

  if (INSTRUCTION_CLASSES.has(decision.decision_class)) {
    const title = stepTitle(body) ?? "this action";
    const pos =
      typeof body.position === "number" && typeof body.of === "number"
        ? ` (action ${body.position} of ${body.of} from this run)`
        : "";
    return [
      `Please rewrite the action "${title}"${pos} for decision ${decision.id}.`,
      `Current action:\n${dump}`,
      `Requested change: ${message}`,
      "This is an instruction to a PERSON — you have no write access to their site, so do not propose executing anything. Return the same action with its wording, reasoning or approach revised. Keep the evidence honest: if the change would make a claim you cannot support, say so instead of inventing support for it.",
    ].join("\n\n");
  }

  return [
    `Please ${shortAction(decision)} for decision ${decision.id}.`,
    `Original proposal body:\n${dump}`,
    `Requested change: ${message}`,
    "Do not execute anything. If a change is warranted, emit a revised proposal for approval; otherwise explain why the original should stand.",
  ].join("\n\n");
}
