"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { showConnectorError } from "@/components/workspace/settings/connectorErrorDialog";
import {
  FormPanel,
  FormField,
  FormSecretInput,
  FormNote,
  FormPrimaryButton,
  FormSecondaryButton,
} from "@/components/workspace/settings/formControls";

type ErrBody = { error?: { message?: string } };

export function HiggsfieldForm({ onClose }: { onClose: () => void }) {
  const [accessToken, setAccessToken] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ balance: string } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await apiFetch("/api/connectors/higgsfield", {
        method: "POST",
        body: JSON.stringify({ access_token: accessToken }),
      });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const parsed = (await res.json().catch(() => ({}))) as ErrBody & { balance?: string };
      if (!res.ok || parsed.error) {
        throw new Error(parsed.error?.message ?? `HTTP ${res.status}`);
      }
      setDone({ balance: parsed.balance ?? "" });
    } catch (err) {
      showConnectorError({
        title: "Couldn’t connect Higgsfield",
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
          <div className="text-[14px] font-semibold text-[#0e0f11]">Connected to Higgsfield</div>
          <p className="text-[16px] leading-[19px] text-[#595959]">
            {done.balance ? (
              <>
                Your account reports{" "}
                <strong className="font-semibold text-[#0e0f11]">{done.balance}</strong>. The
                Generated video channel can now stage creator videos for your approval.
              </>
            ) : (
              <>The Generated video channel can now stage creator videos for your approval.</>
            )}
          </p>
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
        <div className="rounded-[12px] border border-[#f0f0f0] bg-[#f9f9f9] px-4 py-3.5 text-[13px] leading-[18px] text-[#595959]">
          <div className="mb-2 text-[16px] font-semibold text-[#0e0f11]">
            Already have a token?
          </div>
          <ol className="list-decimal space-y-2 pl-4">
            <li>
              Most people should use <strong>Connect</strong> on the Higgsfield tile
              instead. It signs you in directly and needs nothing pasted.
            </li>
            <li>
              This field is only for an access token you already hold. Higgsfield
              does not issue one from account settings, so there is nothing to
              create here.
            </li>
            <li>We check whatever you paste against your account before saving it.</li>
          </ol>
        </div>

        <FormField label="Access token">
          <FormSecretInput
            show={showSecret}
            onToggle={() => setShowSecret((v) => !v)}
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder="Paste your Higgsfield access token"
            autoComplete="off"
            required
          />
        </FormField>

        <FormNote>
          Generation runs on <strong>your</strong> Higgsfield account and spends your credits, and
          only ever after you approve a specific video. Zavi never generates on its own.
        </FormNote>

        <div className="flex items-center gap-2">
          <FormPrimaryButton type="submit" disabled={busy || accessToken.length < 8}>
            {busy ? "Checking…" : "Connect"}
          </FormPrimaryButton>
          <FormSecondaryButton onClick={onClose}>Cancel</FormSecondaryButton>
        </div>
      </div>
    </FormPanel>
  );
}
