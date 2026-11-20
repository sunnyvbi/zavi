"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { SENDGRID_CONNECTED_EVENT } from "@/lib/workspace/emailCampaignSettingsApi";
import { FormPanel, FormField, FormSecretInput, FormNote, FormPrimaryButton, FormSecondaryButton } from "./formControls";

export { SENDGRID_CONNECTED_EVENT };

export const SENDGRID_API_KEYS_URL = "https://app.sendgrid.com/settings/api_keys";

export type SendgridPermission = { group: string; label: string; passed: boolean };
type ConnectResult = { campaign_ready: boolean; permissions: SendgridPermission[]; message?: string };
type ErrBody = { error?: { message?: string } };

export function SendgridPermissionList({ result }: { result: ConnectResult }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[14px] font-semibold text-ink">
        {result.campaign_ready ? "SendGrid is connected" : "Needs more permissions for campaigns"}
      </div>
      <p className="text-[16px] leading-[1.5] text-inkMuted">
        {result.campaign_ready
          ? "Every permission email campaigns need passed."
          : "One-to-one email works with this key. To send campaigns, add the missing permissions to the key in SendGrid (Settings, API Keys) and paste it again."}
      </p>
      <ul className="mt-1 grid gap-1.5" aria-label="SendGrid permissions">
        {result.permissions.map((p) => (
          <li key={p.group} className="flex items-center gap-2 text-[14px] text-ink">
            <span
              aria-hidden
              className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[12px] font-bold ${
                p.passed ? "bg-successBg text-success" : "bg-dangerBg text-danger"
              }`}
            >
              {p.passed ? "✓" : "✕"}
            </span>
            <span>{p.label}</span>
            <span className="sr-only">{p.passed ? "passed" : "missing"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SendgridKeyForm({ onClose, onConnected }: { onClose: () => void; onConnected?: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ConnectResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/connectors/email", { method: "POST", body: JSON.stringify({ api_key: apiKey.trim() }) });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const parsed = (await res.json().catch(() => ({}))) as ErrBody & Partial<ConnectResult>;
      if (!res.ok || parsed.error) throw new Error(parsed.error?.message ?? `HTTP ${res.status}`);
      setApiKey("");
      setDone({ campaign_ready: parsed.campaign_ready === true, permissions: parsed.permissions ?? [] });
      onConnected?.();
      window.dispatchEvent(new Event(SENDGRID_CONNECTED_EVENT));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <FormPanel>
        <SendgridPermissionList result={done} />
        <div className="mt-3">
          <FormPrimaryButton
            type="button"
            onClick={() => {
              onClose();
            }}
          >
            Done
          </FormPrimaryButton>
        </div>
      </FormPanel>
    );
  }

  return (
    <FormPanel onSubmit={onSubmit}>
      <div className="grid gap-4">
        <div className="rounded-[12px] border border-rule bg-creamDeep px-4 py-3.5 text-[13px] leading-[18px] text-inkMuted">
          <div className="mb-2 text-[16px] font-semibold text-ink">How to connect SendGrid (~2 min)</div>
          <ol className="list-decimal space-y-2 pl-4">
            <li>
              In SendGrid, open{" "}
              <a href={SENDGRID_API_KEYS_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-ink underline">
                Settings → API Keys
              </a>{" "}
              and create a key with <strong>Custom Access</strong>.
            </li>
            <li>
              Give it <strong>Mail Send</strong>, <strong>Marketing</strong>, <strong>Stats</strong> (read),{" "}
              <strong>Sender Verification</strong> (read) and <strong>Suppressions</strong> (read). Mail Send alone works for
              one-to-one email; the rest are for campaigns.
            </li>
            <li>Paste it below. Zavi checks every permission before saving.</li>
          </ol>
        </div>

        <FormField label="API key">
          <FormSecretInput
            show={showSecret}
            onToggle={() => setShowSecret((v) => !v)}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setError(null);
            }}
            placeholder="SG.…"
            autoComplete="off"
            required
          />
        </FormField>

        <FormNote>Nothing is sent from this form. Every campaign waits for an owner or admin to approve it, unless you turn on Send without asking in Autopilot.</FormNote>

        {error && (
          <div role="alert" className="rounded-[12px] border border-danger/30 bg-dangerBg px-4 py-3 text-[13px] leading-[18px] text-danger">
            <div className="font-semibold">Couldn’t connect SendGrid</div>
            <div className="mt-1 whitespace-pre-line break-words">{error}</div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <FormPrimaryButton type="submit" disabled={busy || apiKey.trim().length < 20}>
            {busy ? "Checking…" : "Connect"}
          </FormPrimaryButton>
          <FormSecondaryButton onClick={onClose}>Cancel</FormSecondaryButton>
        </div>
      </div>
    </FormPanel>
  );
}
