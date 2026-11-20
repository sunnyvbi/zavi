"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { resetAnalyticsIdentity } from "@/lib/analytics/mixpanel";
import { trackEvent } from "@/lib/analytics/events";
import { apiFetch } from "@/lib/api";
import { useWorkspace } from "../WorkspaceShell";
import { isMember } from "@/lib/members";
import {
  creditBannerState,
  creditResetLine,
  STATUS_LOW_CREDIT_THRESHOLD,
} from "@/lib/workspace/runEstimate";

const SUPPORT_EMAIL = "support@zaviagent.com";

type Credits = {
  remaining: number;
  allowance: number;
  resetDate: string | null;
};

type CreditsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: Credits }
  | { status: "hidden" };

function fmtCredits(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString("en-US");
}

function fmtResetDate(d: string | null): string | null {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function SidebarUserBar({ email }: { email: string }) {
  const { openTab, openAgentTab, role } = useWorkspace();
  const canManageBilling = !isMember(role);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [credits, setCredits] = useState<CreditsState>({ status: "idle" });
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<null | "signout">(null);

  function closeMenu() {
    if (detailsRef.current) detailsRef.current.open = false;
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const el = detailsRef.current;
      if (el && !el.contains(e.target as Node)) closeMenu();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeMenu();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function loadCredits() {
    setCredits({ status: "loading" });
    try {
      const res = await apiFetch("/api/billing/credits");
      if (!res.ok) {
        setCredits({ status: "hidden" });
        return;
      }
      const j = (await res.json()) as {
        effective_available_display?: unknown;
        included_allowance?: unknown;
        period_end?: unknown;
      };
      const remaining =
        typeof j.effective_available_display === "number" &&
          Number.isFinite(j.effective_available_display)
          ? j.effective_available_display
          : null;
      if (remaining === null) {
        setCredits({ status: "hidden" });
        return;
      }
      setCredits({
        status: "ready",
        data: {
          remaining,
          allowance:
            typeof j.included_allowance === "number" && Number.isFinite(j.included_allowance)
              ? j.included_allowance
              : 0,
          resetDate: typeof j.period_end === "string" ? j.period_end : null,
        },
      });
    } catch {
      setCredits({ status: "hidden" });
    }
  }

  function onToggle() {
    const isOpen = !!detailsRef.current?.open;
    setOpen(isOpen);
    if (isOpen && credits.status === "idle") void loadCredits();
  }

  function openSettings() {
    if (pending) return;
    openTab({
      kind: "settings",
      title: "Settings",
      payload: { kind: "settings" },
      dirty: false,
      pinned: false,
    });
    closeMenu();
  }

  function openMetricsAds() {
    if (pending) return;
    void openAgentTab("performance-marketer");
    closeMenu();
  }

  function openDisputeResponse() {
    if (pending) return;
    void openAgentTab("dispute-response");
    closeMenu();
  }

  function goUpgrade() {
    if (pending) return;
    closeMenu();
    openTab({
      kind: "settings",
      title: "Settings",
      payload: { kind: "settings" },
      dirty: false,
      pinned: false,
    });
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        window.location.hash = "billing";
      }, 80);
    }
  }

  async function signOut() {
    if (pending) return;
    setPending("signout");
    try {
      trackEvent("logged_out");
      resetAnalyticsIdentity();
      const supabase = createBrowserSupabase();
      await supabase.auth.signOut({ scope: "local" });
      window.location.replace("/login");
    } catch {
      setPending(null);
    }
  }

  const initial = (email.trim()[0] || "?").toUpperCase();
  const displayName = (() => {
    const local = email.split("@")[0] ?? email;
    const cleaned = local.split("+")[0]?.replace(/[._-]+/g, " ").trim();
    if (!cleaned) return email;
    return cleaned
      .split(" ")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  })();

  const creditsData = credits.status === "ready" ? credits.data : null;
  const hasCredits = !!creditsData && creditsData.remaining > 0;
  const meterState = creditsData
    ? creditBannerState(creditsData.remaining, creditsData.allowance, STATUS_LOW_CREDIT_THRESHOLD)
    : "none";
  const isLowCredit = meterState !== "none";
  const fillPct =
    !creditsData || meterState === "depleted" || creditsData.allowance <= 0
      ? 0
      : Math.max(0, Math.min(1, creditsData.remaining / creditsData.allowance)) * 100;
  const meterColor = isLowCredit ? "#cb2029" : "#946300";
  const resetLabel = creditsData ? fmtResetDate(creditsData.resetDate) : null;

  return (
    <details ref={detailsRef} onToggle={onToggle} className="group relative shrink-0 font-sans">
      <summary
        className="flex h-[58px] cursor-pointer list-none items-center gap-2 bg-white pl-3 pr-2 select-none"
        style={{
          borderTop: "1px solid #f0f0f0",
          boxShadow: "0px -6px 7.75px rgba(0,0,0,0.05)",
        }}
        aria-label="Account menu"
        aria-haspopup="menu"
        title="Account"
      >
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-[0.5px] border-[#f0f0f0] bg-ink text-[16px] font-medium text-white"
        >
          {initial}
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="truncate text-[16px] font-semibold leading-5 tracking-[0.01px] text-black">
            {displayName}
          </span>
          <span className="truncate text-[12px] leading-4 tracking-[0.01px] text-[#595959]">
            {email}
          </span>
        </span>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          aria-hidden
          className="shrink-0 text-[#595959]"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </summary>

      <div className="absolute bottom-full left-2 right-2 z-50 mb-2 overflow-hidden rounded-2xl border border-ink/10 bg-white pb-1.5 shadow-[0_8px_24px_rgba(10,31,58,0.12),0_2px_6px_rgba(10,31,58,0.08)]">
        {}
        {credits.status === "loading" && (
          <>
            <div className="flex flex-col gap-5 px-4 py-3">
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div className="h-5 w-16 animate-pulse rounded bg-[#f0f0f0]" />
                  <div className="h-4 w-14 animate-pulse rounded bg-[#f0f0f0]" />
                </div>
                <div className="h-2 w-full animate-pulse rounded-full bg-[#f0f0f0]" />
              </div>
              <div className="h-10 w-full animate-pulse rounded-[12px] bg-[#f0f0f0]" />
              <div className="h-3.5 w-40 animate-pulse rounded bg-[#f0f0f0]" />
            </div>
            <Divider />
          </>
        )}

        {creditsData && (
          <>
            <div className="flex flex-col gap-5 px-4 py-3">
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <span className="text-[16px] font-semibold leading-6 text-black">Credits</span>
                  {}
                  {canManageBilling ? (
                    <button
                      type="button"
                      onClick={goUpgrade}
                      disabled={!!pending}
                      className={`flex items-center gap-2 rounded-cta text-[16px] leading-5 transition-opacity hover:opacity-70 disabled:opacity-60 ${
                        isLowCredit
                          ? "font-semibold text-[#cb2029]"
                          : "font-medium text-[#595959]"
                      }`}
                      title="Buy credits"
                    >
                      {hasCredits ? `${fmtCredits(creditsData.remaining)} Left` : "0 Left"}
                      <IconArrowRight />
                    </button>
                  ) : (
                    <span
                      className={`text-[16px] leading-5 ${
                        isLowCredit
                          ? "font-semibold text-[#cb2029]"
                          : "font-medium text-[#595959]"
                      }`}
                    >
                      {hasCredits ? `${fmtCredits(creditsData.remaining)} Left` : "0 Left"}
                    </span>
                  )}
                </div>
                {}
                <div className="h-2 w-full overflow-hidden rounded-full bg-[#f0f0f0]">
                  <div
                    className="h-full rounded-full transition-[width] duration-300"
                    style={{ width: `${fillPct}%`, backgroundColor: meterColor }}
                  />
                </div>
              </div>

              {}
              {canManageBilling && (
                <button
                  type="button"
                  onClick={goUpgrade}
                  disabled={!!pending}
                  className="flex w-full items-center justify-center gap-2 rounded-cta bg-[#0e0f11] px-4 py-2.5 text-[16px] font-semibold text-white transition-colors hover:bg-black disabled:opacity-70"
                >
                  {hasCredits ? <IconCoins /> : <IconZap />}
                  Buy Credits
                </button>
              )}

              {}
              {resetLabel && (
                <div className="flex items-center gap-2 text-[13px] leading-5 text-[#595959]">
                  <IconAlert />
                  {creditResetLine(resetLabel)}
                </div>
              )}
            </div>
            <Divider />
          </>
        )}

        {}
        <div className="flex flex-col px-2 pt-1.5">
          <MenuItem icon={<IconMetrics />} label="Metrics Ads" onClick={openMetricsAds} />
          <MenuItem icon={<IconDispute />} label="Dispute Response" onClick={openDisputeResponse} />
          <MenuItem icon={<IconSettings />} label="Settings" onClick={openSettings} />
          {}
          <MenuItem
            icon={<IconHelp />}
            label="Support"
            href={`mailto:${SUPPORT_EMAIL}`}
            onClick={closeMenu}
          />
        </div>
        <Divider className="my-1.5" />
        <div className="flex flex-col px-2">
          <MenuItem
            icon={<IconLogout />}
            label={pending === "signout" ? "Signing out…" : "Sign out"}
            onClick={signOut}
            loading={pending === "signout"}
          />
        </div>
      </div>
    </details>
  );
}

function Divider({ className = "" }: { className?: string }) {
  return <div className={`h-px w-full bg-[#f0f0f0] ${className}`} aria-hidden />;
}

function MenuItem({
  icon,
  label,
  onClick,
  href,
  loading,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
  loading?: boolean;
  disabled?: boolean;
}) {
  const className =
    "flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left text-[16px] font-medium leading-5 tracking-[0.14px] text-[#0e0f11] transition-colors hover:bg-ink/[0.04] disabled:cursor-default disabled:opacity-70";
  const content = (
    <>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[#0e0f11]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {loading && <Spinner className="text-[#595959]" />}
    </>
  );
  if (href) {
    return (
      <a href={href} onClick={onClick} className={className}>
        {content}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading}
      className={className}
    >
      {content}
    </button>
  );
}

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" className="opacity-25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="opacity-90"
      />
    </svg>
  );
}

function IconArrowRight() {
  return (
    <svg
      width="7"
      height="13"
      viewBox="0 0 6.24988 11.2499"
      fill="none"
      aria-hidden
      className="shrink-0 text-[#595959]"
    >
      <path
        d="M0.182863 0.182854C0.426805 -0.0610865 0.822542 -0.0608161 1.06665 0.182854L6.06665 5.18285C6.31073 5.42693 6.31073 5.82257 6.06665 6.06664L1.06665 11.0666C0.822574 11.3107 0.426939 11.3107 0.182863 11.0666C-0.0608266 10.8225 -0.0610819 10.4268 0.182863 10.1829L4.74146 5.62524L0.182863 1.06664C-0.0608004 0.82254 -0.0610554 0.426798 0.182863 0.182854Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconMetrics() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.9" y="1.9" width="16.2" height="16.2" rx="4.2" />
      <path d="M5.4 12.6l3-3.2 2.3 2.1 3.9-4.1" />
      <path d="M11.6 7.4h3v3" />
    </svg>
  );
}

function IconDispute() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12.1" cy="6.2" r="2.9" />
      <path d="M6.9 17.1c0-2.6 2.4-4.4 5.2-4.4s5.2 1.8 5.2 4.4" />
      <path d="M2.4 5.2h3.1M2.4 8.4h2.1M2.4 11.6h3.1" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="18" height="18" viewBox="0 0 17.5002 17.9167" fill="none" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.25619 2.41362e-06H9.24405C9.50796 -3.02696e-05 9.75597 -6.09163e-05 9.96383 0.0237166C10.1954 0.0502116 10.439 0.111486 10.6663 0.275617C10.8935 0.439674 11.0283 0.651574 11.1264 0.862996C11.2146 1.05289 11.293 1.28848 11.3764 1.53943L11.3853 1.56618L11.6588 2.38305C11.7378 2.58203 11.8759 2.75162 12.0541 2.86891L12.3061 3.0143C12.517 3.11924 12.7572 3.14915 12.9872 3.09918L13.988 2.8173L14.0169 2.8091C14.2902 2.7315 14.5458 2.65893 14.7659 2.62398C15.0107 2.58511 15.2785 2.58015 15.5555 2.69278C15.8323 2.80537 16.0207 2.99579 16.169 3.19436C16.3024 3.37302 16.4351 3.60344 16.5772 3.85003L17.0189 4.61661C17.152 4.84749 17.2769 5.06415 17.3606 5.2576C17.4539 5.47302 17.5227 5.71622 17.4933 5.9967C17.4638 6.27721 17.3459 6.50079 17.2099 6.6921C17.0877 6.86388 16.9205 7.04978 16.7424 7.24783L16.7237 7.2686L16.7226 7.26982L15.88 8.21186C15.7747 8.35456 15.6645 8.66471 15.6645 8.9582C15.6645 9.252 15.7746 9.56204 15.88 9.70473L16.7237 10.648L16.7424 10.6688C16.9205 10.8669 17.0877 11.0527 17.2099 11.2245C17.3459 11.4158 17.4638 11.6394 17.4933 11.9199C17.5227 12.2004 17.4539 12.4436 17.3606 12.659C17.2768 12.8525 17.152 13.0692 17.0189 13.3001L16.5772 14.0665C16.4352 14.3131 16.3024 14.5436 16.169 14.7222C16.0207 14.9208 15.8323 15.1112 15.5555 15.2238C15.2785 15.3364 15.0107 15.3315 14.7659 15.2926C14.5458 15.2577 14.2902 15.1851 14.0169 15.1075L13.988 15.0993L12.9873 14.8174C12.7572 14.7674 12.517 14.7973 12.306 14.9023L12.0541 15.0477C11.8758 15.165 11.7378 15.3346 11.6589 15.5335L11.3857 16.3493L11.3764 16.3773C11.293 16.6282 11.2146 16.8638 11.1264 17.0537C11.0283 17.2651 10.8935 17.477 10.6663 17.6411C10.439 17.8052 10.1954 17.8665 9.96383 17.893C9.75596 17.9167 9.50795 17.9167 9.24403 17.9167H8.2562C7.99228 17.9167 7.74427 17.9167 7.53641 17.893C7.30479 17.8665 7.06122 17.8052 6.83395 17.6411C6.60678 17.477 6.47195 17.2651 6.37379 17.0537C6.28562 16.8638 6.20727 16.6282 6.12381 16.3772L6.11454 16.3493L5.84138 15.5335C5.76246 15.3346 5.62438 15.165 5.44617 15.0477L5.19424 14.9023C4.98328 14.7973 4.74304 14.7674 4.51297 14.8174L3.51228 15.0993L3.48339 15.1075C3.21004 15.1851 2.95442 15.2577 2.73431 15.2926C2.48951 15.3315 2.2217 15.3364 1.94478 15.2238C1.66794 15.1112 1.47956 14.9208 1.33126 14.7222C1.19782 14.5436 1.06508 14.3131 0.923026 14.0665L0.907432 14.0395L0.48135 13.3C0.348269 13.0691 0.223387 12.8525 0.139613 12.659C0.0463317 12.4436 -0.0224833 12.2004 0.00698305 11.9199C0.0364521 11.6394 0.154321 11.4158 0.290375 11.2245C0.412541 11.0527 0.579739 10.8668 0.757875 10.6688L0.776559 10.648L0.777657 10.6468L1.62028 9.70473C1.72561 9.56203 1.83569 9.252 1.83569 8.9582C1.83569 8.66471 1.72558 8.35456 1.62026 8.21187L0.777654 7.26982L0.776555 7.2686L0.757874 7.24783C0.579737 7.04977 0.412539 6.86388 0.290372 6.6921C0.154318 6.50079 0.0364504 6.27721 0.00698146 5.9967C-0.0224828 5.71623 0.0463292 5.47302 0.13961 5.2576C0.223385 5.06414 0.348267 4.84747 0.48135 4.61658C0.486262 4.60805 0.491186 4.59951 0.496119 4.59095L0.907444 3.87712C0.912652 3.86808 0.917846 3.85906 0.923029 3.85006C1.06509 3.60346 1.19783 3.37303 1.33127 3.19436C1.47957 2.99579 1.66794 2.80537 1.94477 2.69278C2.22169 2.58015 2.48949 2.58511 2.73429 2.62398C2.9544 2.65893 3.21001 2.7315 3.48335 2.8091C3.49312 2.81188 3.50292 2.81466 3.51274 2.81744L4.51301 3.09918C4.74303 3.14915 4.98321 3.11924 5.19413 3.0143L5.44612 2.86891C5.62437 2.75163 5.76247 2.58204 5.84141 2.38306L6.11454 1.56733C6.11758 1.5582 6.12079 1.54855 6.12381 1.53946C6.20727 1.2885 6.28562 1.0529 6.37379 0.862996C6.47195 0.651574 6.60678 0.439674 6.83395 0.275617C7.06122 0.111486 7.30479 0.0502116 7.53641 0.0237166C7.74427 -6.09163e-05 7.99227 -3.02696e-05 8.25619 2.41362e-06ZM7.56578 1.28899L7.5651 1.28958C7.5651 1.28958 7.56227 1.29245 7.55809 1.29807C7.54904 1.31021 7.53214 1.33641 7.50754 1.38939C7.45303 1.50681 7.39666 1.67327 7.30063 1.96192L7.01767 2.80701L7.01284 2.8196C6.83772 3.27616 6.52127 3.6648 6.10957 3.92848L6.09738 3.93629L5.79092 4.11312L5.77738 4.12007C5.29717 4.3668 4.74528 4.43564 4.21922 4.31433L4.20463 4.31096L3.17218 4.02016C2.85823 3.93107 2.67558 3.88032 2.53828 3.85852C2.47618 3.84866 2.44295 3.84833 2.42714 3.84928C2.41987 3.84972 2.4162 3.85052 2.4162 3.85052L2.41518 3.85094C2.41518 3.85094 2.4119 3.853 2.40633 3.85781C2.3942 3.86827 2.37051 3.89183 2.33277 3.94236C2.24937 4.05401 2.15362 4.21811 1.99051 4.5012L1.57918 5.21503C1.42617 5.48058 1.33854 5.63456 1.28669 5.75431C1.26328 5.80836 1.25489 5.83869 1.25181 5.85373C1.25038 5.86069 1.25012 5.86487 1.25012 5.86487L1.25014 5.8661L1.25037 5.86729C1.25037 5.86729 1.25149 5.87129 1.25432 5.87779C1.26045 5.89181 1.27493 5.9197 1.30904 5.96765C1.38461 6.07392 1.50228 6.20621 1.70714 6.43403L1.70824 6.43525L2.58019 7.4101L2.59205 7.42511C2.90406 7.82011 3.08569 8.42711 3.08569 8.9582C3.08569 9.48952 2.90413 10.0964 2.59207 10.4915L2.58021 10.5065L1.70824 11.4814L1.70714 11.4826C1.50229 11.7104 1.38462 11.8427 1.30904 11.949C1.27493 11.9969 1.26045 12.0248 1.25433 12.0388C1.25149 12.0453 1.25037 12.0493 1.25037 12.0493L1.25014 12.0505L1.25012 12.0517C1.25012 12.0517 1.25039 12.0559 1.25181 12.0629C1.25489 12.0779 1.26328 12.1083 1.28669 12.1623C1.33854 12.2821 1.42617 12.436 1.57918 12.7016L1.99049 13.4154C2.15361 13.6985 2.24936 13.8626 2.33276 13.9742C2.3705 14.0248 2.3942 14.0483 2.40633 14.0588C2.4119 14.0636 2.41518 14.0657 2.41518 14.0657L2.41619 14.0661C2.41619 14.0661 2.41987 14.0669 2.42713 14.0673C2.44294 14.0683 2.47618 14.0679 2.53828 14.0581C2.67558 14.0363 2.85823 13.9855 3.17218 13.8964L4.20459 13.6056L4.21918 13.6022C4.74533 13.4809 5.29732 13.5498 5.77759 13.7966L5.79113 13.8036L6.09754 13.9804L6.10973 13.9882C6.52135 14.2519 6.83773 14.6405 7.01281 15.097L7.01764 15.1096L7.30063 15.9548C7.39666 16.2434 7.45303 16.4099 7.50754 16.5273C7.53214 16.5803 7.54904 16.6065 7.55809 16.6186C7.56227 16.6242 7.5651 16.6271 7.5651 16.6271L7.56578 16.6277C7.56578 16.6277 7.56996 16.6298 7.57652 16.632C7.5907 16.6367 7.62067 16.6444 7.67847 16.6511C7.80667 16.6657 7.98189 16.6667 8.28563 16.6667H9.21461C9.51835 16.6667 9.69356 16.6657 9.82176 16.6511C9.87956 16.6444 9.90953 16.6367 9.92371 16.632C9.93027 16.6298 9.93375 16.6281 9.93375 16.6281L9.93513 16.6271C9.93513 16.6271 9.93796 16.6242 9.94214 16.6186C9.95119 16.6065 9.96809 16.5803 9.99269 16.5273C10.0472 16.4099 10.1036 16.2434 10.1996 15.9548L10.2 15.9536L10.4826 15.1096L10.4874 15.097C10.6625 14.6405 10.9789 14.2519 11.3905 13.9882L11.4027 13.9804L11.7091 13.8036L11.7226 13.7966C12.2029 13.5498 12.7549 13.4809 13.2811 13.6022L13.2956 13.6056L14.328 13.8964C14.642 13.9855 14.8247 14.0363 14.962 14.0581C15.0241 14.0679 15.0573 14.0683 15.0731 14.0673C15.0804 14.0669 15.084 14.0661 15.084 14.0661L15.0851 14.0657C15.0851 14.0657 15.0883 14.0636 15.0939 14.0588C15.106 14.0483 15.1297 14.0248 15.1675 13.9742C15.2509 13.8626 15.3466 13.6985 15.5097 13.4154L15.9211 12.7016C16.0741 12.436 16.1617 12.2821 16.2135 12.1623C16.237 12.1083 16.2453 12.0779 16.2484 12.0629C16.2498 12.0559 16.2501 12.0517 16.2501 12.0517L16.2501 12.0505L16.2499 12.0493C16.2499 12.0493 16.2487 12.0453 16.2459 12.0388C16.2398 12.0248 16.2253 11.9969 16.1912 11.949C16.1156 11.8427 15.9979 11.7104 15.7931 11.4826L14.92 10.5065L14.9082 10.4915C14.5961 10.0964 14.4145 9.48952 14.4145 8.9582C14.4145 8.42711 14.5962 7.82011 14.9082 7.42511L14.92 7.4101L15.792 6.43525L15.7931 6.43403C15.9979 6.20621 16.1156 6.07392 16.1912 5.96765C16.2253 5.9197 16.2398 5.89181 16.2459 5.87779C16.2487 5.87129 16.2499 5.86729 16.2499 5.86729L16.2501 5.8661L16.2501 5.86487C16.2501 5.86487 16.2498 5.86069 16.2484 5.85373C16.2453 5.83869 16.237 5.80836 16.2135 5.75431C16.1617 5.63456 16.0741 5.48058 15.9211 5.21503L15.5097 4.5012C15.3466 4.21811 15.2509 4.05401 15.1675 3.94236C15.1297 3.89183 15.106 3.86827 15.0939 3.85781C15.0883 3.853 15.0851 3.85094 15.0851 3.85094L15.084 3.85052C15.084 3.85052 15.0804 3.84972 15.0731 3.84928C15.0573 3.84833 15.0241 3.84866 14.962 3.85852C14.8247 3.88032 14.642 3.93107 14.3281 4.02016L13.2956 4.31096L13.281 4.31433C12.755 4.43564 12.2031 4.3668 11.7229 4.12007L11.7093 4.11312L11.4029 3.93629L11.3907 3.92848C10.979 3.6648 10.6625 3.27616 10.4874 2.8196L10.4826 2.80701L10.1996 1.96192C10.1036 1.67327 10.0472 1.50681 9.99269 1.38939C9.96809 1.33641 9.95119 1.31021 9.94214 1.29807C9.93796 1.29245 9.93514 1.28958 9.93514 1.28958L9.93445 1.28899C9.93445 1.28899 9.93027 1.28685 9.92371 1.28468C9.90953 1.27998 9.87956 1.27223 9.82176 1.26562C9.69356 1.25095 9.51835 1.25 9.21461 1.25H8.28563C7.98189 1.25 7.80667 1.25095 7.67847 1.26562C7.62067 1.27223 7.5907 1.27998 7.57652 1.28468C7.56996 1.28685 7.56578 1.28899 7.56578 1.28899Z"
        fill="currentColor"
      />
      <path
        opacity="0.4"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.71429 6.66016C7.44864 6.66016 6.42262 7.68618 6.42262 8.95183C6.42262 10.2175 7.44864 11.2435 8.71429 11.2435C9.97994 11.2435 11.006 10.2175 11.006 8.95183C11.006 7.68618 9.97994 6.66016 8.71429 6.66016ZM5.17262 8.95183C5.17262 6.99582 6.75828 5.41016 8.71429 5.41016C10.6703 5.41016 12.256 6.99582 12.256 8.95183C12.256 10.9078 10.6703 12.4935 8.71429 12.4935C6.75828 12.4935 5.17262 10.9078 5.17262 8.95183Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconHelp() {
  return (
    <svg width="18" height="18" viewBox="0 0 17.9167 17.9167" fill="none" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.95833 1.25004C4.70114 1.25004 1.25 4.70118 1.25 8.95837C1.25 13.2156 4.70114 16.6667 8.95833 16.6667C13.2155 16.6667 16.6667 13.2156 16.6667 8.95837C16.6667 4.70118 13.2155 1.25004 8.95833 1.25004ZM0 8.95837C0 4.01082 4.01078 4.06951e-05 8.95833 4.06951e-05C13.9059 4.06951e-05 17.9167 4.01082 17.9167 8.95837C17.9167 13.9059 13.9059 17.9167 8.95833 17.9167C4.01078 17.9167 0 13.9059 0 8.95837Z"
        fill="currentColor"
      />
      <path
        opacity="0.4"
        d="M8.95931 12.2914C9.41955 12.2914 9.79232 12.6651 9.79232 13.1254C9.79214 13.5855 9.41944 13.9584 8.95931 13.9584H8.9515C8.49152 13.9582 8.11867 13.5853 8.11849 13.1254C8.11849 12.6652 8.49141 12.2916 8.9515 12.2914H8.95931ZM8.95833 4.16638C10.224 4.16638 11.2503 5.19272 11.2503 6.45837C11.2503 6.91366 11.1161 7.34008 10.8861 7.69763C10.742 7.92141 10.5735 8.13556 10.4183 8.32849C10.39 8.36367 10.3617 8.39816 10.3343 8.43201C10.2055 8.59144 10.0871 8.73788 9.97786 8.88806C9.70837 9.25846 9.58344 9.53707 9.58333 9.79138V10.2084C9.58333 10.5536 9.30351 10.8334 8.95833 10.8334C8.61316 10.8334 8.33333 10.5536 8.33333 10.2084V9.79138C8.33344 9.12555 8.66008 8.57472 8.96712 8.15271C9.0969 7.97435 9.23918 7.79802 9.36849 7.63806C9.39435 7.60608 9.42004 7.57491 9.44466 7.54431C9.59895 7.35256 9.73037 7.18392 9.83529 7.02087C9.93946 6.85899 10.0003 6.66668 10.0003 6.45837C10.0003 5.88308 9.53363 5.41638 8.95833 5.41638C8.38304 5.41638 7.91634 5.88308 7.91634 6.45837C7.91634 6.80355 7.63652 7.08337 7.29134 7.08337C6.94631 7.0832 6.66634 6.80344 6.66634 6.45837C6.66634 5.19272 7.69268 4.16638 8.95833 4.16638Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconLogout() {
  return (
    <svg width="18" height="18" viewBox="0 0 16.25 16.2501" fill="none" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.6498 12.188C10.9947 12.2017 11.2632 12.4925 11.2495 12.8374C11.1748 14.7166 9.60886 16.2995 7.53944 16.2489C7.05865 16.2371 6.49345 16.0776 5.60677 15.8273C5.57102 15.8172 5.53476 15.8069 5.49795 15.7966C3.06151 15.1093 0.671716 13.8797 0.103003 10.98C-9.42946e-05 10.4543 -5.21486e-05 9.87406 1.86248e-05 8.90064L1.86926e-05 7.34943C-5.19957e-05 6.37601 -9.40909e-05 5.79578 0.103003 5.27012C0.671716 2.37042 3.06151 1.14075 5.49795 0.453507C5.53475 0.443127 5.57102 0.43289 5.60676 0.422801C6.49345 0.172499 7.05864 0.0129508 7.53944 0.0011887C9.60885 -0.0494371 11.1748 1.53344 11.2495 3.41271C11.2632 3.75761 10.9947 4.04833 10.6498 4.06203C10.3049 4.07574 10.0142 3.80725 10.0005 3.46235C9.95253 2.25505 8.94634 1.21714 7.57001 1.25081C7.26852 1.25819 6.86919 1.3655 5.8373 1.65656C3.50456 2.31455 1.75425 3.34571 1.32963 5.5107C1.25286 5.90215 1.25002 6.35275 1.25002 7.42732L1.25002 8.82275C1.25002 9.89732 1.25286 10.3479 1.32963 10.7394C1.75425 12.9044 3.50456 13.9355 5.83729 14.5935C6.86919 14.8846 7.26852 14.9919 7.57001 14.9993C8.94635 15.0329 9.95253 13.995 10.0005 12.7877C10.0142 12.4428 10.3049 12.1743 10.6498 12.188Z"
        fill="currentColor"
      />
      <path
        opacity="0.4"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.98986 5.60608C9.23045 5.85361 9.22483 6.24929 8.97731 6.48988C8.84265 6.62076 8.62839 6.78929 8.42444 6.94948C8.40872 6.96183 8.39289 6.97425 8.37698 6.98674C8.17221 7.14751 7.95324 7.31942 7.74604 7.49499C7.74405 7.49667 7.74206 7.49835 7.74008 7.50004H15.625C15.9702 7.50004 16.25 7.77986 16.25 8.12504C16.25 8.47021 15.9702 8.75004 15.625 8.75004H7.74008C7.74206 8.75172 7.74405 8.7534 7.74604 8.75509C7.95324 8.93066 8.17221 9.10257 8.37698 9.26333C8.39289 9.27582 8.40872 9.28824 8.42444 9.30059C8.62839 9.46078 8.84265 9.62931 8.97731 9.76019C9.22483 10.0008 9.23045 10.3965 8.98986 10.644C8.74928 10.8915 8.35359 10.8971 8.10607 10.6565C8.03002 10.5826 7.87851 10.4613 7.65232 10.2836C7.63593 10.2707 7.61927 10.2577 7.60237 10.2444C7.40058 10.086 7.16387 9.9002 6.93794 9.70876C6.69581 9.50359 6.44432 9.27394 6.2488 9.04438C6.15082 8.92934 6.05418 8.79968 5.97953 8.66018C5.90754 8.52565 5.83335 8.34027 5.83335 8.12504C5.83335 7.9098 5.90754 7.72442 5.97953 7.58989C6.05418 7.4504 6.15082 7.32073 6.2488 7.20569C6.44432 6.97613 6.69581 6.74649 6.93794 6.54132C7.16388 6.34987 7.4006 6.16406 7.60238 6.00567C7.61928 5.9924 7.63594 5.97933 7.65232 5.96646C7.87851 5.7888 8.03002 5.66745 8.10607 5.59353C8.35359 5.35294 8.74928 5.35856 8.98986 5.60608Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconZap() {
  return (
    <svg width="11" height="13" viewBox="0 0 10.5 12.0004" fill="none" aria-hidden className="shrink-0">
      <path
        d="M8.18906 1.04552C8.32734 0.724431 8.22422 0.349431 7.94062 0.143181C7.65703 -0.0630692 7.27031 -0.0443192 7.00547 0.185368L1.00547 5.43537C0.771094 5.64162 0.686719 5.97209 0.796875 6.26271C0.907031 6.55334 1.18828 6.75021 1.5 6.75021H4.11328L2.31094 10.9549C2.17266 11.276 2.27578 11.651 2.55937 11.8572C2.84297 12.0635 3.22969 12.0447 3.49453 11.8151L9.49453 6.56506C9.72891 6.35881 9.81328 6.02834 9.70312 5.73771C9.59297 5.44709 9.31406 5.25256 9 5.25256H6.38672L8.18906 1.04552Z"
        fill="white"
      />
    </svg>
  );
}

function IconCoins() {
  return (
    <svg width="18" height="18" viewBox="0 0 17.916 17.9189" fill="none" aria-hidden className="shrink-0">
      <path
        d="M0.946289 7.66895C1.12241 7.37223 1.50594 7.27426 1.80273 7.4502C2.09949 7.62628 2.19739 8.00983 2.02148 8.30664C1.53139 9.1326 1.25006 10.0971 1.25 11.1289C1.25 14.1883 3.72972 16.6688 6.78906 16.6689C7.82088 16.6689 8.78534 16.3875 9.61133 15.8975C9.90805 15.7214 10.2915 15.8187 10.4678 16.1152C10.6439 16.4121 10.5459 16.7955 10.249 16.9717C9.23527 17.5732 8.05157 17.9189 6.78906 17.9189C3.03937 17.9188 0 14.8786 0 11.1289C6.32695e-05 9.8665 0.344812 8.68263 0.946289 7.66895ZM10.625 0C14.6518 0.000176019 17.9158 3.2642 17.916 7.29102C17.916 11.318 14.6519 14.5828 10.625 14.583C6.59792 14.583 3.33301 11.3181 3.33301 7.29102C3.33318 3.26409 6.59803 0 10.625 0ZM10.625 1.25C7.28839 1.25 4.58318 3.95444 4.58301 7.29102C4.58301 10.6277 7.28828 13.333 10.625 13.333C13.9616 13.3328 16.666 10.6276 16.666 7.29102C16.6658 3.95455 13.9615 1.25018 10.625 1.25Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 14C8.85652 14 10.637 13.2625 11.9497 11.9497C13.2625 10.637 14 8.85652 14 7C14 5.14348 13.2625 3.36301 11.9497 2.05025C10.637 0.737498 8.85652 0 7 0C5.14348 0 3.36301 0.737498 2.05025 2.05025C0.737498 3.36301 0 5.14348 0 7C0 8.85652 0.737498 10.637 2.05025 11.9497C3.36301 13.2625 5.14348 14 7 14ZM7 3.5C7.36367 3.5 7.65625 3.79258 7.65625 4.15625V7.21875C7.65625 7.58242 7.36367 7.875 7 7.875C6.63633 7.875 6.34375 7.58242 6.34375 7.21875V4.15625C6.34375 3.79258 6.63633 3.5 7 3.5ZM6.125 9.625C6.125 9.39294 6.21719 9.17038 6.38128 9.00628C6.54538 8.84219 6.76794 8.75 7 8.75C7.23206 8.75 7.45462 8.84219 7.61872 9.00628C7.78281 9.17038 7.875 9.39294 7.875 9.625C7.875 9.85706 7.78281 10.0796 7.61872 10.2437C7.45462 10.4078 7.23206 10.5 7 10.5C6.76794 10.5 6.54538 10.4078 6.38128 10.2437C6.21719 10.0796 6.125 9.85706 6.125 9.625Z" fill="#F59E0B" />
    </svg>
  );
}
