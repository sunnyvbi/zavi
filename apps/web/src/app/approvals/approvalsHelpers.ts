import { agentDisplayName } from "@/lib/agentRegistry";
import { isXAdsClass, xAdsPreview } from "./xAdsDecision";
import { isTiktokAdsClass, tiktokAdsPreview } from "./tiktokAdsDecision";
import { adCurrencySymbol } from "@/lib/adCurrency";
import { isEmailCampaignSendCard } from "@/components/agents/exactActionFields";
import { needsFullCard } from "./approvalExtras";
export { needsFullCard, approveExtrasFor } from "./approvalExtras";

export function formatScheduledAt(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function expectedScheduledAtFor(picked: boolean, loaded: string | null): string | null | undefined {
  return picked ? undefined : loaded;
}

export function loadedScheduleGuard(d: {
  decision_class: string;
  body: Record<string, unknown> | null | undefined;
}): { expectedScheduledAt?: string | null } {
  if (d.decision_class !== "social.publish.v2") return {};
  const at = d.body?.scheduled_at;
  return { expectedScheduledAt: typeof at === "string" ? at : null };
}

export function scheduleMovedNotice(current: string | null): string {
  const when = formatScheduledAt(current);
  return when
    ? `This was moved to ${when}. Approve again?`
    : "This was changed to publish when approved. Approve again?";
}

const AGENT_LABELS: Record<string, string> = {
  "channel": "Growth channel",
  "engineer": "CTO engineer",
  "qa": "QA engineer",
  "pm": "Product PM",
  "support-lead": "Support Lead",
  "dispute-response": "Dispute response",
  "performance-marketer": "Ads Manager",
  "chief-of-staff": "Chief of staff",
  "growth-lead": "Head of Growth",
  operator: "Operator",
  x_ads: "X Ads",
  tiktok_ads: "TikTok Ads",
  linkedin_ads: "LinkedIn Ads",
  youtube_ads: "YouTube Ads",
};

const VERB_LABELS: Record<string, string> = {
  action: "Action",
  "submit-evidence": "Submit evidence",
  "ship-pr": "Ship PR",
  "open-pr": "Open PR",
  "post-review": "Post review",
  "merge-pr": "Merge PR",
  "request-changes": "Request changes",
  "reallocate-budget": "Reallocate budget",
  notify: "Notify",
  digest: "Digest",
  "file-jira-issue": "File Jira issue",
  "file-linear-issue": "File Linear issue",
  "weekly-plan": "Weekly plan",
  suggestion: "Growth recommendation",
  "daily-digest": "Daily digest",
  "weekly-report": "Weekly report",
  "weekly-digest": "Weekly digest",
  "draft-pr": "Draft PR",
  "send-reply": "Send reply",
  morning: "Morning brief",
  "finalize-application": "Finalize application",
  "draft-sequence": "Draft sequence",
  "draft-ticket": "Draft ticket",
  triage: "Triage",
  backlog: "Backlog",
  audit: "Audit",
  draft: "Draft",
  brief: "Brief",
  reply: "Reply",
  update_ad_set_budget: "Update ad-set budget",
  update_ad_set_budget_review: "Update ad-set budget (review)",
  set_status: "Set status",
  set_status_review: "Set status (review)",
  create_ad_set: "Create ad set",
  update_campaign_budget: "Update campaign budget",
  update_campaign_budget_review: "Update campaign budget (review)",
  create_campaign: "Create campaign",
  update_campaign: "Update campaign settings",
  delete_campaign: "Delete campaign",
  update_ad_set: "Update ad set settings",
  update_ad: "Update ad",
  duplicate_ad: "Copy ad",
  create_creative: "Create creative",
  update_creative: "Rename creative",
  upload_asset: "Upload to ad account",
  create_lookalike_audience: "Build lookalike audience",
  create_custom_conversion: "Create custom conversion",
  create_lead_form: "Create lead form",
  create_ad_group: "Create ad group",
  update_ad_group: "Update ad group",
  create_ad: "Create ad",
  add_keywords: "Add keywords",
  remove_resource: "Remove",
  create_campaign_bundle: "Launch campaign (created paused)",
};

function kebabCap(s: string): string {
  return s
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function kebabSentence(s: string): string {
  const spaced = s.replace(/[-_]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const CLASS_TITLES: Record<string, { agentLabel: string; verbLabel: string }> = {
  "email_campaign.create_and_send": { agentLabel: "Email campaign", verbLabel: "Send to a list" },
};

export function decisionTitle(decisionClass: string, body?: unknown): {
  agentLabel: string;
  verbLabel: string;
} {
  if (decisionClass === "bulk_outbound.send") {
    return {
      agentLabel: "Bulk email",
      verbLabel:
        body === undefined || body === null
          ? "To a contact list"
          : isBulkListSend(body)
            ? "Send to a contact list"
            : "Draft (not sent)",
    };
  }
  const fixed = CLASS_TITLES[decisionClass];
  if (fixed) return { ...fixed };
  const [agentSlug = "", verbSlug = ""] = decisionClass.split(".");
  return {
    agentLabel: AGENT_LABELS[agentSlug] ?? kebabCap(agentSlug || "Unknown"),
    verbLabel: verbSlug
      ? VERB_LABELS[verbSlug] ?? kebabSentence(verbSlug)
      : "",
  };
}

export function agentLabelForSlug(slug: unknown): string {
  const s = typeof slug === "string" ? slug.trim() : "";
  if (!s) return "the specialist";
  return AGENT_LABELS[s] ?? agentDisplayName(s);
}

export function dispatchCardHeadline(body: Record<string, unknown>): {
  headline: string;
  targetLabel: string;
} | null {
  const b = body ?? {};
  const raw = typeof b.intent === "string" ? b.intent.trim() : "";
  if (!raw) return null;

  const firstLine =
    raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  if (!firstLine) return null;

  const sentenceEnd = firstLine.search(/[.!?](\s|$)/);
  const firstSentence =
    sentenceEnd >= 24 ? firstLine.slice(0, sentenceEnd + 1) : firstLine;

  return {
    headline: truncateOnWord(firstSentence, 110),
    targetLabel: agentLabelForSlug(b.target_agent_slug),
  };
}

function truncateOnWord(s: string, max: number): string {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  const hard = cps.slice(0, max).join("");
  const lastSpace = hard.lastIndexOf(" ");
  const cut = lastSpace >= max * 0.6 ? hard.slice(0, lastSpace) : hard;
  return `${cut.replace(/[\s,;:]+$/, "")}…`;
}

function safeTruncate(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const cps = Array.from(value);
  if (cps.length <= max) return value;
  return cps.slice(0, max).join("") + "…";
}

function formatRecipients(to: unknown): string {
  if (typeof to === "string" && to.trim()) return to;
  if (Array.isArray(to)) {
    const parts = to.filter((x): x is string => typeof x === "string");
    if (parts.length === 0) return "-";
    if (parts.length <= 2) return parts.join(", ");
    return `${parts[0]} +${parts.length - 1} more`;
  }
  return "-";
}

function formatMoney(amount: unknown, currency: unknown): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "?";
  const cur =
    typeof currency === "string" && currency.trim()
      ? currency.toUpperCase()
      : "USD";
  const major = (amount / 100).toFixed(2);
  return cur === "USD" ? `$${major}` : `${major} ${cur}`;
}

function scalar(v: unknown, fallback = "-"): string {
  if (typeof v === "string") return v.trim() || fallback;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return fallback;
}

export function handlerPreview(
  handler: string | null,
  body: Record<string, unknown>,
): string | null {
  if (!handler) return null;
  const b = body ?? {};
  if (isXAdsClass(handler)) return xAdsPreview(handler, b);
  if (isTiktokAdsClass(handler)) return tiktokAdsPreview(handler, b);
  switch (handler) {
    case "composio.execute_tool":
      return `→ ${scalar(b.app_name)} · ${scalar(b.action)}`;
    case "slack.post_message":
      return `→ Slack · #${scalar(b.channel_id)} · ${
        typeof b.text === "string" && b.text ? safeTruncate(b.text, 60) : "-"
      }`;
    case "gmail.send":
      return `→ Gmail · to ${formatRecipients(b.to)} · "${safeTruncate(
        b.subject,
        60,
      )}"`;
    case "stripe.refund":
      return `→ Stripe refund · ${formatMoney(b.amount, b.currency)} on \`${scalar(
        b.charge_id,
      )}\``;
    case "github.open_pr":
      return `→ GitHub · ${scalar(b.repo)} (${scalar(b.head_branch)} → ${scalar(
        b.base_branch,
      )})`;
    case "github.merge_pr":
      return `→ GitHub · ${scalar(b.owner, "?")}/${scalar(
        b.repo,
        "?",
      )}#${scalar(b.pull_number, "?")} squash-merge`;
    case "github.post_review":
      return `→ GitHub · ${scalar(b.owner, "?")}/${scalar(
        b.repo,
        "?",
      )}#${scalar(b.pull_number, "?")} review (${scalar(b.event, "COMMENT")})`;
    case "github.request_changes":
      return `→ GitHub · ${scalar(b.owner, "?")}/${scalar(
        b.repo,
        "?",
      )}#${scalar(b.pull_number, "?")} request changes`;
    case "jira.create_issue":
      return `→ Jira · ${scalar(b.project_key)} · "${safeTruncate(
        b.summary,
        60,
      )}"`;
    case "jira.add_comment":
      return `→ Jira · comment on ${scalar(b.issue_key)}`;
    case "linear.create_issue":
      return `→ Linear · "${safeTruncate(b.title, 60)}"`;
    case "linear.add_comment":
      return `→ Linear · comment on ${scalar(b.issue_id)}`;
    case "hiring.publish_role":
      return `→ Hiring · publish role ${scalar(b.role_id)}`;
    case "hiring.finalize_application":
      return `→ Hiring · finalize application ${scalar(b.application_id)}`;
    case "praxis.bake_rule":
      return `→ Zavi · bake rule for ${scalar(b.target_agent_slug)}`;
    case "praxis.propose_global":
      return `→ Zavi · propose global rule`;
    case "praxis.dispatch_specialist": {
      const to = scalar(b.target_agent_slug, "specialist");
      const intent =
        typeof b.intent === "string" && b.intent.trim()
          ? safeTruncate(b.intent, 120)
          : "start on this work";
      return `→ ${to} · ${intent}`;
    }
    case "pm.needs_action": {
      const count =
        typeof b.affected_count === "number" && Number.isFinite(b.affected_count)
          ? b.affected_count
          : null;
      if (b.stuck_rollup === true) {
        const n = count ?? 0;
        return `→ ${n} fix${n === 1 ? "" : "es"} stuck in review`;
      }
      if (b.coalesced === true) {
        const n = count ?? 0;
        return `→ ${n} item${n === 1 ? "" : "s"} blocked by infrastructure`;
      }
      const theme =
        typeof b.theme === "string" && b.theme.trim()
          ? safeTruncate(b.theme, 100)
          : "a roadmap item";
      const kind =
        typeof b.exception_kind === "string" ? NEEDS_ACTION_KIND_SHORT[b.exception_kind] ?? null : null;
      return kind ? `→ ${theme} · ${kind}` : `→ ${theme}`;
    }
    case "digest.post": {
      const t1 = Array.isArray(b.tier1) ? b.tier1 : [];
      const first = t1[0] as { title?: unknown } | undefined;
      const head =
        first && typeof first.title === "string" && first.title.trim()
          ? safeTruncate(first.title, 90)
          : null;
      if (!head) return `→ Daily digest`;
      const more = t1.length > 1 ? ` +${t1.length - 1} more` : "";
      return `→ Digest · ${head}${more}`;
    }
    case "autopilot.daily_plan_approve":
      return `→ ${
        typeof b.objective === "string" && b.objective.trim()
          ? safeTruncate(b.objective, 120)
          : "today's autopilot plan"
      }`;
    case "memory.write_meeting_atoms": {
      const n = Array.isArray(b.atoms) ? b.atoms.length : 0;
      const title =
        typeof b.title === "string" && b.title.trim()
          ? safeTruncate(b.title, 70)
          : "a meeting";
      return n > 0
        ? `→ Save ${n} note${n === 1 ? "" : "s"} from "${title}"`
        : `→ Save notes from "${title}"`;
    }
    case "social.publish":
    case "social.publish.v2": {
      const channel =
        b.channel === "pinterest_pin"
          ? "Pinterest pin"
          : typeof b.channel === "string" && b.channel.trim()
            ? b.channel.charAt(0).toUpperCase() + b.channel.slice(1)
            : "social";
      const payload = (b.payload ?? {}) as { text?: unknown; title?: unknown };
      const isPin = b.channel === "pinterest_pin";
      const words = isPin && typeof payload.title === "string" && payload.title.trim() ? payload.title : payload.text;
      const text =
        typeof words === "string" && words.trim()
          ? safeTruncate(words.replace(/\s+/g, " "), 70)
          : null;
      const when = formatScheduledAt(b.scheduled_at);
      const head = text ? `→ ${channel} · "${text}"` : `→ ${channel} · ${isPin ? "post pin" : "publish post"}`;
      return when ? `${head} · ${when}` : head;
    }
    case "meta_ads.update_ad_set_budget":
    case "meta_ads.update_ad_set_budget_review":
    case "meta_ads.update_campaign_budget":
    case "meta_ads.update_campaign_budget_review": {
      const who =
        typeof b.name === "string" && b.name.trim()
          ? safeTruncate(b.name, 60)
          : handler.startsWith("meta_ads.update_campaign_budget")
            ? `campaign ${scalar(b.campaign_id)}`
            : `ad set ${scalar(b.ad_set_id)}`;
      const sym = adCurrencySymbol(b.currency);
      return `→ Meta · ${who} · ${sym}${scalar(
        b.expected_current_daily_budget_usd,
      )} → ${sym}${scalar(b.daily_budget_usd)}/day`;
    }
    case "meta_ads.set_status":
    case "meta_ads.set_status_review": {
      const who =
        typeof b.name === "string" && b.name.trim()
          ? safeTruncate(b.name, 60)
          : `${scalar(b.level)} ${scalar(b.object_id)}`;
      return `→ Meta · ${who}`;
    }
    case "meta_ads.create_ad_set": {
      const bid = metaNewAdSetBidPhrase(b, (n) => `${adCurrencySymbol(b.currency)}${Number.isInteger(n) ? n : n.toFixed(2)}`);
      return `→ Meta · create ad set "${safeTruncate(b.name, 50)}" in campaign ${scalar(
        b.campaign_id,
      )} (${adCurrencySymbol(b.currency)}${scalar(b.daily_budget_usd)}/day${bid ? `, ${bid}` : ""}, PAUSED)`;
    }
    case "google_ads.update_campaign_budget":
    case "google_ads.update_campaign_budget_review": {
      const who =
        typeof b.name === "string" && b.name.trim()
          ? safeTruncate(b.name, 60)
          : `campaign ${scalar(b.campaign_id)}`;
      return `→ Google · ${who} · $${scalar(
        b.expected_current_daily_budget_usd,
      )} → $${scalar(b.daily_budget_usd)}/day`;
    }
    case "google_ads.set_status":
    case "google_ads.set_status_review": {
      const level = typeof b.level === "string" ? b.level : "campaign";
      const id =
        level === "ad" ? b.ad_id : level === "ad_group" ? b.ad_group_id : b.campaign_id;
      const who =
        typeof b.name === "string" && b.name.trim()
          ? safeTruncate(b.name, 60)
          : `${level.replace("_", " ")} ${scalar(id)}`;
      return `→ Google · ${who}`;
    }
    case "google_ads.create_campaign":
      return `→ Google · create ${scalar(b.channel_type)} campaign "${safeTruncate(b.name, 50)}" ($${scalar(
        b.daily_budget_usd,
      )}/day, PAUSED)`;
    case "meta_ads.launch_campaign": {
      const c = (b.campaign ?? {}) as Record<string, unknown>;
      const who = typeof c.name === "string" && c.name.trim() ? safeTruncate(c.name, 60) : "new campaign";
      const budget = typeof c.daily_budget_usd === "number" ? ` · ${adCurrencySymbol(b.currency)}${c.daily_budget_usd}/day` : "";
      const s = (b.ad_set ?? {}) as Record<string, unknown>;
      const bid = metaNewAdSetBidPhrase({ bid_strategy: c.bid_strategy, bid_amount_usd: s.bid_amount_usd }, (n) => `${adCurrencySymbol(b.currency)}${Number.isInteger(n) ? n : n.toFixed(2)}`);
      return `→ Meta · launch ${who} · goes live${budget}${bid ? ` · ${bid}` : ""}`;
    }
    case "meta_ads.create_campaign": {
      const who = typeof b.name === "string" && b.name.trim() ? safeTruncate(b.name, 60) : "new campaign";
      const budget = typeof b.daily_budget_usd === "number" ? ` · ${adCurrencySymbol(b.currency)}${b.daily_budget_usd}/day on the campaign` : "";
      return `→ Meta · ${who} · paused${budget}`;
    }
    case "meta_ads.update_campaign": {
      const who =
        typeof b.name === "string" && b.name.trim() ? safeTruncate(b.name, 60) : `campaign ${scalar(b.campaign_id)}`;
      const parts: string[] = [];
      if (typeof b.new_name === "string" && b.new_name.trim()) parts.push(`rename to "${safeTruncate(b.new_name, 40)}"`);
      if (b.spend_cap_usd === null) parts.push("remove spend cap");
      else if (typeof b.spend_cap_usd === "number") parts.push(`spend cap ${adCurrencySymbol(b.currency)}${b.spend_cap_usd}`);
      if (typeof b.bid_strategy === "string") parts.push(`bid strategy ${b.bid_strategy}`);
      if (Array.isArray(b.special_ad_categories)) parts.push(`special ad category ${b.special_ad_categories.length ? b.special_ad_categories.join(", ") : "none"}`);
      return `→ Meta · ${who}${parts.length ? ` · ${parts.join(", ")}` : ""}`;
    }
    case "meta_ads.update_ad_set": {
      const who =
        typeof b.name === "string" && b.name.trim() ? safeTruncate(b.name, 60) : `ad set ${scalar(b.ad_set_id)}`;
      const parts: string[] = [];
      if (typeof b.new_name === "string" && b.new_name.trim()) parts.push(`rename to "${safeTruncate(b.new_name, 40)}"`);
      if (typeof b.end_time === "string") parts.push(`end ${b.end_time.slice(0, 10)}`);
      if (typeof b.bid_strategy === "string") parts.push(`bid strategy ${b.bid_strategy}`);
      if (typeof b.bid_amount_usd === "number") parts.push(`bid ${adCurrencySymbol(b.currency)}${b.bid_amount_usd}`);
      if (b.targeting_patch && typeof b.targeting_patch === "object") parts.push(`targeting ${Object.keys(b.targeting_patch).join(", ")}`);
      return `→ Meta · ${who}${parts.length ? ` · ${parts.join(", ")}` : ""}`;
    }
    case "meta_ads.update_ad": {
      const who = typeof b.name === "string" && b.name.trim() ? safeTruncate(b.name, 60) : `ad ${scalar(b.ad_id)}`;
      const parts: string[] = [];
      if (typeof b.new_name === "string" && b.new_name.trim()) parts.push(`rename to "${safeTruncate(b.new_name, 40)}"`);
      if (typeof b.creative_id === "string") parts.push(`creative ${b.creative_id}`);
      if (b.status === "PAUSED") parts.push("pause");
      if (b.status === "ACTIVE") parts.push("turn on");
      return `→ Meta · ${who}${parts.length ? ` · ${parts.join(", ")}` : ""}`;
    }
    case "meta_ads.create_lead_form":
      return `→ Meta · lead form "${typeof b.name === "string" ? safeTruncate(b.name, 50) : ""}" on ${typeof b.page_name === "string" ? safeTruncate(b.page_name, 40) : `Page ${scalar(b.page_id)}`}`;
    case "meta_ads.create_lookalike_audience":
      return `→ Meta · lookalike ${typeof b.ratio === "number" ? `${Math.round(b.ratio * 100)}%` : ""} ${scalar(b.country)} of audience ${scalar(b.origin_audience_id)}`;
    case "meta_ads.create_custom_conversion":
      return `→ Meta · conversion "${typeof b.name === "string" ? safeTruncate(b.name, 50) : ""}" · page contains "${typeof b.url_contains === "string" ? safeTruncate(b.url_contains, 40) : ""}"`;
    case "meta_ads.create_creative":
      return `→ Meta · creative ${typeof b.name === "string" ? `"${safeTruncate(b.name, 50)}"` : ""} · runs nowhere until used`;
    case "meta_ads.update_creative":
      return `→ Meta · creative ${scalar(b.creative_id)} · rename to "${typeof b.new_name === "string" ? safeTruncate(b.new_name, 40) : ""}"`;
    case "meta_ads.upload_asset":
      return `→ Meta · ${scalar(b.kind)} "${typeof b.name === "string" ? safeTruncate(b.name, 50) : ""}" into the ad account`;
    case "meta_ads.duplicate_ad":
      return `→ Meta · copy ad ${scalar(b.source_ad_id)} into ad set ${scalar(b.ad_set_id)} · on`;
    case "meta_ads.delete_campaign": {
      const who =
        typeof b.name === "string" && b.name.trim() ? safeTruncate(b.name, 60) : `campaign ${scalar(b.campaign_id)}`;
      return `→ Meta · ${who} · delete (cannot be undone)`;
    }
    case "google_ads.update_campaign": {
      const who =
        typeof b.name === "string" && b.name.trim()
          ? safeTruncate(b.name, 60)
          : `campaign ${scalar(b.campaign_id)}`;
      const parts: string[] = [];
      if (typeof b.new_name === "string" && b.new_name.trim()) parts.push(`rename to "${safeTruncate(b.new_name, 40)}"`);
      if (typeof b.target_cpa_usd === "number") parts.push(`target CPA $${b.target_cpa_usd}`);
      if (typeof b.target_roas === "number") parts.push(`target ROAS ${b.target_roas}x`);
      if (b.network && typeof b.network === "object") parts.push("network settings");
      return `→ Google · ${who}${parts.length ? ` · ${parts.join(", ")}` : ""}`;
    }
    case "google_ads.create_ad_group": {
      const keywords = Array.isArray(b.keywords) ? b.keywords.length : 0;
      const ads = Array.isArray(b.ads) ? b.ads.length : 0;
      return `→ Google · create ad group "${safeTruncate(b.name, 50)}" in campaign ${scalar(
        b.campaign_id,
      )} (${keywords} keywords, ${ads} ads, PAUSED)`;
    }
    case "google_ads.update_ad_group": {
      const who =
        typeof b.name === "string" && b.name.trim()
          ? safeTruncate(b.name, 60)
          : `ad group ${scalar(b.ad_group_id)}`;
      return `→ Google · ${who}`;
    }
    case "google_ads.create_ad": {
      const ad = b.ad && typeof b.ad === "object" ? (b.ad as { kind?: unknown }) : null;
      const kind = typeof ad?.kind === "string" ? ad.kind.replace(/_/g, " ") : "ad";
      return `→ Google · create ${kind} in ad group ${scalar(b.ad_group_id)} (PAUSED)`;
    }
    case "google_ads.add_keywords": {
      const count = Array.isArray(b.keywords) ? b.keywords.length : 0;
      const target =
        b.level === "campaign" ? `campaign ${scalar(b.campaign_id)}` : `ad group ${scalar(b.ad_group_id)}`;
      return `→ Google · ${count} ${b.negative === true ? "negative " : ""}keywords → ${target}`;
    }
    case "google_ads.remove_resource": {
      const level = typeof b.level === "string" ? b.level.replace("_", " ") : "resource";
      const who =
        typeof b.name === "string" && b.name.trim() ? safeTruncate(b.name, 60) : level;
      return `→ Google · remove ${who} (permanent)`;
    }
    case "linkedin_ads.set_status": {
      const who =
        typeof b.name === "string" && b.name.trim()
          ? safeTruncate(b.name, 60)
          : `campaign ${scalar(b.campaign_id)}`;
      return `→ LinkedIn · ${who}`;
    }
    case "linkedin_ads.create_campaign_bundle": {
      const who =
        typeof b.name === "string" && b.name.trim() ? `"${safeTruncate(b.name, 50)}"` : "campaign";
      const budget = b.daily_budget_usd != null ? ` ($${scalar(b.daily_budget_usd)}/day, PAUSED)` : " (PAUSED)";
      return `→ LinkedIn · create ${who}${budget}`;
    }
    default:
      return null;
  }
}

export function isAcknowledgeOnly(
  handler: string | null,
  body: Record<string, unknown>,
): boolean {
  if (handler === null && (body ?? {}).kind === "operator_db_unreachable") return true;
  if (handler !== "pm.needs_action") return false;
  const b = body ?? {};
  return b.stuck_rollup === true || b.coalesced === true || b.proposed_action === "none" || b.roadmap_id === null;
}

const NEEDS_ACTION_KIND_SHORT: Record<string, string> = {
  stuck: "fix stuck",
  failed_to_open: "engineer could not open a PR",
  recurred: "came back after a fix",
  dispatch_died: "engineer job crashed",
};
const NEEDS_ACTION_KIND_WHY: Record<string, string> = {
  stuck: "The engineer's fix never finished. Retry starts a fresh attempt.",
  failed_to_open: "The engineer could not open a PR for this. Retry starts a fresh attempt.",
  recurred: "This came back after it was fixed. Retry sends the engineer back to it.",
  dispatch_died: "The engineer job crashed before it produced anything. Retry starts it again.",
};

export function hasClosablePr(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const m = url.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1;
}

export function needsActionText(body: Record<string, unknown>): { title: string; why: string } {
  const b = body ?? {};
  const n = typeof b.affected_count === "number" && Number.isFinite(b.affected_count) ? b.affected_count : 0;
  if (b.stuck_rollup === true) {
    return {
      title: `${n} engineer ${n === 1 ? "fix is" : "fixes are"} stuck in review`,
      why: "Heads-up only. Open Product PM to see each one, or ask it or the engineer for status.",
    };
  }
  if (b.coalesced === true) {
    return {
      title: `${n} engineer ${n === 1 ? "job" : "jobs"} crashed before producing anything`,
      why: "Heads-up only. They retry on their own once the engineer can run again. Nothing for you to do.",
    };
  }
  const title = typeof b.theme === "string" && b.theme.trim() ? safeTruncate(b.theme, 140) : "A roadmap item needs a look";
  if (isAcknowledgeOnly("pm.needs_action", b)) return { title, why: "Heads-up only. There is nothing to retry." };
  if (b.exception_kind === "stuck" && hasClosablePr(b.pr_url)) {
    return { title, why: "The engineer's fix is stuck in review (PR open, not merged). Retry starts a fresh attempt and closes the old PR." };
  }
  const kind = typeof b.exception_kind === "string" ? NEEDS_ACTION_KIND_WHY[b.exception_kind] : undefined;
  return { title, why: kind ?? "Retry sends the engineer back to it." };
}

export function isHighStakesDecision(
  decisionClass: string,
  handler: string | null,
  body: Record<string, unknown>,
): boolean {
  if (handler === "stripe.refund") return true;
  if (needsFullCard(handler) || decisionClass.startsWith("composio.")) return true;
  if (
    decisionClass.startsWith("meta_ads.") ||
    decisionClass.startsWith("google_ads.") ||
    decisionClass.startsWith("x_ads.") ||
    decisionClass.startsWith("tiktok_ads.") ||
    decisionClass.startsWith("linkedin_ads.") ||
    decisionClass.startsWith("reddit_ads.") ||
    decisionClass.startsWith("chatgpt_ads.")
  ) {
    return true;
  }
  const ev = (body as { decision_evidence?: unknown })?.decision_evidence;
  if (ev && typeof ev === "object" && !Array.isArray(ev)) {
    if ((ev as { blast_radius?: unknown }).blast_radius === "RED") return true;
  }
  return false;
}

export function stakesClassOf(d: {
  decision_class: string;
  exec_class?: string | null;
}): string {
  return d.exec_class || d.decision_class;
}

export function daysOpen(emittedAt: string, now: number = Date.now()): number {
  const t = new Date(emittedAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

import { getChannel, isBulkListSend, isChannelSlug, metaNewAdSetBidPhrase } from "@zavi/shared";

export function refineTarget(agentSlug: string): { agent: string; seedPrefix: string } {
  if (isChannelSlug(agentSlug)) {
    const name = getChannel(agentSlug)?.name ?? agentSlug;
    return { agent: "operator", seedPrefix: `@${name} ` };
  }
  return { agent: agentSlug, seedPrefix: "" };
}

export function isExactActionCard(decisionClass: string, body: Record<string, unknown> | null | undefined): boolean {
  const b = body ?? {};
  if (b.governed_by === "chokepoint") return true;
  if (decisionClass === "bulk_outbound.send" && isBulkListSend(b)) return true;
  if (isEmailCampaignSendCard(decisionClass, b)) return true;
  return decisionClass === "send_email" && typeof b.to === "string" && typeof b.body_text === "string";
}

export function outcomeAppName(decisionClass: string, body: Record<string, unknown> | null | undefined): string {
  const app = body?.app_name;
  if (typeof app === "string" && app.trim()) return app;
  if (decisionClass.startsWith("stripe.") || decisionClass.startsWith("dispute-response.")) return "Stripe";
  if (decisionClass.startsWith("github.")) return "GitHub";
  if (decisionClass === "create_jira_issue" || decisionClass.startsWith("jira.")) return "Jira";
  if (decisionClass.startsWith("linear.")) return "Linear";
  if (decisionClass === "send_email" || decisionClass === "outbound.send") return "your email";
  if (decisionClass === "email_campaign.create_and_send") return body?.tool === "klaviyo" ? "Klaviyo" : body?.tool === "mailchimp" ? "Mailchimp" : body?.tool === "sendgrid" ? "SendGrid" : "your email tool";
  if (isXAdsClass(decisionClass)) return "X Ads";
  if (isTiktokAdsClass(decisionClass)) return "TikTok Ads";
  return "the app";
}

export const OUTCOME_UNKNOWN_AFTER_MS = 10 * 60 * 1000;

export function outcomeUnknownRows<
  T extends { handler: string | null; status?: string | null; dispatched_at?: string | null },
>(rows: readonly T[], now: number = Date.now()): T[] {
  return rows.filter((r) => {
    if (!needsFullCard(r.handler) || r.status !== "dispatching" || !r.dispatched_at) return false;
    const t = Date.parse(r.dispatched_at);
    return Number.isFinite(t) && now - t > OUTCOME_UNKNOWN_AFTER_MS;
  });
}

export function bulkDraftLine(body: unknown): string {
  const template = (body as { template?: { subject?: unknown } } | null)?.template;
  const subject = typeof template?.subject === "string" ? template.subject.trim() : "";
  if (isBulkListSend(body)) {
    const b = body as { list_name?: unknown; est_recipient_count?: unknown };
    const list = typeof b.list_name === "string" && b.list_name.trim() ? ` to ${b.list_name.trim()}` : "";
    const n = typeof b.est_recipient_count === "number" ? ` (${b.est_recipient_count.toLocaleString("en-US")})` : "";
    return subject ? `Email “${subject.slice(0, 100)}”${list}${n}, waiting for your approval` : `Bulk email${list}${n}, waiting for your approval`;
  }
  return subject ? `Draft “${subject.slice(0, 100)}”, not sent` : "Bulk email draft, not sent";
}
