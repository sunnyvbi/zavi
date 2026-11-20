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

export function FigmaForm({ onClose }: { onClose: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ handle: string | null } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await apiFetch("/api/connectors/figma", {
        method: "POST",
        body: JSON.stringify({ api_key: apiKey }),
      });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const parsed = (await res.json().catch(() => ({}))) as ErrBody & { handle?: string | null };
      if (!res.ok || parsed.error) {
        throw new Error(parsed.error?.message ?? `HTTP ${res.status}`);
      }
      setDone({ handle: parsed.handle ?? null });
    } catch (err) {
      showConnectorError({
        title: "Couldn’t connect Figma",
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
          <div className="text-[14px] font-semibold text-[#0e0f11]">Connected to Figma</div>
          <p className="text-[16px] leading-[19px] text-[#595959]">
            {done.handle ? (
              <>
                Connected as{" "}
                <strong className="font-semibold text-[#0e0f11]">{done.handle}</strong>. Your agents
                can now read the files and projects this account can open.
              </>
            ) : (
              <>Your agents can now read the files and projects this account can open.</>
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
            How to connect Figma (~1 min)
          </div>
          <ol className="list-decimal space-y-2 pl-4">
            <li>
              In Figma, open <strong>Settings → Security → Personal access tokens</strong> and
              generate a token.
            </li>
            <li>
              Grant <strong>current_user:read</strong>, <strong>file_content:read</strong> and{" "}
              <strong>projects:read</strong>. Those three are all we use.
            </li>
            <li>Paste it below. We check it against your account before saving it.</li>
          </ol>
        </div>

        <FormField label="Personal access token">
          <FormSecretInput
            show={showSecret}
            onToggle={() => setShowSecret((v) => !v)}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="figd_…"
            autoComplete="off"
            required
          />
        </FormField>

        <FormNote>
          Read-only. Agents read file contents and project lists; nothing is edited, commented on or
          published in your Figma.
        </FormNote>

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
