"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConnectionSection } from "../../layout/settings/ConnectionSection";
import { ChannelBalance } from "./ChannelBalance";
import { BoundAdsCampaigns } from "./BoundAdsCampaigns";
import { chatgpt_ads } from "../platforms/chatgpt_ads";
import { CHANNEL_DASHBOARD_STALE_EVENT } from "../campaignLinks";
import { platformFor } from "../platforms";
import { campaignFetch } from "./api";
import { useWorkspaceOptional } from "../../WorkspaceShell";
import { useLiveRole } from "./liveRole";
import { ADS_CONNECTION_CHANGED_EVENT, invalidateCampaignReviews } from "./campaignReviewPrefetch";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { isMember } from "@/lib/members";
import { LINKEDIN_ADS_BILLING_HOLD, MANAGED_ACCOUNT_BILLING_HOLD } from "../../agent/linkedinAdsTables";

type Platform = "chatgpt" | "linkedin";
type Account = {
  id: string;
  account_id?: string;
  provider_account_id: string | null;
  funding_source: "wallet" | "provider";
  currency: string | null;
  disabled: boolean;
  not_on_login?: boolean;
  owned_elsewhere?: boolean;
  view_only?: boolean;
  billing_hold?: boolean;
};
type Choices = {
  accounts: Account[];
  managed: Array<{ account_id: string; label: string }>;
  selected_id: string | null;
  unseen_selected_id?: string | null;
  unseen_selected_closed?: boolean;
  connection?: string | null;
};
type Consent = { version: string; text: string; accepted: boolean };
type LiveAccounts = {
  accounts: Array<{ id: string; name: string; currency: string | null; billing_hold?: boolean; held_elsewhere?: boolean; view_only?: boolean }>;
  fetched_at?: string | null;
  just_refreshed?: boolean;
};
const secondary =
  "inline-flex h-11 items-center justify-center gap-2 rounded-full border border-ca-strong bg-ca-bg px-4 text-ca-action font-semibold text-ca-xdark sm:h-9 transition-colors hover:bg-ca-hover disabled:cursor-not-allowed disabled:opacity-50";
const primary =
  "inline-flex h-11 items-center justify-center gap-2 rounded-full bg-ca-action px-4 text-ca-action font-semibold text-ca-on-action sm:h-9 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";
const field =
  "mt-2 block h-11 w-full rounded-2xl border border-ca-strong bg-ca-bg px-4 text-ca-facts text-ca-dark outline-none focus:border-ca-border-focus disabled:opacity-50";

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-ca-title font-semibold text-ca-xdark">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Pill({ tone, children }: { tone: "on" | "off"; children: ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-3 py-1 text-ca-action ${
        tone === "on"
          ? "border-success/30 text-success"
          : "border-rule text-inkMuted"
      }`}
    >
      {children}
    </span>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => (w.match(/[\p{L}\p{N}]/u) ?? [""])[0])
    .join("") || "?";

const accountsSeen = (choices: Choices | null, live: LiveAccounts | null, notConnected: boolean) =>
  JSON.stringify([choices?.selected_id ?? null, choices?.accounts.map((a) => [a.id, !!a.not_on_login, a.disabled, !!a.view_only, !!a.billing_hold]) ?? [], choices?.managed.map((m) => [m.account_id, m.label]) ?? [], live?.accounts.map((a) => [a.id, !!a.billing_hold, !!a.held_elsewhere, !!a.view_only]) ?? null, notConnected]);

const sameConsent = (a: Consent | null, b: Consent) => !!a && a.accepted === b.accepted && a.version === b.version && a.text === b.text;

const lastConnection = new Map<string, string>();

const listFailure = (e: unknown) => {
  const code = (e as { code?: string })?.code;
  return code === "linkedin_ads_not_connected" ? "not_connected" as const : code === "linkedin_ads_token_revoked" ? "reconnect" as const : "failed" as const;
};

const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

const BONE = "animate-pulse rounded-md bg-creamDeep [animation-duration:1.6s] motion-reduce:animate-none";

export function AdsAccountSettings({ platform, onConnectionChange, settingsPage = false, hidden = false }: { platform: Platform; onConnectionChange?: () => void; settingsPage?: boolean; hidden?: boolean }) {
  const [data, setData] = useState<Choices | null>(null);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [inventoryVersion, setInventoryVersion] = useState(0);
  const [walletVersion, setWalletVersion] = useState(0);
  const [live, setLive] = useState<LiveAccounts | null>(null);
  const [liveState, setLiveState] = useState<"idle" | "loading" | "failed" | "not_connected" | "reconnect">("idle");
  const [settled, setSettled] = useState(false);
  const [pausedOnWallet, setPausedOnWallet] = useState(0);
  const [refill, setRefill] = useState<{ on: boolean; canAdd: boolean } | null>(null);
  const [reservedCents, setReservedCents] = useState<number | null>(null);
  const [reauthorized, setReauthorized] = useState(false);
  const latch = useRef(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState<{ at: "select" | "pick" | `pick:${string}`; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ at: string; value?: string } | null>(null);
  const base = `/api/ads/accounts/${platform}`;
  const workspace = useWorkspaceOptional();
  const liveRole = useLiveRole();
  const role = liveRole.unknown ? null : liveRole.role;
  const activeTabId = workspace?.activeTabId;
  const readOnly = liveRole.unknown || isMember(role);
  const readOnlyReason = liveRole.unknown
    ? "Zavi could not check your workspace role just now."
    : platform === "linkedin"
      ? "Only a workspace owner or admin can change the shared wallet permission."
      : "Only a workspace owner or admin can change the ad account or the shared wallet permission.";
  const locked = busy || readOnly;
  const listedFor = useRef<string | null>(null);
  const root = useRef<HTMLDetailsElement>(null);
  const hiddenNow = useRef(hidden);
  hiddenNow.current = hidden;
  const choicesCommits = useRef(0);
  const liveCommits = useRef(0);
  const changed = useRef(onConnectionChange);
  changed.current = onConnectionChange;
  const connectionMoved = useCallback((connection?: string | null) => {
    if (!connection) return false;
    const previous = lastConnection.get(base);
    lastConnection.set(base, connection);
    return !!previous && previous !== connection;
  }, [base]);
  const tellPage = useCallback(() => {
    invalidateCampaignReviews();
    window.dispatchEvent(new Event(ADS_CONNECTION_CHANGED_EVENT));
    changed.current?.();
  }, []);
  const seenNow = useRef({ data, live, liveState, consent });
  seenNow.current = { data, live, liveState, consent };
  const load = useCallback(async () => {
    const commits = choicesCommits.current;
    const [a, c] = await Promise.allSettled([
      campaignFetch<Choices>(base),
      campaignFetch<Consent>("/api/ads/wallet/consent"),
    ]);
    setSettled(true);
    if (listedFor.current === base) setInventoryVersion((v) => v + 1);
    listedFor.current = base;
    setConsent(c.status === "fulfilled" ? c.value : null);
    if (commits !== choicesCommits.current) return;
    if (a.status === "rejected") throw a.reason;
    choicesCommits.current++;
    setData(a.value);
    if (connectionMoved(a.value.connection)) tellPage();
  }, [base, connectionMoved, tellPage]);
  useEffect(() => {
    const slug = `${platform}_ads`;
    const stale = (e: Event) => {
      if ((e as CustomEvent<{ slug?: string }>).detail?.slug !== slug) return;
      setWalletVersion((v) => v + 1);
    };
    window.addEventListener(CHANNEL_DASHBOARD_STALE_EVENT, stale);
    return () => window.removeEventListener(CHANNEL_DASHBOARD_STALE_EVENT, stale);
  }, [platform]);
  useEffect(() => {
    setLive(null);
    setLiveState("idle");
    if (platform !== "linkedin" || readOnly) return;
    let stopped = false;
    setLiveState("loading");
    const commits = liveCommits.current;
    campaignFetch<LiveAccounts>(`${base}/available`)
      .then((r) => {
        if (stopped || commits !== liveCommits.current) return;
        liveCommits.current++;
        setLive(r);
        setLiveState("idle");
      })
      .catch((e) => {
        if (!stopped && commits === liveCommits.current) setLiveState(listFailure(e));
      });
    return () => { stopped = true; };
  }, [base, platform, readOnly]);
  const rereadTurn = useRef(0);
  const seenTab = useRef(activeTabId);
  useEffect(() => {
    if (platform !== "linkedin") return;
    async function reread() {
      if (document.visibilityState !== "visible" || latch.current || (hiddenNow.current ? root.current?.parentElement : root.current)?.checkVisibility?.() === false) return;
      const turn = ++rereadTurn.current;
      const [choices, listed, wallet] = await Promise.allSettled([
        campaignFetch<Choices>(base),
        readOnly ? Promise.resolve(null) : campaignFetch<LiveAccounts>(`${base}/available`),
        campaignFetch<Consent>("/api/ads/wallet/consent"),
      ]);
      if (turn !== rereadTurn.current || latch.current) return;
      if (wallet.status === "fulfilled" && !sameConsent(seenNow.current.consent, wallet.value)) setConsent(wallet.value);
      if (choices.status === "rejected") return;
      const refused = listed.status === "rejected" ? listFailure(listed.reason) : "idle";
      const notConnected = refused === "not_connected" || refused === "reconnect";
      const before = seenNow.current;
      const answered = listed.status === "fulfilled" || notConnected;
      const nextLive = listed.status === "fulfilled" ? listed.value : notConnected ? null : before.live;
      const nextState = listed.status === "fulfilled" ? "idle" : notConnected ? refused : before.liveState;
      const moved = connectionMoved(choices.value.connection);
      const baseline = !!before.data && before.liveState !== "loading";
      const same = accountsSeen(before.data, before.live, before.liveState === "not_connected") === accountsSeen(choices.value, nextLive, nextState === "not_connected");
      choicesCommits.current++;
      if (answered) liveCommits.current++;
      if (same && !moved) return;
      setData(choices.value);
      setLive(nextLive);
      setLiveState(nextState);
      setFieldError(null);
      if (!baseline && !moved) return;
      setInventoryVersion((v) => v + 1);
      tellPage();
    }
    const onReturn = () => void reread();
    if (seenTab.current !== activeTabId) {
      seenTab.current = activeTabId;
      onReturn();
    }
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      rereadTurn.current++;
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [base, platform, readOnly, activeTabId, connectionMoved, tellPage]);
  useEffect(() => {
    setData(null);
    setSettled(false);
    setError("");
    setFieldError(null);
    void load().catch((e) => setError(e.message));
  }, [load]);
  async function action(
    work: () => Promise<unknown>,
    reloadOnError = false,
    readOnlyWork = false,
    at?: "select" | "pick" | `pick:${string}`,
    pressed?: { at: string; value?: string },
  ) {
    if (latch.current) return;
    latch.current = true;
    rereadTurn.current++;
    setBusy(true);
    setPending(pressed ?? null);
    setError("");
    setFieldError(null);
    try {
      if (readOnlyWork) await work();
      else {
        await work();
        await load();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "The account change could not be saved.";
      if (at) setFieldError({ at, message });
      else setError(message);
      if (reloadOnError) await load().catch(() => undefined);
    } finally {
      latch.current = false;
      setBusy(false);
      setPending(null);
    }
  }
  const post = (path: string, body: unknown) =>
    campaignFetch(path, { method: "POST", body: JSON.stringify(body) }).then(
      (r) => { invalidateCampaignReviews(); changed.current?.(); return r; },
      (e) => {
        invalidateCampaignReviews();
        if ((e as { code?: string })?.code === "ads_stops_pending") changed.current?.();
        throw e;
      },
    );
  async function withdraw(version: string) {
    if (latch.current) return;
    const confirmed = await confirmAction({
      title: "Withdraw shared-wallet permission?",
      description:
        "LinkedIn campaigns paid from your shared ads balance will be paused, and auto-refill will be turned off. Campaigns you launched yourself on your own LinkedIn billing keep running; ones Autopilot launched are paused. Spending already incurred is still settled.",
      confirmLabel: "Withdraw permission",
      tone: "danger",
    });
    if (!confirmed) return;
    setReauthorized(false);
    await action(
      () => post("/api/ads/wallet/consent", { version, accept: false }),
      true,
      false,
      undefined,
      { at: "withdraw" },
    );
  }
  async function authorize(c: Consent) {
    if (latch.current) return;
    const confirmed = await confirmAction({
      title: "Authorize the shared wallet",
      description: "Read the permission below. Confirming lets Zavi pay for campaigns you approve from your shared ads balance.",
      body: (
        <p data-testid="consent-terms-popup" className="max-h-[40vh] overflow-y-auto whitespace-pre-line break-words rounded-lg border border-rule bg-bone/60 p-3 text-[13px] leading-6 text-inkSoft">
          {c.text}
        </p>
      ),
      confirmLabel: "I authorize",
      size: "lg",
    });
    if (!confirmed) return;
    await action(
      () =>
        post("/api/ads/wallet/consent", { version: c.version, accept: true }).then(() => setReauthorized(true)),
      false,
      false,
      undefined,
      { at: "authorize" },
    );
  }
  const selectedDisabled = !!data?.accounts.some(
    (a) => a.id === data.selected_id && a.disabled,
  );
  const walletOff = !!consent && !consent.accepted;
  const selectedAccount = data?.accounts.find((a) => a.id === data.selected_id && !a.disabled);
  const selectedElsewhere = !!selectedAccount?.owned_elsewhere;
  const selectedViewOnly = !!selectedAccount?.view_only;
  const selectedWalletOff = selectedAccount?.funding_source === "wallet" && walletOff;
  const unusable = (a: Account) => a.disabled || !!a.owned_elsewhere || !!a.view_only || (a.funding_source === "wallet" && walletOff);
  async function stopUsing(id: string) {
    if (latch.current) return;
    const confirmed = await confirmAction({
      title: "Stop using this account for new campaigns?",
      description:
        "Zavi will not create new campaigns on this account until you choose Use this account again. Campaigns already on it keep running, and you can still pause them.",
      confirmLabel: "Stop using account",
      tone: "danger",
    });
    if (!confirmed) return;
    await action(
      () => post(`${base}/disable`, { account_binding_id: id }),
      false,
      false,
      "select",
      { at: "stop" },
    );
  }
  const inUse = data?.accounts.find(
    (a) => a.id === data.selected_id && !a.disabled && !a.view_only && a.funding_source === "provider",
  );
  const inUseAccountId = inUse?.provider_account_id ?? null;
  const ownBilling = `Campaigns on your own account are billed by ${platformFor(`${platform}_ads`).name}. Only campaigns on a Zavi account use your shared ads balance.`;
  const available = live?.accounts ?? null;
  const accountWords = (a: Account) =>
    [
      a.disabled ? "Disabled" : a.view_only ? "View only" : "",
      a.billing_hold ? "Billing hold" : "",
      a.funding_source === "wallet"
        ? data?.managed.find((m) => m.account_id === a.account_id)?.label
        : available?.find((x) => x.id === a.provider_account_id)?.name,
      a.funding_source === "wallet" ? "Shared wallet" : `Your ${platformFor(`${platform}_ads`).name} billing`,
      a.provider_account_id ?? "Verify account",
      a.currency ?? "Currency unverified",
    ]
      .filter(Boolean)
      .join(" · ");
  const liveIds = available?.map((a) => a.id) ?? null;
  const unseenByLogin = !!data?.unseen_selected_id || (!!inUseAccountId && !!liveIds && !liveIds.includes(inUseAccountId));
  const offered = data?.accounts.filter((a) => !a.not_on_login) ?? [];
  const walletUnread = settled && !consent;
  const firstLoad = !data && !error;
  const noteCampaigns = (list: Array<{ id: string; name?: string | null; funding_source: "wallet" | "provider"; status?: string | null }>) => {
    setPausedOnWallet(list.filter((c) => c.funding_source === "wallet" && c.status?.trim().toLowerCase() === "paused").length);
  };
  useEffect(() => {
    if (platform !== "linkedin") return;
    let stopped = false;
    void campaignFetch<{ campaigns: Array<{ id: string; name?: string | null; funding_source: "wallet" | "provider"; status?: string | null }> }>(
      "/api/ads/campaigns?platform=linkedin",
    )
      .then((r) => {
        if (!stopped) noteCampaigns(r.campaigns);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [platform, inventoryVersion]);
  const unusableIds = new Set((data?.accounts ?? []).filter((a) => a.view_only || a.owned_elsewhere).map((a) => a.provider_account_id));
  const liveUsable = available?.filter((a) => !a.held_elsewhere && !a.view_only && !unusableIds.has(a.id)) ?? null;
  const firstLive = liveUsable?.find((a) => !a.billing_hold) ?? liveUsable?.[0] ?? null;
  const zaviGrant = data?.managed[0] ?? null;
  const loginHasNoAccount = liveState === "idle" && available?.length === 0;
  const zaviHeld = !!zaviGrant && !!data?.accounts.some((a) => a.account_id === zaviGrant.account_id && a.funding_source === "wallet" && a.billing_hold);
  const bindTarget: { kind: "own"; id: string } | { kind: "zavi"; id: string } | null =
    platform !== "linkedin" || readOnly || !data || (selectedAccount && !selectedAccount.view_only && !selectedAccount.owned_elsewhere && !selectedAccount.not_on_login)
      ? null
      : firstLive
        ? { kind: "own", id: firstLive.id }
        : zaviGrant && !zaviHeld && consent?.accepted && loginHasNoAccount
          ? { kind: "zavi", id: zaviGrant.account_id }
          : null;
  const bindKey = bindTarget ? `${data?.connection ?? ""}:${bindTarget.kind}:${bindTarget.id}` : null;
  const bound = useRef<string | null>(null);
  const bindNow = useRef(() => {});
  const bind = (target: { kind: "own" | "zavi"; id: string }, chosen = false) => {
    if (!data) return;
    const existing =
      target.kind === "own"
        ? data.accounts.find(
            (a) => a.provider_account_id === target.id && a.funding_source === "provider" && !a.owned_elsewhere && !a.view_only,
          )
        : data.accounts.find((a) => a.account_id === target.id && a.funding_source === "wallet" && !a.billing_hold);
    void action(
      () =>
        existing
          ? post(`${base}/${existing.disabled ? "enable" : "select"}`, { account_binding_id: existing.id })
          : post(`${base}/connect`, target.kind === "own" ? { mode: "customer", account_id: target.id } : { mode: "managed", account_id: target.id }),
      false,
      false,
      chosen ? undefined : `pick:${target.id}`,
      { at: `pick:${target.id}` },
    );
  };
  bindNow.current = () => {
    if (bindTarget) bind(bindTarget);
  };
  const pickError = fieldError && fieldError.at.startsWith("pick") ? fieldError.message : null;
  useEffect(() => {
    if (!bindKey || bound.current === bindKey) return;
    bound.current = bindKey;
    bindNow.current();
  }, [bindKey]);
  const connectedName = selectedAccount
    ? (selectedAccount.funding_source === "wallet"
        ? data?.managed.find((m) => m.account_id === selectedAccount.account_id)?.label ?? "Zavi's account"
        : available?.find((x) => x.id === selectedAccount.provider_account_id)?.name ?? selectedAccount.provider_account_id)
    : null;
  const openConnect = () => {
    if (root.current) root.current.open = true;
    root.current?.scrollIntoView?.({ block: "start" });
  };
  const settledOn = selectedAccount && !selectedAccount.view_only && !selectedAccount.owned_elsewhere && !selectedAccount.not_on_login ? selectedAccount : null;
  const ownInUse = settledOn?.funding_source === "provider" ? settledOn : null;
  const walletInUse = settledOn?.funding_source === "wallet" && !!consent?.accepted;
  const ownName = ownInUse ? available?.find((x) => x.id === ownInUse.provider_account_id)?.name ?? null : null;
  const ownHeld = !!ownInUse && (!!ownInUse.billing_hold || !!available?.find((x) => x.id === ownInUse.provider_account_id)?.billing_hold);
  const liveBlocked = available?.filter((a) => !liveUsable?.includes(a)) ?? [];
  const liveHeld = liveBlocked.filter((a) => a.held_elsewhere || !!data?.accounts.some((b) => b.provider_account_id === a.id && b.owned_elsewhere));
  const liveViewOnly = liveBlocked.filter((a) => !liveHeld.includes(a));
  const listed = (list: Array<{ name: string }>) => list.map((a) => a.name).join(", ");
  const cardNote = "text-ca-action text-ca-secondary";
  const inUsePill = (
    <Pill tone="on">
      <Check className="mr-1 h-3 w-3" strokeWidth={2.5} aria-hidden />
      In use
    </Pill>
  );
  const walletSection = consent ? (
              <Section
                title="Shared wallet permission"
                aside={
                  <Pill tone={consent.accepted ? "on" : "off"}>
                    {consent.accepted && (
                      <Check className="mr-1 h-3 w-3" strokeWidth={2.5} aria-hidden />
                    )}
                    {consent.accepted ? "Authorized" : "Not authorized"}
                  </Pill>
                }
              >
                {consent.accepted ? (
                  <div className="flex flex-col gap-4 rounded-2xl border border-ca-border bg-ca-subtle p-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                      <div className="min-w-0 space-y-1.5">
                        <p className="text-ca-facts font-medium text-ca-xdark">
                          {inUse ? ownBilling : "Approved campaigns are paid from your shared ads balance."}
                        </p>
                        <p className="text-ca-action text-ca-secondary">
                          Withdrawing pauses LinkedIn campaigns paid from this
                          balance and turns off auto-refill. ChatGPT campaigns and
                          campaigns you launched yourself on your own LinkedIn billing
                          keep running; ones Autopilot launched are paused.
                        </p>
                      </div>
                      <button
                        type="button"
                        className={`${secondary} w-full shrink-0 whitespace-nowrap sm:w-auto`}
                        disabled={readOnly || pending?.at === "withdraw"}
                        aria-disabled={busy || undefined}
                        aria-busy={pending?.at === "withdraw" || undefined}
                        title={readOnly ? readOnlyReason : undefined}
                        onClick={() => void withdraw(consent.version)}
                      >
                        {pending?.at === "withdraw" && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
                        {pending?.at === "withdraw" ? "Withdrawing…" : "Withdraw shared-wallet permission"}
                      </button>
                    </div>
                    {reauthorized && (refill?.on === false || pausedOnWallet > 0) && (
                      <div role="status" data-testid="reauthorized-followup" className="space-y-1.5 border-t border-rule pt-3 text-[13px] leading-5 text-ink">
                        {refill?.on === false && (
                          <p>
                            Auto-refill is still off.{refill.canAdd ? " To turn it back on, use Add balance above and tick Also auto-refill my ads balance." : ""}
                          </p>
                        )}
                        {pausedOnWallet > 0 && (
                          <p>
                            {pausedOnWallet === 1
                              ? "1 LinkedIn campaign paid from your shared ads balance is still paused."
                              : `${pausedOnWallet} LinkedIn campaigns paid from your shared ads balance are still paused.`}{" "}
                            Zavi does not restart them on its own. Use Review launch on each one below to run it again.
                          </p>
                        )}
                      </div>
                    )}
                    <details data-testid="consent-terms" className="group/terms w-full border-t border-ca-border pt-3">
                      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md text-[13px] font-medium text-inkMuted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 sm:min-h-0 [&::-webkit-details-marker]:hidden">
                        <ChevronRight
                          className="h-4 w-4 shrink-0 transition-transform group-open/terms:rotate-90"
                          aria-hidden
                        />
                        View the terms you accepted
                      </summary>
                      <p className="mt-2 w-full whitespace-pre-line break-words rounded-lg border border-rule bg-cream p-3 text-[13px] leading-6 text-inkSoft">
                        {consent.text}
                      </p>
                    </details>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 rounded-xl border border-rule bg-bone/60 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                    <div className="min-w-0 space-y-1.5">
                      <p className="text-[14px] font-medium leading-5 text-ink">
                        Zavi is not allowed to pay for campaigns from your shared ads balance.
                      </p>
                      <p className="text-[13px] leading-5 text-inkMuted">
                        {inUse ? ownBilling : "Authorize it to let Zavi run campaigns you approve, paid from your shared balance. You read the permission before confirming."}
                      </p>
                    </div>
                    <button
                      type="button"
                      className={`${primary} w-full shrink-0 whitespace-nowrap sm:w-auto`}
                      disabled={readOnly || pending?.at === "authorize"}
                      aria-disabled={busy || undefined}
                      aria-busy={pending?.at === "authorize" || undefined}
                      title={readOnly ? readOnlyReason : undefined}
                      onClick={() => void authorize(consent)}
                    >
                      {pending?.at === "authorize" && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
                      {pending?.at === "authorize" ? "Authorizing…" : "Authorize shared wallet"}
                    </button>
                  </div>
                )}
              </Section>
  ) : null;
  return (
    <>
    <details ref={root} open={settingsPage || undefined} hidden={hidden} className={`group rounded-2xl border border-ca-border bg-ca-bg ${settingsPage ? "" : "my-4"} ${hidden ? "hidden" : ""}`}>
      <summary
        className={`flex list-none items-center gap-3 p-5 [&::-webkit-details-marker]:hidden ${firstLoad ? "pointer-events-none" : "cursor-pointer"}`}
        tabIndex={firstLoad ? -1 : undefined}
        aria-busy={firstLoad || undefined}
        data-testid="ads-account-summary"
      >
        {firstLoad ? (
          <>
            <span className={`size-4 shrink-0 ${BONE}`} />
            <span className="sr-only">Ad account and shared wallet</span>
            <span className={`h-5 w-56 max-w-[60%] ${BONE}`} />
            <span className={`ml-auto h-6 w-28 rounded-full ${BONE}`} />
          </>
        ) : (
          <>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-inkMuted transition-transform group-open:rotate-90"
              aria-hidden
            />
            <span className="flex-1 text-ca-section font-semibold text-ca-xdark">
              Ad account and shared wallet
            </span>
            {consent && (
              <Pill tone={consent.accepted ? "on" : "off"}>
                {consent.accepted && settingsPage && <Check className="mr-1.5 h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />}
                {consent.accepted ? "Wallet authorized" : "Wallet not authorized"}
              </Pill>
            )}
          </>
        )}
      </summary>
      <div className="flex flex-col gap-8 border-t border-ca-border p-5">
        {error && (
          <p
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 px-4 py-3 text-[14px] text-danger"
          >
            <span>{error}</span>
            {!data && (
              <button
                type="button"
                className={`${secondary} min-h-11 shrink-0 sm:min-h-9`}
                disabled={busy}
                onClick={() => {
                  setError("");
                  void load().catch((e) => setError(e instanceof Error && e.message ? e.message : "Account settings could not load. Try again."));
                }}
              >
                Try again
              </button>
            )}
          </p>
        )}
        {readOnly && liveRole.unknown && (
          <p role="status" data-testid="account-role-unread" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rule bg-bone/60 px-4 py-3 text-[14px] text-inkMuted">
            <span>
              {liveRole.checking
                ? "Checking your workspace role…"
                : "Zavi could not check your workspace role just now, so changes here are paused until it can. You can view the current setup below."}
            </span>
            {!liveRole.checking && (
              <button type="button" className={`${secondary} min-h-11 shrink-0 sm:min-h-9`} onClick={liveRole.recheck}>
                Try again
              </button>
            )}
          </p>
        )}
        {readOnly && !liveRole.unknown && (
          <p role="status" className="rounded-xl border border-rule bg-bone/60 px-4 py-3 text-[14px] text-inkMuted">
            {readOnlyReason} You can view the current setup below.
          </p>
        )}
        {firstLoad && (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">Loading account settings…</span>
            <span className={`h-4 w-2/3 ${BONE}`} />
            <span className={`h-4 w-1/2 ${BONE}`} />
            <span className={`h-10 w-full ${BONE}`} />
          </div>
        )}
        {walletUnread && (
          <p
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 px-4 py-3 text-[14px] text-danger"
          >
            <span>
              Zavi could not read your shared wallet permission just now, so it is not shown. Your campaigns and their Pause controls below still work.
            </span>
            <button
              type="button"
              className={`${secondary} min-h-11 shrink-0 sm:min-h-9`}
              disabled={busy}
              onClick={() => void action(async () => {})}
            >
              Try again
            </button>
          </p>
        )}
        {platform === "linkedin" && pickError && (
          <p role="alert" data-testid="linkedin-account-error" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 px-4 py-3 text-[14px] text-danger">
            <span>{pickError}</span>
            <button type="button" onClick={() => bindNow.current()} disabled={busy} className="underline">Try again</button>
          </p>
        )}
        {data && (
          <>
            {chatgpt_ads.campaignWorkspace && (
              <ChannelBalance
                spec={chatgpt_ads.campaignWorkspace}
                {...(platform === "linkedin" ? { platform } : {})}
                variant="card"
                refreshKey={`${inventoryVersion}:${walletVersion}`}
                onWallet={(w) => { setRefill({ on: w.auto_refill_enabled, canAdd: w.funding_enabled }); setReservedCents(w.reserved_cents); }}
              />
            )}

            {platform === "chatgpt" && (
            <Section title="Account for new campaigns">
              {selectedDisabled && (
                <p role="status" className="text-[14px] text-danger">
                  Your selected account is disabled for new campaigns. Choose
                  another account to continue.
                </p>
              )}
              {!offered.length && (
                <p data-testid="no-account-hint" className="text-[13px] leading-5 text-inkMuted">
                  No account is connected yet. Use Connect an account below to add one.
                </p>
              )}
              <label className="relative block text-[14px] text-inkMuted">
                <span className="sr-only">Account for new campaigns</span>
                <ChevronDown
                  className="pointer-events-none absolute right-4 top-1/2 mt-1 h-4 w-4 -translate-y-1/2 text-inkMuted"
                  aria-hidden
                />
                <select
                  aria-label="Account for new campaigns"
                  disabled={readOnly || pending?.at === "select"}
                  aria-disabled={busy || undefined}
                  aria-busy={pending?.at === "select" || undefined}
                  title={readOnly ? readOnlyReason : undefined}
                  value={pending?.at === "select" ? pending.value : (data.selected_id ?? "")}
                  className={`${field} cursor-pointer appearance-none pr-11`}
                  onChange={(e) => {
                    const id = e.target.value;
                    if (id)
                      void action(
                        () =>
                          post(`${base}/select`, { account_binding_id: id }),
                        false,
                        false,
                        "select",
                        { at: "select", value: id },
                      );
                  }}
                >
                  <option value="">Choose an account</option>
                  {offered
                    .filter((a) => !unusable(a) || a.id === data.selected_id)
                    .map((a) => (
                      <option key={a.id} value={a.id} disabled={unusable(a)}>
                        {accountWords(a)}
                      </option>
                    ))}
                </select>
              </label>
              {pending?.at === "select" && (
                <p role="status" data-testid="account-saving" className="inline-flex items-center gap-2 text-[13px] leading-5 text-inkMuted">
                  <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  Saving…
                </p>
              )}
              {fieldError?.at === "select" && (
                <p role="alert" className="break-words text-[13px] leading-5 text-danger">
                  {fieldError.message}
                </p>
              )}
              {selectedElsewhere && (
                <p role="status" data-testid="selected-owned-elsewhere" className="text-[13px] leading-5 text-danger">
                  This ad account is now connected to another Zavi workspace, so this workspace cannot use it for new campaigns. Pick another account.
                </p>
              )}
              {selectedViewOnly && (
                <p role="status" data-testid="selected-view-only" className="text-[13px] leading-5 text-danger">
                  Your LinkedIn login can only view this ad account, so Zavi cannot create campaigns on it. Ask an admin of the account in LinkedIn Campaign Manager to make you an Account Manager or Campaign Manager, then use the refresh button below, or pick another account.
                </p>
              )}
              {selectedAccount?.billing_hold && (
                <p role="status" data-testid="selected-billing-hold" className="text-[13px] leading-5 text-danger">
                  {selectedAccount.funding_source === "wallet" ? MANAGED_ACCOUNT_BILLING_HOLD : LINKEDIN_ADS_BILLING_HOLD}
                </p>
              )}
              {selectedWalletOff && (
                <p role="status" data-testid="selected-wallet-off" className="text-[13px] leading-5 text-danger">
                  Your shared wallet permission is withdrawn, so the Zavi account cannot be used for new campaigns. Authorize the shared wallet again below, or pick your own account.
                </p>
              )}
              {unseenByLogin && (
                <p role="status" className="text-[13px] leading-5 text-danger">
                  {data.unseen_selected_closed
                    ? "This ad account is closed in LinkedIn. Pick another account."
                    : "Your LinkedIn login can't see this ad account any more. Pick an account your login can see."}
                </p>
              )}
              {!settingsPage && data.selected_id && !selectedDisabled && !readOnly && pending?.at !== "select" && (
                <button
                  type="button"
                  className="inline-flex items-center gap-2 self-start text-[13px] font-medium text-danger underline-offset-2 hover:underline disabled:opacity-50"
                  disabled={pending?.at === "stop"}
                  aria-disabled={busy || undefined}
                  aria-busy={pending?.at === "stop" || undefined}
                  onClick={() => void stopUsing(data.selected_id!)}
                >
                  {pending?.at === "stop" && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
                  {pending?.at === "stop" ? "Stopping…" : "Stop using this account for new campaigns"}
                </button>
              )}
              {!readOnly &&
                offered
                  .filter((a) => a.disabled && !a.owned_elsewhere)
                  .map((a) => (
                    <div
                      key={a.id}
                      data-testid={`disabled-account-${a.id}`}
                      className="flex flex-col gap-2 rounded-xl border border-rule px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <p className="text-[13px] text-inkMuted">
                        {a.funding_source === "wallet" ? "Zavi account" : "Your account"} · {a.provider_account_id ?? "Verify account"}{" "}
                        is not used for new campaigns.
                      </p>
                      <button
                        type="button"
                        className={`${secondary} shrink-0 whitespace-nowrap`}
                        disabled={pending?.at === `enable:${a.id}`}
                        aria-disabled={busy || undefined}
                        aria-busy={pending?.at === `enable:${a.id}` || undefined}
                        onClick={() =>
                          void action(
                            () => post(`${base}/enable`, { account_binding_id: a.id }),
                            false,
                            false,
                            undefined,
                            { at: `enable:${a.id}` },
                          )
                        }
                      >
                        {pending?.at === `enable:${a.id}` && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
                        {pending?.at === `enable:${a.id}` ? "Turning on…" : "Use this account again"}
                      </button>
                    </div>
                  ))}
            </Section>
            )}

            {walletSection}

            {platform === "linkedin" && (
            <Section title="Connect an account">
              <div className="grid gap-4 sm:grid-cols-2">
                <div data-testid="linkedin-wallet-card" className="flex flex-col gap-4 rounded-2xl border border-ca-border bg-ca-bg p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-ca-title font-semibold text-ca-xdark">
                        Use a Zavi account
                      </p>
                      <p className={`mt-1 ${cardNote}`}>
                        Zavi runs campaigns on its own LinkedIn ad account and pays from your shared wallet.
                      </p>
                      <p className={`mt-1 ${cardNote}`}>
                        It can only promote posts from the LinkedIn page Zavi’s ad account advertises for, not posts from your own company page.
                      </p>
                    </div>
                    {walletInUse && inUsePill}
                  </div>
                  {walletInUse ? (
                    <div data-testid="linkedin-wallet-state" className="space-y-1.5 text-ca-facts text-ca-xdark">
                      <p>New campaigns run on Zavi’s ad account, paid from your shared wallet.</p>
                      {settledOn?.billing_hold && <p className="text-danger">{MANAGED_ACCOUNT_BILLING_HOLD}</p>}
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={secondary}
                        disabled={locked || !zaviGrant || zaviHeld || !consent?.accepted}
                        aria-busy={(!!zaviGrant && pending?.at === `pick:${zaviGrant.account_id}`) || undefined}
                        title={readOnly ? readOnlyReason : undefined}
                        onClick={() => zaviGrant && bind({ kind: "zavi", id: zaviGrant.account_id }, true)}
                      >
                        {zaviGrant && pending?.at === `pick:${zaviGrant.account_id}` && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
                        Use Zavi’s LinkedIn account
                      </button>
                      {(!zaviGrant || zaviHeld || (consent && !consent.accepted)) && (
                        <p data-testid="linkedin-wallet-state" className={cardNote}>
                          {!zaviGrant
                            ? "Zavi’s LinkedIn ad account is not ready for this workspace yet."
                            : zaviHeld
                              ? MANAGED_ACCOUNT_BILLING_HOLD
                              : "Authorize the permission above to use it."}
                        </p>
                      )}
                    </>
                  )}
                </div>
                <div data-testid="linkedin-own-card" className="flex flex-col gap-4 rounded-2xl border border-ca-border bg-ca-bg p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-ca-title font-semibold text-ca-xdark">
                        Use your own account
                      </p>
                      <p className={`mt-1 ${cardNote}`}>
                        Run campaigns on a LinkedIn ad account you already own. LinkedIn bills you directly.
                      </p>
                    </div>
                    {ownInUse ? inUsePill : <Pill tone="off">Billed by LinkedIn</Pill>}
                  </div>
                  <div data-testid="linkedin-own-state" className="space-y-1.5 text-ca-facts text-ca-xdark">
                    {ownInUse && !liveUsable?.some((a) => a.id === ownInUse.provider_account_id) && (
                      <p>New campaigns run on {ownName ?? "your LinkedIn ad account"}.</p>
                    )}
                    {ownHeld && (
                      <p className="text-danger">
                        LinkedIn has paused this ad account for billing, so campaigns on it cannot run until its payment method is fixed in LinkedIn.
                      </p>
                    )}
                    {readOnly ? (
                      !ownInUse && <p>No ad account of your own is in use here. A workspace owner or admin can set one up.</p>
                    ) : liveState === "not_connected" ? (
                      <p>LinkedIn Ads is not connected yet. Connect it to pick one of your ad accounts.</p>
                    ) : liveState === "reconnect" ? (
                      <p>Your LinkedIn connection has expired. Reconnect LinkedIn Ads to use your own ad account.</p>
                    ) : liveState === "failed" ? (
                      <p>Zavi could not read the ad accounts on your LinkedIn login just now.</p>
                    ) : !available ? (
                      <p>Checking the ad accounts on your LinkedIn login…</p>
                    ) : liveUsable?.length ? null : (
                      <>
                        {available.length === 0 && <p>This LinkedIn login has no ad account.</p>}
                        {liveHeld.length > 0 && (
                          <p data-testid="linkedin-accounts-held-elsewhere">
                            {liveHeld.length === 1
                              ? `Your LinkedIn ad account ${listed(liveHeld)} is already connected to another Zavi workspace, so it cannot be used here.`
                              : `Your LinkedIn ad accounts ${listed(liveHeld)} are already connected to another Zavi workspace, so they cannot be used here.`}{" "}
                            An ad account runs in one workspace at a time. Open that workspace to see its campaigns and numbers, or disconnect LinkedIn Ads there first to use the account here.
                          </p>
                        )}
                        {liveViewOnly.length > 0 && (
                          <p>
                            Your LinkedIn login can only view {listed(liveViewOnly)}, so Zavi cannot run ads on {liveViewOnly.length === 1 ? "it" : "them"}. Ask an admin of the ad account to give you a manager role.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  {!readOnly && (liveState === "not_connected" || liveState === "reconnect") && (
                    <button
                      type="button"
                      className={`${primary} self-start`}
                      disabled={busy}
                      onClick={() => void platformFor("linkedin_ads").connect?.()}
                    >
                      {liveState === "reconnect" ? "Reconnect LinkedIn Ads" : "Connect LinkedIn Ads"}
                    </button>
                  )}
                  {!readOnly && liveState === "idle" && !!liveUsable?.length && (
                    <div role="radiogroup" aria-label="Your LinkedIn ad accounts" aria-disabled={locked || undefined} className="flex flex-col gap-2 border-t border-rule pt-3">
                      {liveUsable.map((a) => {
                        const checked = ownInUse?.provider_account_id === a.id;
                        const saving = pending?.at === `pick:${a.id}`;
                        return (
                          <button
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            aria-label={`${a.name} · your account`}
                            key={a.id}
                            className={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:cursor-not-allowed disabled:opacity-50 ${
                              checked ? "border-ink bg-bone" : "border-rule bg-cream hover:border-inkMuted hover:bg-bone/60"
                            }`}
                            disabled={saving}
                            aria-disabled={busy || undefined}
                            aria-busy={saving || undefined}
                            onClick={() => {
                              if (!checked) bind({ kind: "own", id: a.id }, true);
                            }}
                          >
                            <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-creamDeep text-[13px] font-semibold uppercase text-inkSoft">
                              {initials(a.name)}
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-[15px] font-medium leading-5 text-ink">{a.name}</span>
                              <span className="truncate text-[13px] leading-5 text-inkMuted">
                                {saving ? "Saving…" : a.billing_hold ? "Paused by LinkedIn for billing" : "Billed by LinkedIn"}
                              </span>
                            </span>
                            <span aria-hidden className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] ${checked ? "border-ink" : "border-rule"}`}>
                              {checked && <span className="size-2.5 rounded-full bg-ink" />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </Section>
            )}

            {platform === "chatgpt" && (
            <Section title="Connect an account">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-4 rounded-2xl border border-ca-border bg-ca-bg p-5">
                  <div className="min-w-0">
                    <p className="text-ca-title font-semibold text-ca-xdark">
                      Use a Zavi account
                    </p>
                    <p className="mt-1 text-ca-action text-ca-secondary">
                      Zavi runs campaigns on its own ad account and pays from your shared wallet.
                    </p>
                  </div>
                  <button
                    type="button"
                    className={secondary}
                    disabled={locked}
                    onClick={() =>
                      void action(() =>
                        post(`${base}/connect`, { mode: "managed" }),
                      )
                    }
                  >
                    Use Zavi’s ChatGPT account
                  </button>
                  {!!data.managed.length && (
                    <div
                      role="radiogroup"
                      aria-label="Zavi accounts"
                      aria-disabled={locked || !consent?.accepted || undefined}
                      className="flex flex-col gap-2 border-t border-rule pt-3"
                    >
                      {data.managed.map((a) => {
                        const checked = !!data.accounts.some(
                          (x) =>
                            x.id === data.selected_id &&
                            !x.disabled &&
                            x.funding_source === "wallet" &&
                            x.account_id === a.account_id,
                        );
                        return (
                          <button
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            aria-label={`${a.label} · Zavi account`}
                            key={a.account_id}
                            className={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:cursor-not-allowed disabled:opacity-50 ${
                              checked
                                ? "border-ink bg-bone"
                                : "border-rule bg-cream hover:border-inkMuted hover:bg-bone/60"
                            }`}
                            disabled={readOnly || !consent?.accepted || pending?.at === `managed:${a.account_id}`}
                            aria-disabled={busy || undefined}
                            aria-busy={pending?.at === `managed:${a.account_id}` || undefined}
                            onClick={() =>
                              void action(
                                () =>
                                  post(`${base}/connect`, {
                                    mode: "managed",
                                    account_id: a.account_id,
                                  }),
                                false,
                                false,
                                undefined,
                                { at: `managed:${a.account_id}` },
                              )
                            }
                          >
                            <span
                              aria-hidden
                              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-creamDeep text-[13px] font-semibold uppercase text-inkSoft"
                            >
                              {initials(a.label)}
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-[15px] font-medium leading-5 text-ink">
                                {a.label}
                              </span>
                              <span className="truncate text-[13px] leading-5 text-inkMuted">
                                {pending?.at === `managed:${a.account_id}`
                                  ? "Saving…"
                                  : consent?.accepted
                                    ? "Managed by Zavi · paid from your balance"
                                    : "Authorize the permission above to use it"}
                              </span>
                            </span>
                            <span
                              aria-hidden
                              className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] ${
                                checked ? "border-ink" : "border-rule"
                              }`}
                            >
                              {checked && <span className="size-2.5 rounded-full bg-ink" />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-4 rounded-2xl border border-ca-border bg-ca-bg p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-ca-title font-semibold text-ca-xdark">
                        Use your own account
                      </p>
                      <p className="mt-1 text-ca-action text-ca-secondary">
                        Run campaigns on an ad account you already own. The provider bills you directly.
                      </p>
                    </div>
                    <Pill tone="off">Billed by provider</Pill>
                  </div>
                  <form
                    className="space-y-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action(async () => {
                        await post(`${base}/connect`, {
                          mode: "customer_key",
                          api_key: apiKey,
                        });
                        setApiKey("");
                      });
                    }}
                  >
                    <label className="block text-[13px] font-medium text-ink">
                      ChatGPT advertiser API key
                      <input
                        type="password"
                        autoComplete="off"
                        aria-label="ChatGPT advertiser API key"
                        required
                        minLength={10}
                        maxLength={4096}
                        disabled={locked}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        className={field}
                      />
                    </label>
                    <button
                      className={primary}
                      disabled={locked || apiKey.trim().length < 10}
                    >
                      Verify and connect account
                    </button>
                    <p className="text-[12px] leading-5 text-inkMuted">
                      The key is stored securely for this advertiser.
                      Connecting another account keeps existing campaign
                      connections.
                    </p>
                  </form>
                </div>
              </div>
            </Section>
            )}

            {platform === "chatgpt" &&
              data.accounts.find((a) => a.id === data.selected_id)
                ?.funding_source === "provider" && (
                <Section title="Import an existing campaign">
                  <form
                    className="space-y-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action(async () => {
                        await post(`${base}/campaigns/import`, {
                          account_binding_id: data.selected_id,
                          campaign_id: campaignId.trim(),
                        });
                        setCampaignId("");
                      });
                    }}
                  >
                    <label className="block text-[13px] font-medium text-ink">
                      Existing ChatGPT campaign ID
                      <input
                        aria-label="Existing ChatGPT campaign ID"
                        className={field}
                        value={campaignId}
                        onChange={(e) => setCampaignId(e.target.value)}
                        required
                        maxLength={200}
                        disabled={locked}
                      />
                    </label>
                    <button
                      className={primary}
                      disabled={locked || !campaignId.trim()}
                    >
                      Verify and import campaign
                    </button>
                    <p className="text-[12px] leading-5 text-inkMuted">
                      The campaign must belong to your selected advertiser
                      account. It keeps provider billing and its current
                      status.
                    </p>
                  </form>
                </Section>
              )}

            {settingsPage && platform === "chatgpt" && (
              <Section
                title="Reserved across your shared wallet"
                aside={
                  <button type="button" className={secondary} onClick={() => { setInventoryVersion((v) => v + 1); setWalletVersion((v) => v + 1); }}>
                    <RefreshCw className="h-4 w-4" aria-hidden />
                    Refresh campaigns and balance
                  </button>
                }
              >
                <p className="rounded-2xl border border-dashed border-ca-strong p-5 text-ca-facts text-ca-secondary">
                  {reservedCents ? `${dollars(reservedCents)} is reserved for your campaigns.` : "No campaign funds are reserved."}
                </p>
              </Section>
            )}
          </>
        )}
        {platform === "chatgpt" && (
          <BoundAdsCampaigns
            key={platform}
            platform={platform}
            refreshKey={inventoryVersion}
            walletOff={walletOff}
            onCampaigns={noteCampaigns}
          />
        )}
      </div>
    </details>
    {settingsPage && platform === "chatgpt" && (
      <ConnectionSection
        slug="chatgpt_ads"
        name="ChatGPT Ads"
        connected={!!selectedAccount}
        pending={firstLoad}
        account={connectedName}
        manageLabel={selectedAccount ? "Disconnect" : "Connect"}
        disabled={readOnly || pending?.at === "stop"}
        onManage={() => (selectedAccount ? void stopUsing(selectedAccount.id) : openConnect())}
      />
    )}
    </>
  );
}
