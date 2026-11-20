
import { exactActionFields } from "./exactActionFields";
import { adCurrencySymbol } from "@/lib/adCurrency";
import { decisionTitle, handlerPreview } from "@/app/approvals/approvalsHelpers";
import { isXAdsClass, xAdsAction, xAdsDailyStake, xAdsFields } from "@/app/approvals/xAdsDecision";
import { isTiktokAdsClass, tiktokAdsAction, tiktokAdsDailyStake, tiktokAdsFields } from "@/app/approvals/tiktokAdsDecision";
import { adChangeHeadline } from "@zavi/shared";

export type ChipTone = "good" | "bad" | "warn" | "neutral";
export type ProposalChip = { label: string; tone: ChipTone };

export type ProposalView = {
  action: string;
  target: string | null;
  about: string | null;
  chips: ProposalChip[];
  lead: string | null;
  full: string | null;
  markdown: string | null;
  fields: ProposalField[];
};

export type ProposalField = { label: string; value: string };

function canon(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])]));
  }
  return x;
}

function fieldValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "(empty)";
  const json = JSON.stringify(canon(v));
  return json === undefined ? "(empty)" : json;
}

function composioAdAccountField(b: Record<string, unknown>, args: Record<string, unknown>): ProposalField | null {
  const id = typeof args.advertiser_id === "string" ? args.advertiser_id : null;
  if (!id) return null;
  const a = b.ad_account && typeof b.ad_account === "object" ? (b.ad_account as Record<string, unknown>) : null;
  const name = a && a.advertiser_id === id ? str(a.name) : null;
  return { label: "Ad account", value: name && name !== id ? `${name} (ID ${id})` : `ID ${id}` };
}

export function isComposioWriteProposal(handler: string | null, b: Record<string, unknown>): boolean {
  return handler === "composio.execute_tool" && b.kind === "composio_write";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function usd(n: number): string {
  const r = Math.round(n);
  return `$${Math.abs(r).toLocaleString()}`;
}

export function extractRoas(text: string | null): number | null {
  if (!text) return null;
  const patterns = [
    /(\d+(?:\.\d+)?)\s*[×x]\s*roas/i,
    /roas\s*(?:of|is|at|=|:)?\s*(\d+(?:\.\d+)?)\s*[×x]?/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const val = parseFloat(m[1]);
      if (Number.isFinite(val) && val >= 0 && val <= 1000) return val;
    }
  }
  return null;
}

export function extractPurchaseN(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(/\bn\s*=\s*(\d+)\b|\b(\d+)\s+purchases?\b/i);
  if (!m) return null;
  const val = parseInt(m[1] ?? m[2], 10);
  if (Number.isFinite(val) && val >= 0 && val <= 100000) return val;
  return null;
}

const MIN_PURCHASES_FOR_CONFIDENT_RAISE = 10;
const MAX_RAISE_STEP_PCT = 0.3;
const MIN_RAISE_STEP_ABS_USD = 10;

export function firstSentence(text: string | null, max = 150): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const m = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  let lead = (m ? m[0] : trimmed).trim();
  if (lead.length > max) lead = lead.slice(0, max - 1).trimEnd() + "…";
  return lead || null;
}

const BLAST_TONE: Record<string, ChipTone> = {
  GREEN: "good",
  YELLOW: "warn",
  ORANGE: "warn",
  RED: "bad",
};

function asTarget(handler: string | null, body: Record<string, unknown>): string | null {
  const p = handlerPreview(handler, body);
  return p ? p.replace(/^→\s*/, "") : null;
}

function metaNoun(level: unknown): string {
  return level === "campaign" ? "campaign" : "ad set";
}

function actionPhrase(
  decisionClass: string,
  handler: string | null,
  b: Record<string, unknown>,
): string {
  const adTitle = adChangeHeadline(decisionClass, b);
  if (adTitle) return adTitle;
  if (isXAdsClass(decisionClass)) return xAdsAction(decisionClass, b) ?? "Review this change";
  if (isTiktokAdsClass(decisionClass)) return tiktokAdsAction(decisionClass, b) ?? "Review this change";
  switch (handler) {
    case "meta_ads.set_status":
    case "meta_ads.set_status_review":
      return `${b.status === "PAUSED" ? "Pause" : "Resume"} this ${metaNoun(b.level)}`;
    case "meta_ads.update_ad_set_budget":
    case "meta_ads.update_ad_set_budget_review":
    case "meta_ads.update_campaign_budget":
    case "meta_ads.update_campaign_budget_review": {
      const to = num(b.daily_budget_usd);
      const from = num(b.expected_current_daily_budget_usd);
      if (to !== null && from !== null) {
        if (to > from) return "Raise daily budget";
        if (to < from) return "Lower daily budget";
      }
      return "Adjust daily budget";
    }
    case "meta_ads.create_ad_set":
      return "Launch a new ad set";
    case "meta_ads.create_campaign":
      return "Create a new campaign";
    case "meta_ads.launch_campaign":
      return "Launch a new campaign";
    case "meta_ads.update_campaign":
      return "Change campaign settings";
    case "meta_ads.delete_campaign":
      return "Delete this campaign";
    case "meta_ads.update_ad_set":
      return "Change ad set settings";
    case "meta_ads.update_ad":
      return b.status === "PAUSED" ? "Pause this ad" : "Change this ad";
    case "meta_ads.duplicate_ad":
      return "Copy this ad";
    case "meta_ads.create_creative":
      return "Create a creative";
    case "meta_ads.update_creative":
      return "Rename a creative";
    case "meta_ads.upload_asset":
      return "Upload to the ad account";
    case "meta_ads.create_lookalike_audience":
      return "Build a lookalike audience";
    case "meta_ads.create_custom_conversion":
      return "Create a custom conversion";
    case "meta_ads.create_lead_form":
      return "Create a lead form";
    case "github.open_pr":
      return "Open a pull request";
    case "github.merge_pr":
      return "Merge a pull request";
    case "github.request_changes":
      return "Request changes on a PR";
    case "github.post_review":
      return "Post a PR review";
    case "gmail.send":
    case "email.send":
      return "Send an email";
    case "slack.post_message":
      return "Post to Slack";
    case "jira.create_issue":
      return "File a Jira issue";
    case "jira.add_comment":
      return "Comment on a Jira issue";
    case "linear.create_issue":
      return "File a Linear issue";
    case "stripe.refund":
      return "Issue a refund";
    case "outbound.send":
      return "Send outbound message";
    case "email_campaign.create_and_send":
      return "Send an email to a list";
    case "social.publish":
      return "Publish a social post";
    case "hiring.publish_role":
      return "Publish a role";
    default: {
      const { verbLabel } = decisionTitle(decisionClass, b);
      return verbLabel || "Review this change";
    }
  }
}

type DecisionEvidence = {
  reason_text?: unknown;
  blast_radius?: unknown;
  confidence?: unknown;
};

export function parseProposalView(
  decisionClass: string,
  handler: string | null,
  rawBody: Record<string, unknown> | null | undefined,
): ProposalView {
  const b: Record<string, unknown> =
    rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {};

  const rationale = str(b.rationale);
  const markdown = str(b.rendered_markdown);
  const ev =
    b.decision_evidence && typeof b.decision_evidence === "object"
      ? (b.decision_evidence as DecisionEvidence)
      : null;
  const reason = ev ? str(ev.reason_text) : null;

  const reasoning = reason ?? rationale;
  const lead = firstSentence(reasoning);
  const full =
    rationale && rationale.trim() !== (lead ?? "").replace(/…$/, "").trim()
      ? rationale
      : reason && reason.trim() !== (lead ?? "").replace(/…$/, "").trim()
        ? reason
        : null;

  const chips: ProposalChip[] = [];

  const to = num(b.daily_budget_usd);
  const from = num(b.expected_current_daily_budget_usd);
  if (
    isMetaBudgetHandler(handler) &&
    to !== null &&
    from !== null
  ) {
    const delta = to - from;
    const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
    const sym = adCurrencySymbol(b.currency);
    const amount = sym === "$" ? usd(delta) : `${sym}${Math.abs(Math.round(delta)).toLocaleString("en-IN")}`;
    chips.push({ label: `${sign}${amount}/day`, tone: "neutral" });

    if (delta > 0) {
      if (delta > from * MAX_RAISE_STEP_PCT && delta > MIN_RAISE_STEP_ABS_USD) {
        chips.push({ label: ">30% step", tone: "warn" });
      }
      const n = extractPurchaseN(reasoning);
      chips.push(
        n !== null && n >= MIN_PURCHASES_FOR_CONFIDENT_RAISE
          ? { label: "high-confidence", tone: "good" }
          : { label: "speculative-test", tone: "warn" },
      );
    }
  }

  const xAds = isXAdsClass(decisionClass);
  const tiktokAds = isTiktokAdsClass(decisionClass);
  const stake = xAds ? xAdsDailyStake(decisionClass, b) : tiktokAds ? tiktokAdsDailyStake(decisionClass, b) : null;
  if (stake) chips.push({ label: stake, tone: "neutral" });

  const roas = extractRoas(reasoning);
  if (roas !== null) {
    chips.push({ label: `${roas}× ROAS`, tone: roas >= 1 ? "good" : "bad" });
  }

  if (ev) {
    const blast = typeof ev.blast_radius === "string" ? ev.blast_radius : null;
    if (blast && BLAST_TONE[blast]) {
      chips.push({ label: blast.toLowerCase(), tone: BLAST_TONE[blast] });
    }
    const conf = num(ev.confidence);
    if (conf !== null) {
      chips.push({ label: `${Math.round(conf * 100)}% sure`, tone: "neutral" });
    }
  }

  const composio = isComposioWriteProposal(handler, b);
  let fields: ProposalField[] = [];
  if (composio) {
    const labels = Array.isArray(b.labels) ? b.labels : [];
    if (labels.includes("deletes_data")) chips.unshift({ label: "Deletes data", tone: "bad" });
    if (labels.includes("moves_money")) chips.unshift({ label: "Moves money", tone: "bad" });
    const args =
      b.arguments && typeof b.arguments === "object" && !Array.isArray(b.arguments)
        ? (b.arguments as Record<string, unknown>)
        : {};
    fields = Object.keys(args).map((label) => ({ label, value: fieldValue(args[label]) }));
    const adAccount = b.ad_account ? composioAdAccountField(b, args) : null;
    if (adAccount) fields = [adAccount, ...fields.filter((f) => f.label !== "advertiser_id")];
  }
  if (!composio && (handler === "gmail.send" || handler === "email.send" || decisionClass === "send_email")) {
    const to = str(b.to);
    const subject = str(b.subject);
    const message = str(b.body_text);
    if (to || subject || message) {
      const replyTo = str(b.reply_to);
      fields = [
        { label: "To", value: to ?? "(empty)" },
        ...(replyTo ? [{ label: "Reply-To", value: replyTo }] : []),
        { label: "Subject", value: subject ?? "(empty)" },
        { label: "Message", value: message ?? "(empty)" },
      ];
    }
  }

  if (xAds && fields.length === 0) fields = xAdsFields(b);
  if (tiktokAds && fields.length === 0) fields = tiktokAdsFields(decisionClass, b);

  if (!composio && fields.length === 0) {
    const exact = exactActionFields(decisionClass, b);
    if (exact) {
      fields = exact;
      if (decisionClass === "stripe.create_payment" || decisionClass === "stripe.remit_to_tenant") {
        chips.unshift({ label: "Moves money", tone: "bad" });
      }
    }
  }

  return {
    action: composio
      ? `${str(b.app_name) ?? "App"}: ${str(b.action) ?? str(b.tool_slug) ?? "write"}`
      : actionPhrase(decisionClass, handler, b),
    target: composio ? null : asTarget(handler ?? (xAds || tiktokAds ? decisionClass : null), b),
    about: str(b.about) ?? (xAds ? str(b.summary) : null),
    chips,
    lead,
    full,
    markdown,
    fields,
  };
}

export function modifyPlaceholder(
  decisionClass: string,
  handler: string | null,
  body: Record<string, unknown>,
): string {
  const v = parseProposalView(decisionClass, handler, body);
  const action = v.action.toLowerCase();
  if (isMetaBudgetHandler(handler)) {
    const to = num(body.daily_budget_usd);
    if (action.includes("raise")) {
      return `Example: raise to ${to ? `${adCurrencySymbol(body.currency)}${Math.max(1, Math.round(to * 0.7))}/day` : "a smaller amount"} instead`;
    }
    return "Example: cut less aggressively and monitor for 3 days";
  }
  if (handler?.startsWith("meta_ads.set_status")) {
    return "Example: don't pause yet; lower budget and monitor for 3 days";
  }
  if (handler === "meta_ads.create_ad_set") {
    return "Example: launch this with $20/day and a narrower audience";
  }
  return "Tell the agent what you want changed before approving";
}

export function modifyQuickReplies(
  decisionClass: string,
  handler: string | null,
  body: Record<string, unknown>,
): string[] {
  const v = parseProposalView(decisionClass, handler, body);
  const action = v.action.toLowerCase();
  if (isMetaBudgetHandler(handler)) {
    return action.includes("raise")
      ? ["Raise less", "Delay 3 days", "Cap at current", "Ask why"]
      : ["Cut less", "Pause instead", "Delay 3 days", "Ask why"];
  }
  if (handler?.startsWith("meta_ads.set_status")) {
    return ["Lower budget instead", "Delay 3 days", "Ask why", "Reject and monitor"];
  }
  if (handler === "meta_ads.create_ad_set") {
    return ["Lower launch budget", "Narrow audience", "Delay launch", "Ask why"];
  }
  return ["Ask why", "Make safer", "Delay", "Reject"];
}

export function isMetaBudgetHandler(handler: string | null | undefined): boolean {
  return (
    !!handler &&
    (handler.startsWith("meta_ads.update_ad_set_budget") || handler.startsWith("meta_ads.update_campaign_budget"))
  );
}
