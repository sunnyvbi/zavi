
import { z } from "zod";
import { ExpectedToolError } from "@/services/tools/types";
import { withLinkedInAdsToken } from "./client";
import { linkedinAdsGet, linkedinAdsPost, linkedinCreativePath, type LinkedInCreateStep } from "./http";
import { inFlightResolvable, type LinkedInCreationJournal } from "./creation-progress";
import { assertPostFromPage, readPublicPost, type PostAuthor } from "./post-link";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { getAccountBinding, bindCampaign } from "@/services/ads-wallet/bindings";
import { accountChoices, connectCustomerAccount, assertAccountAvailableForNewCampaign } from "@/services/ads-wallet/accounts";
import { resolveLinkedinAccount } from "@/services/ads-wallet/adapters/linkedin-account";
import { linkedinAudienceSchema, linkedinTargetingCriteria } from "@zavi/shared";

const numericId = z.string().regex(/^\d{1,20}$/, "a bare numeric LinkedIn id");
const money = z.object({ amount: z.string().regex(/^\d+(\.\d{1,2})?$/), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();

export const linkedinBundleGroup = z.object({ name: z.string().min(1).max(200) }).strict();
export const linkedinBundleCampaign = z
  .object({
    name: z.string().min(1).max(255),
    daily_budget: money,
    unit_cost: money,
    geo_urns: z.array(z.string().regex(/^urn:li:geo:\d+$/)).min(1).max(50),
    excluded_geo_urns: z.array(z.string().regex(/^urn:li:geo:\d+$/)).max(50).optional(),
    country: z.string().regex(/^[A-Z]{2}$/),
    language: z.string().regex(/^[a-z]{2}$/),
    associated_entity: z.string().regex(/^urn:li:organization:\d+$/),
    audience: linkedinAudienceSchema.optional(),
  })
  .strict();
export const linkedinBundleCreative = z
  .object({ post_urn: z.string().regex(/^urn:li:(share|ugcPost):\d+$/) })
  .strict();

export type LinkedInCampaignBundle = {
  group: z.infer<typeof linkedinBundleGroup>;
  campaign: z.infer<typeof linkedinBundleCampaign>;
  creative: z.infer<typeof linkedinBundleCreative>;
};

const CREATE_STEPS: Record<"group_id" | "campaign_id" | "creative_id", LinkedInCreateStep> = { group_id: "campaign group", campaign_id: "campaign", creative_id: "ad" };

const li = (amount: { amount: string; currency: string }) => ({ amount: amount.amount, currencyCode: amount.currency });

const linkedinCampaignLocale = (campaign: z.infer<typeof linkedinBundleCampaign>) => campaign.language === "en" ? { country: "US", language: "en" } : { country: campaign.country, language: campaign.language };

export function linkedinCampaignTargeting(campaign: z.infer<typeof linkedinBundleCampaign>) {
  const locale = linkedinCampaignLocale(campaign);
  return linkedinTargetingCriteria(campaign.geo_urns, `${locale.language}_${locale.country}`, campaign.audience, campaign.excluded_geo_urns);
}

export const POST_AUTHOR_REFUSED = "linkedin_ads_post_author_refused";
export const AD_REFUSED_MEMBER_POST = "LinkedIn made the paused campaign but would not use this member's post as its ad. A Thought Leader ad needs the post's author to let your company page sponsor it: ask them to approve the request in LinkedIn. Nothing can spend without an ad.";
export const AD_REFUSED_POST = "LinkedIn made the paused campaign but would not use this post as its ad. Check that the post is public and that your company page can sponsor it. Nothing can spend without an ad.";
export const AD_REFUSED_PAGE_ROLE = "LinkedIn made the paused campaign but would not use this post as its ad, because the LinkedIn user connected to Zavi is not allowed to sponsor this page's posts. Ask a page admin to give that user the Sponsored Content poster role, or reconnect LinkedIn Ads with a LinkedIn user who has it. Nothing can spend without an ad.";
const PAGE_ROLE_DENIED = /\borganizationUgcAuthorizations\b/;
const adForbiddenCopy = (author: PostAuthor | null, e: ExpectedToolError) => author === "member" ? AD_REFUSED_MEMBER_POST : PAGE_ROLE_DENIED.test(String(e.meta?.linkedin_reason ?? "")) ? AD_REFUSED_PAGE_ROLE : AD_REFUSED_POST;
const POST_AUTHOR_REFUSED_AGAIN = "LinkedIn will not run this campaign's post as an ad, and Zavi already archived the paused campaign it had made, so nothing can spend and there is nothing left to finish. Start a new campaign with a post from the page this ad account advertises for, or a member's post.";
export const POST_MISSING = "post_missing";
const POST_GONE_LEAD = "The post this campaign promotes is no longer on LinkedIn, so Zavi stopped and closed this card.";
const POST_GONE_NEXT = "Start a new campaign with a post that is still on LinkedIn.";
const CONTENT_REFUSAL = new Set([400, 422]);
const NAMES_THE_POST = /(\bDIRECT_SPONSORED_CONTENT_MISMATCH\b|\bnot created by the account\b|\bcontent\.reference\b|\bauthor\b|\bassociatedEntity\b|\borganizationBrand\b)/i;

const archiveEntity = (token: string, path: string) =>
  linkedinAdsPost(token, path, "PARTIAL_UPDATE", { patch: { $set: { status: "ARCHIVED" } } }).then(() => true, () => false);

async function closeForMissingPost(token: string, account: string, journal?: LinkedInCreationJournal): Promise<never> {
  const made = { group_id: journal?.state.group_id ?? null, campaign_id: journal?.state.campaign_id ?? null };
  if (!made.group_id) throw new ExpectedToolError(POST_AUTHOR_REFUSED, `${POST_GONE_LEAD} Nothing was created in LinkedIn. ${POST_GONE_NEXT}`, { [POST_MISSING]: true });
  const campaign = made.campaign_id ? await archiveEntity(token, `adAccounts/${account}/adCampaigns/${made.campaign_id}`) : null;
  const group = campaign !== false && await archiveEntity(token, `adAccounts/${account}/adCampaignGroups/${made.group_id}`);
  if (journal && campaign) await journal.save({ ...journal.state, archived: true }).catch(() => undefined);
  const left = campaign === false
    ? "Zavi had already made a paused campaign with no ad and its campaign group. It could not archive them, but they stay paused with no ad, so nothing can spend."
    : campaign
      ? group ? "Zavi archived the paused campaign and campaign group it had already made, so nothing can spend." : "Zavi archived the paused campaign it had already made, so nothing can spend. Its empty campaign group stays paused."
      : group ? "Zavi archived the empty campaign group it had already made." : "The empty campaign group Zavi had already made stays paused, so nothing can spend.";
  throw new ExpectedToolError(POST_AUTHOR_REFUSED, `${POST_GONE_LEAD} ${left} ${POST_GONE_NEXT}`, { [POST_MISSING]: true, made, archived: { campaign: campaign === true, group } });
}

async function closeForPageMismatch(token: string, account: string, journal: LinkedInCreationJournal, refusal: ExpectedToolError): Promise<never> {
  const made = { group_id: journal.state.group_id, campaign_id: journal.state.campaign_id ?? null };
  if (!made.group_id || journal.state.in_flight) throw refusal;
  if (made.campaign_id && !(await archiveEntity(token, `adAccounts/${account}/adCampaigns/${made.campaign_id}`))) throw refusal;
  const group = await archiveEntity(token, `adAccounts/${account}/adCampaignGroups/${made.group_id}`);
  if (!made.campaign_id && !group) throw refusal;
  if (made.campaign_id) await journal.save({ ...journal.state, archived: true }).catch(() => undefined);
  const left = made.campaign_id
    ? `Zavi archived the paused campaign${group ? " and campaign group" : ""} it had already made, so nothing can spend${group ? "" : "; the empty campaign group stays paused in LinkedIn"}.`
    : "Zavi archived the empty campaign group it had already made, so nothing can spend.";
  throw new ExpectedToolError(POST_AUTHOR_REFUSED, `LinkedIn will not promote this post for this ad account, because it was published by another page, not the company page this ad account advertises for. ${left} Start a new campaign with a post from that company page, or a member's post.`, { ...refusal.meta, made, archived: { campaign: !!made.campaign_id, group } });
}

async function refuseForeignPost(token: string, account: string, made: { group_id: string | null; campaign_id: string | null }, refusal: ExpectedToolError, author: PostAuthor | null, journal?: LinkedInCreationJournal): Promise<void> {
  if (!made.campaign_id || !made.group_id) return;
  const status = (refusal.meta as { status?: unknown } | undefined)?.status;
  if (refusal.code !== "linkedin_ads_write_refused" || !(typeof status === "number" && CONTENT_REFUSAL.has(status)) || !NAMES_THE_POST.test(String((refusal.meta as { linkedin_reason?: unknown } | undefined)?.linkedin_reason ?? ""))) return;
  const archive = (path: string) => archiveEntity(token, path);
  if (!(await archive(`adAccounts/${account}/adCampaigns/${made.campaign_id}`))) return;
  const group = await archive(`adAccounts/${account}/adCampaignGroups/${made.group_id}`);
  if (journal) await journal.save({ ...journal.state, archived: true }).catch(() => undefined);
  throw new ExpectedToolError(
    POST_AUTHOR_REFUSED,
    `${author === "other_page" ? "LinkedIn refused the ad for this post, which a different page published (a Showcase or another company page), not the page this ad account advertises for." : "LinkedIn refused the ad for this post, and Zavi could not confirm who published it. LinkedIn only runs posts from the page this ad account advertises for, or a member's post that page may sponsor."} Zavi archived the paused campaign${group ? " and campaign group" : ""} it had just made, so nothing can spend${group ? "" : "; the empty campaign group stays paused in LinkedIn"}. Paste a post from that page, or a member's post, and approve a new campaign.`,
    { ...refusal.meta, made, archived: { campaign: true, group } },
  );
}

export async function pauseLinkedInCampaign(tenant_id: string, accountId: string, campaignId: string): Promise<void> {
  const a = numericId.parse(accountId);
  const c = numericId.parse(campaignId);
  await withLinkedInAdsToken(tenant_id, (token) =>
    linkedinAdsPost(token, `adAccounts/${a}/adCampaigns/${c}`, "PARTIAL_UPDATE", {
      patch: { $set: { status: "PAUSED" } },
    }),
  );
}

export type LiRawCampaign = {
  id?: number | string;
  account?: string;
  name?: string;
  status?: string;
  objectiveType?: string;
  type?: string;
  dailyBudget?: { amount: string; currencyCode: string };
  totalBudget?: { amount: string; currencyCode: string };
  runSchedule?: { start?: number; end?: number };
  targetingCriteria?: unknown;
  changeAuditStamps?: { lastModified?: { time?: number } };
};

export async function readLinkedInRawCampaignWithToken(token: string, accountId: string, campaignId: string): Promise<LiRawCampaign | null> {
  const a = numericId.parse(accountId);
  const c = numericId.parse(campaignId);
  const raw = await linkedinAdsGet<LiRawCampaign>(token, `adAccounts/${a}/adCampaigns/${c}`, {}, {}, { fresh: true }).catch((e) => {
    if (e instanceof ExpectedToolError && (e.meta as { status?: unknown } | undefined)?.status === 404) return null;
    throw e;
  });
  if (!raw || String(raw.id) !== c || raw.account !== `urn:li:sponsoredAccount:${a}`) return null;
  return raw;
}

export const readLinkedInRawCampaign = (tenant_id: string, accountId: string, campaignId: string) => withLinkedInAdsToken(tenant_id, (token) => readLinkedInRawCampaignWithToken(token, accountId, campaignId));

export async function resumeLinkedInCampaign(tenant_id: string, accountId: string, campaignId: string, runSchedule?: { start: number; end: number }): Promise<void> {
  const a = numericId.parse(accountId);
  const c = numericId.parse(campaignId);
  await withLinkedInAdsToken(tenant_id, (token) =>
    linkedinAdsPost(token, `adAccounts/${a}/adCampaigns/${c}`, "PARTIAL_UPDATE", {
      patch: { $set: { status: "ACTIVE", ...(runSchedule ? { runSchedule } : {}) } },
    }),
  );
}

export async function updateLinkedInCampaignBudget(tenant_id: string, accountId: string, campaignId: string, kind: "daily" | "total", budget: { amount: string; currency: string }): Promise<void> {
  const a = numericId.parse(accountId);
  const c = numericId.parse(campaignId);
  const b = money.parse(budget);
  await withLinkedInAdsToken(tenant_id, (token) =>
    linkedinAdsPost(token, `adAccounts/${a}/adCampaigns/${c}`, "PARTIAL_UPDATE", {
      patch: { $set: { [kind === "daily" ? "dailyBudget" : "totalBudget"]: li(b) } },
    }),
  );
}

export async function updateLinkedInCampaignTargeting(tenant_id: string, accountId: string, campaignId: string, targetingCriteria: unknown): Promise<void> {
  const a = numericId.parse(accountId);
  const c = numericId.parse(campaignId);
  if (!JSON.stringify(targetingCriteria ?? null).includes("urn:li:adTargetingFacet:interfaceLocales"))
    throw new ExpectedToolError("linkedin_ads_targeting_invalid", "A LinkedIn targeting write must keep the interface locale; nothing was sent.");
  await withLinkedInAdsToken(tenant_id, (token) =>
    linkedinAdsPost(token, `adAccounts/${a}/adCampaigns/${c}`, "PARTIAL_UPDATE", {
      patch: { $set: { targetingCriteria } },
    }),
  );
}

export const NOTHING_SENT = "nothing_sent";
export const LINKEDIN_ACCOUNT_DISABLED = "linkedin_ads_account_disabled";
export const NOT_STARTED = "linkedin_ads_not_started";
export const CHANGED_IN_LINKEDIN = "changed_in_linkedin";
export const ACCOUNT_CHANGED = "linkedin_ads_account_changed";
export const SAVED_ACCOUNT_CHANGED = "Your LinkedIn ad account changed since this campaign was drafted. Start a new campaign.";
export const ZAVI_SAVE_FAILED = "zavi_save_failed";
export const PROGRESS_UNSAVED = "progress_unsaved";

type Found = { elements?: Array<{ id?: number | string; campaignGroup?: unknown; campaign?: unknown; content?: { reference?: unknown } }>; metadata?: { nextPageToken?: string | null } };

async function findInFlight(token: string, a: string, step: "campaign_id" | "creative_id", parent: string, postUrn: string): Promise<string | null> {
  const page = step === "campaign_id"
    ? await linkedinAdsGet<Found>(token, `adAccounts/${a}/adCampaigns`, { q: "search", pageSize: 100, search: { campaignGroup: { values: [`urn:li:sponsoredCampaignGroup:${parent}`] } } }, {}, { fresh: true })
    : await linkedinAdsGet<Found>(token, `adAccounts/${a}/creatives`, { q: "criteria", campaigns: [`urn:li:sponsoredCampaign:${parent}`], pageSize: 100 }, {}, { restliMethod: "FINDER", fresh: true });
  if (!Array.isArray(page.elements) || page.metadata?.nextPageToken)
    throw new ExpectedToolError("linkedin_ads_bad_response", "LinkedIn did not list what Zavi made clearly, so Zavi could not check the step it was on.");
  const found = page.elements;
  if (found.length === 0) return null;
  const one = found[0];
  const fits = step === "campaign_id"
    ? one.campaignGroup === `urn:li:sponsoredCampaignGroup:${parent}`
    : one.campaign === `urn:li:sponsoredCampaign:${parent}` && one.content?.reference === postUrn;
  if (found.length > 1 || !fits)
    throw new ExpectedToolError("exec_partial", `The ${step === "campaign_id" ? "campaign group Zavi made holds campaigns Zavi did not make" : "campaign Zavi made holds ads Zavi did not make"} in LinkedIn, outside Zavi.`, { [CHANGED_IN_LINKEDIN]: true });
  return numericId.parse(String(one.id ?? "").replace(/^urn:li:sponsoredCreative:/, ""));
}

export async function createLinkedInCampaignBundle(
  tenant_id: string,
  accountId: string,
  bundle: LinkedInCampaignBundle,
  accountBindingId?: string,
  journal?: LinkedInCreationJournal,
): Promise<{ group_id: string; campaign_id: string; creative_id: string }> {
  const sending = { started: false };
  try {
    return await writeLinkedInCampaignBundle(tenant_id, accountId, bundle, sending, accountBindingId, journal);
  } catch (e) {
    if (sending.started) throw e;
    throw e instanceof ExpectedToolError
      ? new ExpectedToolError(e.code, e.message, { ...e.meta, [NOTHING_SENT]: true })
      : new ExpectedToolError(NOT_STARTED, e instanceof Error ? e.message : String(e), { [NOTHING_SENT]: true });
  }
}

async function writeLinkedInCampaignBundle(
  tenant_id: string,
  accountId: string,
  bundle: LinkedInCampaignBundle,
  sending: { started: boolean },
  accountBindingId?: string,
  journal?: LinkedInCreationJournal,
): Promise<{ group_id: string; campaign_id: string; creative_id: string }> {
  if (journal?.state.in_flight && !inFlightResolvable(journal.state))
    throw new ExpectedToolError("exec_partial", "A previous create may have reached LinkedIn. Zavi will not repeat it until its outcome is reconciled.");
  if (journal?.state.archived) throw new ExpectedToolError(POST_AUTHOR_REFUSED, POST_AUTHOR_REFUSED_AGAIN);
  const a = numericId.parse(accountId);
  const group = linkedinBundleGroup.parse(bundle.group);
  const campaign = linkedinBundleCampaign.parse(bundle.campaign);
  const creative = linkedinBundleCreative.parse(bundle.creative);
  if (!(Number(campaign.unit_cost.amount) > 0))
    throw new ExpectedToolError("linkedin_ads_bid_invalid", "This campaign has no bid above 0, which LinkedIn refuses. Nothing was created. Review the campaign and enter a bid, then approve it again.");
  const binding = await getAccountBinding(tenant_id, accountBindingId ?? await connectCustomerAccount(tenant_id,"linkedin",a,false));
  if ((await accountChoices(tenant_id,"linkedin")).accounts.some((b)=>b.id===binding.id&&b.disabled))
    throw new ExpectedToolError(LINKEDIN_ACCOUNT_DISABLED,"You turned this ad account off in Zavi with Stop using this account. Nothing was created in LinkedIn. Turn it back on with Use this account again, or review the campaign with another account, then approve it again.");
  await assertAccountAvailableForNewCampaign(tenant_id,binding);
  const {token,account} = await resolveLinkedinAccount(tenant_id,binding,true);
  if(account.id!==a || account.currency!==campaign.daily_budget.currency || account.currency!==campaign.unit_cost.currency || account.reference!==campaign.associated_entity) {
    throw new ExpectedToolError("ads_account_mismatch","The approved account, company or currency changed. Review the campaign again.");
  }
  const author: PostAuthor | null = journal?.state.creative_id ? null : await assertPostFromPage(token, creative.post_urn, campaign.associated_entity, () => readPublicPost(creative.post_urn)).catch((e: unknown) => {
    if (e instanceof ExpectedToolError && e.code === "linkedin_ads_post_page_mismatch" && journal?.state.group_id) {
      sending.started = true;
      return closeForPageMismatch(token, a, journal, e);
    }
    if (!(e instanceof ExpectedToolError && e.code === "linkedin_ads_post_not_found")) throw e;
    if (journal?.state.group_id) sending.started = true;
    return closeForMissingPost(token, a, journal);
  });
  if (journal?.state.account_binding_id && journal.state.account_binding_id !== binding.id)
    throw new ExpectedToolError(ACCOUNT_CHANGED, SAVED_ACCOUNT_CHANGED);
  if (journal) await journal.save({ ...journal.state, account_binding_id: binding.id });
  const made = { group_id: journal?.state.group_id ?? null, campaign_id: journal?.state.campaign_id ?? null, creative_id: journal?.state.creative_id ?? null };
  const pending = journal?.state.in_flight;
  if (journal && (pending === "campaign_id" || pending === "creative_id")) {
    const parent = pending === "campaign_id" ? made.group_id : made.campaign_id;
    if (!parent) throw new ExpectedToolError("exec_partial", "A previous create may have reached LinkedIn. Zavi will not repeat it until its outcome is reconciled.");
    const found = await findInFlight(token, a, pending, parent, creative.post_urn);
    await journal.save({ ...journal.state, [pending]: found, in_flight: null });
    made[pending] = found;
  }
  const verify = (ok: boolean, change: string) => {
    if (!ok) throw new ExpectedToolError("exec_partial", `The ${change} in LinkedIn, outside Zavi.`, { [CHANGED_IN_LINKEDIN]: true });
  };
  if (made.group_id) {
    const g = await linkedinAdsGet<{ id: number | string; account: string; name: string; status: string }>(token, `adAccounts/${a}/adCampaignGroups/${made.group_id}`);
    verify(String(g.id) === made.group_id && g.account === `urn:li:sponsoredAccount:${a}`, "campaign group Zavi made was moved out of this ad account");
    verify(journal?.state.group_paused ? g.status === "PAUSED" : ["ACTIVE", "PAUSED"].includes(g.status), "campaign group Zavi made was switched on or archived");
  }
  if (made.campaign_id) {
    const c = await linkedinAdsGet<Record<string, unknown>>(token, `adAccounts/${a}/adCampaigns/${made.campaign_id}`);
    const inCurrency = (m: unknown) => m == null || (m as { currencyCode?: unknown }).currencyCode === account.currency;
    verify(String(c.id) === made.campaign_id && c.account === `urn:li:sponsoredAccount:${a}` && c.campaignGroup === `urn:li:sponsoredCampaignGroup:${made.group_id}` && c.associatedEntity === campaign.associated_entity && c.type === "SPONSORED_UPDATES" && inCurrency(c.dailyBudget) && inCurrency(c.unitCost), "campaign Zavi made was moved to another ad account, campaign group or company page");
    verify(c.status === "PAUSED", "campaign Zavi made is no longer paused");
  }
  if (made.creative_id) {
    const c = await linkedinAdsGet<{ id: number | string; campaign: string; content?: { reference?: string }; intendedStatus: string }>(token, linkedinCreativePath(a, made.creative_id));
    verify(String(c.id).replace(/^urn:li:sponsoredCreative:/, "") === made.creative_id && c.campaign === `urn:li:sponsoredCampaign:${made.campaign_id}` && c.content?.reference === creative.post_urn, "ad Zavi made was moved to another campaign or post");
    verify(["DRAFT", "PAUSED"].includes(c.intendedStatus), "ad Zavi made was switched on or archived");
  }

  const wrap = (e: unknown): ExpectedToolError =>
    e instanceof ExpectedToolError
      ? new ExpectedToolError(e.code, e.message, { ...e.meta, made })
      : new ExpectedToolError(
          "linkedin_ads_outcome_unknown",
          `The request to LinkedIn did not come back clearly, so this step may or may not exist.${e instanceof Error ? ` (${e.message})` : ""}`,
          { made },
        );
  const create = async (key: "group_id" | "campaign_id" | "creative_id", path: string, body: Record<string, unknown>): Promise<string> => {
    if (made[key]) return made[key];
    if (journal) await journal.save({ ...journal.state, in_flight: key });
    sending.started = true;
    let id: string | null;
    try {
      ({ id } = await linkedinAdsPost(token, path, "CREATE", body, CREATE_STEPS[key]));
    } catch (e) {
      if (journal && e instanceof ExpectedToolError && ["linkedin_ads_write_refused", "linkedin_ads_forbidden", "linkedin_ads_token_revoked", "linkedin_ads_bad_path"].includes(e.code))
        await journal.save({ ...journal.state, in_flight: null });
      throw wrap(e);
    }
    if (!id) {
      throw new ExpectedToolError("linkedin_ads_bad_response", "LinkedIn did not return the created entity's id (x-restli-id).", { made });
    }
    if (journal) {
      id = numericId.parse(id.replace(/^urn:li:sponsoredCreative:/, ""));
      made[key] = id;
      try {
        await journal.save({ ...journal.state, [key]: id, in_flight: null });
      } catch {
        throw new ExpectedToolError("exec_partial", `LinkedIn made the ${CREATE_STEPS[key]}, but Zavi could not save that it did.`, { made: { ...made }, [PROGRESS_UNSAVED]: key });
      }
    }
    return id;
  };

  made.group_id = await create("group_id", `adAccounts/${a}/adCampaignGroups`, {
    account: `urn:li:sponsoredAccount:${a}`,
    name: group.name,
    runSchedule: { start: Date.now() },
    status: "ACTIVE",
  });
  try {
    if (!journal?.state.group_paused) {
      await linkedinAdsPost(token, `adAccounts/${a}/adCampaignGroups/${made.group_id}`, "PARTIAL_UPDATE", { patch: { $set: { status: "PAUSED" } } });
      if (journal) await journal.save({ ...journal.state, group_paused: true });
    }
  } catch (e) {
    throw wrap(e);
  }
  const locale = linkedinCampaignLocale(campaign);
  made.campaign_id = await create("campaign_id", `adAccounts/${a}/adCampaigns`, {
    account: `urn:li:sponsoredAccount:${a}`,
    campaignGroup: `urn:li:sponsoredCampaignGroup:${made.group_id}`,
    name: campaign.name,
    type: "SPONSORED_UPDATES",
    associatedEntity: campaign.associated_entity,
    politicalIntent: "NOT_DECLARED",
    costType: "CPC",
    creativeSelection: "OPTIMIZED",
    dailyBudget: li(campaign.daily_budget),
    unitCost: li(campaign.unit_cost),
    locale,
    runSchedule: { start: Date.now() },
    audienceExpansionEnabled: false,
    offsiteDeliveryEnabled: false,
    targetingCriteria: linkedinCampaignTargeting(campaign),
    status: "PAUSED",
  });
  try {
    const campaignBinding=await bindCampaign(tenant_id,binding,made.campaign_id);
    const lifecycleRow = {tenant_id,campaign_binding_id:campaignBinding.id,created_paused:true,provider_group_id:made.group_id};
    const lifecycleTable = tenantClient(asTenantId(tenant_id)).from("ads_campaign_lifecycle");
    const lifecycle = journal ? await lifecycleTable.upsert(lifecycleRow, { onConflict: "tenant_id,campaign_binding_id" }) : await lifecycleTable.insert(lifecycleRow);
    if(lifecycle.error) throw new Error("Could not persist the campaign's launch inventory");
    try {
      made.creative_id = await create("creative_id", `adAccounts/${a}/creatives`, {
        campaign: `urn:li:sponsoredCampaign:${made.campaign_id}`,
        content: { reference: creative.post_urn },
        intendedStatus: "DRAFT",
      });
    } catch (e) {
      if ((author === "other_page" || author === "unknown") && e instanceof ExpectedToolError && e.code === "linkedin_ads_write_refused")
        await refuseForeignPost(token, a, made, e, author, journal);
      if (e instanceof ExpectedToolError && e.code === "linkedin_ads_forbidden")
        throw new ExpectedToolError(e.code, adForbiddenCopy(author, e), e.meta);
      throw e;
    }
    const saved=await tenantClient(asTenantId(tenant_id)).from("ads_campaign_lifecycle").update({provider_creative_ids:[made.creative_id.replace(/^urn:li:sponsoredCreative:/,"")]}).eq("campaign_binding_id",campaignBinding.id);
    if(saved.error) throw new Error("Could not persist the ad's launch inventory");
  } catch(e) {
    if(e instanceof ExpectedToolError) throw new ExpectedToolError(e.code,e.message,{...e.meta,made});
    throw new ExpectedToolError("linkedin_ads_outcome_unknown","LinkedIn made the paused campaign, but Zavi could not finish saving its setup.",{made,[ZAVI_SAVE_FAILED]:true});
  }
  return { group_id: made.group_id, campaign_id: made.campaign_id, creative_id: made.creative_id };
}

export type LiRawCampaignGroup = {
  id?: number | string;
  account?: string;
  name?: string;
  status?: string;
  backfilled?: boolean;
  totalBudget?: { amount: string; currencyCode: string };
  runSchedule?: { start?: number; end?: number };
  changeAuditStamps?: { lastModified?: { time?: number } };
};

export type LiRawCreative = {
  id?: string | number;
  campaign?: string;
  name?: string;
  intendedStatus?: string;
  isServing?: boolean;
  servingHoldReasons?: string[];
  review?: { status?: string };
  content?: { reference?: string };
  changeAuditStamps?: { lastModified?: { time?: number } };
};

const notFound = (e: unknown) => e instanceof ExpectedToolError && (e.meta as { status?: unknown } | undefined)?.status === 404;
const creativeNumericId = (id: unknown): string | null => (typeof id === "number" ? String(id) : typeof id === "string" ? (/^(?:urn:li:sponsoredCreative:)?(\d{1,20})$/.exec(id)?.[1] ?? null) : null);

export async function readLinkedInRawCampaignGroupWithToken(token: string, accountId: string, groupId: string): Promise<LiRawCampaignGroup | null> {
  const a = numericId.parse(accountId);
  const g = numericId.parse(groupId);
  const raw = await linkedinAdsGet<LiRawCampaignGroup>(token, `adAccounts/${a}/adCampaignGroups/${g}`, {}, {}, { fresh: true }).catch((e) => {
    if (notFound(e)) return null;
    throw e;
  });
  if (!raw || String(raw.id) !== g || raw.account !== `urn:li:sponsoredAccount:${a}`) return null;
  return raw;
}

export const readLinkedInRawCampaignGroup = (tenant_id: string, accountId: string, groupId: string) => withLinkedInAdsToken(tenant_id, (token) => readLinkedInRawCampaignGroupWithToken(token, accountId, groupId));

export async function readLinkedInRawCreativeWithToken(token: string, accountId: string, creativeId: string): Promise<LiRawCreative | null> {
  const a = numericId.parse(accountId);
  const c = numericId.parse(creativeId);
  const raw = await linkedinAdsGet<LiRawCreative>(token, linkedinCreativePath(a, c), {}, {}, { fresh: true }).catch((e) => {
    if (notFound(e)) return null;
    throw e;
  });
  if (!raw || creativeNumericId(raw.id) !== c) return null;
  return raw;
}

export const readLinkedInRawCreative = (tenant_id: string, accountId: string, creativeId: string) => withLinkedInAdsToken(tenant_id, (token) => readLinkedInRawCreativeWithToken(token, accountId, creativeId));

export async function listLinkedInRawCreativesWithToken(token: string, accountId: string, campaignId: string): Promise<Array<LiRawCreative & { creative_id: string }>> {
  const a = numericId.parse(accountId);
  const c = numericId.parse(campaignId);
  const page = await linkedinAdsGet<{ elements?: LiRawCreative[]; metadata?: { nextPageToken?: string | null } }>(token, `adAccounts/${a}/creatives`, { q: "criteria", campaigns: [`urn:li:sponsoredCampaign:${c}`], pageSize: 100 }, {}, { restliMethod: "FINDER", fresh: true });
  if (!Array.isArray(page.elements) || page.metadata?.nextPageToken) throw new ExpectedToolError("linkedin_ads_bad_response", "LinkedIn did not list this campaign's ads clearly, so Zavi could not check them.");
  return page.elements.flatMap((e) => {
    const id = creativeNumericId(e.id);
    return id && e.campaign === `urn:li:sponsoredCampaign:${c}` ? [{ ...e, creative_id: id }] : [];
  });
}

export async function listLinkedInRawCampaignsInGroupWithToken(token: string, accountId: string, groupId: string): Promise<LiRawCampaign[]> {
  const a = numericId.parse(accountId);
  const g = numericId.parse(groupId);
  const page = await linkedinAdsGet<{ elements?: LiRawCampaign[]; metadata?: { nextPageToken?: string | null } }>(token, `adAccounts/${a}/adCampaigns`, { q: "search", pageSize: 100, search: { campaignGroup: { values: [`urn:li:sponsoredCampaignGroup:${g}`] } } }, {}, { fresh: true });
  if (!Array.isArray(page.elements) || page.metadata?.nextPageToken) throw new ExpectedToolError("linkedin_ads_bad_response", "LinkedIn did not list this group's campaigns clearly, so Zavi could not check them.");
  return page.elements.filter((c) => c.account === `urn:li:sponsoredAccount:${a}`);
}

export async function patchLinkedInCampaignWithToken(token: string, accountId: string, campaignId: string, set: Record<string, unknown>): Promise<void> {
  const a = numericId.parse(accountId);
  const c = numericId.parse(campaignId);
  if (!Object.keys(set).length) throw new ExpectedToolError("linkedin_ads_change_empty", "This card changes nothing, so nothing was sent.");
  if ("targetingCriteria" in set && !JSON.stringify(set.targetingCriteria ?? null).includes("urn:li:adTargetingFacet:interfaceLocales"))
    throw new ExpectedToolError("linkedin_ads_targeting_invalid", "A LinkedIn targeting write must keep the interface locale; nothing was sent.");
  await linkedinAdsPost(token, `adAccounts/${a}/adCampaigns/${c}`, "PARTIAL_UPDATE", { patch: { $set: set } });
}

export const patchLinkedInCampaign = (tenant_id: string, accountId: string, campaignId: string, set: Record<string, unknown>) => withLinkedInAdsToken(tenant_id, (token) => patchLinkedInCampaignWithToken(token, accountId, campaignId, set));

export async function patchLinkedInCampaignGroupWithToken(token: string, accountId: string, groupId: string, set: Record<string, unknown>, unset: string[] = []): Promise<void> {
  const a = numericId.parse(accountId);
  const g = numericId.parse(groupId);
  if (!Object.keys(set).length && !unset.length) throw new ExpectedToolError("linkedin_ads_change_empty", "This card changes nothing, so nothing was sent.");
  await linkedinAdsPost(token, `adAccounts/${a}/adCampaignGroups/${g}`, "PARTIAL_UPDATE", { patch: { ...(Object.keys(set).length ? { $set: set } : {}), ...(unset.length ? { $delete: unset } : {}) } });
}

export const patchLinkedInCampaignGroup = (tenant_id: string, accountId: string, groupId: string, set: Record<string, unknown>, unset: string[] = []) => withLinkedInAdsToken(tenant_id, (token) => patchLinkedInCampaignGroupWithToken(token, accountId, groupId, set, unset));

export async function setLinkedInCreativeStatusWithToken(token: string, accountId: string, creativeId: string, intendedStatus: "ACTIVE" | "PAUSED" | "ARCHIVED" | "PENDING_DELETION"): Promise<void> {
  const a = numericId.parse(accountId);
  const c = numericId.parse(creativeId);
  await linkedinAdsPost(token, linkedinCreativePath(a, c), "PARTIAL_UPDATE", { patch: { $set: { intendedStatus } } });
}

export const setLinkedInCreativeStatus = (tenant_id: string, accountId: string, creativeId: string, intendedStatus: "ACTIVE" | "PAUSED" | "ARCHIVED" | "PENDING_DELETION") => withLinkedInAdsToken(tenant_id, (token) => setLinkedInCreativeStatusWithToken(token, accountId, creativeId, intendedStatus));

export type LinkedInArchiveTarget = "campaign_group" | "campaign" | "creative";
const ENTITY_PATH: Record<Exclude<LinkedInArchiveTarget, "creative">, string> = { campaign_group: "adCampaignGroups", campaign: "adCampaigns" };

export async function archiveLinkedInEntityWithToken(token: string, accountId: string, target: LinkedInArchiveTarget, id: string, mode: "archive" | "delete"): Promise<void> {
  const a = numericId.parse(accountId);
  const i = numericId.parse(id);
  const status = mode === "delete" ? "PENDING_DELETION" : "ARCHIVED";
  if (target === "creative") {
    await setLinkedInCreativeStatusWithToken(token, a, i, status);
    return;
  }
  await linkedinAdsPost(token, `adAccounts/${a}/${ENTITY_PATH[target]}/${i}`, "PARTIAL_UPDATE", { patch: { $set: { status } } });
}

export const archiveLinkedInEntity = (tenant_id: string, accountId: string, target: LinkedInArchiveTarget, id: string, mode: "archive" | "delete") => withLinkedInAdsToken(tenant_id, (token) => archiveLinkedInEntityWithToken(token, accountId, target, id, mode));

const createdId = (id: string | null, what: LinkedInCreateStep): string => {
  const n = id ? creativeNumericId(id.replace(/^urn:li:sponsoredCampaignGroup:|^urn:li:sponsoredCampaign:/, "")) : null;
  if (!n) throw new ExpectedToolError("linkedin_ads_bad_response", `LinkedIn did not return the created ${what}'s id (x-restli-id).`);
  return n;
};

export async function createLinkedInCreativeFromPostWithToken(token: string, accountId: string, campaignId: string, postUrn: string, intendedStatus: "ACTIVE" | "PAUSED" | "DRAFT", name?: string): Promise<string> {
  const a = numericId.parse(accountId);
  const c = numericId.parse(campaignId);
  const { id } = await linkedinAdsPost(token, `adAccounts/${a}/creatives`, "CREATE", { campaign: `urn:li:sponsoredCampaign:${c}`, content: { reference: postUrn }, intendedStatus, ...(name ? { name } : {}) }, "ad");
  return createdId(id, "ad");
}

export type LinkedInInlineAd = { ad_name: string; commentary: string; headline?: string; landing_url?: string; image_urn?: string };

export function linkedinInlineCreativeBody(accountId: string, campaignId: string, associatedEntity: string, ad: LinkedInInlineAd, intendedStatus: "ACTIVE" | "PAUSED" | "DRAFT"): Record<string, unknown> {
  const content = ad.landing_url
    ? { article: { source: ad.landing_url, title: ad.headline ?? ad.ad_name, ...(ad.image_urn ? { thumbnail: ad.image_urn } : {}) } }
    : ad.image_urn
      ? { media: { id: ad.image_urn, title: ad.headline ?? ad.ad_name } }
      : undefined;
  return {
    campaign: `urn:li:sponsoredCampaign:${campaignId}`,
    intendedStatus,
    name: ad.ad_name,
    inlineContent: {
      post: {
        adContext: { dscAdAccount: `urn:li:sponsoredAccount:${accountId}`, dscStatus: "ACTIVE", dscAdType: "STANDARD", dscName: ad.ad_name },
        author: associatedEntity,
        commentary: ad.commentary,
        visibility: "PUBLIC",
        distribution: { feedDistribution: "NONE", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
        ...(content ? { content } : {}),
      },
    },
  };
}

export async function createLinkedInInlineCreativeWithToken(token: string, accountId: string, campaignId: string, associatedEntity: string, ad: LinkedInInlineAd, intendedStatus: "ACTIVE" | "PAUSED" | "DRAFT"): Promise<string> {
  const a = numericId.parse(accountId);
  const c = numericId.parse(campaignId);
  if (!/^urn:li:organization:\d+$/.test(associatedEntity)) throw new ExpectedToolError("linkedin_ads_body_invalid", "A direct ad needs the campaign's company page as its author; nothing was sent.");
  const { id } = await linkedinAdsPost(token, `adAccounts/${a}/creatives?action=createInline`, "CREATE", linkedinInlineCreativeBody(a, c, associatedEntity, ad, intendedStatus), "ad");
  return createdId(id, "ad");
}

export async function createLinkedInCampaignGroupWithToken(token: string, accountId: string, fields: { name: string; totalBudget?: { amount: string; currencyCode: string }; runSchedule?: { start: number; end?: number } }): Promise<string> {
  const a = numericId.parse(accountId);
  const { id } = await linkedinAdsPost(token, `adAccounts/${a}/adCampaignGroups`, "CREATE", { account: `urn:li:sponsoredAccount:${a}`, name: fields.name, runSchedule: fields.runSchedule ?? { start: Date.now() }, status: "ACTIVE", ...(fields.totalBudget ? { totalBudget: fields.totalBudget } : {}) }, "campaign group");
  const group = createdId(id, "campaign group");
  try {
    await linkedinAdsPost(token, `adAccounts/${a}/adCampaignGroups/${group}`, "PARTIAL_UPDATE", { patch: { $set: { status: "PAUSED" } } });
  } catch (e) {
    await archiveEntity(token, `adAccounts/${a}/adCampaignGroups/${group}`);
    throw e;
  }
  return group;
}

export async function createLinkedInCampaignInGroupWithToken(token: string, accountId: string, groupId: string, fields: Record<string, unknown>): Promise<string> {
  const a = numericId.parse(accountId);
  const g = numericId.parse(groupId);
  const { id } = await linkedinAdsPost(token, `adAccounts/${a}/adCampaigns`, "CREATE", { ...fields, account: `urn:li:sponsoredAccount:${a}`, campaignGroup: `urn:li:sponsoredCampaignGroup:${g}`, status: "PAUSED" }, "campaign");
  return createdId(id, "campaign");
}

export const LINKEDIN_CAMPAIGN_COPY_FIELDS = ["name", "type", "objectiveType", "associatedEntity", "costType", "creativeSelection", "dailyBudget", "totalBudget", "unitCost", "locale", "targetingCriteria", "audienceExpansionEnabled", "offsiteDeliveryEnabled", "format", "optimizationTargetType", "pacingStrategy", "connectedTelevisionOnly"] as const;

export function linkedinCampaignCopyFields(source: Record<string, unknown>, newName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of LINKEDIN_CAMPAIGN_COPY_FIELDS) if (source[k] !== undefined && source[k] !== null) out[k] = source[k];
  out.name = newName;
  out.runSchedule = { start: Date.now() };
  out.politicalIntent = "NOT_DECLARED";
  delete out.status;
  return out;
}
