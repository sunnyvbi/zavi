"use client";

import type { ReactNode } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import { Skeleton } from "../Skeleton";
import { useSiteFunctions, type SiteFunctionsPayload } from "./SiteFunctionsSettings";

export const PAYMENTS_TITLE = "Payments";
export const PAYMENTS_INTRO = "Take payments on your site with your own Stripe account. Money goes straight to you.";
export const PAYMENTS_NONE_TITLE = "This site doesn't take payments yet";
export const PAYMENTS_NONE =
  "Ask Zavi in the chat to add checkout, for example “Add a Book and pay button that charges with Stripe”. When it's built, you add your Stripe key here.";
export const PAYMENTS_UNUSED_KEY =
  "Ask Zavi in the chat to add checkout, for example \u201cAdd a Book and pay button that charges with Stripe\u201d. It can use the key you already saved.";
export const STRIPE_DASHBOARD_URL = "https://dashboard.stripe.com/payments";

export type PaymentsState =
  | { kind: "none" }
  | { kind: "unused_key"; keys: string[] }
  | { kind: "needs_key"; missing: string[]; functions: string[] }
  | { kind: "key_added"; keys: string[]; functions: string[] };

const isStripe = (name: string) => name.startsWith("STRIPE_");

export function paymentsState(data: SiteFunctionsPayload): PaymentsState {
  const required = [...new Set(data.secrets.required.filter(isStripe))];
  const added = new Set(data.secrets.secrets.map((s) => s.name).filter(isStripe));
  if (required.length === 0 && added.size === 0) return { kind: "none" };
  if (required.length === 0) return { kind: "unused_key", keys: [...added].sort() };
  const functions = data.functions.filter((f) => f.kind === "http" || f.kind === "webhook").map((f) => f.name);
  const missing = required.filter((n) => !added.has(n));
  if (missing.length > 0) return { kind: "needs_key", missing, functions };
  return { kind: "key_added", keys: [...new Set([...required, ...added])].sort(), functions };
}

const card = "rounded-xl border border-[#f0f0f0] bg-white";
const btn = "inline-flex h-8 items-center gap-1.5 rounded-cta border border-[#e5e5e5] px-3 text-[13px] font-medium text-[#0e0f11] hover:bg-[#f9f9f9]";

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-[840px] flex-col gap-4 p-4 sm:p-6">
      <div>
        <h2 className="text-[20px] font-semibold leading-7 text-[#0e0f11]">{PAYMENTS_TITLE}</h2>
        <p className="mt-0.5 max-w-[560px] text-[13px] text-[#8c8c8c]">{PAYMENTS_INTRO}</p>
      </div>
      {children}
    </div>
  );
}

export function SitePaymentsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading payments" data-section-skeleton="payments">
      <Shell>
        <div aria-hidden data-skeleton-row className={`${card} p-4`}>
          <Skeleton className="h-4 w-48" />
          <Skeleton className="mt-3 h-3 w-full" delayMs={120} />
          <Skeleton className="mt-2 h-8 w-32" rounded="rounded-cta" delayMs={240} />
        </div>
      </Shell>
    </div>
  );
}

export function SitePaymentsBody({ data, onOpenSecrets }: { data: SiteFunctionsPayload; onOpenSecrets: () => void }) {
  const st = paymentsState(data);
  if (st.kind === "none") {
    return (
      <div className={`${card} p-6 text-center`} data-payments="none">
        <p className="text-[14px] font-semibold text-[#0e0f11]">{PAYMENTS_NONE_TITLE}</p>
        <p className="mx-auto mt-1 max-w-[440px] text-[13px] leading-5 text-[#595959]">{PAYMENTS_NONE}</p>
      </div>
    );
  }
  if (st.kind === "unused_key") {
    return (
      <div className={`${card} p-4`} data-payments="unused-key">
        <p className="text-[14px] font-semibold text-[#0e0f11]">A Stripe key is saved, but nothing on your site uses it yet</p>
        <p className="mt-1 text-[13px] leading-5 text-[#595959]">{PAYMENTS_UNUSED_KEY}</p>
        <button type="button" className={`${btn} mt-3`} onClick={onOpenSecrets}>
          <KeyRound className="h-3.5 w-3.5" aria-hidden />
          Manage keys
        </button>
      </div>
    );
  }
  const fnList = st.functions.length > 0 && (
    <p className="mt-2 text-[12px] text-[#8c8c8c]">Handled by {st.functions.length === 1 ? "the function" : "the functions"} {st.functions.join(", ")}.</p>
  );
  if (st.kind === "needs_key") {
    return (
      <div role="alert" className="rounded-xl border border-[#f0e2bf] bg-[#fdf7e8] p-4" data-payments="needs-key">
        <p className="text-[14px] font-semibold text-[#8a5a00]">Add your Stripe key to start taking payments</p>
        <p className="mt-1 text-[13px] leading-5 text-[#6b4700]">
          Your site&rsquo;s checkout needs {st.missing.join(" and ")}. Until it is added, checkout can&rsquo;t charge anyone. Copy the secret key from your Stripe dashboard (Developers, API keys) and add it under Secrets.
        </p>
        {fnList}
        <button type="button" className={`${btn} mt-3 bg-white`} onClick={onOpenSecrets}>
          <KeyRound className="h-3.5 w-3.5" aria-hidden />
          Add it in Secrets
        </button>
      </div>
    );
  }
  return (
    <div className={`${card} p-4`} data-payments="key-added">
      <p className="text-[14px] font-semibold text-[#0e0f11]">The Stripe key your checkout needs is added</p>
      <p className="mt-1 text-[13px] leading-5 text-[#595959]">
        Payments made through it go to the Stripe account that key belongs to. Make a test purchase on your live site to check it works, and see and refund payments in your Stripe dashboard.
      </p>
      {fnList}
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={STRIPE_DASHBOARD_URL} target="_blank" rel="noopener noreferrer" className={btn}>
          Open Stripe
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
        <button type="button" className={btn} onClick={onOpenSecrets}>
          <KeyRound className="h-3.5 w-3.5" aria-hidden />
          Manage keys
        </button>
      </div>
    </div>
  );
}

export function SitePaymentsView({ buildSessionId, onOpenSecrets }: { buildSessionId: string; onOpenSecrets: () => void }) {
  const { load, reload } = useSiteFunctions(buildSessionId);
  if (load.phase === "loading") return <SitePaymentsSkeleton />;
  return (
    <Shell>
      {load.phase === "error" ? (
        <div role="alert" className="rounded-xl border border-[#f5c2c0] bg-[#fdf3f2] p-4 text-[13px] text-[#a8332c]">
          <p>{load.message}</p>
          <button type="button" className={`${btn} mt-3`} onClick={reload}>
            Try again
          </button>
        </div>
      ) : (
        <SitePaymentsBody data={load.data} onOpenSecrets={onOpenSecrets} />
      )}
    </Shell>
  );
}
