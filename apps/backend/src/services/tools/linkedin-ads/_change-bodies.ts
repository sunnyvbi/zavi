import { z } from "zod";

export const LINKEDIN_RESUME_CLASS = "linkedin_ads.resume_campaign";
export const LINKEDIN_BUDGET_CLASS = "linkedin_ads.update_campaign_budget";
export const LINKEDIN_TARGETING_CLASS = "linkedin_ads.update_targeting";

const numericId = z.string().regex(/^\d{1,20}$/);
export const LINKEDIN_AGENT_ORIGIN = "agent";
export const linkedinCardOrigin = z.enum([LINKEDIN_AGENT_ORIGIN, "user_initiated_chat"]);
export type LinkedInCardOrigin = z.infer<typeof linkedinCardOrigin>;
export const linkedinMoney = z.object({ amount: z.string().regex(/^\d+(\.\d{1,2})?$/), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();

export const linkedinResumeBodySchema = z
  .object({
    campaign_id: numericId,
    account_id: numericId,
    name: z.string().min(1).max(300),
    origin: linkedinCardOrigin.optional(),
    rationale: z.string().min(1).max(2000),
    expected_status: z.enum(["PAUSED", "COMPLETED"]),
    run_start_at: z.string().datetime().nullable(),
    run_end_at: z.string().datetime().nullable(),
    budget: z.object({ kind: z.enum(["daily", "total"]), amount: z.string(), currency: z.string() }).strict().nullable(),
  })
  .strict();
export type LinkedInResumeBody = z.infer<typeof linkedinResumeBodySchema>;

export const linkedinBudgetBodySchema = z
  .object({
    campaign_id: numericId,
    account_id: numericId,
    name: z.string().min(1).max(300),
    kind: z.enum(["daily", "total"]),
    expected_current: linkedinMoney,
    proposed: linkedinMoney,
    origin: linkedinCardOrigin.optional(),
    rationale: z.string().min(1).max(2000),
    funded_by: z.object({ campaign_id: numericId, name: z.string().min(1).max(300) }).strict().nullable().optional(),
    step_pct: z.number().nullable().optional(),
  })
  .strict();
export type LinkedInBudgetBody = z.infer<typeof linkedinBudgetBodySchema>;

export const linkedinTargetingBodySchema = z
  .object({
    campaign_id: numericId,
    account_id: numericId,
    name: z.string().min(1).max(300),
    before_fingerprint: z.string().min(1),
    before_criteria: z.unknown(),
    after_criteria: z.unknown(),
    places_before: z.array(z.string().min(1).max(200)).max(200),
    places_after: z.array(z.string().min(1).max(200)).max(200),
    origin: linkedinCardOrigin.optional(),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
export type LinkedInTargetingBody = z.infer<typeof linkedinTargetingBodySchema>;

export const minor = (amount: string): number => Math.round(Number(amount) * 100);

export function linkedinActionRaisesSpend(execClass: string, payload: unknown): boolean {
  if (execClass === LINKEDIN_RESUME_CLASS || execClass === LINKEDIN_TARGETING_CLASS) return true;
  if (execClass !== LINKEDIN_BUDGET_CLASS) return linkedinCardRaisesSpend(execClass, payload);
  const p = linkedinBudgetBodySchema.safeParse(payload);
  if (!p.success) return true;
  return minor(p.data.proposed.amount) > minor(p.data.expected_current.amount);
}

const fmt = (m: { amount: string; currency: string }) => new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency }).format(Number(m.amount));
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null);
const label = (b: { name: string; campaign_id: string }) => (b.name && b.name !== b.campaign_id ? `"${b.name}"` : "this campaign");
export const linkedinManagerLink = (account_id: string, campaign_id?: string | null) =>
  `https://www.linkedin.com/campaignmanager/accounts/${account_id}/campaigns${campaign_id && /^\d+$/.test(campaign_id) ? `/${campaign_id}/summary` : ""}`;
const managerLink = linkedinManagerLink;
const groupsLink = (account_id: string) => `https://www.linkedin.com/campaignmanager/accounts/${account_id}/campaign-groups`;
const LI_NAMES = "LinkedIn now calls a campaign group a \"Campaign\" and a campaign an \"Ad set\".";

type Card = { title: string; card: Record<string, unknown> };
const card = (title: string, sentence: string, rationale: string, rows: Array<{ item: string; before: string; after: string }>, link: string, kind_label?: string, where?: string): Card => ({
  title: title.slice(0, 300),
  card: {
    ...(kind_label ? { kind_label } : {}),
    ...(where ? { where } : {}),
    step: { title: title.slice(0, 300), body: [sentence, rationale.trim(), where ? `Where to find it in LinkedIn: ${where}` : ""].filter(Boolean).join("\n\n"), blocking: false, effort: "minutes", evidence: [] },
    change_sentence: sentence,
    exact_change: { rows },
    decision_evidence: null,
    link,
  },
});

export function buildLinkedInResumeCardBody(body: LinkedInResumeBody): Card {
  const was = body.expected_status === "COMPLETED" ? "Completed" : "Paused";
  const end = day(body.run_end_at);
  const budget = body.budget ? (body.budget.kind === "daily" ? `${fmt({ amount: body.budget.amount, currency: body.budget.currency })} a day` : `whatever is left of its ${fmt({ amount: body.budget.amount, currency: body.budget.currency })} total budget`) : "its budget as set in LinkedIn";
  const sentence =
    body.expected_status === "COMPLETED"
      ? `Zavi restarts ${label(body)} in LinkedIn Campaign Manager, which ended, by setting a new end date of ${end ?? "the date on this card"} UTC and switching it back on. It spends ${budget} again from the moment it is approved until someone pauses it or the end date arrives.`
      : `Zavi switches ${label(body)} back on in LinkedIn Campaign Manager. It spends ${budget} again from the moment it is approved until someone pauses it.`;
  return card(
    `Restart the LinkedIn campaign "${body.name}"`,
    sentence,
    body.rationale,
    [
      { item: `Campaign "${body.name}"`, before: was, after: "Active" },
      ...(body.expected_status === "COMPLETED" ? [{ item: "End date", before: day(body.run_end_at) ? "Already passed" : "As set in LinkedIn", after: `${end ?? "new end date"} UTC` }] : []),
      { item: "Budget", before: budget, after: `${budget} (not changed)` },
    ],
    managerLink(body.account_id, body.campaign_id),
  );
}

export function buildLinkedInBudgetCardBody(body: LinkedInBudgetBody): Card {
  const raise = minor(body.proposed.amount) > minor(body.expected_current.amount);
  const what = body.kind === "daily" ? "daily budget" : "total budget";
  const funded = body.funded_by ? ` Zavi proposed it alongside a cut to "${body.funded_by.name}" on its own card; the two are approved separately, and approving this one does not wait for the cut.` : "";
  const sentence = `Zavi ${raise ? "raises" : "lowers"} the ${what} of ${label(body)} in LinkedIn Campaign Manager from ${fmt(body.expected_current)} to ${fmt(body.proposed)}.${raise ? ` That is ${fmt({ amount: ((minor(body.proposed.amount) - minor(body.expected_current.amount)) / 100).toFixed(2), currency: body.proposed.currency })} more ${body.kind === "daily" ? "a day" : "over the campaign"}.` : ""}${funded} If LinkedIn shows a different current budget when this is approved, nothing changes.`;
  return card(
    `${raise ? "Raise" : "Lower"} the ${what} of LinkedIn campaign "${body.name}" to ${fmt(body.proposed)}`,
    sentence,
    body.rationale,
    [
      { item: `${body.kind === "daily" ? "Daily" : "Total"} budget of "${body.name}"`, before: fmt(body.expected_current), after: fmt(body.proposed) },
      ...(body.funded_by ? [{ item: "Paired with", before: `Cut to "${body.funded_by.name}" (separate card)`, after: "Approved on its own" }] : []),
    ],
    managerLink(body.account_id, body.campaign_id),
  );
}

export function buildLinkedInTargetingCardBody(body: LinkedInTargetingBody): Card {
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "none");
  const added = body.places_after.filter((p) => !body.places_before.includes(p));
  const removed = body.places_before.filter((p) => !body.places_after.includes(p));
  const sentence = `Zavi changes where ${label(body)} shows in LinkedIn Campaign Manager: ${added.length ? `adds ${list(added)}` : ""}${added.length && removed.length ? "; " : ""}${removed.length ? `removes ${list(removed)}` : ""}. Everything else about its audience stays as it is. If the campaign's targeting was edited in LinkedIn after this card was written, nothing changes. To undo it, ask Zavi to set the locations back to ${list(body.places_before)}.`;
  return card(
    `Change the locations of LinkedIn campaign "${body.name}"`,
    sentence,
    body.rationale,
    [{ item: `Locations of "${body.name}"`, before: list(body.places_before), after: list(body.places_after) }],
    managerLink(body.account_id, body.campaign_id),
  );
}

export const LINKEDIN_SET_STATUS_CLASS = "linkedin_ads.set_status";
export const LINKEDIN_CAMPAIGN_EDIT_CLASS = "linkedin_ads.update_campaign";
export const LINKEDIN_GROUP_EDIT_CLASS = "linkedin_ads.update_campaign_group";
export const LINKEDIN_ARCHIVE_CLASS = "linkedin_ads.archive";
export const LINKEDIN_AD_STATUS_CLASS = "linkedin_ads.set_ad_status";
export const LINKEDIN_CREATE_AD_CLASS = "linkedin_ads.create_ad";
export const LINKEDIN_SWAP_AD_CLASS = "linkedin_ads.swap_ad";
export const LINKEDIN_CREATE_CAMPAIGN_CLASS = "linkedin_ads.create_campaign";
export const LINKEDIN_DUPLICATE_CLASS = "linkedin_ads.duplicate";

export const LINKEDIN_CARD_CLASSES = [
  LINKEDIN_RESUME_CLASS,
  LINKEDIN_BUDGET_CLASS,
  LINKEDIN_TARGETING_CLASS,
  LINKEDIN_CAMPAIGN_EDIT_CLASS,
  LINKEDIN_GROUP_EDIT_CLASS,
  LINKEDIN_ARCHIVE_CLASS,
  LINKEDIN_AD_STATUS_CLASS,
  LINKEDIN_CREATE_AD_CLASS,
  LINKEDIN_SWAP_AD_CLASS,
  LINKEDIN_CREATE_CAMPAIGN_CLASS,
  LINKEDIN_DUPLICATE_CLASS,
] as const;

export const LINKEDIN_CGO_DOOR_CLASSES: ReadonlySet<string> = new Set([
  LINKEDIN_RESUME_CLASS,
  LINKEDIN_BUDGET_CLASS,
  LINKEDIN_CAMPAIGN_EDIT_CLASS,
  LINKEDIN_GROUP_EDIT_CLASS,
  LINKEDIN_CREATE_AD_CLASS,
  LINKEDIN_SWAP_AD_CLASS,
  LINKEDIN_CREATE_CAMPAIGN_CLASS,
  LINKEDIN_DUPLICATE_CLASS,
]);

const isoOrNull = z.string().datetime().nullable();
const shortName = z.string().min(1).max(255);
const pair = <T extends z.ZodTypeAny>(v: T) => z.object({ before: v, after: v }).strict();

export const linkedinCampaignEditBodySchema = z
  .object({
    campaign_id: numericId,
    account_id: numericId,
    name: z.string().min(1).max(300),
    origin: linkedinCardOrigin.optional(),
    rationale: z.string().min(1).max(2000),
    last_modified_at: isoOrNull,
    changes: z
      .object({
        name: pair(shortName).optional(),
        run_end_at: pair(isoOrNull).optional(),
        unit_cost: pair(linkedinMoney).optional(),
        audience_expansion: pair(z.boolean()).optional(),
        offsite_delivery: pair(z.boolean()).optional(),
        targeting: z.object({ before_fingerprint: z.string().min(1), after_criteria: z.unknown(), summary_before: z.string().max(2000), summary_after: z.string().max(2000) }).strict().optional(),
      })
      .strict()
      .refine((c) => Object.keys(c).length > 0, "at least one change"),
  })
  .strict();
export type LinkedInCampaignEditBody = z.infer<typeof linkedinCampaignEditBodySchema>;

export const linkedinGroupEditBodySchema = z
  .object({
    group_id: numericId,
    account_id: numericId,
    name: z.string().min(1).max(300),
    origin: linkedinCardOrigin.optional(),
    rationale: z.string().min(1).max(2000),
    last_modified_at: isoOrNull,
    changes: z
      .object({
        name: pair(shortName).optional(),
        status: pair(z.enum(["ACTIVE", "PAUSED"])).optional(),
        run_end_at: pair(isoOrNull).optional(),
        total_budget: pair(linkedinMoney.nullable()).optional(),
      })
      .strict()
      .refine((c) => Object.keys(c).length > 0, "at least one change"),
  })
  .strict();
export type LinkedInGroupEditBody = z.infer<typeof linkedinGroupEditBodySchema>;

export const linkedinArchiveBodySchema = z
  .object({
    target: z.enum(["campaign_group", "campaign", "creative"]),
    id: numericId,
    account_id: numericId,
    campaign_id: numericId.nullable(),
    name: z.string().min(1).max(300),
    expected_status: z.string().min(1).max(40),
    mode: z.enum(["archive", "delete"]),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
export type LinkedInArchiveBody = z.infer<typeof linkedinArchiveBodySchema>;

export const linkedinAdStatusBodySchema = z
  .object({
    creative_id: numericId,
    campaign_id: numericId,
    account_id: numericId,
    campaign_name: z.string().min(1).max(300),
    ad_name: z.string().min(1).max(300),
    expected_status: z.enum(["ACTIVE", "PAUSED", "DRAFT"]),
    status: z.enum(["ACTIVE", "PAUSED"]),
    origin: linkedinCardOrigin.optional(),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
export type LinkedInAdStatusBody = z.infer<typeof linkedinAdStatusBodySchema>;

export const linkedinAdSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("post"), post_urn: z.string().regex(/^urn:li:(share|ugcPost):\d{1,25}$/) }).strict(),
  z
    .object({
      kind: z.literal("inline"),
      commentary: z.string().min(1).max(3000),
      headline: z.string().max(200).optional(),
      landing_url: z.string().url().max(2000).optional(),
      image_urn: z.string().regex(/^urn:li:image:[A-Za-z0-9_-]{1,80}$/).optional(),
      ad_name: shortName,
    })
    .strict(),
]);
export type LinkedInAdSource = z.infer<typeof linkedinAdSourceSchema>;

export const linkedinCreateAdBodySchema = z
  .object({
    campaign_id: numericId,
    account_id: numericId,
    campaign_name: z.string().min(1).max(300),
    campaign_status: z.string().min(1).max(40),
    associated_entity: z.string().regex(/^urn:li:organization:\d+$/),
    source: linkedinAdSourceSchema,
    go_live: z.boolean(),
    expected_ad_count: z.number().int().min(0).max(100),
    origin: linkedinCardOrigin.optional(),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
export type LinkedInCreateAdBody = z.infer<typeof linkedinCreateAdBodySchema>;

export const linkedinSwapAdBodySchema = z
  .object({
    campaign_id: numericId,
    account_id: numericId,
    campaign_name: z.string().min(1).max(300),
    associated_entity: z.string().regex(/^urn:li:organization:\d+$/),
    old_creative_id: numericId,
    old_ad_name: z.string().min(1).max(300),
    source: linkedinAdSourceSchema,
    origin: linkedinCardOrigin.optional(),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
export type LinkedInSwapAdBody = z.infer<typeof linkedinSwapAdBodySchema>;

export const linkedinCreateCampaignBodySchema = z
  .object({
    account_id: numericId,
    group_id: numericId,
    group_name: z.string().min(1).max(300),
    expected_group_status: z.string().min(1).max(40),
    name: shortName,
    daily_budget: linkedinMoney,
    unit_cost: linkedinMoney,
    geo_urns: z.array(z.string().regex(/^urn:li:geo:\d+$/)).min(1).max(50),
    excluded_geo_urns: z.array(z.string().regex(/^urn:li:geo:\d+$/)).max(50).optional(),
    country: z.string().regex(/^[A-Z]{2}$/),
    language: z.string().regex(/^[a-z]{2}$/),
    associated_entity: z.string().regex(/^urn:li:organization:\d+$/),
    audience: z.unknown().optional(),
    objective_type: z.string().min(1).max(60).nullable(),
    post_urn: z.string().regex(/^urn:li:(share|ugcPost):\d{1,25}$/).nullable(),
    places: z.array(z.string().min(1).max(200)).max(50),
    origin: linkedinCardOrigin.optional(),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
export type LinkedInCreateCampaignBody = z.infer<typeof linkedinCreateCampaignBodySchema>;

export const linkedinDuplicateBodySchema = z
  .object({
    target: z.enum(["campaign_group", "campaign", "creative"]),
    source_id: numericId,
    account_id: numericId,
    source_name: z.string().min(1).max(300),
    new_name: shortName,
    group_id: numericId.nullable(),
    campaign_id: numericId.nullable(),
    copy_ads: z.boolean(),
    source_last_modified_at: isoOrNull,
    origin: linkedinCardOrigin.optional(),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
export type LinkedInDuplicateBody = z.infer<typeof linkedinDuplicateBodySchema>;

const later = (before: string | null, after: string | null) => after === null ? before !== null : before !== null && Date.parse(after) > Date.parse(before);

export function linkedinCampaignEditRaisesSpend(b: LinkedInCampaignEditBody): boolean {
  const c = b.changes;
  if (c.unit_cost && minor(c.unit_cost.after.amount) > minor(c.unit_cost.before.amount)) return true;
  if (c.run_end_at && later(c.run_end_at.before, c.run_end_at.after)) return true;
  if (c.audience_expansion && c.audience_expansion.after && !c.audience_expansion.before) return true;
  if (c.offsite_delivery && c.offsite_delivery.after && !c.offsite_delivery.before) return true;
  if (c.targeting) return true;
  return false;
}

export function linkedinGroupEditRaisesSpend(b: LinkedInGroupEditBody): boolean {
  const c = b.changes;
  if (c.status && c.status.after === "ACTIVE" && c.status.before !== "ACTIVE") return true;
  if (c.run_end_at && later(c.run_end_at.before, c.run_end_at.after)) return true;
  if (c.total_budget) {
    if (c.total_budget.after === null) return c.total_budget.before !== null;
    if (c.total_budget.before === null) return false;
    return minor(c.total_budget.after.amount) > minor(c.total_budget.before.amount);
  }
  return false;
}

export function linkedinCardRaisesSpend(execClass: string, payload: unknown): boolean {
  switch (execClass) {
    case LINKEDIN_CAMPAIGN_EDIT_CLASS: {
      const p = linkedinCampaignEditBodySchema.safeParse(payload);
      return p.success ? linkedinCampaignEditRaisesSpend(p.data) : true;
    }
    case LINKEDIN_GROUP_EDIT_CLASS: {
      const p = linkedinGroupEditBodySchema.safeParse(payload);
      return p.success ? linkedinGroupEditRaisesSpend(p.data) : true;
    }
    case LINKEDIN_AD_STATUS_CLASS: {
      const p = linkedinAdStatusBodySchema.safeParse(payload);
      return p.success ? p.data.status === "ACTIVE" : true;
    }
    case LINKEDIN_CREATE_AD_CLASS: {
      const p = linkedinCreateAdBodySchema.safeParse(payload);
      return p.success ? p.data.go_live : true;
    }
    case LINKEDIN_SWAP_AD_CLASS:
    case LINKEDIN_CREATE_CAMPAIGN_CLASS:
    case LINKEDIN_DUPLICATE_CLASS:
      return true;
    case LINKEDIN_ARCHIVE_CLASS:
      return false;
    default:
      return false;
  }
}

export function linkedinArchiveNeedsAdmin(payload: unknown): boolean {
  const p = linkedinArchiveBodySchema.safeParse(payload);
  return p.success ? p.data.mode === "delete" : true;
}

const money = (m: { amount: string; currency: string } | null) => (m ? fmt(m) : "none");
const onOff = (v: boolean) => (v ? "On" : "Off");
const dayOrOpen = (iso: string | null) => day(iso) ?? "No end date";
const TARGET_WORD = { campaign_group: "campaign group", campaign: "campaign", creative: "ad" } as const;

export function buildLinkedInCampaignEditCardBody(body: LinkedInCampaignEditBody): Card {
  const c = body.changes;
  const rows: Array<{ item: string; before: string; after: string }> = [];
  const parts: string[] = [];
  if (c.name) { rows.push({ item: "Name", before: c.name.before, after: c.name.after }); parts.push(`renames it to "${c.name.after}"`); }
  if (c.run_end_at) { rows.push({ item: "End date", before: dayOrOpen(c.run_end_at.before), after: dayOrOpen(c.run_end_at.after) }); parts.push(`sets its end date to ${c.run_end_at.after ? `${day(c.run_end_at.after)} UTC` : "no end date"}`); }
  if (c.unit_cost) { rows.push({ item: "Bid", before: fmt(c.unit_cost.before), after: fmt(c.unit_cost.after) }); parts.push(`${minor(c.unit_cost.after.amount) > minor(c.unit_cost.before.amount) ? "raises" : "lowers"} its bid from ${fmt(c.unit_cost.before)} to ${fmt(c.unit_cost.after)}`); }
  if (c.audience_expansion) { rows.push({ item: "Audience expansion", before: onOff(c.audience_expansion.before), after: onOff(c.audience_expansion.after) }); parts.push(`turns audience expansion ${c.audience_expansion.after ? "on" : "off"}`); }
  if (c.offsite_delivery) { rows.push({ item: "LinkedIn Audience Network", before: onOff(c.offsite_delivery.before), after: onOff(c.offsite_delivery.after) }); parts.push(`turns the LinkedIn Audience Network ${c.offsite_delivery.after ? "on" : "off"}`); }
  if (c.targeting) { rows.push({ item: "Audience", before: c.targeting.summary_before, after: c.targeting.summary_after }); parts.push(`changes its audience to ${c.targeting.summary_after}`); }
  const sentence = `Zavi edits ${label(body)} in LinkedIn Campaign Manager: ${parts.join("; ")}. Everything else stays as it is. If the campaign was edited in LinkedIn after this card was written, nothing changes.`;
  return card(`Edit the LinkedIn campaign "${body.name}"`, sentence, body.rationale, rows, managerLink(body.account_id, body.campaign_id), "Campaign change");
}

export function buildLinkedInGroupEditCardBody(body: LinkedInGroupEditBody): Card {
  const c = body.changes;
  const rows: Array<{ item: string; before: string; after: string }> = [];
  const parts: string[] = [];
  if (c.name) { rows.push({ item: "Name", before: c.name.before, after: c.name.after }); parts.push(`renames it to "${c.name.after}"`); }
  if (c.status) { rows.push({ item: "Status", before: c.status.before === "ACTIVE" ? "Active" : "Paused", after: c.status.after === "ACTIVE" ? "Active" : "Paused" }); parts.push(c.status.after === "ACTIVE" ? "switches it on, so every active campaign in it spends again" : "pauses it, so every campaign in it stops spending"); }
  if (c.run_end_at) { rows.push({ item: "End date", before: dayOrOpen(c.run_end_at.before), after: dayOrOpen(c.run_end_at.after) }); parts.push(`sets its end date to ${c.run_end_at.after ? `${day(c.run_end_at.after)} UTC` : "no end date"}`); }
  if (c.total_budget) { rows.push({ item: "Total budget", before: money(c.total_budget.before), after: money(c.total_budget.after) }); parts.push(c.total_budget.after ? `sets its total budget to ${fmt(c.total_budget.after)}` : "removes its total budget"); }
  const sentence = `Zavi edits the campaign group "${body.name}" in LinkedIn Campaign Manager: ${parts.join("; ")}. If the group was edited in LinkedIn after this card was written, nothing changes.`;
  return card(`Edit the LinkedIn campaign group "${body.name}"`, sentence, body.rationale, rows, groupsLink(body.account_id), "Campaign group change", `the link opens the Campaigns tab of Campaign Manager. Open "${body.name}" there. ${LI_NAMES}`);
}

const archiveWhere = (body: LinkedInArchiveBody) => {
  const after = body.mode === "delete" ? "once deleted it no longer shows in any list" : "once archived, set the status filter to Archived to see it";
  return body.target === "campaign_group"
    ? `the link opens the Campaigns tab of Campaign Manager. Find "${body.name}" there; ${after}. ${LI_NAMES}`
    : body.target === "creative"
      ? `the link opens ${body.campaign_id ? "the campaign the ad runs in" : "the list of campaigns"}. Find the ad "${body.name}" in its ads; ${after}.`
      : `the link opens ${body.campaign_id ? "this campaign" : "the list of campaigns"}; ${after}. ${LI_NAMES}`;
};

export function buildLinkedInArchiveCardBody(body: LinkedInArchiveBody): Card {
  const what = TARGET_WORD[body.target];
  const verb = body.mode === "delete" ? "deletes" : "archives";
  const sentence = body.mode === "delete"
    ? `Zavi deletes the LinkedIn ${what} "${body.name}". LinkedIn removes it for good; its past numbers stay in reports. Nothing happens if it is no longer ${body.expected_status.toLowerCase()} when this is approved.`
    : `Zavi archives the LinkedIn ${what} "${body.name}". It stops showing in the active lists and cannot spend; LinkedIn keeps its history and it can be un-archived in Campaign Manager. Nothing happens if it is no longer ${body.expected_status.toLowerCase()} when this is approved.`;
  const Verb = verb === "deletes" ? "Delete" : "Archive";
  return card(`${Verb} the LinkedIn ${what} "${body.name}"`, sentence, body.rationale, [{ item: `${what[0].toUpperCase()}${what.slice(1)} "${body.name}"`, before: body.expected_status.charAt(0) + body.expected_status.slice(1).toLowerCase(), after: body.mode === "delete" ? "Deleted" : "Archived" }], body.target === "campaign_group" ? groupsLink(body.account_id) : managerLink(body.account_id, body.campaign_id), `${what[0].toUpperCase()}${what.slice(1)} ${body.mode === "delete" ? "delete" : "archive"}`, archiveWhere(body));
}

export function buildLinkedInAdStatusCardBody(body: LinkedInAdStatusBody): Card {
  const on = body.status === "ACTIVE";
  const sentence = on
    ? `Zavi turns the ad "${body.ad_name}" back on in the LinkedIn campaign "${body.campaign_name}". It serves again, and spends, as soon as the campaign is running. If the ad is no longer ${body.expected_status.toLowerCase()} when this is approved, nothing changes.`
    : `Zavi turns the ad "${body.ad_name}" off in the LinkedIn campaign "${body.campaign_name}". The campaign keeps running on its other ads. Zavi refuses at approval if this is the campaign's last ad that is on, so a running campaign is never left with nothing to show.`;
  return card(`Turn ${on ? "on" : "off"} the LinkedIn ad "${body.ad_name}"`, sentence, body.rationale, [{ item: `Ad "${body.ad_name}"`, before: body.expected_status === "ACTIVE" ? "On" : body.expected_status === "DRAFT" ? "Draft" : "Off", after: on ? "On" : "Off" }], managerLink(body.account_id, body.campaign_id), `Ad ${on ? "on" : "off"}`, `the link opens the campaign "${body.campaign_name}". Find the ad "${body.ad_name}" in its ads. LinkedIn has no link to a single ad.`);
}

const sourceWords = (s: LinkedInAdSource) => (s.kind === "post" ? `the existing LinkedIn post ${s.post_urn}` : `a new direct ad${s.image_urn ? " with an image" : ""}${s.landing_url ? ` linking to ${s.landing_url}` : ""}`);
const sourceRows = (s: LinkedInAdSource): Array<{ item: string; before: string; after: string }> =>
  s.kind === "post"
    ? [{ item: "Ad content", before: "None", after: `Post ${s.post_urn}` }]
    : [
        { item: "Ad name", before: "None", after: s.ad_name },
        { item: "Text", before: "None", after: s.commentary },
        ...(s.headline ? [{ item: "Headline", before: "None", after: s.headline }] : []),
        ...(s.landing_url ? [{ item: "Landing page", before: "None", after: s.landing_url }] : []),
        ...(s.image_urn ? [{ item: "Image", before: "None", after: s.image_urn }] : []),
      ];

export function buildLinkedInCreateAdCardBody(body: LinkedInCreateAdBody): Card {
  const sentence = `Zavi adds ${sourceWords(body.source)} as an ad in the LinkedIn campaign "${body.campaign_name}", ${body.go_live ? "switched on, so it serves and spends as soon as LinkedIn's review passes and the campaign is running" : "paused, so it spends nothing until someone turns it on"}. The campaign has ${body.expected_ad_count} ${body.expected_ad_count === 1 ? "ad" : "ads"} now; if that changed in LinkedIn after this card was written, nothing is created.`;
  return card(`Add an ad to the LinkedIn campaign "${body.campaign_name}"`, sentence, body.rationale, [...sourceRows(body.source), { item: "Ad status", before: "None", after: body.go_live ? "On" : "Paused" }, { item: `Ads in "${body.campaign_name}"`, before: String(body.expected_ad_count), after: String(body.expected_ad_count + 1) }], managerLink(body.account_id, body.campaign_id), undefined, `the link opens the campaign "${body.campaign_name}". The new ad shows in its ads once created.`);
}

export function buildLinkedInSwapAdCardBody(body: LinkedInSwapAdBody): Card {
  const sentence = `Zavi replaces the ad "${body.old_ad_name}" in the LinkedIn campaign "${body.campaign_name}": it adds ${sourceWords(body.source)} switched on, then turns "${body.old_ad_name}" off. The campaign's budget and audience do not change. If "${body.old_ad_name}" is no longer on when this is approved, nothing changes.`;
  return card(`Replace the LinkedIn ad "${body.old_ad_name}"`, sentence, body.rationale, [{ item: `Ad "${body.old_ad_name}"`, before: "On", after: "Off" }, ...sourceRows(body.source), { item: "New ad status", before: "None", after: "On" }], managerLink(body.account_id, body.campaign_id), "Ad swap", `the link opens the campaign "${body.campaign_name}". Both ads show in its ads: the new one on, "${body.old_ad_name}" off.`);
}

export function buildLinkedInCreateCampaignCardBody(body: LinkedInCreateCampaignBody): Card {
  const sentence = `Zavi creates the campaign "${body.name}" paused in the LinkedIn campaign group "${body.group_name}", with a ${fmt(body.daily_budget)} daily budget, a ${fmt(body.unit_cost)} bid and ${body.places.length ? body.places.join(", ") : "the listed locations"} as its audience${body.post_urn ? `, promoting the post ${body.post_urn} as a paused ad` : ", with no ad yet"}. Nothing spends until someone switches it on.`;
  return card(`Create the LinkedIn campaign "${body.name}" in "${body.group_name}"`, sentence, body.rationale, [
    { item: "Campaign", before: "None", after: `"${body.name}" (paused)` },
    { item: "Campaign group", before: body.group_name, after: body.group_name },
    { item: "Daily budget", before: "None", after: fmt(body.daily_budget) },
    { item: "Bid", before: "None", after: fmt(body.unit_cost) },
    { item: "Locations", before: "None", after: body.places.join(", ") || "As listed" },
    ...(body.post_urn ? [{ item: "Ad", before: "None", after: `Post ${body.post_urn} (paused)` }] : []),
  ], managerLink(body.account_id), "Campaign", `the link opens the list of campaigns. Find the paused campaign "${body.name}" there once created; it sits under "${body.group_name}". ${LI_NAMES}`);
}

export function buildLinkedInDuplicateCardBody(body: LinkedInDuplicateBody): Card {
  const what = TARGET_WORD[body.target];
  const ads = body.target === "campaign" ? (body.copy_ads ? " with copies of its ads, all paused" : " without its ads") : body.target === "campaign_group" ? (body.copy_ads ? " with paused copies of its campaigns and their ads" : " with paused copies of its campaigns, without ads") : "";
  const sentence = `Zavi copies the LinkedIn ${what} "${body.source_name}" as "${body.new_name}"${ads}. The copy is created paused with the same settings, so nothing spends until someone switches it on. If "${body.source_name}" was edited in LinkedIn after this card was written, nothing is created.`;
  return card(`Copy the LinkedIn ${what} "${body.source_name}"`, sentence, body.rationale, [{ item: `${what[0].toUpperCase()}${what.slice(1)}`, before: `"${body.source_name}"`, after: `"${body.new_name}" (paused copy)` }], body.target === "campaign_group" ? groupsLink(body.account_id) : managerLink(body.account_id), `${what[0].toUpperCase()}${what.slice(1)} copy`, `the link opens the ${body.target === "campaign_group" ? "Campaigns tab" : "list of campaigns"} in Campaign Manager. Find the paused copy "${body.new_name}" there once created.${body.target === "creative" ? "" : ` ${LI_NAMES}`}`);
}
