"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { showConnectorError } from "@/components/workspace/settings/connectorErrorDialog";
import {
  FormPanel,
  FormField,
  FormInput,
  FormSecretInput,
  FormNote,
  FormPrimaryButton,
  FormSecondaryButton,
} from "@/components/workspace/settings/formControls";

type Project = { id: string; slug: string; name: string };
type ErrBody = { error?: { message?: string } };

export function SentryForm({ onClose }: { onClose: () => void }) {
  const [authToken, setAuthToken] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ org: string; projects: Project[] } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await apiFetch("/api/connectors/sentry", {
        method: "POST",
        body: JSON.stringify({ auth_token: authToken, org_slug: orgSlug.trim() }),
      });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const parsed = (await res.json().catch(() => ({}))) as ErrBody & {
        org_slug?: string;
        projects?: Project[];
      };
      if (!res.ok || parsed.error) {
        throw new Error(parsed.error?.message ?? `HTTP ${res.status}`);
      }
      setDone({ org: parsed.org_slug ?? orgSlug, projects: parsed.projects ?? [] });
    } catch (err) {
      showConnectorError({
        title: "Couldn’t connect Sentry",
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
          <div className="text-[14px] font-semibold text-[#0e0f11]">Connected to Sentry</div>
          <p className="text-[16px] leading-[19px] text-[#595959]">
            Reading from <strong className="font-semibold text-[#0e0f11]">{done.org}</strong>
            {done.projects.length > 0 && (
              <>
                {" "}
                ({done.projects.length} project{done.projects.length === 1 ? "" : "s"} visible). Your
                agents can now read issues and error volume when they investigate a regression.
              </>
            )}
            {done.projects.length === 0 && (
              <>. Your agents can now read issues when they investigate a regression.</>
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
            How to connect Sentry (~1 min)
          </div>
          <ol className="list-decimal space-y-2 pl-4">
            <li>
              In Sentry, open <strong>Settings → Auth Tokens</strong> and create an organization
              token.
            </li>
            <li>
              Give it <strong>org:read</strong>, <strong>project:read</strong> and{" "}
              <strong>event:read</strong>. Those three are all we use; this connector never writes
              to Sentry.
            </li>
            <li>
              Paste it below with your organization slug (the part after{" "}
              <strong>sentry.io/organizations/</strong>).
            </li>
          </ol>
        </div>

        <FormField label="Auth token">
          <FormSecretInput
            show={showSecret}
            onToggle={() => setShowSecret((v) => !v)}
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder="sntrys_…"
            autoComplete="off"
            required
          />
        </FormField>

        <FormField label="Organization slug">
          <FormInput
            value={orgSlug}
            onChange={(e) => setOrgSlug(e.target.value)}
            placeholder="acme-inc"
            autoComplete="off"
            required
          />
        </FormField>

        <FormNote>
          Read-only. Agents read issues, events and error volume; nothing is created, resolved or
          deleted in your Sentry.
        </FormNote>

        <div className="flex items-center gap-2">
          <FormPrimaryButton type="submit" disabled={busy || authToken.length < 10 || !orgSlug.trim()}>
            {busy ? "Checking…" : "Connect"}
          </FormPrimaryButton>
          <FormSecondaryButton onClick={onClose}>Cancel</FormSecondaryButton>
        </div>
      </div>
    </FormPanel>
  );
}
