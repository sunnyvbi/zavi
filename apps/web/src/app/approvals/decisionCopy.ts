
import { agentLabelForSlug, formatScheduledAt, hasClosablePr } from "./approvalsHelpers";
import { isXAdsClass, xAdsConsequence } from "./xAdsDecision";
import { isTiktokAdsClass, tiktokAdsConsequence } from "./tiktokAdsDecision";

export type { DecisionConsequence } from "@zavi/shared";
import { CLASS_CONSEQUENCE, GENERIC_CONSEQUENCE, bulkSendConsequence, linkedinLaunchTotalText, metaNewAdSetBidPhrase, type DecisionConsequence } from "@zavi/shared";
import { adCurrencySymbol } from "@/lib/adCurrency";

const HANDLER_CONSEQUENCE: Record<string, DecisionConsequence> = {
  "github.open_pr": {
    approve: "Opens a pull request on GitHub. Nothing merges or deploys; you review and merge it there.",
    reject: "No pull request is opened. The work is kept; nothing changes on GitHub.",
  },
  "github.merge_pr": {
    approve: "Merges the pull request on GitHub.",
    reject: "The pull request stays open and unmerged.",
  },
  "github.post_review": { approve: "Posts the review to the pull request.", reject: "No review is posted." },
  "github.request_changes": {
    approve: "Posts a change request on the pull request.",
    reject: "No change request is posted.",
  },
  "gmail.send": { approve: "Sends the email.", reject: "The email is not sent; the draft is kept." },
  "outbound.send": { approve: "Sends the message.", reject: "The message is not sent; the draft is kept." },
  "fundraising.outbound.send": {
    approve: "Sends the outbound message.",
    reject: "The message is not sent; the draft is kept.",
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
  "praxis.bake_rule": { approve: "Adds this as a standing rule for your fleet.", reject: "No rule is added." },
  "praxis.create_research_watch": { approve: "Sets up the research watch.", reject: "No watch is set up." },
  "praxis.create_standing_order": {
    approve: "Sets up the standing order.",
    reject: "No standing order is set up.",
  },
  "praxis.create_channel_standing_order": {
    approve: "Sets up the daily schedule for this channel. One per channel: it replaces any existing one. Each run stages drafts for your approval; nothing posts on its own.",
    reject: "No schedule is set up. Nothing changes.",
  },
  "autopilot.daily_plan_approve": {
    approve: "Approves today's plan, and the agents act on it.",
    reject: "The plan is discarded.",
  },
  "heartbeat.automation_proposal_approve": {
    approve: "Turns on the automation.",
    reject: "The automation is not turned on.",
  },
  "social.publish": {
    approve: "Publishes the post to the connected social account.",
    reject: "Nothing is published; the draft is kept.",
  },
  "social.publish.v2": {
    approve: "Publishes the post to the connected social account.",
    reject: "Nothing is published; the draft is kept.",
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
      : handler.startsWith("linkedin_ads.")
        ? "LinkedIn Ads"
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
        reject: `${noun()} stays paused: no delivery, no spend.`,
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
    const sym = adCurrencySymbol(b.currency);
    if (to !== null && from !== null) {
      return {
        approve: `Changes ${noun()}'s daily budget from ${sym}${from} to ${sym}${to}/day in ${platform}.`,
        reject: `The daily budget stays at ${sym}${from}/day.`,
      };
    }
    if (to !== null) {
      return {
        approve: `Sets ${noun()}'s daily budget to ${sym}${to}/day in ${platform}.`,
        reject: `The daily budget is unchanged.`,
      };
    }
    return generic;
  }

  if (handler === "meta_ads.create_ad_set") {
    const budget = num(b.daily_budget_usd);
    const cap = budget !== null ? ` with a ${adCurrencySymbol(b.currency)}${budget}/day budget` : "";
    const bid = metaNewAdSetBidPhrase(b, (n) => `${adCurrencySymbol(b.currency)}${Number.isInteger(n) ? n : n.toFixed(2)}`);
    return {
      approve: `Creates ${noun()} in ${platform}${cap}${bid ? ` and ${bid}` : ""}. It is created PAUSED, with no spend until you turn it on.`,
      reject: `No ad set is created.`,
    };
  }

  const googleNoun = (): string => {
    const name = str(b.name);
    if (name) return `“${name}”`;
    const level = str(b.level);
    if (level === "ad_group") return `ad group ${str(b.ad_group_id) ?? ""}`.trim();
    if (level === "ad") return `ad ${str(b.ad_id) ?? ""}`.trim();
    return `campaign ${str(b.campaign_id) ?? ""}`.trim();
  };

  if (handler === "google_ads.set_status" || handler === "google_ads.set_status_review") {
    const status = str(b.status)?.toUpperCase();
    if (status === "PAUSED") {
      return {
        approve: `Pauses ${googleNoun()} in ${platform}. It stops delivering and stops spending.`,
        reject: `${googleNoun()} keeps running and keeps spending.`,
      };
    }
    if (status === "ENABLED") {
      return {
        approve: `Turns ${googleNoun()} on in ${platform}. It starts delivering and spending.`,
        reject: `${googleNoun()} stays paused: no delivery, no spend.`,
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
    if (to !== null && from !== null) {
      return {
        approve: `Changes ${googleNoun()}'s daily budget from $${from} to $${to}/day in ${platform}.`,
        reject: `The daily budget stays at $${from}/day.`,
      };
    }
    if (to !== null) {
      return {
        approve: `Sets ${googleNoun()}'s daily budget to $${to}/day in ${platform}.`,
        reject: `The daily budget is unchanged.`,
      };
    }
    return generic;
  }

  if (handler === "google_ads.create_campaign") {
    const budget = num(b.daily_budget_usd);
    const cap = budget !== null ? ` with a $${budget}/day budget` : "";
    const adGroup = b.ad_group && typeof b.ad_group === "object" ? " and its first ad group" : "";
    return {
      approve: `Creates ${googleNoun()}${adGroup} in ${platform}${cap}. It is created PAUSED, with no spend until you turn it on.`,
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

  if (handler === "linkedin_ads.set_status") {
    const who = str(b.name) ? `“${str(b.name)}”` : `campaign ${str(b.campaign_id) ?? ""}`.trim();
    return {
      approve: `Pauses ${who} in ${platform}. It stops delivering and stops spending.`,
      reject: `${who} keeps running and keeps spending.`,
    };
  }
  if (handler === "linkedin_ads.create_campaign_bundle") {
    const budget = num(b.daily_budget_usd);
    const cap = budget !== null ? ` with a $${budget}/day budget` : "";
    const who = str(b.name) ? `“${str(b.name)}”` : "the campaign";
    return {
      approve: `Creates ${who} (campaign group, campaign and creative) in ${platform}${cap}. Everything is created PAUSED, with no spend until you choose Review launch on your LinkedIn Ads page in Zavi. Turning it on in Campaign Manager skips your monthly ad budget check.`,
      reject: `No campaign is created.`,
    };
  }

  if (handler === "linkedin_ads.launch_campaign") {
    const who = str(b.name) ? `“${str(b.name)}”` : "the campaign";
    const total = linkedinLaunchTotalText(b);
    const endMs = num(b.end_time);
    const endDate = endMs !== null ? new Date(endMs) : null;
    const end =
      endDate && Number.isFinite(endDate.getTime())
        ? endDate.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })
        : null;
    const cap = total !== null ? ` with a ${total} total budget` : "";
    const until = end ? ` and an end date of ${end} UTC` : "";
    return {
      approve: `Launches ${who} in ${platform}${cap}${until}. It starts spending as soon as LinkedIn approves the ad.`,
      reject: str(b.name)
        ? `${who} is not launched and the campaign stays paused. Nothing is spent.`
        : "The campaign is not launched and stays paused. Nothing is spent.",
    };
  }

  if (handler === "meta_ads.launch_campaign") {
    const c = (b.campaign ?? {}) as Record<string, unknown>;
    const who = str(c.name) ? `“${str(c.name)}”` : "the campaign";
    const budget = num(c.daily_budget_usd);
    const s = (b.ad_set ?? {}) as Record<string, unknown>;
    const bid = metaNewAdSetBidPhrase({ bid_strategy: c.bid_strategy, bid_amount_usd: s.bid_amount_usd }, (n) => `${adCurrencySymbol(b.currency)}${Number.isInteger(n) ? n : n.toFixed(2)}`);
    return {
      approve: `Creates ${who} with its ad set and ad in ${platform} and switches it on${budget !== null ? ` at ${adCurrencySymbol(b.currency)}${budget}/day` : ""}${bid ? ` with ${bid}` : ""}. It starts spending as soon as Meta approves the ad.`,
      reject: `${who} is not created and nothing is spent.`,
    };
  }

  if (handler === "meta_ads.create_campaign") {
    const who = str(b.name) ? `“${str(b.name)}”` : "the campaign";
    return {
      approve: `Creates ${who} in ${platform}, paused. Nothing is spent until it has ad sets and ads and is turned on.`,
      reject: `No campaign is created.`,
    };
  }

  if (handler === "meta_ads.update_campaign") {
    const who = str(b.name) ? `“${str(b.name)}”` : "this campaign";
    return {
      approve: `Updates ${who}'s settings in ${platform} (name, spend cap, bid strategy or special ad category).`,
      reject: `${who} keeps its current settings.`,
    };
  }

  if (handler === "meta_ads.update_ad_set") {
    const who = str(b.name) ? `“${str(b.name)}”` : "this ad set";
    return {
      approve: `Updates ${who} in ${platform} (name, end date, bid or targeting). Everything else stays as it is.`,
      reject: `${who} keeps its current settings.`,
    };
  }

  if (handler === "meta_ads.update_ad") {
    const who = str(b.name) ? `“${str(b.name)}”` : "this ad";
    return {
      approve: str(b.status) === "PAUSED" ? `Pauses ${who} in ${platform}; its ad set keeps running.` : `Updates ${who} in ${platform}.`,
      reject: `${who} stays as it is.`,
    };
  }

  if (handler === "meta_ads.create_lead_form") {
    return {
      approve: `Adds a lead form to your Facebook Page, collecting contact details under your privacy policy. Zavi never reads the leads.`,
      reject: `No lead form is created.`,
    };
  }

  if (handler === "meta_ads.create_lookalike_audience") {
    return { approve: `Builds a lookalike audience in ${platform}. It spends nothing until an ad set targets it.`, reject: `No audience is built.` };
  }

  if (handler === "meta_ads.create_custom_conversion") {
    return { approve: `Creates a custom conversion in ${platform} from your pixel.`, reject: `No conversion is created.` };
  }

  if (handler === "meta_ads.create_creative" || handler === "meta_ads.upload_asset") {
    return {
      approve: `Adds it to the ${platform} ad account. It runs nowhere until it is used in an ad.`,
      reject: `Nothing is added.`,
    };
  }

  if (handler === "meta_ads.update_creative") {
    return { approve: `Renames the creative in ${platform}. Ads using it do not change.`, reject: `The creative keeps its name.` };
  }

  if (handler === "meta_ads.duplicate_ad") {
    return {
      approve: `Copies the ad into ad set ${str(b.ad_set_id) ?? ""} in ${platform} and switches it on. It adds no budget.`,
      reject: `No copy is made.`,
    };
  }

  if (handler === "meta_ads.delete_campaign") {
    const who = str(b.name) ? `“${str(b.name)}”` : "this campaign";
    return {
      approve: `Deletes ${who} in ${platform} with its ad sets and ads. It stops spending and cannot be brought back.`,
      reject: `${who} stays as it is.`,
    };
  }

  if (handler === "google_ads.update_campaign") {
    return {
      approve: `Updates ${googleNoun()}'s settings in ${platform} (name, bidding target or networks). Spend continues under the new settings.`,
      reject: `${googleNoun()} keeps its current settings.`,
    };
  }

  if (handler === "google_ads.create_ad_group") {
    return {
      approve: `Creates ad group ${googleNoun()} in ${platform} campaign ${str(b.campaign_id) ?? ""}. It is created PAUSED.`,
      reject: `No ad group is created.`,
    };
  }

  if (handler === "google_ads.update_ad_group") {
    return {
      approve: `Updates ${googleNoun()} in ${platform} (name or default bid).`,
      reject: `${googleNoun()} is unchanged.`,
    };
  }

  if (handler === "google_ads.create_ad") {
    return {
      approve: `Creates a new ad in ${platform} ad group ${str(b.ad_group_id) ?? ""}. It is created PAUSED.`,
      reject: `No ad is created.`,
    };
  }

  if (handler === "google_ads.add_keywords") {
    const count = Array.isArray(b.keywords) ? b.keywords.length : 0;
    return {
      approve:
        b.negative === true
          ? `Adds ${count} negative keyword(s) in ${platform}. Those searches stop triggering ads.`
          : `Adds ${count} keyword(s) in ${platform}. Ads start entering those auctions.`,
      reject: `No keywords are added.`,
    };
  }

  if (handler === "google_ads.remove_resource") {
    const level = str(b.level)?.replace("_", " ") ?? "resource";
    return {
      approve: `Permanently removes ${googleNoun()} from ${platform}. A removed ${level} cannot be restored.`,
      reject: `${googleNoun()} stays as it is.`,
    };
  }

  return generic;
}

function needsActionConsequence(
  body?: Record<string, unknown>,
): DecisionConsequence | null {
  const b = body ?? {};
  if (b.stuck_rollup === true || b.coalesced === true || b.proposed_action === "none" || b.roadmap_id === null) {
    return {
      approve:
        "Clears this heads-up from your queue. Nothing is re-run and no pull request is closed. Review or re-dispatch any item from the agent's workspace.",
      reject: "Clears this heads-up from your queue. Nothing is re-run.",
    };
  }
  return {
    approve: hasClosablePr(b.pr_url)
      ? "Re-dispatches the engineer to retry this, and closes the stale pull request. Nothing merges or deploys."
      : "Re-dispatches the engineer to retry this. Nothing merges or deploys.",
    reject: "Drops it. Nothing is re-run, and Product PM should not propose this item again.",
  };
}

const AGENT_SLUG_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

function dispatchConsequence(body?: Record<string, unknown>): DecisionConsequence {
  const raw = body?.target_agent_slug;
  const slug = typeof raw === "string" ? raw.trim() : "";
  if (!slug || slug.length > 48 || !AGENT_SLUG_RE.test(slug)) {
    return {
      approve: "Hands the work to the specialist agent to start on.",
      reject: "The specialist agent is not dispatched.",
    };
  }
  const label = agentLabelForSlug(slug);
  return {
    approve: `Starts ${label} on this work now: a real agent run, not a draft.`,
    reject: `${label} is not started. Nothing else changes.`,
  };
}

export function decisionConsequence(
  handler: string | null | undefined,
  decisionClass?: string | null,
  body?: Record<string, unknown>,
): DecisionConsequence {
  if (decisionClass === "social.publish.v2") {
    const base = CLASS_CONSEQUENCE["social.publish.v2"] ?? GENERIC_CONSEQUENCE;
    const when = formatScheduledAt(body?.scheduled_at);
    return when
      ? { approve: `Publishes the post on ${when} to the connected social account.`, reject: base.reject }
      : base;
  }
  if (decisionClass === "bulk_outbound.send") {
    const bulk = bulkSendConsequence(body);
    if (bulk) return bulk;
  }
  if (decisionClass && CLASS_CONSEQUENCE[decisionClass]) {
    return CLASS_CONSEQUENCE[decisionClass];
  }
  const xAds = isXAdsClass(handler) ? handler : isXAdsClass(decisionClass) ? decisionClass : null;
  if (xAds) return xAdsConsequence(xAds, body ?? {}) ?? GENERIC_CONSEQUENCE;
  const tiktokAds = isTiktokAdsClass(handler) ? handler : isTiktokAdsClass(decisionClass) ? decisionClass : null;
  if (tiktokAds) return tiktokAdsConsequence(tiktokAds, body ?? {}) ?? GENERIC_CONSEQUENCE;
  if (!handler) return GENERIC_CONSEQUENCE;
  if (handler === "pm.needs_action") {
    return needsActionConsequence(body) ?? GENERIC_CONSEQUENCE;
  }
  if (handler === "praxis.dispatch_specialist") {
    return dispatchConsequence(body);
  }
  return HANDLER_CONSEQUENCE[handler] ?? adConsequence(handler, body) ?? GENERIC_CONSEQUENCE;
}
