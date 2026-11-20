
import { z } from "zod";
import { adConstraint } from "@zavi/shared";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { linkedinCampaignDraftPresentationSchema } from "@/agents/lib/channel-recipe-step";
import { ExpectedToolError } from "@/services/tools/types";
import { isLinkedInAdsWriteEnabled, LINKEDIN_ADS_WRITES_OFF_MESSAGE } from "@/services/tools/linkedin-ads/write/_flag-check";
import { linkedinAdsToken, listLinkedInAdAccounts, listLinkedInAdAccountsWithReference, withLinkedInAdsToken } from "./client";
import { LINKEDIN_ADS_BILLING_HOLD, linkedinOnBillingHold } from "./http";
import { linkedinBundleSchema } from "./action-execution";
import { linkedinBundleCampaign } from "./write";
import { linkedinCreateRefusal } from "./create-preflight";
import { linkedinAccountOpen } from "./account-list-cache";
import { linkedinAccountHolders } from "./own-accounts";
import { readAction, assertPreparable, assertReviewable } from "./action-read";
import { accountChoices, connectCustomerAccount, assertAccountAvailableForNewCampaign } from "@/services/ads-wallet/accounts";
import { getAccountBinding } from "@/services/ads-wallet/bindings";
import { sharedWalletConsent } from "@/services/ads-wallet/consent";
import { adsFx } from "@/services/ads-wallet/fx";
import { linkedinManagedAccountIds, MANAGED_ACCOUNT_BILLING_HOLD, resolveLinkedinAccount } from "@/services/ads-wallet/adapters/linkedin-account";
import { postBehindAccountAd } from "./post-list";
import { resolvePastedPost, assertPostFromPage, postLink, readCompanyPage, readPostForPage, readPublicPost, readPublicPostMedia, repostNote, type CompanyPage, type PostAuthor } from "./post-link";
import { linkedinAudienceSchema, LINKEDIN_AUDIENCE_FACETS } from "@zavi/shared";
import { verifyLinkedinAudience, verifyLinkedinLocations, resolveLinkedinLocationNames, linkedinLocationInEu, linkedinLocationIncludable } from "./targeting";

const fail = (message: string): never => { throw new ExpectedToolError("linkedin_ads_conflict", message); };
export const linkedinSavedAccountHidden = (id: string) => `Your saved ad account (ID ${id}) is not available to the LinkedIn login connected now, so Zavi will not create the campaign on a different account. Reconnect LinkedIn Ads in Connectors with the login that manages that account, or pick another account in Ad account and shared wallet.`;
export const linkedinSavedAccountClosed = (id: string) => `Your saved ad account (ID ${id}) is closed in LinkedIn, so Zavi will not create the campaign on a different account. Pick another account in Ad account and shared wallet.`;
export const LINKEDIN_NO_AD_ACCOUNT = "This LinkedIn login has no ad account Zavi can use, so reconnecting the same login will not help. Create one in LinkedIn Campaign Manager, or ask an account admin to add you, then start the campaign again.";
export const LINKEDIN_VIEW_ONLY = "Your LinkedIn user can only view the ad accounts on this login, so Zavi cannot create a campaign yet. Ask an account admin in LinkedIn Campaign Manager to give you an Account Manager or Campaign Manager role, then start the campaign again.";
export const LINKEDIN_ALL_TURNED_OFF = "You turned off every ad account on this login with Stop using this account. Turn one back on with Use this account again in Ad account and shared wallet.";
export const linkedinSavedAccountViewOnly = (id: string) => `Your LinkedIn user can only view your saved ad account (ID ${id}), so Zavi will not create a campaign on it. Ask an account admin in LinkedIn Campaign Manager to give you an Account Manager or Campaign Manager role, or pick another account in Ad account and shared wallet.`;
export const LINKEDIN_WALLET_WITHDRAWN = "Your shared wallet permission is withdrawn, so Zavi's account cannot be used for new campaigns. Authorize the shared wallet again in Ad account and shared wallet, or connect your own LinkedIn ad account.";
export const LINKEDIN_ALL_OWNED_ELSEWHERE = "Every ad account on this LinkedIn login is already connected to another Zavi workspace, so Zavi cannot create a campaign on one here. Disconnect it from the other workspace first, or connect a LinkedIn login with a different ad account.";
const nameList = (names: string[]) => names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
export function linkedinNoUsableAccount(why: { turnedOff: string[]; elsewhere: string[]; managed: string[] }): string {
  const { turnedOff, elsewhere, managed } = why;
  if (!turnedOff.length && !elsewhere.length && !managed.length) return LINKEDIN_NO_AD_ACCOUNT;
  if (!elsewhere.length && !managed.length) return LINKEDIN_ALL_TURNED_OFF;
  if (!turnedOff.length && !managed.length) return LINKEDIN_ALL_OWNED_ELSEWHERE;
  const many = (names: string[], one: string, more: string) => `${nameList(names)} ${names.length === 1 ? one : more}`;
  return [
    "Zavi cannot create this campaign on any ad account on this LinkedIn login.",
    ...(turnedOff.length ? [`${many(turnedOff, "is", "are")} turned off for new campaigns in this workspace. Turn ${turnedOff.length === 1 ? "it" : "one"} back on with Use this account again in Ad account and shared wallet.`] : []),
    ...(elsewhere.length ? [`${many(elsewhere, "is", "are")} connected to another Zavi workspace.`] : []),
    ...(managed.length ? [`${many(managed, "is Zavi's managed account", "are Zavi's managed accounts")}, not your own. Use ${managed.length === 1 ? "it" : "them"} under Use a Zavi account in Ad account and shared wallet.`] : []),
    "Nothing was created.",
  ].join(" ");
}
export const LINKEDIN_SAVED_OWNED_ELSEWHERE = "Your saved ad account is now connected to another Zavi workspace, so Zavi will not create the campaign on it or on a different account. Pick another account in Ad account and shared wallet.";
export const LINKEDIN_WALLET_READ_FAILED = "Zavi could not reach its shared wallet ad account just now, so it will not move this campaign onto your own LinkedIn billing without asking. Nothing was created. Try again in a few minutes, or choose your own account in Ad account and shared wallet to pay with your own LinkedIn billing.";
export const LINKEDIN_WALLET_POST_PAGE = "A shared wallet campaign can only promote posts from the LinkedIn page that Zavi's shared ad account advertises for, so LinkedIn will not run an ad for your company page's post through it. To promote your company's post, connect your own LinkedIn ad account in Ad account and shared wallet and choose it here. Nothing was created.";
export const linkedinLocationSearchFailed = (places: string[]) => `LinkedIn's location search didn't answer, so Zavi could not fill in ${places.join(", ")}. Try again in a moment, or add the places you want.`;
export const LINKEDIN_MAX_LOCATIONS = 50;
export const linkedinTooManyLocations = (list: "include" | "exclude") => `Zavi can ${list} up to ${LINKEDIN_MAX_LOCATIONS} places in one campaign. Remove some, or pick a wider area such as a whole country or region. Nothing was created.`;
export const LINKEDIN_ACCOUNT_TURNED_OFF ="You turned this ad account off in Zavi with Stop using this account. Choose another account, or turn it back on with Use this account again.";

function draftCountryName(country: string): string {
  try {
    return (/^[A-Z]{2}$/.test(country) && new Intl.DisplayNames(["en"], { type: "region" }).of(country)) || country;
  } catch {
    return country;
  }
}

async function accountsLoginCannotManage(tenantId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const unmanaged = async (fresh: boolean) => {
    const managed = await withLinkedInAdsToken(tenantId, (token) => linkedinManagedAccountIds(token, fresh));
    return managed ? ids.filter((id) => !managed.has(id)) : [];
  };
  try {
    return new Set((await unmanaged(false)).length ? await unmanaged(true) : []);
  } catch {
    return new Set();
  }
}

export async function linkedinMinDailyBudget(currency: string): Promise<number> {
  const usd = adConstraint("linkedin_ads")!.min_daily_usd;
  if (currency === "USD") return usd;
  const fx = await adsFx(currency);
  return Math.ceil(Number((usd * fx.units_per_usd).toFixed(6)));
}

export const COUNTRY_GEO_URNS: Record<string, { urn: string; name: string }> = {
  US: { urn: "urn:li:geo:103644278", name: "United States" },
  GB: { urn: "urn:li:geo:101165590", name: "United Kingdom" },
  CA: { urn: "urn:li:geo:101174742", name: "Canada" },
  IN: { urn: "urn:li:geo:102713980", name: "India" },
};

export const LINKEDIN_STARTER = { currency: "USD", daily_budget: "15", unit_cost: "6" } as const;

export type LinkedInCampaignReviewResponse = {
  draft: z.infer<typeof linkedinCampaignDraftPresentationSchema>;
  accounts: Array<{ id: string; name: string; currency: string | null; min_daily_budget: string | null; account_binding_id?: string; funding_source?: "wallet" | "provider"; billing_hold?: true }>;
  selected_account_binding_id: string | null;
  suggested: { daily_budget: string | null; unit_cost: string | null; country: string; locations: Array<{ id: string; name: string }>; excluded_locations: Array<{ id: string; name: string }>; unresolved_locations: string[]; location_search_failed?: string };
  supported_countries: Array<{ code: string; name: string }>;
  own_account_unavailable?: string;
};

export async function reviewLinkedInCampaignAction(tenantId: string, actionId: string): Promise<LinkedInCampaignReviewResponse> {
  const row = await readAction(tenantId, actionId);
  assertReviewable(row);
  const draft = linkedinCampaignDraftPresentationSchema.parse(row.body?.step?.deliverable?.presentation);
  const choices=await accountChoices(tenantId,"linkedin");
  const walletOn=choices.accounts.filter(a=>!a.disabled && a.funding_source==="wallet");
  const walletConsent=walletOn.length ? await sharedWalletConsent(tenantId).catch(()=>null) : true;
  const walletWithdrawn=walletConsent===false;
  const walletReads=await Promise.allSettled((walletConsent===true?walletOn:[]).map(async choice=>{
    const binding=await getAccountBinding(tenantId,choice.id);
    const {account,token}=await resolveLinkedinAccount(tenantId,binding);
    return {...account,name:account.name??`Managed account ${account.id}`,account_binding_id:binding.id,funding_source:"wallet" as const,token,...(linkedinOnBillingHold(account.servingStatuses)?{billing_hold:true as const}:{})};
  }));
  const managed=walletReads.flatMap(r=>r.status==="fulfilled"?[r.value]:[]);
  const managedTokens=new Map(managed.map(({account_binding_id,token})=>[account_binding_id,token]));
  const walletFailure=walletReads.find((r):r is PromiseRejectedResult=>r.status==="rejected");
  let customer:Awaited<ReturnType<typeof listLinkedInAdAccounts>>=[];
  let ownUnavailable:string|null=null;
  const saved=choices.accounts.find(b=>b.id===choices.selected_id&&!b.disabled&&b.funding_source==="provider");
  try {customer=await listLinkedInAdAccounts(tenantId);} catch(e) {
    if(walletFailure && !managed.length) throw walletFailure.reason;
    if(walletWithdrawn && e instanceof ExpectedToolError && e.code==="linkedin_ads_not_connected") return fail(LINKEDIN_WALLET_WITHDRAWN);
    if(!(e instanceof ExpectedToolError) || !managed.length) throw e;
    if(e.code!=="linkedin_ads_not_connected") {
      if(saved) throw e;
      ownUnavailable=e.message;
    }
  }
  if(walletFailure && !managed.length && !customer.some(a=>linkedinAccountOpen(a.status))) throw walletFailure.reason;
  const seen=(list:typeof customer)=>!saved?.provider_account_id||list.some(a=>a.id===saved.provider_account_id&&linkedinAccountOpen(a.status));
  const none=(list:typeof customer)=>!managed.length&&!list.some(a=>linkedinAccountOpen(a.status));
  if(!seen(customer)||none(customer)) customer=await listLinkedInAdAccounts(tenantId,true).catch(()=>customer);
  if(saved?.provider_account_id && !seen(customer)) return fail(customer.some(a=>a.id===saved.provider_account_id)?linkedinSavedAccountClosed(saved.provider_account_id):linkedinSavedAccountHidden(saved.provider_account_id));
  const turnedOffHere=(a:(typeof customer)[number])=>choices.accounts.some(b=>b.disabled&&b.funding_source==="provider"&&b.provider_account_id===a.id);
  const open=customer.filter(a=>linkedinAccountOpen(a.status)&&!turnedOffHere(a));
  const {elsewhere:claimedElsewhere,managed:zaviManaged}=await linkedinAccountHolders(tenantId,open.map(a=>a.id));
  if(saved?.provider_account_id && claimedElsewhere.has(saved.provider_account_id)) return fail(LINKEDIN_SAVED_OWNED_ELSEWHERE);
  const turnedOn=open.filter(a=>!claimedElsewhere.has(a.id)&&!zaviManaged.has(a.id));
  const viewOnly=await accountsLoginCannotManage(tenantId,turnedOn.map(a=>a.id));
  if(saved?.provider_account_id && viewOnly.has(saved.provider_account_id)) return fail(linkedinSavedAccountViewOnly(saved.provider_account_id));
  const accounts = [...managed,...turnedOn.filter(a=>!viewOnly.has(a.id)).map(a=>({...a,account_binding_id:choices.accounts.find(b=>!b.disabled&&b.funding_source==="provider"&&b.provider_account_id===a.id)?.id,funding_source:"provider" as const}))].filter((a) => linkedinAccountOpen(a.status));
  accounts.sort((a,b)=>Number(!!a.billing_hold)-Number(!!b.billing_hold)||Number(b.account_binding_id===choices.selected_id)-Number(a.account_binding_id===choices.selected_id));
  const selectedAccount=accounts.find(a=>!!a.account_binding_id&&a.account_binding_id===choices.selected_id&&!a.billing_hold);
  if (accounts.length === 0 && walletWithdrawn) return fail(LINKEDIN_WALLET_WITHDRAWN);
  if (accounts.length === 0) return fail(viewOnly.size ? LINKEDIN_VIEW_ONLY : linkedinNoUsableAccount({
    turnedOff: customer.filter((a) => linkedinAccountOpen(a.status) && turnedOffHere(a)).map((a) => a.name),
    elsewhere: open.filter((a) => claimedElsewhere.has(a.id)).map((a) => a.name),
    managed: open.filter((a) => zaviManaged.has(a.id)).map((a) => a.name),
  }));
  if (walletFailure && accounts[0].funding_source === "provider" && accounts[0].account_binding_id !== choices.selected_id) return fail(LINKEDIN_WALLET_READ_FAILED);
  const usd = accounts.every((a) => a.currency === LINKEDIN_STARTER.currency);
  const countryUsable = Object.hasOwn(COUNTRY_GEO_URNS, draft.country);
  const country = countryUsable ? draft.country : "US";
  const namesPlaces = !!draft.locations?.length;
  let locations = countryUsable && !namesPlaces ? [{ id: COUNTRY_GEO_URNS[country].urn, name: COUNTRY_GEO_URNS[country].name }] : [];
  let excluded_locations: Array<{ id: string; name: string }> = [];
  const countryName = countryUsable || namesPlaces ? null : draftCountryName(draft.country);
  const searchCountry = !!countryName && linkedinLocationIncludable(countryName);
  const includeNames = namesPlaces ? draft.locations ?? [] : searchCountry ? [countryName] : [];
  const unresolved: string[] = countryName && !searchCountry ? [countryName] : [];
  let locationSearchFailed: string | null = null;
  if (includeNames.length || draft.excluded_locations?.length) {
    try {
      const token = (accounts[0].funding_source === "wallet" ? managedTokens.get(accounts[0].account_binding_id!) : undefined) ?? await linkedinAdsToken(tenantId);
      const [include, exclude] = await Promise.all([
        resolveLinkedinLocationNames(token, includeNames),
        resolveLinkedinLocationNames(token, draft.excluded_locations ?? []),
      ]);
      const eu = include.found.filter((l) => !linkedinLocationIncludable(l.name));
      const allowed = include.found.filter((l) => linkedinLocationIncludable(l.name));
      if (includeNames.length) locations = allowed;
      excluded_locations = exclude.found;
      unresolved.push(...include.missed, ...eu.map((l) => l.name), ...exclude.missed.map((n) => `${n} (exclude)`));
    } catch {
      locationSearchFailed = linkedinLocationSearchFailed([...includeNames, ...(draft.excluded_locations ?? []).map((n) => `${n} (exclude)`)]);
    }
  }
  const minimums = new Map<string, string | null>();
  for (const currency of new Set(accounts.map((a) => a.currency).filter((c): c is string => !!c))) {
    minimums.set(currency, await linkedinMinDailyBudget(currency).then(String, () => null));
  }
  return {
    draft,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency, min_daily_budget: a.currency ? minimums.get(a.currency) ?? null : null, account_binding_id:a.account_binding_id, funding_source:a.funding_source, ...(a.billing_hold ? { billing_hold: true as const } : {}) })),
    selected_account_binding_id: selectedAccount?.account_binding_id ?? null,
    suggested: {
      daily_budget: usd ? LINKEDIN_STARTER.daily_budget : null,
      unit_cost: usd ? LINKEDIN_STARTER.unit_cost : null,
      country,
      locations,
      excluded_locations,
      unresolved_locations: unresolved,
      ...(locationSearchFailed ? { location_search_failed: locationSearchFailed } : {}),
    },
    supported_countries: Object.entries(COUNTRY_GEO_URNS).map(([code, v]) => ({ code, name: v.name })),
    ...(ownUnavailable ? { own_account_unavailable: ownUnavailable } : {}),
  };
}

const unconfirmedAuthor = (name: string | null) => `Zavi could not confirm that ${name ?? "the company page this ad account advertises for"} can sponsor this post, so LinkedIn may refuse the ad after Zavi makes the paused campaign. Check that the post is from that page, and that the connected LinkedIn user has the Sponsored Content poster role on it. Nothing can spend without an ad.`;

const walletPageRefusal = (binding: { funding_source: string } | null) => (e: unknown): never => {
  if (binding?.funding_source === "wallet" && e instanceof ExpectedToolError && e.code === "linkedin_ads_post_page_mismatch") throw new ExpectedToolError("linkedin_ads_post_page_mismatch", LINKEDIN_WALLET_POST_PAGE);
  throw e;
};

const moneyAmount = z.string().regex(/^\d+(\.\d{1,2})?$/);
export const linkedinReviewInput = z.object({
  account_id: z.string().regex(/^\d{1,20}$/),
  account_binding_id: z.string().uuid().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  daily_budget: moneyAmount,
  unit_cost: moneyAmount,
  country: z.string().regex(/^[A-Z]{2}$/),
  locations: z.array(z.string().regex(/^urn:li:geo:\d+$/)).refine((v) => v.length <= LINKEDIN_MAX_LOCATIONS, linkedinTooManyLocations("include")).optional(),
  excluded_locations: z.array(z.string().regex(/^urn:li:geo:\d+$/)).refine((v) => v.length <= LINKEDIN_MAX_LOCATIONS, linkedinTooManyLocations("exclude")).optional(),
  post: z.string().min(1).max(2000),
  audience: linkedinAudienceSchema.optional(),
  use_broad_audience: z.boolean().optional(),
}).strict();

export async function prepareLinkedInCampaignAction(tenantId: string, actionId: string, actorId: string, input: unknown) {
  const value = linkedinReviewInput.parse(input);
  if (!(await isLinkedInAdsWriteEnabled())) {
    return fail(`${LINKEDIN_ADS_WRITES_OFF_MESSAGE}. Your draft is saved.`);
  }
  const row = await readAction(tenantId, actionId);
  assertPreparable(row);
  const draft = linkedinCampaignDraftPresentationSchema.parse(row.body?.step?.deliverable?.presentation);
  const minDaily = await linkedinMinDailyBudget(value.currency).catch(() => fail(`Zavi could not read today's exchange rate to check LinkedIn's minimum daily budget in ${value.currency}. Nothing was created. Try again in a few minutes.`));
  if (Number(value.daily_budget) < minDaily) {
    return fail(value.currency === "USD" ? `LinkedIn's minimum daily budget is ${minDaily} USD.` : `LinkedIn's minimum daily budget for this account is ${minDaily} ${value.currency} (about ${adConstraint("linkedin_ads")!.min_daily_usd} USD).`);
  }

  if (!(Number(value.unit_cost) > 0)) return fail("Enter a bid above 0. LinkedIn refuses a campaign with no bid. Nothing was created.");
  if (Number(value.unit_cost) > Number(value.daily_budget)) {
    return fail("The bid cannot be higher than the daily budget.");
  }
  const included = [...new Set(value.locations ?? [])];
  const excluded = [...new Set(value.excluded_locations ?? [])];
  const geo = COUNTRY_GEO_URNS[value.country];
  if (!included.length && !geo) return fail("That country is not supported yet. Choose one from the list.");
  if ((included.length ? included : [geo.urn]).some((urn) => excluded.includes(urn))) return fail("A location cannot be both included and excluded. Remove it from one list.");
  const hasAudience = LINKEDIN_AUDIENCE_FACETS.some(f => value.audience?.[f]?.length);
  if (!hasAudience && !value.use_broad_audience)
    return fail("Choose LinkedIn audience options, or explicitly choose location and language only.");
  const pasted = await resolvePastedPost(value.post);
  if (!pasted) return fail("Paste the link to the company post (from its … menu, Copy link to post) or its embed code.");
  const { post_urn } = pasted;

  const choices=await accountChoices(tenantId,"linkedin");
  if(choices.accounts.some(b=>b.disabled&&(b.id===value.account_binding_id||(b.funding_source==="provider"&&b.provider_account_id===value.account_id)))) return fail(LINKEDIN_ACCOUNT_TURNED_OFF);
  const binding=value.account_binding_id?await getAccountBinding(tenantId,value.account_binding_id):null;
  if(binding) await assertAccountAvailableForNewCampaign(tenantId,binding);
  const resolved = binding ? await resolveLinkedinAccount(tenantId,binding,true) : null;
  const account = resolved ? resolved.account : (await listLinkedInAdAccountsWithReference(tenantId, true)).find((a) => a.id === value.account_id);
  if (!account) return fail("That ad account is not linked to this workspace. Refresh and choose again.");
  if(account.id!==value.account_id) return fail("The selected advertiser account changed. Review it again.");
  if (linkedinOnBillingHold(account.servingStatuses)) return fail(binding?.funding_source === "wallet" ? MANAGED_ACCOUNT_BILLING_HOLD : LINKEDIN_ADS_BILLING_HOLD);
  if (!account.reference?.match(/^urn:li:organization:\d+$/)) {
    return fail("This ad account is not tied to a LinkedIn company page, which LinkedIn needs to promote a post. Choose another account.");
  }
  if (account.currency !== value.currency) {
    return fail("The account currency changed. Review the budget again.");
  }
  const page = account.reference;
  const readPublic = () => readPublicPost(post_urn);
  const checkPost = async (t: string) => {
    const found = await assertPostFromPage(t, post_urn, page, readPublic);
    return { author: found, unconfirmed: found === "unknown" && !(await postBehindAccountAd(t, account.id, post_urn)) };
  };
  const { author, unconfirmed } = resolved ? await checkPost(resolved.token).catch(walletPageRefusal(binding)) : await withLinkedInAdsToken(tenantId, checkPost);
  const token = hasAudience || included.length || excluded.length ? resolved?.token ?? await linkedinAdsToken(tenantId) : "";
  const placeNames = await verifyLinkedinLocations(token, [...included, ...excluded]);
  const includeUrns = included.length ? included : [geo.urn];
  const includeNames = included.length ? included.map((urn) => placeNames.get(urn)!) : [geo.name];
  const eu = includeNames.find((name) => linkedinLocationInEu(name));
  if (eu) return fail(`${eu} is in or includes the EU or EEA. LinkedIn needs a political-ads declaration for those places, which Zavi does not collect yet. Exclude it or choose another location.`);
  const unnamed = includeNames.find((name) => !linkedinLocationIncludable(name));
  if (unnamed) return fail(`${unnamed} does not name its country, so Zavi cannot confirm it is outside the EU. Choose the entry that ends with its country, such as a city or region.`);
  const verified = value.audience ? await verifyLinkedinAudience(hasAudience ? token : "", value.audience) : null;

  const campaign = linkedinBundleCampaign.parse({
    name: draft.name,
    daily_budget: { amount: value.daily_budget, currency: value.currency },
    unit_cost: { amount: value.unit_cost, currency: value.currency },
    geo_urns: includeUrns,
    ...(excluded.length ? { excluded_geo_urns: excluded } : {}),
    country: value.country,
    language: draft.language,
    associated_entity: account.reference,
    ...(verified ? { audience: verified.audience } : {}),
  });
  const refusal = await linkedinCreateRefusal(tenantId, campaign, async () => resolved?.token ?? await linkedinAdsToken(tenantId));
  if (refusal) return fail(refusal);

  const payload = linkedinBundleSchema.parse({
    account_id: value.account_id,
    account_binding_id: binding?.id ?? await connectCustomerAccount(tenantId,"linkedin",value.account_id,false),
    group: { name: draft.group_name },
    campaign,
    creative: { post_urn },
  });
  const rows = [
    { item: "Campaign", before: "Not created", after: `${draft.name} · paused` },
    { item: "Daily budget", before: "Not chosen", after: `${value.daily_budget} ${value.currency}/day` },
    { item: "Maximum bid per click", before: "Not chosen", after: `${value.unit_cost} ${value.currency}` },
    { item: "Where it shows", before: "Not chosen", after: includeNames.join(", ") },
    ...(excluded.length ? [{ item: "Where it does not show", before: "Not chosen", after: excluded.map((urn) => placeNames.get(urn)!).join(", ") }] : []),
    { item: "Promoted post", before: "Not chosen", after: postLink(post_urn) },
    ...(pasted.reposted_from ? [{ item: "Pasted link", before: "Not chosen", after: repostNote(pasted.reposted_from, author === "page" ? "your company page" : null) }] : []),
    ...(unconfirmed ? [{ item: "Post check", before: "Not chosen", after: unconfirmedAuthor(null) }] : []),
    { item: "Ad account", before: "Not chosen", after: account.name??account.id },
    { item: "Funding", before: "Not chosen", after: binding?.funding_source==="wallet"?"Shared Zavi ads balance":"Your LinkedIn account bills you directly" },
    ...(verified?.rows ?? []),
    ...(!hasAudience ? [{ item: "Professional audience", before: "Not chosen", after: "Location and language only" }] : []),
  ];
  const { data, error } = await tenantRpc(asTenantId(tenantId), "prepare_channel_campaign_action", {
    p_action_id: actionId, p_actor_user_id: actorId, p_expected_body: row.body,
    p_payload: payload, p_exact_change: { rows },
  });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new ExpectedToolError("linkedin_ads_setup_unavailable", "Zavi is finishing campaign setup. Your draft is saved, but creation is unavailable on this server right now.");
    }
    throw new Error("Could not prepare campaign action.");
  }
  const prepared = data as { ok?: boolean; replayed?: boolean } | null;
  if (!prepared?.ok) return fail("This action changed. Refresh Next steps before approving.");
  const stored = row.body.exact_change?.rows;
  return { id: actionId, executable: true, exact_change: prepared.replayed && stored ? { rows: stored } : { rows } };
}

export const linkedinPostPreviewInput = z.object({
  post: z.string().trim().min(1).max(2000),
  account_id: z.string().regex(/^\d{1,20}$/),
  account_binding_id: z.string().uuid().optional(),
}).strict();

const createdPostQuery = (payload: unknown) => {
  const found = linkedinPostPreviewInput.safeParse(payload && typeof payload === "object" ? {
    post: (payload as { creative?: { post_urn?: unknown } }).creative?.post_urn,
    account_id: (payload as { account_id?: unknown }).account_id,
    ...((payload as { account_binding_id?: unknown }).account_binding_id ? { account_binding_id: (payload as { account_binding_id?: unknown }).account_binding_id } : {}),
  } : null);
  return found.success ? found.data : null;
};

export type LinkedInPostPreview = { post_urn: string; repost_note?: string; author: PostAuthor; post_preview: string | null; author_note: string | null; page: CompanyPage; image_url?: string };

export async function previewLinkedInPost(tenantId: string, actionId: string, input: unknown): Promise<LinkedInPostPreview> {
  const row = await readAction(tenantId, actionId);
  const created = row.exec_class === "linkedin_ads.create_campaign_bundle" ? createdPostQuery(row.exec_payload) : null;
  if (!created) assertReviewable(row);
  const value = linkedinPostPreviewInput.parse(created ?? input);
  const pasted = await resolvePastedPost(value.post);
  if (!pasted) return fail("Paste the link to the company post (from its … menu, Copy link to post) or its embed code.");
  const { post_urn } = pasted;
  const choices = await accountChoices(tenantId, "linkedin");
  if (choices.accounts.some(b => b.disabled && (b.id === value.account_binding_id || (b.funding_source === "provider" && b.provider_account_id === value.account_id)))) return fail(LINKEDIN_ACCOUNT_TURNED_OFF);
  const binding = value.account_binding_id ? await getAccountBinding(tenantId, value.account_binding_id) : null;
  const resolved = binding ? await resolveLinkedinAccount(tenantId, binding) : null;
  const account = resolved ? resolved.account : (await listLinkedInAdAccountsWithReference(tenantId)).find((a) => a.id === value.account_id);
  if (!account) return fail("That ad account is not linked to this workspace. Refresh and choose again.");
  if (account.id !== value.account_id) return fail("The selected advertiser account changed. Review it again.");
  const page = account.reference;
  if (!page?.match(/^urn:li:organization:\d+$/)) {
    return fail("This ad account is not tied to a LinkedIn company page, which LinkedIn needs to promote a post. Choose another account.");
  }
  const readPublic = () => readPublicPost(post_urn);
  const readBoth = async (t: string) => {
    const [post, shown, media] = await Promise.all([readPostForPage(t, post_urn, page, readPublic), readCompanyPage(t, page), readPublicPostMedia(post_urn)]);
    return [post, shown, post.author === "unknown" && !(await postBehindAccountAd(t, account.id, post_urn)), media] as const;
  };
  const [read, named, unconfirmed, { image, page_logo }] = resolved ? await readBoth(resolved.token).catch(walletPageRefusal(binding)) : await withLinkedInAdsToken(tenantId, readBoth);
  const company = read.author === "page" && !named.logo_url && page_logo ? { ...named, logo_url: page_logo } : named;
  const preview = { post_urn, author: read.author, post_preview: read.text, author_note: unconfirmed ? unconfirmedAuthor(company.name) : null, page: company, ...(image ? { image_url: image } : {}) };
  return pasted.reposted_from ? { ...preview, repost_note: repostNote(pasted.reposted_from, read.author === "page" ? company.name ?? "your company page" : null) } : preview;
}
