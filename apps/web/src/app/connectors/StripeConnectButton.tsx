"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { showConnectorError } from "@/components/workspace/settings/connectorErrorDialog";
import {
  FormPanel,
  FormField,
  FormSecretInput,
  FormPrimaryButton,
  FormSecondaryButton,
} from "@/components/workspace/settings/formControls";

type ConnectResult = {
  ok?: boolean;
  account_id?: string;
  account_email?: string | null;
  country?: string | null;
  capabilities?: string[];
  error?: { code?: string; message?: string };
};

export function StripeConnectButton({
  connected,
  open,
  onToggle,
}: {
  connected: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {}
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex h-10 shrink-0 items-center justify-center whitespace-nowrap rounded-cta border border-[#f0f0f0] bg-white px-4 text-[16px] font-semibold leading-[20px] tracking-[0.01px] text-[#1f1f1f] transition-colors hover:border-[#e0e0e0] hover:bg-[#fafafa]"
        >
          {connected ? "Reconnect" : open ? "Hide setup" : "Connect"}
        </button>
      </div>
    </div>
  );
}

export function StripeForm({ onClose }: { onClose: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectResult | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    setBusy(true);
    try {
      const res = await apiFetch("/api/connectors/stripe", {
        method: "POST",
        body: JSON.stringify({ api_key: apiKey }),
      });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const body = (await res.json().catch(() => ({}))) as ConnectResult;
      if (!res.ok || body.error) {
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      setResult(body);
    } catch (e) {
      showConnectorError({ title: "Couldn’t connect Stripe", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (result?.ok) {
    return (
      <FormPanel>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-[#0e0f11]">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#f5faf8] text-[#167f50]">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m5 12.5 4.2 4.2L19 7" />
              </svg>
            </span>
            Connected to Stripe
          </div>
          <p className="text-[16px] leading-[19px] text-[#595959]">
            Account <strong className="font-semibold text-[#0e0f11]">{result.account_id}</strong>
            {result.account_email ? <> · {result.account_email}</> : null}
            {result.country ? <> · {result.country.toUpperCase()}</> : null}
          </p>
          {result.capabilities && result.capabilities.length > 0 && (
            <p className="text-[13px] text-[#8a8a8a]">
              Capabilities: {result.capabilities.join(", ")}
            </p>
          )}
          <div className="mt-1">
            <FormPrimaryButton type="button" onClick={() => window.location.reload()}>
              Done
            </FormPrimaryButton>
          </div>
        </div>
      </FormPanel>
    );
  }

  return (
    <FormPanel onSubmit={onSubmit}>
      <div className="grid gap-4">
        {}
        <div className="rounded-[12px] border border-[#f0f0f0] bg-[#f9f9f9] px-4 py-3.5 text-[13px] leading-[18px] text-[#595959]">
          <div className="mb-2 text-[16px] font-semibold text-[#0e0f11]">
            How to connect Stripe (~2 min)
          </div>
          <ol className="list-decimal space-y-2 pl-4">
            <li>
              <a
                href="https://dashboard.stripe.com/apikeys"
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-[#027bff] hover:underline"
              >
                Open Stripe&apos;s API-keys page ↗
              </a>{" "}
              (sign into your Stripe account if it asks).
            </li>
            <li>
              Click <strong className="font-semibold text-[#0e0f11]">Create secret key</strong>, then choose{" "}
              <strong className="font-semibold text-[#0e0f11]">Powering an integration you built</strong>.
            </li>
            <li>
              Name it <strong className="font-semibold text-[#0e0f11]">Zavi</strong>. Under the{" "}
              <strong className="font-semibold text-[#0e0f11]">Permissions</strong> column (your own account&apos;s data,
              not <strong className="font-semibold text-[#0e0f11]">Connect permissions</strong>), set{" "}
              <strong className="font-semibold text-[#0e0f11]">every resource to Read</strong>, then change{" "}
              <strong className="font-semibold text-[#0e0f11]">Disputes</strong> to{" "}
              <strong className="font-semibold text-[#0e0f11]">Write</strong>.
            </li>
            <li>
              Click <strong className="font-semibold text-[#0e0f11]">Create key</strong>, then copy it (it starts with{" "}
              <code className="rounded bg-[#f0f0f0] px-1 font-mono text-[12px] text-[#0e0f11]">rk_</code>).
            </li>
            <li>
              Paste it below and click <strong className="font-semibold text-[#0e0f11]">Connect Stripe</strong>.
            </li>
          </ol>
          <div className="mt-2.5 text-[#8a8a8a]">
            Read on everything lets your agents answer billing and payout
            questions and trace charges when something looks off.{" "}
            <strong className="font-semibold text-[#595959]">Disputes → Write</strong> is the one write scope: it lets the
            dispute agent submit evidence on your approval. Nothing here can move
            money or issue refunds. We verify the key with Stripe before saving;
            stored encrypted in Vault, never logged. You can revoke it anytime in
            your Stripe dashboard.
          </div>
        </div>

        <FormField label="Paste your restricted key">
          <FormSecretInput
            show={showSecret}
            onToggle={() => setShowSecret((v) => !v)}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            minLength={12}
            placeholder="rk_live_…"
          />
        </FormField>

        <div className="flex items-center gap-2.5">
          <FormPrimaryButton disabled={busy}>
            {busy ? "Verifying with Stripe…" : "Connect Stripe"}
          </FormPrimaryButton>
          <FormSecondaryButton onClick={onClose} disabled={busy}>
            Cancel
          </FormSecondaryButton>
        </div>

      </div>
    </FormPanel>
  );
}
