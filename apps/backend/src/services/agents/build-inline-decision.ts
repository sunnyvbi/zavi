
import {
  DecisionBodySchema,
  type ThreadEventBody,
} from "./thread-event-types";
import { isComposioDecisionClass } from "@/services/connectors/composio/write-classify";
import { isEmailCardClass } from "@/services/email-cards/approve-gate";
import { REVIEW_SIBLING, isMetaOrGoogleAdClass } from "@/services/growth/founder-order";
import { logEvent } from "@/services/logging/logEvent";
import { adChangeHeadline } from "@zavi/shared";

const BUDGET_REVIEW_CLASS = "meta_ads.update_ad_set_budget_review";

const ADVISORY_CLASS = "agent.urgent_advisory";

const SPEND_BEARING_KEYS = [
  "ad_set_id",
  "daily_budget",
  "daily_budget_usd",
  "authorized_effective_cap",
  "expected_current_daily_budget_usd",
  "object_id",
  "amount",
  "amount_usd",
] as const;

type InlineDecisionInput = {
  decision_id: string;
  decision_class: string;
  body: unknown;
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asObj(body: unknown): Record<string, unknown> {
  return body && typeof body === "object"
    ? (body as Record<string, unknown>)
    : {};
}

function buildBudgetReviewCard(
  input: InlineDecisionInput,
): ThreadEventBody<"decision"> | null {
  const b = asObj(input.body);

  const subject = str(b.ad_set_id);
  const after = num(b.daily_budget_usd);
  const before = num(b.expected_current_daily_budget_usd);

  const isAmbiguous = b.match_unsure === "ambiguous_match";
  const summary = isAmbiguous
    ? "Which campaign did you mean? Confirm to apply this budget change."
    : "Tap below to apply this budget change.";

  const title =
    adChangeHeadline(input.decision_class, input.body) ??
    (before !== undefined && after !== undefined
      ? `Budget change: $${before}/day → $${after}/day`
      : "Confirm budget change");

  const card: ThreadEventBody<"decision"> = {
    decision_id: input.decision_id,
    decision_class: input.decision_class,
    title,
    summary,
    ...(subject !== undefined ? { subject } : {}),
    ...(before !== undefined ? { before_usd: before } : {}),
    ...(after !== undefined ? { after_usd: after } : {}),
  };

  return DecisionBodySchema.parse(card) as ThreadEventBody<"decision">;
}

function buildAdvisoryCard(
  input: InlineDecisionInput,
): ThreadEventBody<"decision"> | null {
  const b = asObj(input.body);

  for (const k of SPEND_BEARING_KEYS) {
    if (k in b) return null;
  }

  const title = str(b.title) ?? "Heads-up from your agent";
  const summary =
    str(b.summary) ??
    "An agent flagged something urgent. Tap to acknowledge, or dismiss.";
  const subject = str(b.subject);

  const card: ThreadEventBody<"decision"> = {
    decision_id: input.decision_id,
    decision_class: input.decision_class,
    title: title.slice(0, 280),
    summary: summary.slice(0, 280),
    ...(subject !== undefined ? { subject: subject.slice(0, 160) } : {}),
  };

  return DecisionBodySchema.parse(card) as ThreadEventBody<"decision">;
}

function buildComposioWriteCard(
  input: InlineDecisionInput,
): ThreadEventBody<"decision"> | null {
  const b = asObj(input.body);
  if (b.kind !== "composio_write") return null;
  const title = `${str(b.app_name) ?? "App"}: ${str(b.action) ?? str(b.tool_slug) ?? "write"}`;
  return DecisionBodySchema.parse({
    decision_id: input.decision_id,
    decision_class: input.decision_class,
    title: title.slice(0, 280),
  }) as ThreadEventBody<"decision">;
}

const X_ADS_CARD_TITLES: Readonly<Record<string, string>> = {
  "x_ads.set_status": "X Ads: change a campaign's status",
  "x_ads.update_campaign": "X Ads: change a campaign",
  "x_ads.create_campaign": "X Ads: start a new campaign",
  "x_ads.manage_objects": "X Ads: manage campaign objects",
};

function buildXAdsCard(input: InlineDecisionInput): ThreadEventBody<"decision"> | null {
  const b = asObj(input.body);
  let title = X_ADS_CARD_TITLES[input.decision_class];
  if (input.decision_class === "x_ads.set_status") {
    if (b.status === "PAUSED") title = "X Ads: pause a campaign";
    else if (b.status === "ACTIVE") title = "X Ads: turn a campaign back on";
    else return null;
  }
  const subject = str(b.campaign_id);
  const daily = num(b.daily_budget);
  return DecisionBodySchema.parse({
    decision_id: input.decision_id,
    decision_class: input.decision_class,
    title,
    summary: "Nothing changes in X Ads until you approve.",
    ...(subject && /^[a-z0-9]{1,32}$/.test(subject) ? { subject } : {}),
    ...(input.decision_class === "x_ads.create_campaign" && daily !== undefined && b.currency === "USD" ? { after_usd: daily } : {}),
  }) as ThreadEventBody<"decision">;
}

const TIKTOK_ADS_CARD_TITLES: Readonly<Record<string, string>> = {
  "tiktok_ads.set_status": "TikTok Ads: change a status",
  "tiktok_ads.update_budget": "TikTok Ads: change a daily budget",
};

function buildTiktokAdsCard(input: InlineDecisionInput): ThreadEventBody<"decision"> | null {
  const b = asObj(input.body);
  let title = TIKTOK_ADS_CARD_TITLES[input.decision_class];
  if (input.decision_class === "tiktok_ads.set_status") {
    const noun = b.level === "ad_group" ? "an ad group" : b.level === "ad" ? "an ad" : "a campaign";
    if (b.status === "PAUSED") title = `TikTok Ads: pause ${noun}`;
    else if (b.status === "ACTIVE") title = `TikTok Ads: turn ${noun} back on`;
    else return null;
  }
  const subject = str(b.object_id);
  return DecisionBodySchema.parse({
    decision_id: input.decision_id,
    decision_class: input.decision_class,
    title,
    summary: "Nothing changes in TikTok Ads until you approve.",
    ...(subject && /^[0-9]{1,32}$/.test(subject) ? { subject } : {}),
  }) as ThreadEventBody<"decision">;
}

const PLATFORM_NAME: Readonly<Record<string, string>> = { meta_ads: "Meta Ads", google_ads: "Google Ads" };

export function buildAdOrderCard(input: InlineDecisionInput): ThreadEventBody<"decision"> | null {
  const b = asObj(input.body);
  if (b.origin !== "user_initiated_chat" || Object.hasOwn(REVIEW_SIBLING, input.decision_class)) return null;
  const platform = PLATFORM_NAME[input.decision_class.split(".")[0]];
  if (!platform) return null;
  const name = str(b.name);
  return DecisionBodySchema.parse({
    decision_id: input.decision_id,
    decision_class: input.decision_class,
    title: (adChangeHeadline(input.decision_class, b) ?? `${platform}: ${name ?? "a change you asked for"}`).slice(0, 280),
    full_card: true,
  }) as ThreadEventBody<"decision">;
}

export function buildInlineDecisionBody(
  input: InlineDecisionInput,
): ThreadEventBody<"decision"> | null {
  if (isComposioDecisionClass(input.decision_class)) return buildComposioWriteCard(input);
  if (input.decision_class === "growth.save_business_controls") {
    return DecisionBodySchema.parse({ decision_id: input.decision_id, decision_class: input.decision_class, title: "Business results and experiments" }) as ThreadEventBody<"decision">;
  }
  if (isEmailCardClass(input.decision_class)) {
    return DecisionBodySchema.parse({ decision_id: input.decision_id, decision_class: input.decision_class, title: "Email to send" }) as ThreadEventBody<"decision">;
  }
  if (Object.hasOwn(X_ADS_CARD_TITLES, input.decision_class)) return buildXAdsCard(input);
  if (Object.hasOwn(TIKTOK_ADS_CARD_TITLES, input.decision_class)) return buildTiktokAdsCard(input);
  switch (input.decision_class) {
    case BUDGET_REVIEW_CLASS:
      return buildBudgetReviewCard(input);
    case ADVISORY_CLASS:
      return buildAdvisoryCard(input);
    default:
      return null;
  }
}

export type MaybeEmitInlineCardInput = {
  decision_id: string;
  decision_class: string;
  body: unknown;
  run_trigger: string;
  thread_id: string | null;
  agent_run_id: string;
  agent_slug: string;
  tenant_id: string;
  founder_chat_order?: boolean;
  founder_card_thread_id?: string | null;
  founder_card_agent_slug?: string | null;
  founder_card_run_id?: string | null;
};

export type MaybeEmitInlineCardDeps = {
  isSpendFlagOn: () => Promise<boolean>;
  isUrgentCardsFlagOn: () => Promise<boolean>;
  showInChat?: (decision_id: string) => Promise<{ shown: boolean }>;
  emit: (e: {
    agent_run_id: string;
    agent_slug: string;
    tenant_id: string;
    thread_id: string | null;
    kind: "decision";
    body: ThreadEventBody<"decision">;
  }) => Promise<void>;
  alreadyEmitted?: (decision_id: string) => Promise<boolean>;
  onFounderCardEmitted?: (decision_id: string) => void;
  decisionIsOpen?: (decision_id: string) => Promise<boolean>;
};

function isDuplicateCard(e: unknown): boolean {
  return /duplicate key|23505/.test((e as Error)?.message ?? "");
}

function isFounderAdOrder(input: Pick<MaybeEmitInlineCardInput, "decision_class" | "body" | "founder_chat_order">): boolean {
  return input.founder_chat_order === true && isMetaOrGoogleAdClass(input.decision_class) && asObj(input.body).origin === "user_initiated_chat";
}

async function isClassGateOpen(
  decision_class: string,
  deps: Pick<MaybeEmitInlineCardDeps, "isSpendFlagOn" | "isUrgentCardsFlagOn">,
): Promise<boolean> {
  if (decision_class === BUDGET_REVIEW_CLASS) {
    return deps.isSpendFlagOn();
  }
  if (decision_class === ADVISORY_CLASS) {
    return deps.isUrgentCardsFlagOn();
  }
  if (isComposioDecisionClass(decision_class)) return true;
  if (decision_class === "growth.save_business_controls" || isEmailCardClass(decision_class)) return true;
  if (Object.hasOwn(X_ADS_CARD_TITLES, decision_class)) return true;
  if (Object.hasOwn(TIKTOK_ADS_CARD_TITLES, decision_class)) return true;
  return deps.isUrgentCardsFlagOn();
}

export async function maybeEmitInlineConfirmCard(
  input: MaybeEmitInlineCardInput,
  deps: MaybeEmitInlineCardDeps,
): Promise<boolean> {
  const founderCard = isFounderAdOrder(input) && input.founder_card_thread_id ? buildAdOrderCard(input) : null;
  if (founderCard) {
    const log = (code: string) =>
      void logEvent({ level: "info", source: "build-inline-decision", code, tenant_id: input.tenant_id, run_id: input.agent_run_id, meta: { decision_class: input.decision_class } });
    if (deps.decisionIsOpen && !(await deps.decisionIsOpen(input.decision_id))) {
      log("founder_order.card_skipped_closed");
      return false;
    }
    if (deps.alreadyEmitted && (await deps.alreadyEmitted(input.decision_id))) {
      log("founder_order.card_duplicate_skipped");
      deps.onFounderCardEmitted?.(input.decision_id);
      return false;
    }
    try {
      await deps.emit({
        agent_run_id: input.founder_card_run_id ?? input.agent_run_id,
        agent_slug: input.founder_card_agent_slug ?? input.agent_slug,
        tenant_id: input.tenant_id,
        thread_id: input.founder_card_thread_id ?? null,
        kind: "decision",
        body: founderCard,
      });
    } catch (e) {
      if (!isDuplicateCard(e)) throw e;
      log("founder_order.card_duplicate_skipped");
      deps.onFounderCardEmitted?.(input.decision_id);
      return false;
    }
    log("founder_order.card_emitted");
    deps.onFounderCardEmitted?.(input.decision_id);
    return true;
  }
  if (input.run_trigger === "handoff") {
    if (!deps.showInChat || isMetaOrGoogleAdClass(input.decision_class)) return false;
    if (!(await isClassGateOpen(input.decision_class, deps))) return false;
    if (!buildInlineDecisionBody({ decision_id: input.decision_id, decision_class: input.decision_class, body: input.body })) return false;
    return (await deps.showInChat(input.decision_id)).shown;
  }
  if (input.run_trigger !== "chat" || !input.thread_id) return false;
  if (!(await isClassGateOpen(input.decision_class, deps))) return false;
  const card = buildInlineDecisionBody({
    decision_id: input.decision_id,
    decision_class: input.decision_class,
    body: input.body,
  });
  if (!card) return false;
  await deps.emit({
    agent_run_id: input.agent_run_id,
    agent_slug: input.agent_slug,
    tenant_id: input.tenant_id,
    thread_id: input.thread_id,
    kind: "decision",
    body: card,
  });
  return true;
}
