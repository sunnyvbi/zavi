"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { validateOptionalUsd } from "@/lib/workspace/usdCap";
import { Skeleton } from "../Skeleton";
import { FormField, FormInput } from "./formControls";
import { decisionTitle } from "@/app/approvals/approvalsHelpers";

type DecisionClass = {
  slug: string;
  description: string | null;
  default_autonomy: string;
  tenant_override: string | null;
  effective: string;
  never_auto?: boolean;
  max_daily_usd: number | null;
  max_per_action_usd: number | null;
};

type AutopilotPayload = {
  classes: DecisionClass[];
  fleet_halted: boolean;
  autopilot_enabled: boolean;
};

type ActiveWaiver = {
  decision_class: string;
  expires_at: string;
  max_daily_usd: number | null;
  cooling_off_seconds: number;
};

type WaiversPayload = {
  waivers: ActiveWaiver[];
};

const WAIVER_MAX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const WAIVER_MAX_DAILY_USD = 100;

type RiskGroup = "money" | "irreversible" | "review" | "safe";

type ClassMeta = {
  blurb: string;
  worst?: string;
  group: RiskGroup;
  noDailyCap?: true;
};

const CLASS_META: Record<string, ClassMeta> = {
  "meta_ads.create_ad_set": {
    group: "money",
    blurb: "Creates a new Meta (Facebook/Instagram) ad set under an existing campaign.",
    worst: "Starts spending real ad budget on a new ad set, up to your daily cap.",
  },
  "meta_ads.set_status": {
    group: "money",
    blurb: "Pauses or resumes a Meta campaign or ad set.",
    worst: "Resuming restarts live ad spend; pausing stops delivery.",
  },
  "meta_ads.set_status_review": {
    group: "money",
    blurb: "Pauses or resumes a Meta campaign or ad set (over-cap, held for your approval).",
    worst: "Resuming restarts live ad spend.",
  },
  "meta_ads.update_ad_set_budget": {
    group: "money",
    blurb: "Changes the daily budget of a Meta ad set (within your cap).",
    worst: "Raises live daily ad spend up to the new budget.",
  },
  "meta_ads.update_ad_set_budget_review": {
    group: "money",
    blurb: "Changes the daily budget of a Meta ad set (over-cap, held for your approval).",
    worst: "Raises live daily ad spend up to the new budget.",
  },
  "meta_ads.update_campaign_budget": {
    group: "money",
    blurb: "Changes the daily budget of a Meta campaign that sets its own budget (within your cap).",
    worst: "Raises live daily ad spend up to the new budget.",
  },
  "meta_ads.update_campaign_budget_review": {
    group: "money",
    blurb: "Changes the daily budget of a Meta campaign that sets its own budget (over-cap, held for your approval).",
    worst: "Raises live daily ad spend up to the new budget.",
  },
  "google_ads.set_status": {
    group: "money",
    blurb: "Pauses or resumes a Google Ads campaign.",
    worst: "Resuming restarts live ad spend; pausing stops delivery.",
  },
  "google_ads.set_status_review": {
    group: "money",
    blurb: "Pauses or resumes a Google Ads campaign (over-cap, held for your approval).",
    worst: "Resuming restarts live ad spend.",
  },
  "google_ads.update_campaign_budget": {
    group: "money",
    blurb: "Changes a Google Ads campaign's daily budget (within your cap).",
    worst: "Raises live daily ad spend up to the new budget.",
  },
  "google_ads.update_campaign_budget_review": {
    group: "money",
    blurb: "Changes a Google Ads campaign's daily budget (over-cap, held for your approval).",
    worst: "Raises live daily ad spend up to the new budget.",
  },
  "linkedin_ads.set_status": {
    group: "money",
    blurb: "Pauses a LinkedIn Ads campaign. Pause-only: it can never resume one.",
    worst: "Pausing stops delivery and spend on that campaign.",
  },
  "linkedin_ads.create_campaign_bundle": {
    group: "money",
    blurb: "Creates a LinkedIn campaign (group, campaign and creative), everything PAUSED.",
    worst: "A paused campaign exists, ready to spend once you choose Review launch on your LinkedIn Ads page in Zavi.",
  },
  "linkedin_ads.launch_campaign": {
    group: "money",
    blurb:
      "Switches on one of your paused LinkedIn campaigns with the total budget and end date in its launch plan. It is paid from your shared wallet, or billed to your own LinkedIn ad account if the campaign runs there.",
    worst: "The campaign starts spending, up to the total budget you approved, until its end date. Your monthly ad budget still limits it.",
    noDailyCap: true,
  },
  "stripe.create_connected_account": {
    group: "money",
    blurb: "Provisions a Stripe Connect payout account for your company.",
    worst: "Creates real payment infrastructure tied to your business.",
  },
  "dispute-response.submit-evidence": {
    group: "money",
    blurb:
      "Submits evidence to a Stripe chargeback dispute (saved as a draft; a final submit needs a second approval).",
    worst: "Files dispute evidence with Stripe on a real chargeback.",
  },

  "social.publish": {
    group: "irreversible",
    blurb: "Publishes an organic post to a connected social account.",
    worst: "Posts publicly. It can't be un-posted.",
  },
  "outbound.send": {
    group: "irreversible",
    blurb: "Sends a cold / SDR first-touch outbound message.",
    worst: "Delivers an external message that can't be recalled.",
  },
  "bulk_outbound.send": {
    group: "review",
    blurb: "Sends one email to everyone on one of your contact lists, from your own domain.",
    worst: "Emails up to 1,000 people at once, and an email can't be unsent. You always approve each bulk email yourself.",
  },
  "email_campaign.create_and_send": {
    group: "irreversible",
    blurb: "Sends one email to a list in your connected email tool (Mailchimp or Klaviyo), proposed in a chat.",
    worst: "The email goes to everyone on that list and can't be unsent. A send proposed in chat always waits for your approval.",
  },
  send_email: {
    group: "irreversible",
    blurb: "Sends a transactional or marketing email.",
    worst: "Email leaves your domain and can't be unsent.",
  },
  post_slack_message: {
    group: "irreversible",
    blurb: "Posts a message to a Slack channel or DM.",
    worst: "The message is visible to the channel immediately.",
  },
  "operator.post-slack-message": {
    group: "irreversible",
    blurb: "Posts a Slack message on the operator agent's behalf.",
    worst: "The message is visible to the channel immediately.",
  },
  "content-design.propose-change": {
    group: "irreversible",
    blurb: "Opens a pull request with a proposed content change to your connected repo.",
    worst: "Writes a content change as a PR against your repo.",
  },
  "content-seo.publish-content": {
    group: "irreversible",
    blurb: "Opens a pull request with a proposed content change to your connected repo.",
    worst: "Writes a content change as a PR against your repo.",
  },
  "engineer.ship-pr": {
    group: "irreversible",
    blurb: "Opens a pull request with a proposed code change to your repo.",
    worst: "Pushes a code change as a PR for review.",
  },
  "browser.action": {
    group: "irreversible",
    blurb: "Performs a click or form-fill in a browser on a non-OAuth site.",
    worst: "Takes a real action on an external website.",
  },
  "hiring-partner.publish-role": {
    group: "irreversible",
    blurb: "Publishes a hiring role to a public URL.",
    worst: "Makes the role live publicly.",
  },
  "hiring-partner.ask-question": {
    group: "irreversible",
    blurb: "Asks a candidate an approved interview question.",
    worst: "Sends a message to a real candidate.",
  },
  "hiring-partner.follow-up": {
    group: "irreversible",
    blurb: "Asks a candidate a bounded follow-up question.",
    worst: "Sends a message to a real candidate.",
  },
  ban_user: {
    group: "irreversible",
    blurb: "Bans a user from your platform.",
    worst: "Immediately blocks a real user's access.",
  },

  "agent.urgent_advisory": {
    group: "safe",
    blurb: "Surfaces an urgent heads-up. No action is taken; approving just acknowledges it.",
  },
  "autopilot.daily-plan": {
    group: "safe",
    blurb: "Proposes a daily plan for your AI team. Approving stages it; it doesn't act on its own.",
  },
  "chief-of-staff.daily-digest": {
    group: "safe",
    blurb: "Renders the daily digest. No side effect.",
  },
  "chief-of-staff.dispatch-specialist": {
    group: "safe",
    blurb:
      "Hands a digest item to a specialist agent. The specialist's own actions stay separately gated.",
  },
  "growth-lead.dispatch-specialist": {
    group: "safe",
    blurb:
      "Hands an approved growth bet to a specialist agent. Downstream actions stay separately gated.",
  },
  "qa.dispatch-specialist": {
    group: "safe",
    blurb: "Dispatches the engineer agent to fix a QA-found bug. The engineer's PR stays separately gated.",
  },
  "growth-lead.lifecycle-draft": {
    group: "safe",
    blurb: "Drafts a lifecycle email / sequence for your review. Nothing sends until you approve a send.",
  },
  "growth-lead.outreach-drafts": {
    group: "safe",
    blurb: "Prepares outreach drafts for you to copy and send yourself. Nothing is sent automatically.",
  },
  "growth-lead.reallocate-budget": {
    group: "safe",
    blurb: "Proposes a cross-channel budget reallocation. Proposal only: nothing moves until you act.",
  },
  "growth-lead.social-draft": {
    group: "safe",
    blurb: "Drafts a social post for your review. Nothing publishes until you approve.",
  },
  "performance-marketer.weekly-plan": {
    group: "safe",
    blurb: "Drafts a weekly paid-ads plan for your review. No spend on its own.",
  },
  "qa.bug-report": {
    group: "safe",
    blurb: "Files a bug report for a failed test. Approving records it; nothing is changed.",
  },
  "qa.file-bug": {
    group: "safe",
    blurb: "Flags a regression for your review. Notification only.",
  },
  "qa.weekly-digest": {
    group: "safe",
    blurb: "Posts a weekly QA digest. No side effect beyond the report.",
  },
  "research.create-watch": {
    group: "safe",
    blurb: "Sets up a scheduled research watch that reports what changed. Read-only monitoring.",
  },
  "operator.create-standing-order": {
    group: "safe",
    blurb: "Creates or replaces a scheduled operator brief. Internal scheduling only.",
  },
  "operator.file-jira-issue": {
    group: "safe",
    blurb: "Creates a Jira issue in your tracker.",
  },
  "operator.file-linear-issue": {
    group: "safe",
    blurb: "Creates a Linear issue in your tracker.",
  },
  create_jira_issue: {
    group: "safe",
    blurb: "Opens a Jira issue in your tracker.",
  },
  "jira.add_comment": {
    group: "safe",
    blurb: "Adds a comment to a Jira issue.",
  },
  "linear.add_comment": {
    group: "safe",
    blurb: "Adds a comment to a Linear issue.",
  },
  "linear.create_issue": {
    group: "safe",
    blurb: "Creates a Linear issue in your tracker.",
  },
  "notetaker.write_atoms": {
    group: "safe",
    blurb: "Saves reviewed standup notes into your company memory. Internal only.",
  },
  "hiring-partner.finalize-application": {
    group: "safe",
    blurb: "Finalizes a candidate conversation and records the application. Internal only.",
  },
  proposed_global_rule: {
    group: "safe",
    blurb: "Proposes a cross-tenant agent rule for human review. No effect until a human promotes it.",
  },
  tag_ticket: {
    group: "safe",
    blurb: "Tags a support ticket with a category. Internal classification.",
  },
};

function metaFor(dc: DecisionClass): ClassMeta {
  const m = CLASS_META[dc.slug];
  if (m) return m;
  return {
    group: "review",
    blurb: plainDescription(dc.description) ?? "No description available. Review before granting a waiver.",
  };
}

export function plainDescription(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/\bBody:[^.]*\.?[a-z]*/gi, " ")
    .replace(/\S*\/\S*\.(?:ts|tsx|js|jsx|md|json|sql)\b\.?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : null;
}

function isSensitive(g: RiskGroup): boolean {
  return g !== "safe";
}

const GROUP_ORDER: Record<RiskGroup, number> = {
  money: 0,
  irreversible: 1,
  review: 2,
  safe: 3,
};

function riskChip(g: RiskGroup): { label: string; cls: string } | null {
  if (g === "money") return { label: "Money", cls: "bg-dangerBg text-danger" };
  if (g === "irreversible") return { label: "Irreversible", cls: "bg-warnBg text-warn" };
  if (g === "review") return { label: "Review", cls: "bg-[#f0f0f0] text-[#595959]" };
  return null;
}

function classTitle(slug: string): string {
  const { agentLabel, verbLabel } = decisionTitle(slug);
  return verbLabel ? `${agentLabel} · ${verbLabel}` : agentLabel;
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";

const BTN_PRIMARY = `inline-flex h-9 shrink-0 items-center justify-center rounded-cta bg-ink px-3.5 text-[14px] font-semibold text-cream transition-colors hover:bg-ink/90 disabled:opacity-50 ${FOCUS_RING}`;
const BTN_SECONDARY = `inline-flex h-9 shrink-0 items-center justify-center rounded-cta border border-[#f0f0f0] bg-white px-3.5 text-[14px] font-semibold text-[#1f1f1f] transition-colors hover:border-[#e0e0e0] hover:bg-[#fafafa] disabled:opacity-50 ${FOCUS_RING}`;
const CARD = "rounded-[16px] border border-[#f0f0f0] bg-white";

function autonomyLabel(a: string): string {
  if (a === "auto") return "Auto";
  if (a === "approval") return "Needs approval";
  if (a === "forbidden") return "Forbidden";
  return a;
}

function autonomyColor(a: string): string {
  if (a === "auto") return "bg-successBg text-success";
  if (a === "approval") return "bg-warnBg text-warn";
  if (a === "forbidden") return "bg-dangerBg text-danger";
  return "bg-[#f0f0f0] text-[#595959]";
}

function fmtLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function relativeUntil(iso: string): string {
  const diffMs = Date.parse(iso) - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "expired";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export function AutopilotWaiverPanel() {
  const [classes, setClasses] = useState<DecisionClass[]>([]);
  const [waivers, setWaivers] = useState<ActiveWaiver[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [revoking, setRevoking] = useState<Record<string, boolean>>({});
  const [revokeError, setRevokeError] = useState<Record<string, string | null>>({});

  const [grantSlug, setGrantSlug] = useState<string | null>(null);

  const isMounted = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [apRes, wvRes] = await Promise.all([
        apiFetch("/api/workspace/autopilot"),
        apiFetch("/api/workspace/autopilot/waivers"),
      ]);
      if (!apRes.ok) {
        const body = (await apRes.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        if (isMounted.current) {
          setLoadError(body?.error?.message ?? `HTTP ${apRes.status}`);
        }
        return;
      }
      if (!wvRes.ok) {
        const body = (await wvRes.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        if (isMounted.current) {
          setLoadError(body?.error?.message ?? `HTTP ${wvRes.status}`);
        }
        return;
      }
      const ap = (await apRes.json()) as AutopilotPayload;
      const wv = (await wvRes.json()) as WaiversPayload;
      if (!isMounted.current) return;
      setClasses(ap.classes ?? []);
      setWaivers(wv.waivers ?? []);
    } catch (err) {
      if (!isMounted.current) return;
      setLoadError((err as Error).message ?? "Unknown error");
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    void load();
    return () => {
      isMounted.current = false;
    };
  }, [load]);

  const waiverBySlug = new Map<string, ActiveWaiver>();
  for (const w of waivers) waiverBySlug.set(w.decision_class, w);

  async function revoke(slug: string) {
    setRevoking((p) => ({ ...p, [slug]: true }));
    setRevokeError((p) => ({ ...p, [slug]: null }));
    try {
      const res = await apiFetch(
        `/api/workspace/autopilot/waivers/${encodeURIComponent(slug)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setRevokeError((p) => ({
          ...p,
          [slug]: body?.error?.message ?? `HTTP ${res.status}`,
        }));
        return;
      }
      const wvRes = await apiFetch("/api/workspace/autopilot/waivers");
      if (wvRes.ok && isMounted.current) {
        const wv = (await wvRes.json()) as WaiversPayload;
        setWaivers(wv.waivers ?? []);
      }
    } catch (err) {
      if (!isMounted.current) return;
      setRevokeError((p) => ({
        ...p,
        [slug]: (err as Error).message ?? "Unknown error",
      }));
    } finally {
      if (isMounted.current) setRevoking((p) => ({ ...p, [slug]: false }));
    }
  }

  async function saveCap(slug: string, dailyUsd: number | null): Promise<void> {
    const dc = classes.find((c) => c.slug === slug);
    const res = await apiFetch("/api/workspace/autopilot/settings", {
      method: "POST",
      body: JSON.stringify({
        decision_class: slug,
        autonomy: dc?.effective,
        max_daily_usd: dailyUsd,
        max_per_action_usd: dc?.max_per_action_usd ?? null,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    }
    if (isMounted.current) {
      setClasses((prev) =>
        prev.map((c) =>
          c.slug === slug ? { ...c, max_daily_usd: dailyUsd } : c,
        ),
      );
    }
  }

  async function onGrantSubmitted() {
    setGrantSlug(null);
    const wvRes = await apiFetch("/api/workspace/autopilot/waivers");
    if (wvRes.ok && isMounted.current) {
      const wv = (await wvRes.json()) as WaiversPayload;
      setWaivers(wv.waivers ?? []);
    }
  }

  if (loading) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading waivers…"
        className="space-y-3"
      >
        <Skeleton className="mb-1 h-6 w-64" />
        {[0, 1, 2].map((i) => (
          <div key={i} className={`${CARD} flex flex-col gap-3 px-4 py-3.5`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-6 w-28 shrink-0" rounded="rounded-full" />
            </div>
            <Skeleton className="h-3.5 w-full max-w-lg" />
            <div className="flex items-end justify-between gap-3 border-t border-[#f0f0f0] pt-3">
              <div className="flex gap-8">
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-8 w-20" />
              </div>
              <Skeleton className="h-9 w-28 shrink-0" rounded="rounded-cta" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-[16px] border border-danger/20 bg-dangerBg px-4 py-3.5">
        <p className="text-[14px] text-danger">
          Couldn&apos;t load your autopilot settings: {loadError}
        </p>
        <button type="button" onClick={() => void load()} className={`mt-3 ${BTN_SECONDARY}`}>
          Try again
        </button>
      </div>
    );
  }

  if (classes.length === 0) {
    return (
      <p className="text-[16px] text-inkMuted">
        No decision classes are configured yet, so there&apos;s nothing to waive.
      </p>
    );
  }

  const byRisk = (a: DecisionClass, b: DecisionClass) => {
    const ga = GROUP_ORDER[metaFor(a).group];
    const gb = GROUP_ORDER[metaFor(b).group];
    if (ga !== gb) return ga - gb;
    return a.slug.localeCompare(b.slug);
  };
  const sensitive = classes.filter((c) => isSensitive(metaFor(c).group)).sort(byRisk);
  const routine = classes.filter((c) => !isSensitive(metaFor(c).group)).sort(byRisk);

  function renderRow(dc: DecisionClass) {
    const meta = metaFor(dc);
    const active = waiverBySlug.get(dc.slug);
    const rError = revokeError[dc.slug];
    const chip = riskChip(meta.group);
    const unwaivable = dc.effective === "forbidden" || dc.never_auto === true;
    return (
      <li key={dc.slug} className={`${CARD} flex flex-col gap-3 px-4 py-3.5`}>
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold tracking-tight text-[#0e0f11]">
                {classTitle(dc.slug)}
              </span>
              {chip && (
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${chip.cls}`}
                >
                  {chip.label}
                </span>
              )}
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-inkLight">{dc.slug}</div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${autonomyColor(dc.effective)}`}
            >
              {autonomyLabel(dc.effective)}
            </span>
            {dc.tenant_override && dc.tenant_override !== dc.default_autonomy && (
              <span className="text-[11px] text-inkMuted">
                default: {autonomyLabel(dc.default_autonomy)}
              </span>
            )}
          </div>
        </div>

        <div className="text-[14px] leading-[1.5] text-[#595959]">
          <p>{meta.blurb}</p>
          {meta.worst && (
            <p className="mt-1 text-[13px] text-inkMuted">
              <span className="font-semibold text-[#595959]">Worst case:</span> {meta.worst}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-[#f0f0f0] pt-3">
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            {!meta.noDailyCap && (
              <div>
                <div className="mb-1 text-[12px] font-medium text-[#8a8a8a]">Daily cap</div>
                <DailyCapCell dc={dc} onSave={saveCap} />
              </div>
            )}
            <div>
              <div className="mb-1 text-[12px] font-medium text-[#8a8a8a]">Waiver</div>
              {active ? (
                <div className="text-[13px] leading-[1.45]">
                  <div className="font-semibold text-success">
                    Active · {relativeUntil(active.expires_at)} left
                  </div>
                  <div className="text-inkMuted">
                    until {fmtLocal(active.expires_at)} · cap{" "}
                    {active.max_daily_usd !== null
                      ? `$${active.max_daily_usd.toFixed(2)}/day`
                      : "-"}
                    {active.cooling_off_seconds > 0 &&
                      ` · cool-off ${active.cooling_off_seconds}s`}
                  </div>
                </div>
              ) : (
                <span className="text-[13px] text-inkMuted">None</span>
              )}
              {rError && <div className="mt-1 text-[12px] text-danger">{rError}</div>}
            </div>
          </div>
          {active ? (
            <button
              type="button"
              onClick={() => void revoke(dc.slug)}
              disabled={revoking[dc.slug] === true}
              className={BTN_SECONDARY}
            >
              {revoking[dc.slug] ? "Revoking…" : "Revoke"}
            </button>
          ) : unwaivable ? (
            <span className="text-[13px] text-inkMuted">Can&apos;t be waived</span>
          ) : (
            <button type="button" onClick={() => setGrantSlug(dc.slug)} className={BTN_PRIMARY}>
              Grant waiver
            </button>
          )}
        </div>
      </li>
    );
  }

  function table(rows: DecisionClass[]) {
    return <ul className="flex flex-col gap-3">{rows.map(renderRow)}</ul>;
  }

  return (
    <>
      {sensitive.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-[20px] font-semibold leading-[25px] tracking-tight text-ink">
              Money &amp; irreversible actions
            </h2>
            <span className="text-[13px] text-inkMuted">
              {sensitive.length} {sensitive.length === 1 ? "action" : "actions"}
            </span>
          </div>
          <div className="rounded-[12px] border border-warn/20 bg-warnBg px-3.5 py-2.5 text-[13px] leading-[1.5] text-warn">
            These classes spend money or take actions you can&apos;t cleanly undo
            (ad spend, payouts, sends, publishes, code changes, bans). Granting a
            waiver lets Zavi run them hands-off until the waiver expires. Keep
            the window short and the daily cap tight.
          </div>
          {table(sensitive)}
        </section>
      )}

      {routine.length > 0 && (
        <section className={`flex flex-col gap-3 ${sensitive.length > 0 ? "mt-10" : ""}`}>
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-[20px] font-semibold leading-[25px] tracking-tight text-ink">
              Routine actions
            </h2>
            <span className="text-[13px] text-inkMuted">
              {routine.length} {routine.length === 1 ? "action" : "actions"}
            </span>
          </div>
          <p className="text-[13px] leading-[1.5] text-inkMuted">
            Internal or proposal-only actions: reversible and low-risk. Approving
            one of these typically just acknowledges or records it.
          </p>
          {table(routine)}
        </section>
      )}

      {grantSlug && (
        <GrantWaiverModal
          slug={grantSlug}
          onClose={() => setGrantSlug(null)}
          onGranted={() => void onGrantSubmitted()}
        />
      )}
    </>
  );
}

function DailyCapCell({
  dc,
  onSave,
}: {
  dc: DecisionClass;
  onSave: (slug: string, dailyUsd: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (dc.effective === "forbidden") {
    return (
      <span
        className="text-[13px] text-inkMuted"
        title="Forbidden classes never run, so no spend cap applies."
      >
        n/a
      </span>
    );
  }

  function startEdit() {
    setDraft(dc.max_daily_usd !== null ? String(dc.max_daily_usd) : "");
    setError(null);
    setEditing(true);
  }

  async function commit(clear: boolean) {
    setBusy(true);
    setError(null);
    let val: number | null = null;
    if (!clear) {
      const parsed = validateOptionalUsd(draft);
      if (!parsed.ok || parsed.value === null) {
        setError("Enter a number ≥ 0");
        setBusy(false);
        return;
      }
      val = parsed.value;
    }
    try {
      await onSave(dc.slug, val);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message ?? "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="text-[13px] text-inkMuted">
        <span className={dc.max_daily_usd !== null ? "text-ink" : undefined}>
          {dc.max_daily_usd !== null
            ? `$${dc.max_daily_usd.toFixed(2)}/day`
            : "No cap"}
        </span>
        <button
          type="button"
          onClick={startEdit}
          className={`ml-2 rounded-cta text-[13px] font-medium text-brand hover:underline ${FOCUS_RING}`}
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <span className="text-[13px] text-inkMuted">$</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="0.00"
          aria-label={`Daily cap for ${dc.slug}`}
          className="h-8 w-24 rounded-[10px] border border-[#f0f0f0] bg-white px-2.5 text-[14px] font-medium text-[#1f1f1f] outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/15"
        />
        <span className="text-[12px] text-inkMuted">/day</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void commit(false)}
          disabled={busy}
          className={`inline-flex h-8 items-center rounded-cta bg-ink px-3 text-[13px] font-semibold text-cream hover:bg-ink/90 disabled:opacity-50 ${FOCUS_RING}`}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          disabled={busy}
          className={`inline-flex h-8 items-center rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-semibold text-[#1f1f1f] hover:bg-[#fafafa] disabled:opacity-50 ${FOCUS_RING}`}
        >
          Cancel
        </button>
        {dc.max_daily_usd !== null && (
          <button
            type="button"
            onClick={() => void commit(true)}
            disabled={busy}
            className={`rounded-cta text-[13px] font-medium text-danger hover:underline disabled:opacity-50 ${FOCUS_RING}`}
          >
            Remove cap
          </button>
        )}
      </div>
      {error && <div className="text-[12px] text-danger">{error}</div>}
    </div>
  );
}

function GrantWaiverModal({
  slug,
  onClose,
  onGranted,
}: {
  slug: string;
  onClose: () => void;
  onGranted: () => void;
}) {
  const now = new Date();
  const defaultExpires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const minExpires = new Date(now.getTime() + 60 * 1000);
  const maxExpires = new Date(now.getTime() + WAIVER_MAX_EXPIRY_MS);

  const [expiresAt, setExpiresAt] = useState<string>(toDatetimeLocal(defaultExpires));
  const [maxDailyUsd, setMaxDailyUsd] = useState<string>("10");
  const [coolingOff, setCoolingOff] = useState<string>("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      setError("Invalid expires_at");
      setBusy(false);
      return;
    }
    const cap = parseFloat(maxDailyUsd);
    if (!Number.isFinite(cap) || cap < 0) {
      setError("Max daily USD must be a number ≥ 0");
      setBusy(false);
      return;
    }
    if (cap > WAIVER_MAX_DAILY_USD) {
      setError(`Max daily USD cannot exceed $${WAIVER_MAX_DAILY_USD}`);
      setBusy(false);
      return;
    }
    const cool = parseInt(coolingOff, 10);
    if (!Number.isFinite(cool) || cool < 0 || !Number.isInteger(cool)) {
      setError("Cooling-off seconds must be a non-negative integer");
      setBusy(false);
      return;
    }

    try {
      const res = await apiFetch("/api/workspace/autopilot/waivers", {
        method: "POST",
        body: JSON.stringify({
          decision_class: slug,
          expires_at: parsed.toISOString(),
          max_daily_usd: cap,
          cooling_off_seconds: cool,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      onGranted();
    } catch (err) {
      setError((err as Error).message ?? "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="dialog-scrim fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="grant-waiver-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-[20px] border border-[#f0f0f0] bg-white p-6 shadow-[0_16px_48px_rgba(25,25,25,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id="grant-waiver-title"
          className="font-display text-[20px] font-semibold tracking-tight text-ink"
        >
          Grant waiver
        </h3>
        <p className="mt-1.5 text-[14px] leading-[1.5] text-[#595959]">
          Let <span className="font-semibold text-ink">{classTitle(slug)}</span> run
          without asking you, inside the time window and daily spend cap below. Approvals
          for it are skipped until the waiver ends.
        </p>

        <form onSubmit={submit} className="mt-5 flex flex-col gap-4">
          <FormField label="Ends at (up to 7 days from now)">
            <FormInput
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              min={toDatetimeLocal(minExpires)}
              max={toDatetimeLocal(maxExpires)}
              required
            />
          </FormField>

          <FormField label={`Max daily spend (USD, 0–${WAIVER_MAX_DAILY_USD})`}>
            <FormInput
              type="number"
              min="0"
              max={WAIVER_MAX_DAILY_USD}
              step="0.01"
              value={maxDailyUsd}
              onChange={(e) => setMaxDailyUsd(e.target.value)}
              required
            />
          </FormField>

          <FormField
            label="Cooling-off seconds"
            hint="Minimum gap between automatic runs of this action. 0 means no gap."
          >
            <FormInput
              type="number"
              min="0"
              step="1"
              value={coolingOff}
              onChange={(e) => setCoolingOff(e.target.value)}
              required
            />
          </FormField>

          {error && (
            <div className="rounded-[10px] border border-danger/20 bg-dangerBg px-3 py-2.5 text-[13px] text-danger">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className={BTN_SECONDARY}
            >
              Cancel
            </button>
            <button type="submit" disabled={busy} className={BTN_PRIMARY}>
              {busy ? "Granting…" : "Grant waiver"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
