"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Switch } from "@/components/ui/Switch";
import { useCookieClearOfComposer } from "@/lib/workspace/buildFraming";
import { captureFirstTouch } from "@/lib/analytics/first-touch";
import { ANALYTICS, NECESSARY, type CookieRow } from "@/lib/cookie-inventory";
import {
  OPEN_PREFERENCES_EVENT,
  hasAnalyticsConsent,
  readConsent,
  signalsRejection,
  subscribe,
  withdrawAnalyticsConsent,
  writeConsent,
} from "@/lib/consent";

const SUPPRESSED_PATHS = new Set([
  "/extension/connect",
  "/oauth/consent",
  "/loginas",
  "/login",
  "/reset-password",
]);
const SUPPRESSED_PREFIXES = ["/auth/"];

const DISMISSED_KEY = "zavi:cookie-banner-dismissed";

function isSuppressed(pathname: string | null): boolean {
  if (!pathname) return false;
  if (SUPPRESSED_PATHS.has(pathname)) return true;
  return SUPPRESSED_PREFIXES.some((p) => pathname.startsWith(p));
}

export function isWorkspacePath(pathname: string | null): boolean {
  return !!pathname && (pathname === "/workspace" || pathname.startsWith("/workspace/"));
}

function dismissedThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function markDismissed(): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, "1");
  } catch {
  }
}

const CHOICE_SIZE =
  "inline-flex h-10 flex-1 items-center justify-center rounded-block px-4 text-[14px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-cream";
const ACCEPT_BUTTON = `${CHOICE_SIZE} bg-ink text-cream hover:bg-inkSoft`;
const REJECT_BUTTON = `${CHOICE_SIZE} border border-ink/15 bg-cream text-ink hover:border-ink/40`;

const TEXT_BUTTON =
  "text-[13px] font-medium text-ink underline underline-offset-2 transition-opacity hover:opacity-70";

export type CookieBannerViewProps = {
  bannerOpen: boolean;
  modalOpen: boolean;
  placement?: "bottom" | "top" | "phone-top";
  analytics: boolean;
  gpc: boolean;
  onAccept: () => void;
  onReject: () => void;
  onOpenPrefs: () => void;
  onDismiss: () => void;
  onToggleAnalytics: (v: boolean) => void;
  onSave: () => void;
  onCloseModal: () => void;
};

function Disclosures({ rows }: { rows: CookieRow[] }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-[13px] font-medium text-inkMuted hover:text-ink">
        View disclosures
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.name} className="rounded-lg border border-rule bg-creamDeep px-3 py-2 text-[13px] leading-[1.5] text-inkSoft">
            <div className="font-medium text-ink">{r.name}</div>
            <div className="text-inkMuted">
              {r.provider} · {r.type} · {r.expiry}
            </div>
            <div>{r.purpose}</div>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function CookieBannerView(p: CookieBannerViewProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!p.modalOpen) return;
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;
    headingRef.current?.focus();
    return () => {
      restoreRef.current?.focus?.();
    };
  }, [p.modalOpen]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      p.onCloseModal();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, summary, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      {p.bannerOpen && !p.modalOpen && (
        <section
          aria-label="Cookie consent"
          data-analytics-ignore
          data-placement={p.placement ?? "bottom"}
          className={`cookie-consent fixed left-4 right-4 z-[130] rounded-2xl border border-rule bg-cream p-4 shadow-[0_8px_32px_rgba(0,0,0,0.12)] sm:w-[400px] ${
            p.placement === "top"
              ? "top-4 sm:left-auto"
              : p.placement === "phone-top"
                ? "top-4 sm:bottom-4 sm:right-auto sm:top-auto"
                : "bottom-4 sm:right-auto"
          }`}
        >
          <p className="text-[13px] leading-[1.5] text-inkSoft sm:text-[14px] sm:leading-[1.55]">
            We use cookies to keep you signed in and to understand how the site
            is used. You can turn analytics off at any time. We do not use
            advertising cookies and we do not record your screen.
          </p>
          <div className="mt-3 flex gap-2 sm:mt-4">
            <button type="button" onClick={p.onReject} className={REJECT_BUTTON}>
              Reject
            </button>
            <button type="button" onClick={p.onAccept} className={ACCEPT_BUTTON}>
              Accept
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
            <button type="button" onClick={p.onOpenPrefs} className={TEXT_BUTTON}>
              Manage preferences
            </button>
            <a href="/cookie-policy" className={TEXT_BUTTON}>
              Cookie policy
            </a>
            <button
              type="button"
              onClick={p.onDismiss}
              aria-label="Close without choosing"
              className="ml-auto text-[13px] text-inkMuted hover:text-ink"
            >
              Close
            </button>
          </div>
        </section>
      )}

      {p.modalOpen && (
        <div
          data-analytics-ignore
          className="fixed inset-0 z-[131] flex items-end justify-center bg-black/40 p-4 sm:items-center"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) p.onCloseModal();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cookie-prefs-title"
            onKeyDown={onKeyDown}
            className="cookie-consent max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-2xl border border-rule bg-cream p-6 shadow-[0_8px_32px_rgba(0,0,0,0.18)]"
          >
            <h2
              id="cookie-prefs-title"
              ref={headingRef}
              tabIndex={-1}
              className="text-[20px] font-semibold tracking-[-0.4px] text-ink focus:outline-none"
            >
              Cookie preferences
            </h2>
            <p className="mt-2 text-[14px] leading-[1.55] text-inkMuted">
              Your choice is saved on this device and browser for 180 days. You
              can change it at any time from the footer or the{" "}
              <a href="/cookie-policy" className="underline underline-offset-2 hover:text-ink">
                cookie policy
              </a>
              .
            </p>
            {p.gpc && (
              <p className="mt-2 rounded-lg bg-creamDeep px-3 py-2 text-[13px] leading-[1.5] text-inkSoft">
                Your browser is sending a Global Privacy Control signal, so
                analytics is off unless you turn it on here.
              </p>
            )}

            <div className="mt-5 flex flex-col gap-5">
              <div>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-[14px] font-semibold text-ink">Necessary</div>
                    <p className="mt-1 text-[13px] leading-[1.5] text-inkMuted">
                      Signing in, your saved settings, and this choice. Always on.
                    </p>
                  </div>
                  <Switch checked disabled label="Necessary cookies (always on)" onCheckedChange={() => {}} />
                </div>
                <Disclosures rows={NECESSARY} />
              </div>

              <div>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-[14px] font-semibold text-ink">Analytics</div>
                    <p className="mt-1 text-[13px] leading-[1.5] text-inkMuted">
                      Page views and clicks on our public pages and a short list of
                      product events (PostHog, Mixpanel, Google Analytics). On unless you turn it off.
                    </p>
                  </div>
                  <Switch
                    checked={p.analytics}
                    label="Analytics cookies"
                    onCheckedChange={p.onToggleAnalytics}
                  />
                </div>
                <Disclosures rows={ANALYTICS} />
              </div>
            </div>

            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-4">
                <button type="button" onClick={p.onReject} className={TEXT_BUTTON}>
                  Reject all
                </button>
                <button type="button" onClick={p.onAccept} className={TEXT_BUTTON}>
                  Accept all
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={p.onCloseModal}
                  className="inline-flex h-10 items-center justify-center rounded-block border border-ink/15 bg-cream px-4 text-[14px] font-semibold text-ink transition-colors hover:border-ink/40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={p.onSave}
                  className="inline-flex h-10 items-center justify-center rounded-block bg-ink px-4 text-[14px] font-semibold text-cream transition-colors hover:bg-inkSoft"
                >
                  Save preferences
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function CookieBanner() {
  const pathname = usePathname();
  const [bannerOpen, setBannerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [gpc, setGpc] = useState(false);
  const onWorkspace = isWorkspacePath(pathname);
  const clearOfComposer = useCookieClearOfComposer(onWorkspace);
  const placement = !onWorkspace ? "phone-top" : clearOfComposer === true ? "top" : "bottom";
  const placementKnown = !onWorkspace || clearOfComposer !== null;

  const openModal = () => {
    setAnalytics(hasAnalyticsConsent());
    setModalOpen(true);
  };

  useEffect(() => {
    setGpc(signalsRejection());
    setBannerOpen(
      readConsent().status === "unset" &&
        !signalsRejection() &&
        !dismissedThisSession() &&
        !isSuppressed(pathname),
    );
    const unsub = subscribe((s) => {
      if (s.status === "set") setBannerOpen(false);
    });
    window.addEventListener(OPEN_PREFERENCES_EVENT, openModal);
    return () => {
      unsub();
      window.removeEventListener(OPEN_PREFERENCES_EVENT, openModal);
    };
  }, [pathname]);

  const accept = () => {
    writeConsent({ analytics: true });
    captureFirstTouch();
    setModalOpen(false);
  };

  const reject = () => {
    withdrawAnalyticsConsent();
    setModalOpen(false);
  };

  return (
    <CookieBannerView
      bannerOpen={bannerOpen && placementKnown}
      modalOpen={modalOpen}
      placement={placement}
      analytics={analytics}
      gpc={gpc}
      onAccept={accept}
      onReject={reject}
      onOpenPrefs={openModal}
      onDismiss={() => {
        markDismissed();
        setBannerOpen(false);
      }}
      onToggleAnalytics={setAnalytics}
      onSave={analytics ? accept : reject}
      onCloseModal={() => setModalOpen(false)}
    />
  );
}
