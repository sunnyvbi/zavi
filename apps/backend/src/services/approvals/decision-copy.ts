
export type { DecisionConsequence } from "@zavi/shared";
import { CLASS_CONSEQUENCE, GENERIC_CONSEQUENCE, adChangeHeadline, bulkSendConsequence, bulkSendTitle, linkedinLaunchTotalText, metaNewAdSetBidPhrase, type DecisionConsequence } from "@zavi/shared";
import { formatMoney } from "@/services/tools/meta-ads/write/_currency";

function bidMoney(n: number, currency: string | null | undefined): string {
  if (Number.isInteger(n)) return formatMoney(n, currency);
  const locale = String(currency ?? "").toUpperCase() === "INR" ? "en-IN" : "en-US";
  const two = n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return formatMoney(n, currency).replace(/[\d,.]+$/, two);
}

const AGENT_LABELS: Record<string, string> = {
  engineer: "Engineer",
  "pr-reviewer": "PR reviewer",
  "growth-lead": "Growth lead",
  "growth-orchestrator": "Growth",
  "chief-of-staff": "Chief of staff",
  operator: "Operator",
  "performance-marketer": "Performance marketer",
  "dispute-response": "Dispute response",
  "supply-onboarding": "Supply onboarding",
  "content-design": "Content design",
  "content-seo": "Content SEO",
  "customer-support-inbox": "Support inbox",
  "support-helper": "Support",
  research: "Research",
  qa: "QA",
  "qa-engineer": "QA",
  pm: "Product manager",
  "support-lead": "Support Lead",
  advisor: "Advisor",
  notetaker: "Notetaker",
  "hiring-partner": "Hiring partner",
  "lifecycle-crm": "Lifecycle",
  autopilot: "Autopilot",
  heartbeat: "Automation",
  fundraising: "Fundraising",
  "ads-manager": "Ads manager",
  "meta_ads": "Meta Ads",
  "google_ads": "Google Ads",
  praxis: "Zavi",
  social: "Social",
  "social-organic": "Social",
};

function agentLabel(slug: string): string {
  return AGENT_LABELS[slug] ?? sentence(slug);
}

function sentence(s: string): string {
  const t = s.replace(/[-_]+/g, " ").trim();
  if (!t) return s;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const TITLE_OVERRIDES: Record<string, string> = {
  "operator_db.unreachable": "Your database can't be reached",
  "engineer.ship-pr": "Ship code — open a pull request",
  "content-design.propose-change": "Ship a content change — open a pull request",
  "content-seo.publish-content": "Publish SEO content — open a pull request",
  "pr-reviewer.merge-pr": "Merge the pull request",
  "github.open_pr_direct": "Open a pull request",
  "github.merge_pr_direct": "Merge the pull request",
  "pr-reviewer.post-review": "Post a code review",
  "pr-reviewer.request-changes": "Request changes on a pull request",
  send_email: "Send an email",
  "outbound.send": "Send an outbound message",
  "bulk_outbound.send": "Bulk email draft (not sent)",
  "email_campaign.create_and_send": "Send an email to a list in your email tool",
  "fundraising.outbound.send": "Send a fundraising outbound message",
  post_slack_message: "Post a Slack message",
  "operator.post-slack-message": "Post a Slack message",
  "performance-marketer.weekly-plan": "Share the weekly ads plan",
  "growth-lead.suggestion": "Review a growth recommendation",
  "operator.file-jira-issue": "File a Jira issue",
  "operator.file-linear-issue": "File a Linear issue",
  create_jira_issue: "File a Jira issue",
  "jira.add_comment": "Comment on a Jira issue",
  "linear.create_issue": "File a Linear issue",
  "linear.add_comment": "Comment on a Linear issue",
  "operator.create-standing-order": "Set up a standing order",
  "research.create-watch": "Set up a research watch",
  "channel.create-standing-order": "Set up a daily channel brief",
  "notetaker.write_atoms": "Save meeting notes to your brain",
  "dispute-response.submit-evidence": "Save dispute evidence draft (Stripe)",
  "dispute-response.final-submit-evidence": "Submit dispute evidence to Stripe for review",
  "stripe.create_connected_account": "Create a Stripe payout account",
  "stripe.create_payment": "Take a payment",
  "stripe.remit_to_tenant": "Send a payout",
  ban_user: "Ban a user",
  tag_ticket: "Tag a support ticket",
  "browser.action": "Run a browser action",
  "hiring-partner.publish-role": "Publish a job role",
  "hiring-partner.finalize-application": "Finalize an application",
  "chief-of-staff.dispatch-specialist": "Hand work to a specialist agent",
  "growth-lead.dispatch-specialist": "Hand work to a specialist agent",
  "growth-lead.reallocate-budget": "Reallocate ad budget",
  "growth-lead.lifecycle-draft": "Send a lifecycle email draft",
  "growth-lead.social-draft": "Publish a social post draft",
  "growth-lead.outreach-drafts": "Send outreach drafts",
  "social.publish": "Publish a social post",
  "social.publish.v2": "Publish a social post",
  "proposed_global_rule": "Add a standing rule for your fleet",
  "agent.urgent_advisory": "Review an urgent heads-up",
  "pm.needs_action": "Take a product action",
  "autopilot.daily-plan": "Approve today's autopilot plan",
  "heartbeat.automation-proposal": "Approve an automation",
};

export function decisionCardTitle(decisionClass: string, body?: unknown): string {
  if (decisionClass === "bulk_outbound.send") return bulkSendTitle(body);
  const ad = adChangeHeadline(decisionClass, body);
  if (ad) return ad;
  const hit = TITLE_OVERRIDES[decisionClass];
  if (hit) return hit;
  const [agent, ...rest] = decisionClass.split(".");
  const verb = rest.join(".");
  if (!verb) return sentence(agent ?? decisionClass);
  return `${agentLabel(agent ?? "")} — ${sentence(verb).toLowerCase()}`;
}

const HANDLER_CONSEQUENCE: Record<string, DecisionConsequence> = {
  "github.open_pr": {
    approve: "Opens a pull request on GitHub. Nothing merges or deploys — you review and merge it there.",
    reject: "No pull request is opened. The work is kept; nothing changes on GitHub.",
  },
  "github.merge_pr": {
    approve: "Merges the pull request on GitHub.",
    reject: "The pull request stays open and unmerged.",
  },
  "github.post_review": {
    approve: "Posts the review to the pull request.",
    reject: "No review is posted.",
  },
  "github.request_changes": {
    approve: "Posts a change request on the pull request.",
    reject: "No change request is posted.",
  },
  "gmail.send": { approve: "Sends the email.", reject: "The email is not sent — the draft is kept." },
  "outbound.send": { approve: "Sends the message.", reject: "The message is not sent — the draft is kept." },
  "fundraising.outbound.send": {
    approve: "Sends the outbound message.",
    reject: "The message is not sent — the draft is kept.",
  },
  "slack.post_message": { approve: "Posts the message to Slack.", reject: "Nothing is posted to Slack." },
  "jira.create_issue": { approve: "Creates the issue in Jira.", reject: "No Jira issue is created." },
  "jira.add_comment": { approve: "Adds the comment to the Jira issue.", reject: "No comment is added." },
  "linear.create_issue": { approve: "Creates the issue in Linear.", reject: "No Linear issue is created." },
  "linear.add_comment": { approve: "Adds the comment to the Linear issue.", reject: "No comment is added." },
  "stripe.refund": { approve: "Issues the refund through Stripe.", reject: "No refund is issued." },
  "stripe.submit_dispute_evidence": {
    approve: "Submits the dispute evidence to Stripe.",
    reject: "No evidence is submitted to Stripe.",
  },
  "stripe.create_connected_account": {
    approve: "Creates the Stripe payout account.",
    reject: "The payout account is not created.",
  },
  "stripe.create_payment": { approve: "Charges the payment through Stripe.", reject: "No payment is charged." },
  "stripe.remit_to_tenant": { approve: "Sends the payout through Stripe.", reject: "No payout is sent." },
  "tenant.ban_user": { approve: "Bans the user.", reject: "The user is not banned." },
  "support.tag_ticket": { approve: "Tags the support ticket.", reject: "No tag is applied." },
  "browser.action": { approve: "Runs the browser action.", reject: "The browser action is not run." },
  "memory.write_meeting_atoms": {
    approve: "Saves these notes to your company brain.",
    reject: "The notes are not saved.",
  },
  "hiring.publish_role": { approve: "Publishes the role.", reject: "The role stays a draft." },
  "hiring.finalize_application": {
    approve: "Finalizes the application.",
    reject: "The application is not finalized.",
  },
  "digest.post": { approve: "Posts the digest.", reject: "The digest is not posted." },
  "praxis.propose_global": {
    approve: "Adds this as a standing rule for your whole fleet.",
    reject: "No standing rule is added.",
  },
  "praxis.bake_rule": {
    approve: "Adds this as a standing rule for your fleet.",
    reject: "No rule is added.",
  },
  "praxis.create_research_watch": {
    approve: "Sets up the research watch.",
    reject: "No watch is set up.",
  },
  "praxis.create_standing_order": {
    approve: "Sets up the standing order.",
    reject: "No standing order is set up.",
  },
  "autopilot.daily_plan_approve": {
    approve: "Approves today's plan — the agents act on it.",
    reject: "The plan is discarded.",
  },
  "heartbeat.automation_proposal_approve": {
    approve: "Turns on the automation.",
    reject: "The automation is not turned on.",
  },
  "social.publish": {
    approve: "Publishes the post to the connected social account.",
    reject: "Nothing is published — the draft is kept.",
  },
  "social.publish.v2": {
    approve: "Publishes the post to the connected social account.",
    reject: "Nothing is published — the draft is kept.",
  },
};

function adConsequence(
  handler: string,
  body?: Record<string, unknown>,
): DecisionConsequence | null {
  const platform = handler.startsWith("meta_ads.")
    ? "Meta Ads"
    : handler.startsWith("google_ads.")
      ? "Google Ads"
      : null;
  if (!platform) return null;
  const generic = {
    approve: `Applies the change in ${platform}.`,
    reject: `No change is made in ${platform}.`,
  };
  const b = body ?? {};
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const noun = (): string => {
    const name = str(b.name);
    if (name) return `“${name}”`;
    const level = str(b.level);
    const id = str(b.object_id) ?? str(b.ad_set_id);
    if (level && id) return `${level === "adset" ? "ad set" : level} ${id}`;
    return level === "adset" ? "this ad set" : "this campaign";
  };

  if (handler === "meta_ads.set_status" || handler === "meta_ads.set_status_review") {
    const status = str(b.status)?.toUpperCase();
    if (status === "PAUSED") {
      return {
        approve: `Pauses ${noun()} in ${platform}. It stops delivering and stops spending.`,
        reject: `${noun()} keeps running and keeps spending.`,
      };
    }
    if (status === "ACTIVE") {
      return {
        approve: `Turns ${noun()} back on in ${platform}. It starts delivering and spending again.`,
        reject: `${noun()} stays paused — no delivery, no spend.`,
      };
    }
    return generic;
  }

  if (
    handler === "meta_ads.update_ad_set_budget" ||
    handler === "meta_ads.update_ad_set_budget_review" ||
    handler === "meta_ads.update_campaign_budget" ||
    handler === "meta_ads.update_campaign_budget_review"
  ) {
    const to = num(b.daily_budget_usd);
    const from = num(b.expected_current_daily_budget_usd);
    const m = (n: number) => formatMoney(n, str(b.currency));
    if (to !== null && from !== null) {
      return {
        approve: `Changes ${noun()}'s daily budget from ${m(from)} to ${m(to)}/day in ${platform}.`,
        reject: `The daily budget stays at ${m(from)}/day.`,
      };
    }
    if (to !== null) {
      return {
        approve: `Sets ${noun()}'s daily budget to ${m(to)}/day in ${platform}.`,
        reject: `The daily budget is unchanged.`,
      };
    }
    return generic;
  }

  if (handler === "google_ads.set_status" || handler === "google_ads.set_status_review") {
    const status = str(b.status)?.toUpperCase();
    const level = str(b.level);
    const what = str(b.name)
      ? `“${str(b.name)}”`
      : level === "ad_group"
        ? `ad group ${str(b.ad_group_id) ?? ""}`.trim()
        : level === "ad"
          ? `ad ${str(b.ad_id) ?? ""}`.trim()
          : `campaign ${str(b.campaign_id) ?? ""}`.trim();
    if (status === "PAUSED") {
      return {
        approve: `Pauses ${what} in ${platform}. It stops delivering and stops spending.`,
        reject: `${what} keeps running and keeps spending.`,
      };
    }
    if (status === "ENABLED") {
      return {
        approve: `Turns ${what} on in ${platform}. It starts delivering and spending.`,
        reject: `${what} stays paused — no delivery, no spend.`,
      };
    }
    return generic;
  }

  if (
    handler === "google_ads.update_campaign_budget" ||
    handler === "google_ads.update_campaign_budget_review"
  ) {
    const to = num(b.daily_budget_usd);
    const from = num(b.expected_current_daily_budget_usd);
    const what = str(b.name) ? `“${str(b.name)}”` : `campaign ${str(b.campaign_id) ?? ""}`.trim();
    if (to !== null && from !== null) {
      return {
        approve: `Changes ${what}'s daily budget from $${from} to $${to}/day in ${platform}.`,
        reject: `The daily budget stays at $${from}/day.`,
      };
    }
    if (to !== null) {
      return {
        approve: `Sets ${what}'s daily budget to $${to}/day in ${platform}.`,
        reject: `The daily budget is unchanged.`,
      };
    }
    return generic;
  }

  if (handler === "google_ads.create_campaign") {
    const budget = num(b.daily_budget_usd);
    const name = str(b.name) ? `“${str(b.name)}”` : "the campaign";
    const cap = budget !== null ? ` with a $${budget}/day budget` : "";
    const adGroup = b.ad_group && typeof b.ad_group === "object" ? " and its first ad group" : "";
    return {
      approve: `Creates ${name}${adGroup} in ${platform}${cap}. It is created PAUSED — no spend until you turn it on.`,
      reject: `No campaign is created.`,
    };
  }

  if (handler === "google_ads.replace_geo_targets_review" || handler === "meta_ads.replace_ad_set_geo_review") {
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
    const fromPlaces = Array.isArray(b.places)
      ? (b.places as Array<{ name?: unknown; key?: unknown }>).map((x) => (typeof x?.name === "string" ? x.name : typeof x?.key === "string" ? x.key : "")).filter(Boolean)
      : [];
    const after = strs(b.place_names).length ? strs(b.place_names) : fromPlaces;
    const before = strs(b.before_names);
    const from = before.length ? ` from ${before.join(", ")}` : "";
    return {
      approve: after.length
        ? `Changes where ${noun()} shows in ${platform}${from} to ${after.join(", ")}. Nothing else on it changes.`
        : `Changes where ${noun()} shows in ${platform}. Nothing else on it changes.`,
      reject: `${noun()} keeps showing where it does now.`,
    };
  }

  if (handler === "meta_ads.launch_campaign") {
    const c = (b.campaign ?? {}) as Record<string, unknown>;
    const name = str(c.name) ? `“${str(c.name)}”` : "the campaign";
    const budget = num(c.daily_budget_usd) !== null ? ` at ${formatMoney(num(c.daily_budget_usd) as number, str(b.currency))} a day` : "";
    const s = (b.ad_set ?? {}) as Record<string, unknown>;
    const bid = metaNewAdSetBidPhrase({ bid_strategy: c.bid_strategy, bid_amount_usd: s.bid_amount_usd }, (n) => bidMoney(n, str(b.currency)));
    return {
      approve: `Creates ${name} with its ad set and ad in ${platform} and switches it on${budget}${bid ? ` with ${bid}` : ""}. It starts spending as soon as Meta approves the ad.`,
      reject: `${name} is not created and nothing is spent.`,
    };
  }

  if (handler === "meta_ads.create_campaign") {
    const name = str(b.name) ? `“${str(b.name)}”` : "the campaign";
    return {
      approve: `Creates ${name} in ${platform}, paused. Nothing is spent until it has ad sets and ads and is turned on.`,
      reject: `${name} is not created.`,
    };
  }

  if (handler === "meta_ads.update_campaign") {
    const what = str(b.name) ? `“${str(b.name)}”` : `campaign ${str(b.campaign_id) ?? ""}`.trim();
    const m = (n: number) => formatMoney(n, str(b.currency));
    const parts: string[] = [];
    if (str(b.new_name)) parts.push(`renames it to “${str(b.new_name)}”`);
    if (b.spend_cap_usd === null) parts.push("removes its spend cap");
    else if (num(b.spend_cap_usd) !== null) parts.push(`caps its total spend at ${m(num(b.spend_cap_usd) as number)}`);
    if (str(b.bid_strategy)) parts.push("changes its bid strategy");
    if (Array.isArray(b.special_ad_categories)) parts.push("changes its special ad category");
    return {
      approve: parts.length ? `Updates ${what} in ${platform}: ${parts.join(", ")}.` : `Updates ${what}'s settings in ${platform}.`,
      reject: `${what} keeps its current settings.`,
    };
  }

  if (handler === "meta_ads.update_ad_set") {
    const what = str(b.name) ? `“${str(b.name)}”` : `ad set ${str(b.ad_set_id) ?? ""}`.trim();
    const parts: string[] = [];
    if (str(b.new_name)) parts.push(`renames it to “${str(b.new_name)}”`);
    if (str(b.end_time)) parts.push(`sets its end date to ${str(b.end_time)}`);
    if (str(b.bid_strategy)) parts.push("changes its bid strategy");
    if (num(b.bid_amount_usd) !== null) parts.push(`sets its bid to ${formatMoney(num(b.bid_amount_usd) as number, str(b.currency))}`);
    if (b.targeting_patch && typeof b.targeting_patch === "object") parts.push("changes its targeting");
    return {
      approve: parts.length ? `Updates ${what} in ${platform}: ${parts.join(", ")}. Everything else stays as it is.` : `Updates ${what}'s settings in ${platform}.`,
      reject: `${what} keeps its current settings.`,
    };
  }

  if (handler === "meta_ads.update_ad") {
    const what = str(b.name) ? `“${str(b.name)}”` : `ad ${str(b.ad_id) ?? ""}`.trim();
    const parts: string[] = [];
    if (str(b.new_name)) parts.push(`renames it to “${str(b.new_name)}”`);
    if (str(b.creative_id)) parts.push("swaps its creative");
    if (str(b.status) === "PAUSED") parts.push("pauses it");
    if (str(b.status) === "ACTIVE") parts.push("turns it on");
    return {
      approve: parts.length ? `Updates ${what} in ${platform}: ${parts.join(", ")}.` : `Updates ${what} in ${platform}.`,
      reject: `${what} stays as it is.`,
    };
  }

  if (handler === "meta_ads.create_lead_form") {
    return {
      approve: `Adds the lead form “${str(b.name) ?? ""}” to your Facebook Page, collecting contact details under your privacy policy. Zavi never reads the leads.`,
      reject: `No lead form is created.`,
    };
  }

  if (handler === "meta_ads.create_lookalike_audience") {
    return {
      approve: `Builds a lookalike audience in ${platform} (${str(b.country) ?? ""}). It spends nothing until an ad set targets it.`,
      reject: `No audience is built.`,
    };
  }

  if (handler === "meta_ads.create_custom_conversion") {
    return {
      approve: `Creates the conversion “${str(b.name) ?? ""}” in ${platform}: counted when the pixel sees a page containing “${str(b.url_contains) ?? ""}”.`,
      reject: `No conversion is created.`,
    };
  }

  if (handler === "meta_ads.create_creative") {
    const name = str(b.name) ? `“${str(b.name)}”` : "the creative";
    return {
      approve: `Adds ${name} to the ${platform} ad account. It runs nowhere until an ad uses it.`,
      reject: `${name} is not created.`,
    };
  }

  if (handler === "meta_ads.update_creative") {
    return {
      approve: `Renames creative ${str(b.creative_id) ?? ""} “${str(b.new_name) ?? ""}” in ${platform}. Ads using it do not change.`,
      reject: `The creative keeps its name.`,
    };
  }

  if (handler === "meta_ads.upload_asset") {
    return {
      approve: `Adds the ${str(b.kind) ?? "file"} “${str(b.name) ?? ""}” to the ${platform} ad account's library. It runs nowhere until a creative uses it.`,
      reject: `Nothing is uploaded.`,
    };
  }

  if (handler === "meta_ads.duplicate_ad") {
    return {
      approve: `Copies ad ${str(b.source_ad_id) ?? ""} into ad set ${str(b.ad_set_id) ?? ""} in ${platform} and switches it on. It adds no budget.`,
      reject: `No copy is made.`,
    };
  }

  if (handler === "meta_ads.delete_campaign") {
    const what = str(b.name) ? `“${str(b.name)}”` : `campaign ${str(b.campaign_id) ?? ""}`.trim();
    return {
      approve: `Deletes ${what} in ${platform} with its ad sets and ads. It stops spending and cannot be brought back.`,
      reject: `${what} stays as it is.`,
    };
  }

  if (handler === "google_ads.update_campaign") {
    const what = str(b.name) ? `“${str(b.name)}”` : `campaign ${str(b.campaign_id) ?? ""}`.trim();
    const parts: string[] = [];
    if (str(b.new_name)) parts.push(`renames it to “${str(b.new_name)}”`);
    if (num(b.target_cpa_usd) !== null) parts.push(`sets target CPA to $${num(b.target_cpa_usd)}`);
    if (num(b.target_roas) !== null) parts.push(`sets target ROAS to ${num(b.target_roas)}x`);
    if (b.network && typeof b.network === "object") parts.push("changes its network settings");
    return {
      approve: parts.length
        ? `Updates ${what} in ${platform}: ${parts.join(", ")}.`
        : `Updates ${what}'s settings in ${platform}.`,
      reject: `${what} keeps its current settings.`,
    };
  }

  if (handler === "google_ads.create_ad_group") {
    const name = str(b.name) ? `“${str(b.name)}”` : "a new ad group";
    const keywords = Array.isArray(b.keywords) ? b.keywords.length : 0;
    const ads = Array.isArray(b.ads) ? b.ads.length : 0;
    return {
      approve: `Creates ad group ${name} in ${platform} campaign ${str(b.campaign_id) ?? ""} with ${keywords} keyword(s) and ${ads} ad(s). Created PAUSED.`,
      reject: `No ad group is created.`,
    };
  }

  if (handler === "google_ads.update_ad_group") {
    const what = str(b.name) ? `“${str(b.name)}”` : `ad group ${str(b.ad_group_id) ?? ""}`.trim();
    const parts: string[] = [];
    if (str(b.new_name)) parts.push(`renames it to “${str(b.new_name)}”`);
    if (num(b.cpc_bid_usd) !== null) parts.push(`sets the CPC bid to $${num(b.cpc_bid_usd)}`);
    if (num(b.cpv_bid_usd) !== null) parts.push(`sets the CPV bid to $${num(b.cpv_bid_usd)}`);
    if (num(b.cpm_bid_usd) !== null) parts.push(`sets the CPM bid to $${num(b.cpm_bid_usd)}`);
    return {
      approve: parts.length
        ? `Updates ${what} in ${platform}: ${parts.join(", ")}.`
        : `Updates ${what} in ${platform}.`,
      reject: `${what} is unchanged.`,
    };
  }

  if (handler === "google_ads.create_ad") {
    const ad = b.ad && typeof b.ad === "object" ? (b.ad as { kind?: unknown }) : null;
    const kind = str(ad?.kind)?.replace(/_/g, " ") ?? "new";
    return {
      approve: `Creates a ${kind} ad in ${platform} ad group ${str(b.ad_group_id) ?? ""}. Created PAUSED.`,
      reject: `No ad is created.`,
    };
  }

  if (handler === "google_ads.add_keywords") {
    const count = Array.isArray(b.keywords) ? b.keywords.length : 0;
    const negative = b.negative === true;
    const target = b.level === "campaign" ? `campaign ${str(b.campaign_id) ?? ""}` : `ad group ${str(b.ad_group_id) ?? ""}`;
    return {
      approve: negative
        ? `Adds ${count} negative keyword(s) to ${platform} ${target}. Those searches stop triggering ads.`
        : `Adds ${count} keyword(s) to ${platform} ${target}. Ads start entering those auctions.`,
      reject: `No keywords are added.`,
    };
  }

  if (handler === "google_ads.remove_resource") {
    const level = str(b.level)?.replace("_", " ") ?? "resource";
    const what = str(b.name) ? `“${str(b.name)}”` : `this ${level}`;
    return {
      approve: `Permanently removes ${what} from ${platform}. A removed ${level} cannot be restored.`,
      reject: `${what} stays as it is.`,
    };
  }

  if (handler === "meta_ads.create_ad_set") {
    const budget = num(b.daily_budget_usd);
    const cap = budget !== null ? ` with a ${formatMoney(budget, str(b.currency))}/day budget` : "";
    const bid = metaNewAdSetBidPhrase(b, (n) => bidMoney(n, str(b.currency)));
    return {
      approve: `Creates ${noun()} in ${platform}${cap}${bid ? ` and ${bid}` : ""}. It is created PAUSED — no spend until you turn it on.`,
      reject: `No ad set is created.`,
    };
  }

  return generic;
}

const AGENT_SLUG_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

function dispatchConsequence(body?: Record<string, unknown>): DecisionConsequence {
  const slug = typeof body?.target_agent_slug === "string" ? body.target_agent_slug.trim() : "";
  if (!slug || slug.length > 48 || !AGENT_SLUG_RE.test(slug)) {
    return {
      approve: "Hands the work to the specialist agent to start on.",
      reject: "The specialist agent is not dispatched.",
    };
  }
  const label = agentLabel(slug);
  return {
    approve: `Starts ${label} on this work now — a real agent run, not a draft.`,
    reject: `${label} is not started. Nothing else changes.`,
  };
}

function formatScheduledAtUtc(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toLocaleString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })} UTC`;
}

function linkedinLaunchConsequence(b: Record<string, unknown>): DecisionConsequence {
  const named = typeof b.name === "string" && b.name.trim().length > 0;
  const name = named ? `“${(b.name as string).trim()}”` : "the campaign";
  const total = linkedinLaunchTotalText(b);
  const endMs = typeof b.end_time === "number" && Number.isFinite(b.end_time) ? new Date(b.end_time) : null;
  const end =
    endMs && Number.isFinite(endMs.getTime())
      ? `${endMs.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`
      : null;
  const cap = total !== null ? ` with a ${total} total budget` : "";
  const until = end ? ` and an end date of ${end}` : "";
  return {
    approve: `Launches ${name} in LinkedIn Ads${cap}${until}. It starts spending as soon as LinkedIn approves the ad.`,
    reject: named
      ? `${name} is not launched and the campaign stays paused. Nothing is spent.`
      : "The campaign is not launched and stays paused. Nothing is spent.",
  };
}

function xAdsConsequence(cls: string, b: Record<string, unknown>): DecisionConsequence {
  const summary =
    typeof b.summary === "string" && b.summary.trim()
      ? b.summary.trim().replace(/\s+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      : null;
  if (!summary) return GENERIC_CONSEQUENCE;
  const pause = cls === "x_ads.set_status" && b.status === "PAUSED";
  const reject =
    cls === "x_ads.create_campaign"
      ? "No campaign is created."
      : cls === "x_ads.set_status"
        ? pause
          ? "The campaign keeps running and keeps spending."
          : "The campaign stays paused: no delivery, no spend."
        : "The campaign keeps its current name and budgets.";
  return { approve: summary, reject };
}

function tiktokAdsConsequence(cls: string, b: Record<string, unknown>): DecisionConsequence {
  const name = typeof b.name === "string" && b.name.trim() ? `"${b.name.trim().replace(/\s+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"` : "it";
  const usd = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? `$${v.toFixed(2)}` : null);
  if (cls === "tiktok_ads.update_budget") {
    const from = usd(b.expected_current_daily_budget_usd), to = usd(b.daily_budget_usd);
    return { approve: from && to ? `Changes the daily budget of ${name} in TikTok Ads from ${from} to ${to}.` : "Changes the daily budget in TikTok Ads.", reject: "The daily budget stays as it is." };
  }
  if (b.status === "PAUSED") return { approve: `Pauses ${name} in TikTok Ads. It stops spending.`, reject: "It keeps running and keeps spending." };
  const daily = usd(b.daily_budget_usd);
  return { approve: `Turns ${name} back on in TikTok Ads${daily ? `, up to ${daily} a day` : ""}.`, reject: "It stays paused: no delivery, no spend." };
}

export function decisionConsequence(
  handler: string | null | undefined,
  decisionClass?: string | null,
  body?: Record<string, unknown>,
): DecisionConsequence {
  if (decisionClass === "social.publish.v2") {
    const base = CLASS_CONSEQUENCE["social.publish.v2"] ?? GENERIC_CONSEQUENCE;
    const when = formatScheduledAtUtc(body?.scheduled_at);
    return when
      ? { approve: `Publishes the post on ${when} to the connected social account.`, reject: base.reject }
      : base;
  }
  if (decisionClass === "bulk_outbound.send") {
    const bulk = bulkSendConsequence(body, { names: false });
    if (bulk) return bulk;
  }
  if (decisionClass && CLASS_CONSEQUENCE[decisionClass]) {
    return CLASS_CONSEQUENCE[decisionClass];
  }
  const xAds = handler?.startsWith("x_ads.") ? handler : decisionClass?.startsWith("x_ads.") ? decisionClass : null;
  if (xAds) return xAdsConsequence(xAds, body ?? {});
  const isTiktokEdit = (c: string | null | undefined) => c === "tiktok_ads.set_status" || c === "tiktok_ads.update_budget";
  const tiktokAds = isTiktokEdit(handler) ? handler : isTiktokEdit(decisionClass) ? decisionClass : null;
  if (tiktokAds) return tiktokAdsConsequence(tiktokAds, body ?? {});
  if (handler === "linkedin_ads.launch_campaign" || decisionClass === "linkedin_ads.launch_campaign") {
    return linkedinLaunchConsequence(body ?? {});
  }
  if (!handler) return GENERIC_CONSEQUENCE;
  if (handler === "praxis.dispatch_specialist") return dispatchConsequence(body);
  return HANDLER_CONSEQUENCE[handler] ?? adConsequence(handler, body) ?? GENERIC_CONSEQUENCE;
}

export type StatusChip = { label: string; tone: "good" | "warn" | "neutral" };

export function statusChip(key: string, value: unknown): StatusChip | null {
  switch (key) {
    case "typecheck_ok":
      return value === true
        ? { label: "Code compiles", tone: "good" }
        : { label: "Compile errors", tone: "warn" };
    case "http_route_changed":
      return value === true ? { label: "Changes a server route", tone: "warn" } : null;
    case "ship_gate_warning": {
      if (!value || value === "none") return null;
      const v = String(value);
      if (v === "critic_fail" || v === "task_mismatch") return null;
      if (v === "tests_failed") return { label: "Some tests failed", tone: "warn" };
      if (v === "typecheck_failed") return { label: "Compile errors", tone: "warn" };
      if (v === "app_verify_missing") return { label: "App not verified running", tone: "warn" };
      return { label: `Review flag: ${sentence(v).toLowerCase()}`, tone: "warn" };
    }
    case "risk_class": {
      const v = String(value ?? "").toLowerCase();
      if (!v) return null;
      return { label: `${sentence(v)} risk`, tone: v === "trivial" || v === "low" ? "good" : "neutral" };
    }
    default:
      return null;
  }
}

export const STATUS_CHIP_KEYS = new Set([
  "typecheck_ok",
  "http_route_changed",
  "ship_gate_warning",
  "risk_class",
]);
