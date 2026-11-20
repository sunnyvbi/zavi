"use client";
import { useEffect, useId, useRef, useState } from "react";
import { AdsPostRowsSkeleton, AdsReviewSkeleton, SkeletonBar } from "./AdsLoading";
import { LINKEDIN_POST_PENDING, type ActionHandlers, type ActionItem } from "../types";
import { campaignFetch } from "./api";
import { ActionEditDialog } from "../ActionEditDialog";
import { ChannelMarkIcon } from "../../growth/GrowthChannelLabel";
import { SheetNote, sheetFooterButton, sheetHint, sheetInput, sheetLabel } from "./AdsSheet";
import { LINKEDIN_AUDIENCE_FACETS, adConstraint, type LinkedInAudienceSuggestions } from "@zavi/shared";
import { LinkedInAudiencePicker, emptyAudienceChoices, resolveAudienceSuggestions } from "./LinkedInAudiencePicker";
import { CampaignLocations } from "./CampaignLocations";
import { campaignReviewDraft, saveCampaignReviewDraft } from "./openCampaignReview";
import { LinkedInPostPreview, type LinkedInPostPage } from "../linkedin/LinkedInPostPreview";
import { POST_UNREADABLE, postAuthorName, toPostRead } from "../linkedin/linkedInPostRead";
import { ADS_CONNECTION_CHANGED_EVENT, cachedCampaignReview, forgetCampaignReview, loadCampaignReview } from "./campaignReviewPrefetch";
import { TENANT_SWITCHED_ELSEWHERE_EVENT, holdReloadForUnsavedWork, tenantSwitchedElsewhere } from "@/lib/workspace/tenantSwitch";
import { reloadWithoutBuild } from "@/lib/workspace/buildLinkOnLoad";
import { Check, Image as ImageIcon, Link2, List, TriangleAlert } from "lucide-react";
import { FigmaCheckbox } from "./fundingUi";
import { FOCUS_RING } from "../../layout/shared";
import { LINKEDIN_ADS_BILLING_HOLD, MANAGED_ACCOUNT_BILLING_HOLD } from "../../agent/linkedinAdsTables";

const RECONNECT_CODES = new Set(["linkedin_ads_token_revoked", "linkedin_ads_not_connected"]);
type Place = { id: string; name?: string };
type PostPage = LinkedInPostPage;

type Draft = { account: string; currency: string; budget: string; bid: string; country: string; locations: Place[]; excludedLocations: Place[]; post: string; audience: ReturnType<typeof emptyAudienceChoices>; broadAudience: boolean };

type Review = {
  draft: { name: string; group_name: string; rationale: string; post_urn?: string; post_preview: string; country: string; audience_suggestions?: LinkedInAudienceSuggestions };
  accounts: Array<{ id: string; name: string; currency: string | null; min_daily_budget?: string | null; account_binding_id?: string; funding_source?: "wallet" | "provider"; billing_hold?: boolean }>;
  suggested: { daily_budget: string | null; unit_cost: string | null; country: string; locations?: Place[]; excluded_locations?: Place[]; unresolved_locations?: string[]; location_search_failed?: string };
  own_account_unavailable?: string;
  selected_account_binding_id?: string | null;
};

const POST_LINK_FORMS = [
  /urn(?::|%3A)li(?::|%3A)(share|ugcPost|activity)(?::|%3A)\d{6,25}(?!\d)/i,
  /linkedin\.com\/posts\/[^?#\s"']*[-_](share|ugcPost|activity)-\d{6,25}(?!\d)/i,
  /https?:\/\/lnkd\.in\/[A-Za-z0-9_\/-]{1,100}/i,
];
const chosenAccount = (r: Review) => {
  const inUse = r.selected_account_binding_id
    ? r.accounts.find((a) => !!a.account_binding_id && a.account_binding_id === r.selected_account_binding_id)
    : undefined;
  return inUse ?? r.accounts.find((a) => a.funding_source !== "wallet" && !a.billing_hold) ?? r.accounts.find((a) => a.funding_source !== "wallet");
};
const startAccount = (r: Review) => {
  const chosen = chosenAccount(r);
  return chosen ? chosen.account_binding_id ?? chosen.id : "";
};
const startCurrency = (r: Review) => {
  const start = startAccount(r);
  return r.accounts.find((a) => (a.account_binding_id ?? a.id) === start)?.currency ?? "";
};
const restoredMoney = (saved: Partial<Draft>) => !!saved.budget || !!saved.bid;
const moneyMoved = (saved: Partial<Draft>, r: Review) => saved.currency !== undefined && saved.currency !== startCurrency(r);
const currencyResetWords = (to: string, from: string) =>
  `Budget and bid were cleared because this account bills in ${to || "a different currency"}, not ${from || "the previous currency"}. Enter them again in ${to || "the new currency"}.`;
const POST_REFUSALS = ["linkedin_ads_post_page_mismatch", "linkedin_ads_post_unreadable", "linkedin_ads_post_not_found"];
const POST_UNRECOGNISED = "Paste the link to the company post";
const APPROVE_NOT_STARTED = "Zavi could not start creating this campaign, so nothing was created. Your choices are still here: choose Create paused campaign to try again.";
const LOAD_FAILED = "Zavi could not read this draft just now. Nothing you entered is lost.";
const POST_NEEDED_PICK = "Pick a post or paste its link.";
const POST_NEEDED_PASTE = "Paste the link of the post to promote.";
const PLAIN_REASON = /^[A-Za-z0-9 ,.'’:;()…-]{1,300}$/;
const plainReason = (s: string | undefined) => !!s && PLAIN_REASON.test(s.trim()) && !/\b\d{3}\b|https?:|urn:|_/.test(s);
const sameDraft = (a: Omit<Draft, "currency">, b: Omit<Draft, "currency">) => JSON.stringify(a) === JSON.stringify(b);
type PostRow = { post_urn: string; text: string | null; date: string | null; thumbnail_url: string | null; label: string };
type PostList = { key: string; failed: boolean; posts: PostRow[]; pageName: string | null };
const PICKABLE_POST = /^urn:li:(share|ugcPost):\d{6,25}$/;
const pickablePosts = (value: unknown): PostRow[] => (Array.isArray(value) ? value : []).filter((p): p is PostRow => !!p && typeof p === "object" && typeof (p as PostRow).post_urn === "string" && PICKABLE_POST.test((p as PostRow).post_urn));
const postDay = (iso: string | null) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
};
const COMPANY_CHANGED = "You switched to another company in a different tab, so Zavi will not create this campaign: it belongs to the company you started it in. Reload to open the company you switched to.";

export function SponsoredPostReview({ action, spec, handlers, onPrepared, onClose }: {
  action: ActionItem;
  spec: { actionReviewPath: string; title: string };
  handlers: ActionHandlers;
  onPrepared: (a: ActionItem) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const [saved] = useState(() => campaignReviewDraft<Draft>(action.id));
  const base = `${spec.actionReviewPath}/${encodeURIComponent(action.id)}`;
  const reviewPath = `${base}/review`;
  const revision = action.post_revision;
  const reviewKey = `${reviewPath}|${revision ?? ""}`;
  const [initial] = useState(() => {
    const cached = cachedCampaignReview<Review>(reviewPath, revision);
    return cached ? { key: reviewKey, review: cached } : null;
  });
  const [loaded, setLoaded] = useState(initial);
  const ready = loaded?.key === reviewKey;
  const review = loaded && ready ? loaded.review : null;
  const first = initial?.review;
  const [account, setAccount] = useState(first ? startAccount(first) : "");
  const moved = !!first && moneyMoved(saved, first);
  const [budget, setBudget] = useState(moved ? "" : saved.budget ?? (first?.suggested.daily_budget || ""));
  const [bid, setBid] = useState(moved ? "" : saved.bid ?? (first?.suggested.unit_cost || ""));
  const moneyIn = useRef({ currency: saved.currency, entered: restoredMoney(saved) });
  const [country, setCountry] = useState(saved.country ?? first?.suggested.country ?? "");
  const [locations, setLocations] = useState<Place[]>(saved.locations ?? first?.suggested.locations ?? []);
  const [excludedLocations, setExcludedLocations] = useState<Place[]>(saved.excludedLocations ?? first?.suggested.excluded_locations ?? []);
  const [post, setPost] = useState(saved.post ?? (first?.draft.post_urn || ""));
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [postError, setPostError] = useState<{ message: string } | null>(null);
  const [postCheckFailed, setPostCheckFailed] = useState<string | null>(null);
  const [postRetry, setPostRetry] = useState(0);
  const [resolvedPost, setResolvedPost] = useState<{ key: string; preview: string | null; author?: string; page?: PostPage; postUrl?: string; repostNote?: string; authorNote?: string | null; imageUrl?: string } | null>(null);
  const [postList, setPostList] = useState<PostList | null>(null);
  const [listRetry, setListRetry] = useState(0);
  const [typed, setTyped] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [listWanted, setListWanted] = useState(false);
  const [brokenThumbs, setBrokenThumbs] = useState<string[]>([]);
  const postInput = useRef<HTMLInputElement>(null);
  const postErrorRef = useRef<HTMLSpanElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [busy, setBusy] = useState(false);
  const [currencyReset, setCurrencyReset] = useState(first && moved && restoredMoney(saved) ? currencyResetWords(startCurrency(first), saved.currency ?? "") : "");
  const savedAudienceFits = !first || startAccount(first) === saved.account;
  const [audience, setAudience] = useState(() => (savedAudienceFits && saved.audience) || emptyAudienceChoices());
  const [broadAudience, setBroadAudience] = useState(savedAudienceFits ? saved.broadAudience ?? false : false);
  const [audienceTouched, setAudienceTouched] = useState(false);
  const [loadedImages, setLoadedImages] = useState<string[]>([]);
  const latch = useRef(false);
  const current = useRef(saved);
  const [companyChanged, setCompanyChanged] = useState(tenantSwitchedElsewhere);

  useEffect(() => {
    const changed = () => setCompanyChanged(true);
    window.addEventListener(TENANT_SWITCHED_ELSEWHERE_EVENT, changed);
    const release = holdReloadForUnsavedWork();
    if (tenantSwitchedElsewhere()) changed();
    return () => { window.removeEventListener(TENANT_SWITCHED_ELSEWHERE_EVENT, changed); release(); };
  }, []);

  useEffect(() => {
    if (ready) return;
    let stopped = false;
    const saved = current.current;
    if (!saved.audience) { setAudience(emptyAudienceChoices()); setBroadAudience(false); }
    void loadCampaignReview<Review>(reviewPath, revision).then((r) => {
      if (stopped) return;
      setLoaded({ key: reviewKey, review: r });
      const start = startAccount(r);
      setAccount(start);
      if (saved.audience && start !== saved.account) { setAudience(emptyAudienceChoices()); setBroadAudience(false); }
      const to = startCurrency(r);
      const before = moneyIn.current;
      if (before.currency !== undefined && before.currency !== to) {
        setBudget("");
        setBid("");
        setCurrencyReset(before.entered ? currencyResetWords(to, before.currency) : "");
      } else {
        if (saved.budget === undefined && r.suggested.daily_budget) setBudget(r.suggested.daily_budget);
        if (saved.bid === undefined && r.suggested.unit_cost) setBid(r.suggested.unit_cost);
      }
      if (saved.country === undefined) setCountry(r.suggested.country);
      if (saved.locations === undefined) setLocations(r.suggested.locations ?? []);
      if (saved.excludedLocations === undefined) setExcludedLocations(r.suggested.excluded_locations ?? []);
      if (saved.post === undefined && r.draft.post_urn) setPost(r.draft.post_urn);
    }).catch((e) => {
      if (stopped) return;
      setNeedsReconnect(RECONNECT_CODES.has((e as { code?: string } | null)?.code ?? ""));
      setLoadError(e instanceof Error && e.message ? e.message : LOAD_FAILED);
    });
    return () => { stopped = true; };
  }, [ready, reviewKey, reviewPath, revision, reloads]);

  function readAgain() {
    forgetCampaignReview(reviewPath, revision);
    setLoadError("");
    setNeedsReconnect(false);
    setLoaded(null);
    setReloads((n) => n + 1);
  }

  useEffect(() => {
    const stale = () => setLoaded(null);
    window.addEventListener(ADS_CONNECTION_CHANGED_EVENT, stale);
    return () => window.removeEventListener(ADS_CONNECTION_CHANGED_EVENT, stale);
  }, []);

  useEffect(() => {
    if (!postError) return;
    postInput.current?.focus();
    postErrorRef.current?.scrollIntoView?.({ block: "center" });
  }, [postError]);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: "center" });
  }, [error]);

  const inputs = { account, budget, bid, country, locations, excludedLocations, post, audience, broadAudience };
  const loadedInputs = useRef<{ key: string; inputs: typeof inputs } | null>(null);
  useEffect(() => {
    if (review && loadedInputs.current?.key !== reviewKey) loadedInputs.current = { key: reviewKey, inputs };
  });
  const dirty = !!review && !!loadedInputs.current && loadedInputs.current.key === reviewKey && !sameDraft(loadedInputs.current.inputs, inputs);

  const selected = review?.accounts.find((a) => (a.account_binding_id ?? a.id) === account);
  const currency = selected?.currency ?? "";

  const prefilled = useRef<string | null>(null);
  const broadNow = useRef(broadAudience);
  broadNow.current = broadAudience;
  const audienceEmpty = !LINKEDIN_AUDIENCE_FACETS.some(f => audience[f].length);
  useEffect(() => {
    if (!review || !selected || !audienceEmpty || broadAudience) return;
    const key = `${reviewKey}|${selected.account_binding_id ?? selected.id}`;
    if (prefilled.current === key || (savedAudienceFits && saved.audience)) return;
    prefilled.current = key;
    void resolveAudienceSuggestions(base, selected.id, selected.account_binding_id, review.draft.audience_suggestions).then((found) => {
      if (prefilled.current !== key || broadNow.current || !LINKEDIN_AUDIENCE_FACETS.some(f => found[f].length)) return;
      if (loadedInputs.current?.key === reviewKey) loadedInputs.current.inputs = { ...loadedInputs.current.inputs, audience: found };
      setAudience((now) => LINKEDIN_AUDIENCE_FACETS.some(f => now[f].length) ? now : found);
    });
  }, [review, selected, audienceEmpty, broadAudience, reviewKey, base, savedAudienceFits, saved.audience]);

  useEffect(() => {
    if (!review) return;
    moneyIn.current = { currency, entered: !!budget || !!bid };
    current.current = { account, currency, budget, bid, country, locations, excludedLocations, post, audience, broadAudience };
    saveCampaignReviewDraft<Draft>(action.id, current.current as Draft);
  }, [review, action.id, account, currency, budget, bid, country, locations, excludedLocations, post, audience, broadAudience]);

  const usdFloor = adConstraint("linkedin_ads")!.min_daily_usd;
  const minBudget = selected?.min_daily_budget ?? (currency === "USD" ? String(usdFloor) : null);
  const starter = !!review?.suggested.daily_budget && budget === review.suggested.daily_budget;
  const budgetProblem = minBudget && budget !== "" && Number(budget) < Number(minBudget)
    ? currency === "USD" ? `LinkedIn's minimum daily budget is ${minBudget} USD.` : `LinkedIn's minimum daily budget for this account is ${minBudget} ${currency} (about ${usdFloor} USD).`
    : "";
  const bidProblem = !(Number(bid) >= 0.01) || bid.trim() === "" ? "Enter a bid of at least 0.01."
    : budget !== "" && Number(bid) > Number(budget) ? "The maximum bid cannot be higher than the daily budget." : "";
  const hasSuggestions = LINKEDIN_AUDIENCE_FACETS.some(f => review?.draft.audience_suggestions?.[f]?.length);
  const hasAudience = LINKEDIN_AUDIENCE_FACETS.some(f => audience[f].length);
  const broadLabel = hasSuggestions ? "Use location and language only instead of Zavi's suggested professional audience." : "Show this to everyone in these locations who speaks the language, with no professional audience.";
  const postRecognised = POST_LINK_FORMS.some(form => form.test(post));
  const postProblem = postError?.message ?? (post.trim() && !postRecognised ? "Zavi does not recognise this as a LinkedIn post link. On the post, open … and choose Copy link to post, then paste it here." : "");
  const overlap = locations.some(l => excludedLocations.some(x => x.id === l.id));
  const valid = !!review && !!handlers.onApprove
    && Number(budget) >= Number(minBudget ?? 1)
    && Number(bid) >= 0.01 && Number(bid) <= Number(budget)
    && /^[A-Z]{2}$/.test(country) && locations.length > 0 && !overlap && !!account && postRecognised && !postError
    && (hasAudience || broadAudience) && !selected?.billing_hold;
  const accountId = selected?.id;
  const bindingId = selected?.account_binding_id;
  const postKey = `${accountId ?? ""}|${bindingId ?? ""}|${post.trim()}`;
  const postUnchecked = postCheckFailed === postKey;
  const postChecking = !!accountId && postRecognised && !postError && !postUnchecked && resolvedPost?.key !== postKey;
  const canCreate = valid && !postUnchecked && !postChecking && !companyChanged;
  const listKey = accountId && selected?.funding_source !== "wallet" ? `${reviewKey}|${accountId}` : "";
  const listed = postList?.key === listKey ? postList : null;
  const pickRows = listed?.posts ?? [];
  const pickedRow = pickRows.some((p) => p.post_urn === post.trim());
  const pastedValue = typed || !pickedRow ? post : "";
  const canSwap = pickRows.length > 0;
  const pickView = !!listKey && pickOpen;
  const showPaste = !pickView || (!!listed && !canSwap);
  const rowThumb = (p: PostRow | undefined) => p?.thumbnail_url?.startsWith("https://") && !brokenThumbs.includes(p.thumbnail_url) ? p.thumbnail_url : null;
  const pickedThumb = rowThumb(pickRows.find((p) => p.post_urn === post.trim()));
  const preselected = useRef("");
  const lastPick = useRef("");
  const lastPaste = useRef("");
  const pickWant = useRef("");
  const swapPostView = () => {
    if (pickView) {
      if (pickedRow) lastPick.current = post.trim();
      if (canSwap) setPost(lastPaste.current);
      setTyped(true);
    } else {
      if (!pickedRow) lastPaste.current = post;
      pickWant.current = lastPick.current || post.trim();
      const keepPaste = !!listed && !canSwap;
      if (!keepPaste) {
        setPost(pickRows.some((p) => p.post_urn === pickWant.current) ? pickWant.current : "");
        setTyped(false);
      }
      setListWanted(true);
    }
    setPostError(null);
    setPickOpen(!pickView);
  };
  useEffect(() => {
    if (!pickView || !listKey || !listed || preselected.current === listKey) return;
    preselected.current = listKey;
    const rows = listed.posts;
    if (!rows.length) {
      setPost((current) => (current.trim() ? current : lastPaste.current));
      setTyped(true);
      return;
    }
    const isRow = (value: string) => rows.some((p) => p.post_urn === value.trim());
    if (post.trim() && !isRow(post)) lastPaste.current = post;
    const choice = isRow(pickWant.current) ? pickWant.current : rows[0].post_urn;
    if (loadedInputs.current?.key === reviewKey && !loadedInputs.current.inputs.post.trim()) loadedInputs.current.inputs = { ...loadedInputs.current.inputs, post: choice };
    setPost((current) => (isRow(current) ? current : choice));
    setTyped(false);
  }, [pickView, listKey, listed, post, reviewKey]);
  const postNeeded = pickView && canSwap ? POST_NEEDED_PICK : POST_NEEDED_PASTE;
  const blockedReason = !review || canCreate || busy || companyChanged ? ""
    : !handlers.onApprove ? "You cannot approve campaigns in this workspace."
    : !account ? (review.accounts.some((a) => a.funding_source === "wallet") ? "Authorize the shared wallet first." : "Connect a LinkedIn ad account first.")
    : selected?.billing_hold ? "LinkedIn has paused this ad account for billing."
    : budget === "" ? "Enter a daily budget."
    : budgetProblem ? "Fix the daily budget above."
    : !(Number(budget) >= Number(minBudget ?? 1)) ? `Enter a daily budget of at least ${minBudget ?? 1} ${currency}.`
    : bidProblem ? "Fix the bid above."
    : locations.length === 0 ? "Add an included location above."
    : overlap ? "Remove the place that is in both location lists."
    : !/^[A-Z]{2}$/.test(country) ? "This draft has no country. Ask Zavi to prepare the campaign again."
    : !post.trim() ? postNeeded
    : postProblem ? "Fix the post link above."
    : postUnchecked ? "Zavi has to check the post with LinkedIn before it can create the campaign."
    : !hasAudience && !broadAudience ? "Choose at least one job title, seniority, industry or company size, or tick the box to use location and language only."
    : postChecking ? "Checking the post…"
    : "Check the fields above.";
  const postPreview = resolvedPost?.key === postKey ? resolvedPost.preview ?? POST_UNREADABLE : null;

  const checkedPosts = useRef(new Map<string, { preview: string | null; author?: string; page?: PostPage; postUrl?: string; repostNote?: string; authorNote?: string | null; imageUrl?: string }>());
  useEffect(() => {
    if (!accountId || !postRecognised) return;
    let stopped = false;
    setPostCheckFailed((k) => (k === postKey ? null : k));
    const known = checkedPosts.current.get(postKey);
    if (known) {
      setResolvedPost({ key: postKey, ...known });
      return;
    }
    const query = new URLSearchParams({ post: post.trim(), account_id: accountId, ...(bindingId ? { account_binding_id: bindingId } : {}) });
    const timer = setTimeout(() => {
      void campaignFetch<{ post_urn?: string; post_preview?: string | null; author?: string; author_note?: string | null; image_url?: unknown; page?: PostPage; repost_note?: string }>(`${base}/post-preview?${query}`).then((r) => {
        const read = { ...toPostRead(r), authorNote: r.author_note, imageUrl: typeof r.image_url === "string" && r.image_url.startsWith("https://") ? r.image_url : undefined };
        checkedPosts.current.set(postKey, read);
        if (!stopped) setResolvedPost({ key: postKey, ...read });
      }).catch((e) => {
        const code = (e as { code?: string }).code;
        if (!code || !POST_REFUSALS.includes(code)) {
          if (!stopped) setPostCheckFailed(postKey);
          return;
        }
        const message = e instanceof Error ? e.message : "LinkedIn refused this post.";
        if (!stopped) setPostError({ message });
      });
    }, 400);
    return () => { stopped = true; clearTimeout(timer); };
  }, [base, accountId, bindingId, post, postKey, postRecognised, postRetry]);

  useEffect(() => {
    if (!listWanted || !listKey || !accountId) return;
    let stopped = false;
    void campaignFetch<{ posts?: unknown; page_name?: unknown }>(`${base}/posts?${new URLSearchParams({ account_id: accountId })}`).then((r) => {
      if (!stopped) setPostList({ key: listKey, failed: false, posts: pickablePosts(r?.posts), pageName: typeof r?.page_name === "string" && r.page_name.trim() ? r.page_name.trim() : null });
    }).catch(() => {
      if (!stopped) setPostList({ key: listKey, failed: true, posts: [], pageName: null });
    });
    return () => { stopped = true; };
  }, [base, listWanted, listKey, accountId, listRetry]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!canCreate || !review || latch.current || tenantSwitchedElsewhere()) return;
    latch.current = true; setBusy(true); setError(""); setPostError(null);
    try {
      const result = await campaignFetch<{ exact_change: NonNullable<ActionItem["body"]["exact_change"]> }>(`${base}/prepare`, {
        method: "POST",
        body: JSON.stringify({ account_id: selected?.id, account_binding_id: selected?.account_binding_id, currency, daily_budget: Number(budget).toFixed(2), unit_cost: Number(bid).toFixed(2), country, post: post.trim(),
          locations: locations.map(l => l.id), excluded_locations: excludedLocations.map(l => l.id),
          audience: Object.fromEntries(LINKEDIN_AUDIENCE_FACETS.map(f => [f, audience[f].map(o => o.urn)])),
          use_broad_audience: broadAudience,
        }),
      });
      const prepared: ActionItem = { ...action, executable: true, card_kind: "executes", primary_label: "Create paused campaign", body: { ...action.body, exact_change: result.exact_change } };
      forgetCampaignReview(reviewPath, revision);
      if (tenantSwitchedElsewhere()) { setCompanyChanged(true); return; }
      onPrepared(prepared);
      const started = await handlers.onApprove?.(prepared);
      if (started === false) { setError(APPROVE_NOT_STARTED); return; }
      onClose();
    } catch (e) {
      forgetCampaignReview(reviewPath, revision);
      const message = e instanceof Error ? e.message : "Could not prepare this campaign.";
      const code = (e as { code?: string }).code;
      if ((code && POST_REFUSALS.includes(code)) || message.startsWith(POST_UNRECOGNISED)) setPostError({ message });
      else setError(message);
    }
    finally { latch.current = false; setBusy(false); }
  }

  const draftPreview = review && !LINKEDIN_POST_PENDING.has(review.draft.post_preview?.trim() ?? "") ? review.draft.post_preview ?? null : null;
  const linkedInText = resolvedPost?.key === postKey ? resolvedPost.preview : null;
  const previewText = review
    ? linkedInText ?? (post === (review.draft.post_urn ?? "") ? draftPreview : null) ?? postPreview ?? (post.trim() ? "Your post shows here once Zavi can read it." : "Paste the link to a company post to preview it here.")
    : loadError ? "The post preview is not available because the draft did not load." : "Reading the post…";
  const previewReal = !!review && previewText !== null && (post === (review.draft.post_urn ?? "") ? draftPreview != null || (resolvedPost?.key === postKey && resolvedPost.preview != null) : resolvedPost?.key === postKey && resolvedPost.preview != null);
  const pending = !review && !loadError;
  const suggestedText = !!review && !review.draft.post_urn && !post.trim() && draftPreview != null;
  const heading = "text-[12px] font-semibold uppercase leading-4 tracking-[0.12em] text-inkMuted";
  const section = "space-y-4 border-t border-rule pt-6";
  const params = { account_id: selected?.id, account_binding_id: selected?.account_binding_id };
  const read = resolvedPost?.key === postKey ? resolvedPost : undefined;
  const page = read?.author === "page" ? read.page : undefined;
  const previewImage = pickedThumb ?? (read?.imageUrl && !brokenThumbs.includes(read.imageUrl) ? read.imageUrl : null);
  const imageOnly = !!previewImage && !previewReal;
  const imageReady = !previewImage || loadedImages.includes(previewImage);
  const settling = !!review && (postChecking || !imageReady);
  const imageLoaded = (src: string) => setLoadedImages((list) => (list.includes(src) ? list : [...list, src]));
  const authorName = postAuthorName(read, listed?.pageName ?? selected?.name ?? "") || (pickedRow && read?.author !== "member" ? listed?.pageName ?? "" : "");
  const preview = <div className="space-y-2">
  {suggestedText && <p role="note" data-testid="suggested-post-text" className="text-[13px] font-medium leading-[18px] text-ink">Zavi&apos;s suggested text, not a chosen post. LinkedIn promotes the post you paste, as it is on LinkedIn.</p>}
  <LinkedInPostPreview name={settling ? "" : authorName} logoUrl={settling ? undefined : page?.logo_url} text={imageOnly && !settling ? "" : previewText} textReal={previewReal && !settling} pending={pending || settling}
    media={previewImage ? <>
      <img data-testid="post-preview-image" src={previewImage} alt="" referrerPolicy="no-referrer" onLoad={() => imageLoaded(previewImage)} onError={() => setBrokenThumbs((list) => [...list, previewImage])} className={`${settling ? "hidden" : "block"} max-h-80 w-full border-y border-rule object-cover`} />
      {settling && <span aria-hidden="true" data-testid="post-preview-image-skeleton" className="block h-56 w-full animate-pulse border-y border-rule bg-bone motion-reduce:animate-none" />}
    </> : undefined} />
  {!settling && read?.repostNote && <p role="note" className="text-[13px] font-medium leading-[18px] text-ink">{read.repostNote}</p>}
  {!settling && read?.postUrl && <p className="text-[13px] leading-[18px] text-inkMuted [overflow-wrap:anywhere]">LinkedIn will promote this post: <a className="underline" href={read.postUrl} target="_blank" rel="noreferrer">{read.postUrl}</a></p>}
  {review && <dl data-testid="review-summary" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 pt-2 text-[14px] leading-5">
    {[
      ["Who sees it", locations.length ? `People in ${locations.map((l) => l.name ?? l.id).join(", ")}` : "No location chosen yet"],
      ["Budget", Number(budget) > 0 ? `Up to ${currency} ${Number(budget).toLocaleString("en-US", { maximumFractionDigits: 2 })} a day` : "Not set yet"],
      ["Runs", "Created paused · No end date"],
    ].map(([label, value]) => <div key={label} className="contents"><dt className="text-ca-secondary">{label}</dt><dd className="break-words font-medium text-ca-xdark">{value}</dd></div>)}
  </dl>}
  {pending && <div aria-hidden="true" data-testid="review-summary-skeleton" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 pt-2">
    {["w-20", "w-40", "w-14", "w-32", "w-10", "w-36"].map((width, i) => <SkeletonBar key={i} className={`my-1 h-3 ${width}`} />)}
  </div>}
  </div>;
  useEffect(() => {
    if (!previewImage || imageReady) return;
    const timer = setTimeout(() => imageLoaded(previewImage), 4000);
    return () => clearTimeout(timer);
  }, [previewImage, imageReady]);
  const footer = <div className="flex w-full flex-wrap items-center justify-end gap-2.5">
    {blockedReason && <p role="status" data-testid="create-blocked-reason" className="sr-only">{blockedReason}</p>}
    {loadError && !review && needsReconnect
      ? <button type="button" className={`${sheetFooterButton} bg-ink text-cream compact:flex-1`} onClick={() => { void import("@/app/connectors/ConnectButton").then((m) => m.startConnectFlow("linkedin_ads", { returnHere: true })); }}>Reconnect LinkedIn Ads</button>
      : loadError && !review
      ? <button type="button" className={`${sheetFooterButton} bg-ink text-cream compact:flex-1`} onClick={readAgain}>Try again</button>
      : <button type="button" className={`${sheetFooterButton} border-[1.5px] border-rule bg-cream text-inkSoft outline-none focus:outline-none compact:flex-1`} disabled={busy} onClick={(e) => { if (dirty) e.currentTarget.closest("dialog")?.dispatchEvent(new Event("cancel")); else onClose(); }}>Cancel</button>}
    {review ? <button type="submit" form={formId} className={`${sheetFooterButton} compact:flex-1 ${canCreate || busy ? "bg-ink text-cream" : "cursor-not-allowed border-[1.5px] border-dashed border-rule bg-ink/5 text-inkMuted disabled:opacity-100"}`} disabled={!canCreate || busy} title={blockedReason || undefined}>{busy ? "Creating…" : "Create paused campaign"}</button> : null}
  </div>;

  return <ActionEditDialog title={`Review your ${spec.title} campaign`} busy={busy} confirmDiscard={dirty} onClose={onClose} preview={preview} previewTitle={<><ChannelMarkIcon slug="linkedin_ads" compact />Live preview</>} footer={footer}>
    {companyChanged && <div role="alert" className="mb-4 space-y-2"><p className="text-[14px] font-medium text-danger">{COMPANY_CHANGED}</p><button type="button" className={`${sheetFooterButton} bg-ink text-cream`} onClick={() => reloadWithoutBuild()}>Reload</button></div>}
    {error && <p ref={errorRef} role="alert" className="mb-4 text-[14px] font-medium text-danger">{error}</p>}
    {loadError && !review && <p role="alert" className="mb-4 text-[14px] font-medium text-danger">{loadError}</p>}
    {!review && !error && !loadError && <AdsReviewSkeleton label="Reading the draft…" />}
    {review && (!handlers.onApprove || !/^[A-Z]{2}$/.test(country)) && <p data-testid="create-unavailable" className="mb-4 text-[14px] font-medium text-danger">{!handlers.onApprove ? "You cannot approve campaigns in this workspace." : "This draft has no country. Ask Zavi to prepare the campaign again."}</p>}
    {review && <form id={formId} onSubmit={submit} className="ads-sheet-form space-y-6"><fieldset disabled={busy} className="space-y-6">
      <section className="space-y-2">
        <p className="text-[16px] font-semibold text-ink">{review.draft.name}</p>
        <p className="text-[14px] font-medium text-inkSoft">{review.draft.rationale}</p>
      </section>

      <section aria-labelledby={`${formId}-budget`} className={section}>
        <h3 id={`${formId}-budget`} className={heading}>Budget</h3>
        {selected?.billing_hold && <p role="alert" data-testid="account-billing-hold" className="text-[13px] font-medium text-danger">{selected.funding_source === "wallet" ? MANAGED_ACCOUNT_BILLING_HOLD : LINKEDIN_ADS_BILLING_HOLD}</p>}
        {review.own_account_unavailable && <p role="status" data-testid="own-account-unavailable" className={sheetHint}>Your own LinkedIn ad accounts cannot be read right now{plainReason(review.own_account_unavailable) ? ` (${review.own_account_unavailable.trim().replace(/[.]+$/, "")})` : ""}.</p>}
        <p className={sheetHint} data-testid="account-billing">{!selected ? (review.accounts.some((a) => a.funding_source === "wallet") ? "No LinkedIn ad account is in use yet. Authorize the shared wallet under Ad account and shared wallet on the LinkedIn Ads page, then open this review again." : "No LinkedIn ad account is in use yet. Connect LinkedIn Ads in Connectors, then open this review again.") : selected.funding_source === "wallet" ? "This campaign runs on the Zavi account and uses your shared ads balance when you approve its launch." : "This campaign runs on your connected LinkedIn ad account. LinkedIn bills it directly."}</p>
        <div className="grid items-start gap-4 md:grid-cols-2">
          <label className={sheetLabel}><span className="flex items-center gap-2">Spend up to, per day
              {starter && <span data-testid="starter-budget" className="whitespace-nowrap rounded-full border border-rule bg-creamDeep px-2 py-0.5 text-[11px] font-semibold leading-4 text-inkSoft">Zavi&apos;s pick</span>}
            </span>
            <span className="relative mt-1.5 block"><span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] font-semibold text-inkMuted">{currency}</span>
              <input aria-label={`Spend up to, per day (${currency})`} className={`${sheetInput} !mt-0 pl-12`} type="number" min={minBudget ?? "1"} step="0.01" required value={budget} onChange={(e) => setBudget(e.target.value)} />
            </span>
            {currencyReset && <span role="status" className="mt-1.5 block text-[13px] font-medium text-danger">{currencyReset}</span>}
            {budgetProblem ? <span role="alert" className="mt-1.5 block text-[13px] font-medium text-danger">{budgetProblem}</span> : budget === "" ? <span data-testid="budget-needed" className="mt-1.5 block text-[13px] font-medium text-danger">Enter a daily budget.</span> : <span className={sheetHint}>Daily average. Nothing spends until you launch.</span>}
          </label>
          <label className={sheetLabel}>Maximum bid per click
            <span className="relative mt-1.5 block"><span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] font-semibold text-inkMuted">{currency}</span>
              <input aria-label={`Maximum bid per click (${currency})`} className={`${sheetInput} !mt-0 pl-12`} type="number" min="0.01" step="0.01" required value={bid} onChange={(e) => setBid(e.target.value)} />
            </span>
            {bidProblem ? <span role="alert" className="mt-1.5 block text-[13px] font-medium text-danger">{bidProblem}</span> : null}
          </label>
        </div>
      </section>

      <section aria-labelledby={`${formId}-locations`} className={section}>
        <h3 id={`${formId}-locations`} className={heading}>Locations</h3>
        <div className="grid items-start gap-6 md:grid-cols-2">
          <CampaignLocations apiBase={base} includeOnly max={50} label="Include locations" selected={locations} onChange={setLocations} params={params} placeholder="Country, region or city" />
          <CampaignLocations apiBase={base} max={50} label="Exclude locations" selected={excludedLocations} onChange={setExcludedLocations} params={params} placeholder="Country, region or city" />
        </div>
        <p className={sheetHint}>EU and EEA locations can be excluded but not included yet.</p>
        {!!review.suggested.unresolved_locations?.length && !review.suggested.locations?.length && <p role="status" className={sheetHint}>Zavi could not use {review.suggested.unresolved_locations.join(", ")} for this campaign, so it filled in no location and chose none for you: no single LinkedIn location matched, or the place is in the EU or EEA and can only be excluded. Add the places you want.</p>}
        {!!review.suggested.unresolved_locations?.length && !!review.suggested.locations?.length && <p className={sheetHint}>Zavi also suggested {review.suggested.unresolved_locations.join(", ")}, which it could not add for you: no single LinkedIn location matched, or the place is in the EU or EEA and can only be excluded. Type to add them, or leave them out.</p>}
        {review.suggested.location_search_failed && <p role="status" className={sheetHint}>{review.suggested.location_search_failed} <button type="button" className="underline underline-offset-2" onClick={readAgain}>Try again</button></p>}
        {locations.length === 0 && <p role="alert" className="text-[13px] text-danger">Add at least one included location.</p>}
        {overlap && <p role="alert" className="text-[13px] text-danger">A location cannot be both included and excluded.</p>}
      </section>

      <section aria-labelledby={`${formId}-audience`} className={section}>
        <h3 id={`${formId}-audience`} className={heading}>Audience</h3>
        {selected && <LinkedInAudiencePicker base={base} accountId={selected.id} bindingId={selected.account_binding_id} value={audience} suggestions={review.draft.audience_suggestions} disabled={busy} onChange={(next) => { setAudienceTouched(true); setAudience(next); }} />}
        {!hasAudience && <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink">
          <FigmaCheckbox label={broadLabel} checked={broadAudience} disabled={busy} onChange={(on) => { setAudienceTouched(true); setBroadAudience(on); }} />
          <span className="pt-0.5">{broadLabel}</span>
        </label>}
        {!hasAudience && !broadAudience && <p data-testid="audience-needed" className={`text-[13px] font-medium ${audienceTouched ? "text-danger" : "text-inkSoft"}`}>Choose a job title, seniority, industry or company size, or tick the box above.</p>}
        <p className={sheetHint}>LinkedIn tools may not be used to discriminate based on personal characteristics such as gender, age, race, or ethnicity. <a className="underline" href="https://www.linkedin.com/help/lms/answer/86856" target="_blank" rel="noreferrer">Learn more</a>.</p>
      </section>

      <section aria-labelledby={`${formId}-post`} className={section}>
        <div className="flex min-h-8 items-center justify-between gap-3 pb-1">
          <h3 id={`${formId}-post`} className={heading}>Post</h3>
          {listKey && <button type="button" data-testid="post-view-swap" className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-rule bg-cream px-3 text-[13px] font-semibold leading-5 text-inkSoft transition-colors hover:border-inkMuted hover:text-ink ${FOCUS_RING}`} onClick={swapPostView}>
            {!pickView ? <><List aria-hidden className="size-4" />Choose from posts</> : <><Link2 aria-hidden className="size-4" />Paste a link</>}
          </button>}
        </div>
        {pickView && !canSwap && <div data-testid="post-picker" className="space-y-2">
          {!listed && <AdsPostRowsSkeleton testId="post-picker-loading" label="Reading the posts on your company page…" />}
          {listed?.failed && <p data-testid="post-picker-failed" className={sheetHint}>Zavi could not list your page&apos;s posts just now. Paste a post link below, or <button type="button" className="underline underline-offset-2" onClick={() => { preselected.current = ""; setPostList(null); setListRetry((n) => n + 1); }}>try again</button>.</p>}
          {listed && !listed.failed && <p data-testid="post-picker-empty" className="rounded-xl border border-dashed border-rule px-4 py-5 text-center text-[14px] text-inkMuted">No posts to pick from yet for {listed.pageName ?? selected?.name ?? "this company page"}. Zavi can only list posts already used in an ad on this account, so paste the link of the post you want to promote.</p>}
        </div>}
        {pickView && canSwap && <div data-testid="post-picker" className="space-y-2">
          <div role="radiogroup" aria-label="Choose a post to promote" className="-m-0.5 flex max-h-[420px] flex-col gap-3 overflow-y-auto overscroll-contain p-0.5">
            {pickRows.map((p) => {
              const on = p.post_urn === post.trim();
              const thumb = rowThumb(p);
              return <button key={p.post_urn} type="button" role="radio" aria-checked={on} onClick={() => { setPost(p.post_urn); setPostError(null); setTyped(false); }} className={`flex w-full shrink-0 cursor-pointer items-center gap-4 rounded-2xl border p-4 text-left transition-colors ${FOCUS_RING} ${on ? "border-ink bg-ink/5 ring-1 ring-ink" : "border-rule bg-cream hover:border-inkMuted hover:bg-creamDeep"}`}>
                {thumb
                  ? <img src={thumb} alt="" referrerPolicy="no-referrer" onError={() => setBrokenThumbs((list) => [...list, thumb])} className="size-24 shrink-0 rounded-xl border border-rule object-cover" />
                  : <span aria-hidden="true" data-testid="post-thumb-placeholder" className="flex size-24 shrink-0 items-center justify-center rounded-xl border border-rule bg-bone text-inkMuted"><ImageIcon className="size-7" /></span>}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-[12px] font-medium leading-4 text-inkMuted">
                    {postDay(p.date)}
                    <span className="rounded-md border border-rule bg-cream px-1.5 text-[11px] font-semibold text-inkSoft">{p.label}</span>
                  </span>
                  <span className={`mt-2 block text-[15px] font-medium leading-[22px] [overflow-wrap:anywhere] ${p.text ? "text-ink" : "text-inkMuted"} ${on ? "line-clamp-3" : "line-clamp-2"}`}>{p.text || (thumb ? "Image post" : "Post without text")}</span>
                </span>
                <span aria-hidden="true" className={`flex size-6 shrink-0 items-center justify-center rounded-full border-[1.5px] ${on ? "border-ink bg-ink text-cream" : "border-rule bg-cream"}`}>{on && <Check className="size-3.5" strokeWidth={3} />}</span>
              </button>;
            })}
          </div>
          {postProblem && <span ref={postErrorRef} role={postError ? "alert" : undefined} className="block text-[13px] font-medium text-danger">{postProblem}</span>}
        </div>}
        {showPaste && <label className={sheetLabel}>The post to promote
          <input ref={postInput} className={sheetInput} required={!pickedRow} value={pastedValue} onChange={(e) => { setPost(e.target.value); setPostError(null); setTyped(true); }} placeholder="https://www.linkedin.com/posts/…" aria-invalid={!!postProblem} aria-describedby={postProblem ? `${formId}-post-error` : undefined} />
          {postProblem && <span ref={postErrorRef} id={`${formId}-post-error`} role={postError ? "alert" : undefined} className="mt-1.5 block text-[13px] font-medium text-danger">{postProblem}</span>}
        </label>}
        {postUnchecked && <p role="alert" className="text-[13px] font-medium text-danger">Zavi could not check this post with LinkedIn just now, so the campaign cannot be created yet. <button type="button" className="underline underline-offset-2" onClick={() => { setPostCheckFailed(null); setPostRetry((n) => n + 1); }}>Check again</button></p>}
        {read?.authorNote && <p role="status" data-testid="post-author-note" className="flex items-center gap-2.5 rounded-xl border border-warn/30 bg-warnBg p-3 text-[14px] font-medium leading-5 tracking-[0.14px] text-ink"><TriangleAlert aria-hidden className="size-5 shrink-0 text-warn" />{read.authorNote}</p>}
        <SheetNote tone="neutral">Created paused. Review the budget, end date and funding source in Zavi before launch.</SheetNote>
      </section>
    </fieldset></form>}
  </ActionEditDialog>;
}
