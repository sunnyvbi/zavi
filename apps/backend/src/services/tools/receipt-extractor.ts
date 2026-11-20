
import type { ToolReceipt } from "./types";

function parse(content: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(content);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

const STRIPE_OK = new Set(["succeeded", "already_collected"]);

function stripePaymentSucceeded(body: Record<string, unknown>): boolean {
  const status = str(body.status)?.toLowerCase();
  if (status) return STRIPE_OK.has(status);
  return false;
}

function family(name: string): string {
  const base = name.replace(/^pipedream_/, "");
  return base.split("__")[0] ?? "";
}

function baseToolName(name: string): string {
  const base = name.replace(/^pipedream_/, "");
  const idx = base.indexOf("__");
  return idx >= 0 ? base.slice(idx + 2) : base;
}

const META_BARE_ID_IS_AD_SET = new Set(["create_ad_set", "update_ad_set_budget"]);

export function extractReceipts(
  toolName: string,
  resultContent: string,
): ToolReceipt[] | undefined {
  if (typeof toolName !== "string" || typeof resultContent !== "string") {
    return undefined;
  }
  const body = parse(resultContent);
  if (!body) return undefined;
  const fam = family(toolName);
  const receipts: ToolReceipt[] = [];

  if (fam === "slack") {
    const ts = str(body.ts) ?? str(body.message_ts);
    const permalink = str(body.permalink);
    if (ts || permalink) {
      receipts.push({
        type: "slack_message",
        label: ts ? `Slack message ${ts}` : "Slack message",
        url: permalink,
      });
    }
  } else if (fam === "github") {
    const number = str(body.number) ?? str(body.pr_number);
    const url = str(body.html_url) ?? str(body.url);
    if (number || url) {
      receipts.push({
        type: "github_pr",
        label: number ? `PR #${number}` : "GitHub PR",
        url,
      });
    }
  } else if (fam === "stripe") {
    const pi = str(body.payment_intent_id) ?? str(body.charge_id);
    if (pi && stripePaymentSucceeded(body)) {
      receipts.push({ type: "stripe_payment", label: `Payment ${pi}` });
    }
  } else if (fam === "meta_ads" || fam === "meta") {
    const adSet =
      (META_BARE_ID_IS_AD_SET.has(baseToolName(toolName)) ? str(body.id) : undefined) ??
      str(body.ad_set_id) ??
      str(body.adset_id);
    const explicitlyFailed = body.success === false || body.ok === false;
    if (adSet && !explicitlyFailed) {
      receipts.push({ type: "meta_ad_set", label: `Ad set ${adSet}` });
    }
  } else if (fam === "jira") {
    const key = str(body.key) ?? str(body.issue_key);
    const url = str(body.url) ?? str(body.self);
    if (key) receipts.push({ type: "jira_issue", label: key, url });
  } else if (fam === "linear") {
    const id = str(body.identifier) ?? str(body.id);
    const url = str(body.url);
    if (id) receipts.push({ type: "linear_issue", label: id, url });
  }

  return receipts.length > 0 ? receipts : undefined;
}
