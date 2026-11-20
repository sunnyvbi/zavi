"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { showConnectorError } from "@/components/workspace/settings/connectorErrorDialog";
import {
  FormPanel,
  FormField,
  FormInput,
  FormSelect,
  FormSecretInput,
  FormNote,
  FormPrimaryButton,
  FormSecondaryButton,
} from "@/components/workspace/settings/formControls";

type SocialPlatform = "linkedin" | "instagram" | "tiktok";

type SocialConnection = {
  platform: SocialPlatform;
  handle: string;
  status: string;
};

type ConnectResult = {
  ok?: boolean;
  platform?: string;
  handle?: string;
  error?: { code?: string; message?: string };
};

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
  tiktok: "TikTok",
};

export function SocialConnectButton({
  connected,
  open,
  onToggle,
}: {
  connected: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const label = open ? "Cancel" : connected ? "Reconnect" : "Connect";
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex h-10 shrink-0 items-center justify-center whitespace-nowrap rounded-cta border border-[#f0f0f0] bg-white px-4 text-[16px] font-semibold leading-[20px] tracking-[0.01px] text-[#1f1f1f] transition-colors hover:border-[#e0e0e0] hover:bg-[#fafafa]"
    >
      {label}
    </button>
  );
}

export function SocialConnectForm({ onClose }: { onClose: () => void }) {
  const [platform, setPlatform] = useState<SocialPlatform>("linkedin");
  const [handle, setHandle] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectResult | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    setBusy(true);
    try {
      const res = await apiFetch("/api/connectors/social", {
        method: "POST",
        body: JSON.stringify({ platform, handle, username, password }),
      });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const body = (await res.json().catch(() => ({}))) as ConnectResult;
      if (res.status === 503 || body.error?.code === "feature_flag_off") {
        throw new Error("Social publishing isn't enabled for this workspace yet.");
      }
      if (res.status >= 400 || body.error) {
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      setResult(body);
    } catch (e) {
      showConnectorError({ title: "Couldn’t connect", message: (e as Error).message });
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
            Connected: {PLATFORM_LABELS[(result.platform as SocialPlatform) ?? platform]}
          </div>
          <p className="text-[16px] leading-[19px] text-[#595959]">
            Account <strong className="font-semibold text-[#0e0f11]">{result.handle ?? handle}</strong> is
            connected. Only your agent runs will use it.
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
        <FormField label="Platform">
          <FormSelect
            value={platform}
            onChange={(e) => setPlatform(e.target.value as SocialPlatform)}
          >
            <option value="linkedin">LinkedIn</option>
            <option value="instagram">Instagram</option>
            <option value="tiktok">TikTok</option>
          </FormSelect>
        </FormField>

        <FormField label="Profile / page name">
          <FormInput
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            minLength={1}
            placeholder="e.g. acme-co"
          />
        </FormField>

        <FormField label="Username / email">
          <FormInput
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            minLength={1}
            placeholder="login@company.com"
          />
        </FormField>

        <FormField label="Password">
          <FormSecretInput
            show={showSecret}
            onToggle={() => setShowSecret((v) => !v)}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            minLength={1}
            placeholder="account password"
          />
        </FormField>

        {}
        <FormNote>
          This stores the account password in your company workspace. Only your
          own agent runs use this login; teammates can&apos;t post from your
          account.
        </FormNote>

        <div className="flex items-center gap-2.5">
          <FormPrimaryButton disabled={busy}>
            {busy ? "Connecting…" : "Connect account"}
          </FormPrimaryButton>
          <FormSecondaryButton onClick={onClose} disabled={busy}>
            Cancel
          </FormSecondaryButton>
        </div>
      </div>
    </FormPanel>
  );
}

export function SocialConnectionsList() {
  const [conns, setConns] = useState<SocialConnection[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/connectors/social");
      if (!res.ok) {
        setConns([]);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        connections?: SocialConnection[];
      };
      setConns(body.connections ?? []);
    } catch {
      setConns([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function disconnect(c: SocialConnection) {
    const key = `${c.platform}:${c.handle}`;
    setBusy(key);
    try {
      await apiFetch("/api/connectors/social/disconnect", {
        method: "POST",
        body: JSON.stringify({ platform: c.platform, handle: c.handle }),
      });
      await load();
    } catch {
    } finally {
      setBusy(null);
    }
  }

  if (!conns || conns.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {conns.map((c) => {
        const key = `${c.platform}:${c.handle}`;
        return (
          <div
            key={key}
            className="flex items-center justify-between gap-2 rounded-[10px] border border-[#f0f0f0] bg-white px-3 py-2 text-[13px]"
          >
            <span className="min-w-0 truncate">
              <span className="font-semibold text-[#0e0f11]">
                {PLATFORM_LABELS[c.platform] ?? c.platform}
              </span>
              <span className="text-[#595959]"> · {c.handle}</span>
              {c.status !== "connected" && (
                <span className="text-[#595959]"> · {c.status}</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => void disconnect(c)}
              disabled={busy === key}
              className="shrink-0 rounded-cta border border-rose-200 bg-white px-2.5 py-1 text-[12px] font-medium text-rose-700 transition-colors hover:border-rose-300 hover:bg-rose-50 disabled:opacity-50"
            >
              {busy === key ? "…" : "Disconnect"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
