"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { showConnectorError } from "@/components/workspace/settings/connectorErrorDialog";
import {
  FormPanel,
  FormField,
  FormInput,
  FormNote,
  FormPrimaryButton,
  FormSecondaryButton,
} from "@/components/workspace/settings/formControls";

type ErrBody = { error?: { message?: string } };

export function AppleAdsForm({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected?: () => void;
}) {
  const [clientId, setClientId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ label: string; ad_accounts: number } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await apiFetch("/api/connectors/apple_ads/connect", {
        method: "POST",
        body: JSON.stringify({
          client_id: clientId.trim(),
          team_id: teamId.trim(),
          key_id: keyId.trim(),
          private_key_pem: privateKeyPem.trim(),
        }),
      });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const parsed = (await res.json().catch(() => ({}))) as ErrBody & {
        ok?: boolean;
        label?: string;
        ad_accounts?: number;
      };
      if (!res.ok || parsed.error) {
        throw new Error(parsed.error?.message ?? `HTTP ${res.status}`);
      }
      setDone({ label: parsed.label ?? "Apple Search Ads", ad_accounts: parsed.ad_accounts ?? 0 });
    } catch (err) {
      showConnectorError({
        title: "Couldn’t connect Apple Search Ads",
        message: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <FormPanel>
        <div className="flex flex-col gap-2">
          <div className="text-[14px] font-semibold text-[#0e0f11]">Connected to Apple Search Ads</div>
          <p className="text-[16px] leading-[19px] text-[#595959]">
            {done.ad_accounts > 0 ? (
              <>
                Reading from <strong className="font-semibold text-[#0e0f11]">{done.label}</strong>
                {done.ad_accounts > 1 ? ` (${done.ad_accounts} ad accounts)` : ""}. Spend now counts
                against your ad budget.
              </>
            ) : (
              <>
                Credentials saved, but this API user can reach no ad account yet. Grant it account
                access in Apple Search Ads (Account Settings → User Management), then spend can be
                read and counted.
              </>
            )}
          </p>
          <div>
            <FormPrimaryButton
              type="button"
              onClick={() => {
                onConnected?.();
                onClose();
              }}
            >
              Done
            </FormPrimaryButton>
          </div>
        </div>
      </FormPanel>
    );
  }

  return (
    <FormPanel>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <FormField label="Client ID">
          <FormInput
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            required
          />
        </FormField>
        <FormField label="Team ID">
          <FormInput value={teamId} onChange={(e) => setTeamId(e.target.value)} required />
        </FormField>
        <FormField label="Key ID">
          <FormInput value={keyId} onChange={(e) => setKeyId(e.target.value)} required />
        </FormField>
        <FormField label="Private key (.p8 contents)">
          {}
          <textarea
            data-replay-mask=""
            value={privateKeyPem}
            onChange={(e) => setPrivateKeyPem(e.target.value)}
            placeholder={"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"}
            required
            rows={5}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-[10px] bg-[#f0f0f0] px-3 py-2 font-mono text-[12.5px] leading-[1.45] text-[#0e0f11] outline-none placeholder:text-[#a3a3a3] focus:ring-2 focus:ring-[#0e0f11]/20"
          />
        </FormField>
        <FormNote>
          From the Apple Search Ads console: Account Settings → API. Zavi validates the
          credentials by reading your ad accounts before saving, and only reads; it never
          changes your campaigns.
        </FormNote>
        <div className="flex items-center gap-2">
          <FormPrimaryButton type="submit" disabled={busy}>
            {busy ? "Checking…" : "Connect"}
          </FormPrimaryButton>
          <FormSecondaryButton onClick={onClose}>
            Cancel
          </FormSecondaryButton>
        </div>
      </form>
    </FormPanel>
  );
}
