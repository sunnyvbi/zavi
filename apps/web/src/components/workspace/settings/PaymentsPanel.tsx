"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { InlineLoading } from "../InlineLoading";

type MoneyModel = "path_a" | "path_b";
type AccountState = "rail_disabled" | "no_account" | "pending" | "active";

type PayoutStatus = {
  rail_enabled: boolean;
  money_model: MoneyModel | null;
  account: {
    id: string;
    charges_enabled: boolean;
    payouts_enabled: boolean;
    details_submitted: boolean;
  } | null;
  state: AccountState;
  role: string | null;
  can_write: boolean;
};

const MODEL_COPY: Record<MoneyModel, { title: string; body: string }> = {
  path_a: {
    title: "You collect directly",
    body: "Payments settle straight to your Stripe account. You are the merchant of record and handle any chargebacks.",
  },
  path_b: {
    title: "Zavi collects and pays you out",
    body: "Zavi collects on your behalf and remits the net to your account. Zavi is the merchant of record. Use this when you want Zavi to run the money flow end to end.",
  },
};

const MERCHANT_OF_RECORD: Record<MoneyModel, string> = {
  path_a: "You are the merchant of record",
  path_b: "Zavi is the merchant of record",
};

export function PaymentsPanel() {
  const [status, setStatus] = useState<PayoutStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [picked, setPicked] = useState<MoneyModel | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [onboardingUrl, setOnboardingUrl] = useState<string | null>(null);

  const isMounted = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch("/api/workspace/stripe/payout-account");
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        if (isMounted.current) setLoadError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as PayoutStatus;
      if (!isMounted.current) return;
      setStatus(data);
      setPicked(data.money_model);
    } catch (err) {
      if (isMounted.current) setLoadError((err as Error).message ?? "Unknown error");
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    const kyc =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("kyc")
        : null;
    void load().then(() => {
      if (kyc === "refresh") void regenerateLink();
    });
    return () => {
      isMounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function saveMoneyModel() {
    if (!picked) return;
    setBusy("money_model");
    setActionError(null);
    try {
      const res = await apiFetch("/api/workspace/stripe/money-model", {
        method: "POST",
        body: JSON.stringify({ money_model: picked }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setActionError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      await load();
    } catch (err) {
      setActionError((err as Error).message ?? "Unknown error");
    } finally {
      if (isMounted.current) setBusy(null);
    }
  }

  async function createAccount() {
    setBusy("create");
    setActionError(null);
    try {
      const res = await apiFetch("/api/workspace/stripe/payout-account", {
        method: "POST",
        body: JSON.stringify({ company_name: companyName.trim() }),
      });
      const body = (await res.json().catch(() => null)) as
        | { onboarding_url?: string | null; state?: string; error?: { message?: string } }
        | null;
      if (!res.ok) {
        setActionError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      if (body?.onboarding_url) setOnboardingUrl(body.onboarding_url);
      await load();
    } catch (err) {
      setActionError((err as Error).message ?? "Unknown error");
    } finally {
      if (isMounted.current) setBusy(null);
    }
  }

  async function regenerateLink() {
    setBusy("link");
    setActionError(null);
    try {
      const res = await apiFetch("/api/workspace/stripe/onboarding-link", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { onboarding_url?: string; state?: string; error?: { message?: string } }
        | null;
      if (!res.ok) {
        setActionError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      if (body?.onboarding_url) setOnboardingUrl(body.onboarding_url);
    } catch (err) {
      setActionError((err as Error).message ?? "Unknown error");
    } finally {
      if (isMounted.current) setBusy(null);
    }
  }

  if (loading) return <InlineLoading label="Loading payment settings…" />;

  if (loadError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
        <p className="text-[13px] text-red-700">Failed to load payment settings: {loadError}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-2 rounded-full border border-ink/20 px-3 py-1 text-[13px] text-ink hover:bg-ink/5"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!status) return null;

  const canWrite = status.can_write;

  return (
    <div className="space-y-8">
      {!canWrite && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          Only an owner or admin can change payment settings. You can view the current setup below.
        </div>
      )}

      {status.state === "rail_disabled" ? (
        <div className="rounded-xl border border-ink/[0.08] bg-white px-4 py-4">
          <h2 className="text-[14px] font-semibold text-ink">Payments are not enabled yet</h2>
          <p className="mt-1.5 text-[13px] text-inkMuted leading-[1.55]">
            Payouts for your workspace have not been turned on. Once enabled, you can create a Stripe
            payout account here and start collecting. Your current choices below are saved and will
            apply when payments go live.
          </p>
        </div>
      ) : null}

      {}
      <section>
        <h2 className="text-[14px] font-semibold text-ink">How you get paid</h2>
        <p className="mt-1 text-[13px] text-inkMuted leading-[1.55]">
          Choose who collects the payment and who is the merchant of record. This is required before
          any payment can be collected.
        </p>

        {}
        {status.money_model ? (
          <div className="mt-3 rounded-lg border border-ink/[0.08] bg-ink/[0.02] px-3 py-2 text-[13px] text-ink">
            <span className="font-medium">Current model:</span>{" "}
            {MODEL_COPY[status.money_model].title}: {MERCHANT_OF_RECORD[status.money_model]}.
          </div>
        ) : (
          <div className="mt-3 text-[13px] text-inkMuted">No money model selected yet.</div>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(["path_a", "path_b"] as MoneyModel[]).map((m) => {
            const selected = picked === m;
            return (
              <button
                key={m}
                type="button"
                disabled={!canWrite}
                onClick={() => setPicked(m)}
                className={`rounded-cta border px-4 py-3 text-left transition ${
                  selected ? "border-ink bg-ink/[0.03]" : "border-ink/[0.12] hover:border-ink/30"
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full border ${
                      selected ? "border-ink bg-ink" : "border-ink/30"
                    }`}
                  />
                  <span className="text-[16px] font-semibold text-ink">{MODEL_COPY[m].title}</span>
                </div>
                <p className="mt-1.5 text-[12px] text-inkMuted leading-[1.5]">{MODEL_COPY[m].body}</p>
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            disabled={!canWrite || !picked || picked === status.money_model || busy === "money_model"}
            onClick={() => void saveMoneyModel()}
            className="rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-cream hover:bg-ink/90 disabled:opacity-50"
          >
            {busy === "money_model" ? "Saving…" : "Save choice"}
          </button>
          {canWrite && !picked && (
            <span className="text-[12px] text-inkMuted">Select a model above to enable Save.</span>
          )}
          {canWrite && picked && picked !== status.money_model && (
            <span className="text-[12px] text-inkMuted">Unsaved change. Click Save choice to apply.</span>
          )}
          {canWrite && picked && picked === status.money_model && (
            <span className="text-[12px] text-inkMuted">Saved.</span>
          )}
        </div>
      </section>

      {}
      <section>
        <h2 className="text-[14px] font-semibold text-ink">Payout account</h2>

        {status.state === "no_account" || status.state === "rail_disabled" ? (
          <div className="mt-2 space-y-3">
            <p className="text-[13px] text-inkMuted leading-[1.55]">
              Create a Stripe account to receive payouts. You will complete identity verification on
              Stripe, then return here.
            </p>
            <div className="flex flex-col gap-2 sm:max-w-sm">
              <label className="text-[14px] font-medium text-inkMuted">Legal business name</label>
              <input
                type="text"
                value={companyName}
                disabled={!canWrite}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Acme Inc"
                className="rounded-lg border border-ink/15 bg-white px-3 py-2 text-[13px] text-ink outline-none focus:ring-2 focus:ring-ink/20 disabled:opacity-60"
              />
            </div>
            <button
              type="button"
              disabled={
                !canWrite || status.state === "rail_disabled" || !companyName.trim() || busy === "create"
              }
              onClick={() => void createAccount()}
              className="rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-cream hover:bg-ink/90 disabled:opacity-50"
            >
              {busy === "create" ? "Creating…" : "Create payout account"}
            </button>
            {canWrite && status.state === "no_account" && !companyName.trim() && (
              <p className="text-[12px] text-inkMuted">
                Enter your legal business name above to enable this.
              </p>
            )}
          </div>
        ) : null}

        {status.state === "pending" ? (
          <div className="mt-2 space-y-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                Pending verification
              </span>
              <span className="font-mono text-[12px] text-inkMuted">{status.account?.id}</span>
            </div>
            <p className="text-[13px] text-inkMuted leading-[1.5]">
              Finish Stripe identity verification to start receiving payouts.
            </p>
            <button
              type="button"
              disabled={!canWrite || busy === "link"}
              onClick={() => void regenerateLink()}
              className="rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-cream hover:bg-ink/90 disabled:opacity-50"
            >
              {busy === "link" ? "Preparing…" : "Finish verification"}
            </button>
          </div>
        ) : null}

        {status.state === "active" ? (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                Active
              </span>
              {status.account?.charges_enabled && (
                <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                  Charges enabled
                </span>
              )}
              {status.account?.payouts_enabled && (
                <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                  Payouts enabled
                </span>
              )}
              <span className="font-mono text-[12px] text-inkMuted">{status.account?.id}</span>
            </div>
            <p className="text-[13px] text-inkMuted">Your payout account is verified and live.</p>
          </div>
        ) : null}

        {onboardingUrl && (
          <a
            href={onboardingUrl}
            className="mt-3 inline-flex rounded-full border border-ink/20 px-4 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/5"
          >
            Continue to Stripe
          </a>
        )}

        {actionError && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
            {actionError}
          </div>
        )}
      </section>
    </div>
  );
}
