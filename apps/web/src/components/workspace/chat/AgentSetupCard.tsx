"use client";

import { useState } from "react";
import { startConnectFlow } from "@/app/connectors/ConnectButton";
import { SOCIAL_PLATFORM_LABEL } from "../settings/socialConnectorRows";

export function connectorLabel(slug: string): string {
  return (SOCIAL_PLATFORM_LABEL as Record<string, string>)[slug] ?? slug;
}

type VaultKey = {
  key: string;
  label: string;
  input: "text" | "email" | "password" | "url";
  required: boolean;
  placeholder?: string;
};

export type SetupEnvelope = {
  envelope_kind: "setup_required";
  missing_vault_keys: string[];
  missing_connectors: string[];
  missing_required_connectors?: string[];
  missing_optional_connectors?: string[];
  rationale: string;
  schema: {
    vault_keys: VaultKey[];
    connectors: string[];
    optional_connectors?: string[];
  };
};

export type AgentSetupCardProps = {
  agentSlug: string;
  envelope: SetupEnvelope;
  onSaved?: () => void;
};

export function AgentSetupCard(props: AgentSetupCardProps) {
  const seen = new Set<string>();
  const ordered: VaultKey[] = [];
  for (const v of props.envelope.schema.vault_keys) {
    if (v.required && !seen.has(v.key)) {
      ordered.push(v);
      seen.add(v.key);
    }
  }
  for (const v of props.envelope.schema.vault_keys) {
    if (!v.required && !seen.has(v.key)) {
      ordered.push(v);
      seen.add(v.key);
    }
  }

  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busyConnector, setBusyConnector] = useState<string | null>(null);

  const allRequiredFilled = ordered
    .filter((v) => v.required)
    .every((v) => (values[v.key] ?? "").trim().length > 0);

  const missingRequiredConnectors =
    props.envelope.missing_required_connectors ??
    props.envelope.missing_connectors;
  const missingOptionalConnectors =
    props.envelope.missing_optional_connectors ?? [];
  const canSave =
    allRequiredFilled && missingRequiredConnectors.length === 0;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const payloadVault: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        const trimmed = v.trim();
        if (trimmed.length > 0) payloadVault[k] = trimmed;
      }
      const r = await fetch(`/api/agents/${props.agentSlug}/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ vault: payloadVault, retry: true }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(body?.error?.message ?? `HTTP ${r.status}`);
        return;
      }
      setSubmitted(true);
      props.onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="mt-2 rounded-xl border border-ink/10 bg-white p-3 text-[13px] text-inkMuted">
        Setup saved. Running {props.agentSlug} now…
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-ink/10 bg-white p-4 shadow-sm">
      <div className="mb-2 text-[16px] font-semibold text-ink">
        ⚠ Setup needed before {props.agentSlug} can run
      </div>
      {props.envelope.rationale && (
        <p className="mb-3 text-[13px] leading-[1.55] text-inkMuted">
          {props.envelope.rationale}
        </p>
      )}
      <div className="space-y-3">
        {ordered.map((v) => (
          <label key={v.key} className="block">
            <span className="text-[14px] font-medium text-ink">
              {v.label}{" "}
              {v.required && (
                <span className="text-red-500" aria-label="required">
                  *
                </span>
              )}
            </span>
            <input
              type={v.input}
              placeholder={v.placeholder ?? ""}
              value={values[v.key] ?? ""}
              onChange={(e) =>
                setValues({ ...values, [v.key]: e.target.value })
              }
              className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1 text-[13px] text-ink"
              autoComplete={v.input === "password" ? "new-password" : "off"}
            />
          </label>
        ))}
        {missingRequiredConnectors.length > 0 && (
          <div className="rounded-md bg-bone p-2 text-[13px]">
            <div className="mb-1 text-ink font-medium">Required:</div>
            <div className="flex flex-wrap gap-2">
              {missingRequiredConnectors.map((c) => (
                <button
                  key={c}
                  type="button"
                  disabled={busyConnector === c}
                  onClick={async () => {
                    setBusyConnector(c);
                    setError(null);
                    try {
                      await startConnectFlow(c);
                    } catch (e) {
                      setError(`Connect ${connectorLabel(c)} failed: ${(e as Error).message}`);
                      setBusyConnector(null);
                    }
                  }}
                  className="bg-transparent border-0 p-0 underline text-ink disabled:opacity-50 cursor-pointer"
                >
                  {busyConnector === c ? `Connecting ${connectorLabel(c)}…` : `Connect ${connectorLabel(c)} ↗`}
                </button>
              ))}
            </div>
          </div>
        )}
        {missingOptionalConnectors.length > 0 && (
          <div className="rounded-md bg-bone/50 p-2 text-[13px]">
            <div className="mb-1 text-ink/70">
              Recommended <span className="text-ink/50">(optional)</span>:
            </div>
            <div className="flex flex-wrap gap-2">
              {missingOptionalConnectors.map((c) => (
                <button
                  key={c}
                  type="button"
                  disabled={busyConnector === c}
                  onClick={async () => {
                    setBusyConnector(c);
                    setError(null);
                    try {
                      await startConnectFlow(c);
                    } catch (e) {
                      setError(`Connect ${connectorLabel(c)} failed: ${(e as Error).message}`);
                      setBusyConnector(null);
                    }
                  }}
                  className="bg-transparent border-0 p-0 underline text-ink/80 disabled:opacity-50 cursor-pointer"
                >
                  {busyConnector === c ? `Connecting ${connectorLabel(c)}…` : `Connect ${connectorLabel(c)} ↗`}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="mt-2 rounded-md bg-red-50 px-2 py-1 text-[12px] text-red-700"
        >
          {error}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !canSave}
          className="rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
        >
          {submitting
            ? "Saving + running…"
            : !allRequiredFilled
              ? "Save and run"
              : missingRequiredConnectors.length > 0
                ? "Connect required tools above first"
                : "Save and run"}
        </button>
      </div>
    </div>
  );
}
