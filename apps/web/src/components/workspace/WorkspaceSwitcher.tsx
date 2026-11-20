"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "@/lib/api";
import { useCanAddCompany } from "@/lib/gatekeeper";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { switchToTenantDetailed } from "@/lib/workspace/tenantSwitch";
import { reloadWithoutBuild } from "@/lib/workspace/buildLinkOnLoad";
import { SiteIcon } from "@/components/marketing/growth-home/SiteIcon";

type TenantMembership = {
  tenant_id: string;
  slug: string;
  display_name: string;
  role: string;
  website?: string | null;
};

function WorkspaceAvatar({
  website,
  initial,
  size,
}: {
  website: string | null | undefined;
  initial: string;
  size: 24 | 32;
}) {
  const box = size === 32 ? "h-8 w-8 text-[14px]" : "h-6 w-6 text-[11px]";
  const letter = (
    <span
      className={`flex items-center justify-center rounded-full border-[0.5px] border-[#f0f0f0] bg-ink font-medium text-white ${box}`}
    >
      {initial}
    </span>
  );
  if (!website) return <span aria-hidden className="shrink-0">{letter}</span>;
  return (
    <SiteIcon
      value={website}
      size={size}
      delayMs={0}
      fallback={letter}
      className="overflow-hidden rounded-full"
      imgClassName="rounded-full object-cover"
    />
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SwitchingOverlay({
  name,
  initial,
  stuck = false,
  onRetry,
}: {
  name: string;
  initial: string;
  stuck?: boolean;
  onRetry?: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const overlay = overlayRef.current;
    const inerted: HTMLElement[] = [];
    for (const el of Array.from(document.body.children)) {
      if (!(el instanceof HTMLElement)) continue;
      if (overlay && el.contains(overlay)) continue;
      if (el.hasAttribute("inert")) continue;
      el.setAttribute("inert", "");
      inerted.push(el);
    }
    overlay?.focus();
    return () => {
      for (const el of inerted) el.removeAttribute("inert");
    };
  }, [mounted]);

  if (!mounted) return null;

  const signOut = async () => {
    const res = await createBrowserSupabase().auth.signOut({ scope: "local" }).catch((e: unknown) => ({ error: e }));
    if (res?.error) {
      setSignOutFailed(true);
      return;
    }
    window.location.replace("/login");
  };

  return createPortal(
    <div
      ref={overlayRef}
      tabIndex={-1}
      role={stuck ? "alertdialog" : "status"}
      aria-modal={stuck ? true : undefined}
      aria-live="polite"
      aria-busy={!stuck}
      className="fixed inset-0 z-[200] flex animate-fade-in items-center justify-center bg-white/70 outline-none backdrop-blur-md motion-reduce:animate-none"
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {stuck ? (
        <div className="flex flex-col items-center gap-3 px-6 text-center">
          <p className="text-[14px] font-semibold text-[#0e0f11]">
            Couldn&apos;t finish switching to {name}
          </p>
          <p className="text-[13px] text-[#595959]">
            {onRetry ? "Try again, or sign out and sign back in." : "Sign out and sign back in to continue."}
          </p>
          {signOutFailed ? (
            <p className="text-[13px] text-[#dc2626]">Couldn&apos;t sign you out. Try again.</p>
          ) : null}
          <div className="flex gap-2">
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-cta bg-ink px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-ink/90"
              >
                Try again
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-cta border border-rule bg-cream px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-creamDeep"
            >
              Sign out
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 px-6 text-center">
          <span className="relative flex h-12 w-12 items-center justify-center">
            <span
              aria-hidden
              className="absolute inset-0 animate-spin rounded-full border-2 border-[#e5e5e5] border-t-ink"
            />
            <span
              aria-hidden
              className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-[13px] font-medium text-white"
            >
              {initial}
            </span>
          </span>
          <p className="text-[14px] font-semibold text-[#0e0f11]">
            Switching to {name}
          </p>
          <p className="text-[13px] text-[#595959]">
            Reloading your workspace…
          </p>
        </div>
      )}
    </div>,
    document.body,
  );
}

export function WorkspaceSwitcher({
  companyName,
  companyInitial,
  onOpenHome,
}: {
  companyName: string;
  companyInitial: string;
  onOpenHome: () => void;
}) {
  const [memberships, setMemberships] = useState<TenantMembership[] | null>(null);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stuck, setStuck] = useState(false);
  const [currentTenantId, setCurrentTenantId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { open, setOpen, toggle, close } = useDismissableMenu(wrapRef, triggerRef);

  const switchingTarget = useMemo(
    () =>
      switchingTo === null
        ? null
        : (memberships ?? []).find((t) => t.tenant_id === switchingTo) ?? null,
    [switchingTo, memberships],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const id = await getActiveTenantId(createBrowserSupabase());
      if (!cancelled) setCurrentTenantId(id);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/v1/tenants/mine");
        if (!res.ok) return;
        const body = (await res.json()) as { tenants?: TenantMembership[] };
        if (!cancelled) setMemberships(body.tenants ?? []);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const menuVisible = open || switchingTo !== null;

  const handleSwitch = useCallback(
    async (tenantId: string) => {
      setError(null);
      setSwitchingTo(tenantId);
      const fail = () => {
        setSwitchingTo(null);
        setError("Couldn't switch workspace. Try again.");
        setOpen(true);
      };
      try {
        const result = await switchToTenantDetailed(tenantId).catch(() => "not_converged" as const);
        if (result === "not_converged") {
          setStuck(true);
          return;
        }
        if (result !== "ok") {
          fail();
          return;
        }
        reloadWithoutBuild();
      } catch {
        fail();
      }
    },
    [setOpen],
  );

  const canAddCompany = useCanAddCompany() === true;
  const handleAddCompany = useCallback(() => {
    window.location.href = "/start?new=1";
  }, []);

  const currentWebsite = memberships?.find((t) =>
    currentTenantId !== null ? t.tenant_id === currentTenantId : t.display_name === companyName,
  )?.website;

  if (memberships === null || memberships.length < 2) {
    return (
      <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onOpenHome}
        className="flex w-full items-center gap-2 rounded-cta px-2 py-1.5 text-left transition-colors duration-150 hover:bg-[#f5f5f5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
        title={companyName}
        aria-label={`${companyName}: workspace home`}
      >
        <WorkspaceAvatar website={currentWebsite} initial={companyInitial} size={32} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[0.01px] text-[#0e0f11]">
          {companyName}
        </span>
      </button>
      {memberships !== null && canAddCompany && (
        <a
          href="/start?new=1"
          aria-label="Add company"
          title="Add company"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-inkLight transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
        >
          <PlusIcon className="h-4 w-4" />
        </a>
      )}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-cta px-2 py-1.5 text-left transition-colors duration-150 hover:bg-[#f5f5f5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
        title={companyName}
        aria-haspopup="menu"
        aria-expanded={menuVisible}
        aria-label={`${companyName}: switch workspace`}
      >
        <WorkspaceAvatar website={currentWebsite} initial={companyInitial} size={32} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[0.01px] text-[#0e0f11]">
          {companyName}
        </span>
        <ChevronDown
          className={`h-5 w-5 shrink-0 text-[#595959] transition-transform duration-150 ${
            menuVisible ? "rotate-180" : ""
          }`}
        />
      </button>

      {menuVisible ? (
        <div
          role="menu"
          aria-label="Switch workspace"
          className="absolute left-0 right-0 z-30 mt-1 max-h-[60vh] overflow-y-auto rounded-[10px] border border-[#f0f0f0] bg-white py-1 shadow-lg"
        >
          {memberships.map((t) => {
            const isCurrent =
              currentTenantId !== null
                ? t.tenant_id === currentTenantId
                : t.display_name === companyName;
            const isSwitching = switchingTo === t.tenant_id;
            return (
              <button
                key={t.tenant_id}
                type="button"
                role="menuitem"
                disabled={isCurrent || isSwitching || switchingTo !== null}
                onClick={() => {
                  if (isCurrent) {
                    close();
                    onOpenHome();
                    return;
                  }
                  void handleSwitch(t.tenant_id);
                }}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[14px] transition-colors duration-150 ${
                  isCurrent
                    ? "cursor-default text-[#0e0f11]"
                    : "text-[#0e0f11] hover:bg-[#f5f5f5]"
                } ${switchingTo !== null && !isSwitching ? "opacity-50" : ""}`}
                title={t.display_name}
              >
                <WorkspaceAvatar
                  website={t.website}
                  initial={(t.display_name.trim()[0] || "Z").toUpperCase()}
                  size={24}
                />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {t.display_name}
                </span>
                {isCurrent ? (
                  <CheckIcon className="h-4 w-4 shrink-0 text-[#16a34a]" />
                ) : isSwitching ? (
                  <span
                    aria-hidden
                    className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[#e5e5e5] border-t-[#595959]"
                  />
                ) : null}
              </button>
            );
          })}
          {error ? (
            <p className="px-2.5 pt-1 text-[12px] text-[#dc2626]">{error}</p>
          ) : null}

          {canAddCompany ? (
            <>
              <div className="my-1 border-t border-[#f0f0f0]" aria-hidden />
              <button
                type="button"
                role="menuitem"
                disabled={switchingTo !== null}
                onClick={() => {
                  close(false);
                  handleAddCompany();
                }}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[14px] text-[#0e0f11] transition-colors duration-150 hover:bg-[#f5f5f5] ${
                  switchingTo !== null ? "opacity-50" : ""
                }`}
                title="Add another company"
              >
                <span
                  aria-hidden
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[0.5px] border-dashed border-[#d4d4d4] text-[#595959]"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">Add company</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {switchingTarget ? (
        <SwitchingOverlay
          name={switchingTarget.display_name}
          initial={(switchingTarget.display_name.trim()[0] || "Z").toUpperCase()}
          stuck={stuck}
          onRetry={
            stuck && switchingTo
              ? () => {
                  setStuck(false);
                  void handleSwitch(switchingTo);
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
