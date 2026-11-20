
"use client";

import { Suspense, useEffect, useState, type JSX } from "react";
import { useSearchParams } from "next/navigation";
import { inter } from "@/fonts";
import { createBrowserSupabase } from "@/lib/supabase";
import { apiFetch } from "@/lib/api";
import { ZaviMark } from "@/components/marketing/ZaviWordmark";

type Info = { client_name: string; scopes: string[]; tenant_name: string };

const SCOPE_META: Record<string, { label: string; icon: JSX.Element }> = {
  read: {
    label: "Read your agents, runs, and company brain",
    icon: <BookIcon />,
  },
  run: {
    label: "Run agents on your behalf",
    icon: <BoltIcon />,
  },
  offline_access: {
    label: "Stay connected without re-logging in",
    icon: <RefreshIcon />,
  },
};

function ConsentInner() {
  const params = useSearchParams();
  const req = params.get("req") ?? "";
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "approve" | "deny">(null);

  useEffect(() => {
    if (!req) {
      setError("Missing consent request.");
      return;
    }
    (async () => {
      const supabase = createBrowserSupabase();
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        const here = `/oauth/consent?req=${encodeURIComponent(req)}`;
        window.location.href = `/login?next=${encodeURIComponent(here)}`;
        return;
      }
      const res = await apiFetch("/oauth/consent/info", {
        method: "POST",
        body: JSON.stringify({ req }),
      });
      if (!res.ok) {
        setError("This connection request is invalid or has expired.");
        return;
      }
      setInfo((await res.json()) as Info);
    })().catch(() => setError("Something went wrong."));
  }, [req]);

  async function decide(path: "approve" | "deny") {
    setBusy(path);
    setError(null);
    try {
      const res = await apiFetch(`/oauth/consent/${path}`, {
        method: "POST",
        body: JSON.stringify({ req }),
      });
      const body = (await res.json()) as { redirect?: string; error?: { message?: string } };
      if (!res.ok || !body.redirect) {
        setError(body.error?.message ?? "Could not complete the request.");
        setBusy(null);
        return;
      }
      window.location.href = body.redirect;
    } catch {
      setError("Network error. Try again.");
      setBusy(null);
    }
  }

  if (error && !info) {
    return (
      <Card>
        <div className="flex flex-col items-center text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-[#fef2f2] text-[#dc2626]">
            <AlertIcon />
          </span>
          <h1 className="mt-4 text-[20px] font-bold leading-tight tracking-[-0.4px] text-[#0e0f11]">
            Connection unavailable
          </h1>
          <p className="mt-2 text-[16px] leading-[1.55] tracking-[-0.15px] text-[#525252]">
            {error}
          </p>
          <p className="mt-5 text-[12px] leading-[1.55] tracking-[-0.15px] text-[#a1a1a1]">
            Start the connection again from the app you were using.
          </p>
        </div>
      </Card>
    );
  }

  if (!info) {
    return (
      <Card>
        <div className="flex flex-col items-center py-6 text-center">
          <Spinner className="text-[#a1a1a1]" size={22} />
          <p className="mt-3 text-[13px] tracking-[-0.15px] text-[#a1a1a1]">Loading…</p>
        </div>
      </Card>
    );
  }

  const scopes = info.scopes.length > 0 ? info.scopes : ["__none__"];
  const anyBusy = busy !== null;

  return (
    <Card>
      {}
      <div className="flex items-center justify-center gap-3">
        <ClientChip name={info.client_name} />
        <ConnectorGlyph />
        <ZaviMark size="lg" className="shadow-[0_1px_3px_rgba(14,15,17,0.14)]" />
      </div>

      <div className="mt-6 text-center">
        <p className="text-[12px] font-semibold uppercase leading-4 tracking-[2px] text-[#027bff]">
          Authorize connection
        </p>
        <h1 className="mt-2 text-[24px] font-bold leading-[1.15] tracking-[-0.6px] text-[#0e0f11]">
          Connect {info.client_name}
        </h1>
        <p className="mt-1.5 text-[16px] leading-[1.5] tracking-[-0.15px] text-[#525252]">
          to your Zavi workspace
        </p>
        <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-[#ececec] bg-[#faf9f8] px-3 py-1">
          <WorkspaceIcon />
          <span className="text-[13px] font-medium tracking-[-0.15px] text-[#171717]">
            {info.tenant_name}
          </span>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-[#f0f0f0] bg-white p-4">
        <p className="text-[12px] font-semibold uppercase tracking-[1.2px] text-[#a1a1a1]">
          This will allow it to
        </p>
        <ul className="mt-3 flex flex-col gap-3">
          {scopes.map((s) =>
            s === "__none__" ? (
              <li key={s} className="flex items-center gap-3">
                <ScopeIcon>
                  <CheckIcon />
                </ScopeIcon>
                <span className="text-[16px] leading-[1.4] tracking-[-0.15px] text-[#374151]">
                  Connect (no special permissions)
                </span>
              </li>
            ) : (
              <li key={s} className="flex items-center gap-3">
                <ScopeIcon>{SCOPE_META[s]?.icon ?? <CheckIcon />}</ScopeIcon>
                <span className="text-[16px] leading-[1.4] tracking-[-0.15px] text-[#374151]">
                  {SCOPE_META[s]?.label ?? s}
                </span>
              </li>
            ),
          )}
        </ul>
      </div>

      {}
      <div role="alert" aria-live="polite" className="min-h-[1rem]">
        {error && info && (
          <p className="mt-3 text-[13px] tracking-[-0.15px] text-[#dc2626]">{error}</p>
        )}
      </div>

      <div className="mt-5 flex flex-col gap-2.5">
        <button
          onClick={() => decide("approve")}
          disabled={anyBusy}
          aria-busy={busy === "approve" || undefined}
          className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-cta bg-[#0e0f11] px-4 text-[14px] font-semibold tracking-[-0.15px] text-white transition-colors hover:bg-[#404040] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "approve" ? (
            <>
              <Spinner size={16} /> Connecting…
            </>
          ) : (
            "Approve"
          )}
        </button>
        <button
          onClick={() => decide("deny")}
          disabled={anyBusy}
          className="inline-flex min-h-[48px] w-full items-center justify-center rounded-cta border border-[#e5e5e5] bg-white px-4 text-[14px] font-medium tracking-[-0.15px] text-[#374151] transition-colors hover:border-[#171717] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "deny" ? "Cancelling…" : "Deny"}
        </button>
      </div>

      <p className="mt-5 flex items-start gap-2 text-[12px] leading-[1.5] tracking-[-0.15px] text-[#a1a1a1]">
        <LockIcon />
        <span>
          Only approve if you started this from {info.client_name}. Disconnecting
          in {info.client_name} stops it calling Zavi. Email
          developer@zaviagent.com and we&apos;ll revoke every AI-assistant
          connection for your account within two business days.
        </span>
      </p>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full max-w-[440px] rounded-2xl border border-[#ececec] bg-white p-7 shadow-[0_1px_2px_rgba(14,15,17,0.04),0_12px_32px_-12px_rgba(14,15,17,0.12)]">
      {children}
    </div>
  );
}

function ClientChip({ name }: { name: string }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span className="flex size-10 items-center justify-center rounded-[12px] border border-[#ececec] bg-[#faf9f8] text-[16px] font-semibold text-[#525252] shadow-[0_1px_3px_rgba(14,15,17,0.06)]">
      {initial}
    </span>
  );
}

function ConnectorGlyph() {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      <span className="size-1 rounded-full bg-[#d4d4d4]" />
      <span className="size-1 rounded-full bg-[#d4d4d4]" />
      <span className="size-1 rounded-full bg-[#d4d4d4]" />
    </span>
  );
}

function ScopeIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-[#f4f7ff] text-[#027bff]">
      {children}
    </span>
  );
}

function BookIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function WorkspaceIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 text-[#a1a1a1]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 9h1M9 13h1M14 9h1M14 13h1M9 21v-3h6v3" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="mt-px size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function Spinner({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      style={{ height: size, width: size }}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default function OAuthConsentPage() {
  return (
    <main
      className={`${inter.variable} flex min-h-screen items-center justify-center bg-[#f5f3f1] px-4 py-10 font-[family-name:var(--font-inter)] text-[#0e0f11] selection:bg-[#171717] selection:text-white`}
    >
      <Suspense
        fallback={
          <Card>
            <div className="flex flex-col items-center py-6 text-center">
              <Spinner className="text-[#a1a1a1]" size={22} />
              <p className="mt-3 text-[13px] tracking-[-0.15px] text-[#a1a1a1]">Loading…</p>
            </div>
          </Card>
        }
      >
        <ConsentInner />
      </Suspense>
    </main>
  );
}
