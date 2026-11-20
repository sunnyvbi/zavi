"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { showConnectorError } from "@/components/workspace/settings/connectorErrorDialog";
import {
  FormPanel,
  FormField,
  FormSelect,
  FormSecretInput,
  FormNote,
  FormPrimaryButton,
  FormSecondaryButton,
} from "@/components/workspace/settings/formControls";

type DbType = "postgres" | "mongodb" | "mysql" | "dynamodb";

type ConnectResult = {
  ok?: boolean;
  type?: string;
  write_capable?: "true" | "false" | "unknown";
  discovery?: string;
  discovery_error?: string;
  error?: { code?: string; message?: string };
};

export function probeFailureReason(raw: string | undefined): string | null {
  const s = (raw ?? "").toLowerCase();
  if (/password|authentication|auth failed|access denied|not authorized|unrecognizedclient|security token|signature/.test(s)) {
    return "The username or password was rejected.";
  }
  if (/does not exist|unknown database/.test(s)) {
    return "That database name wasn't found.";
  }
  if (/enotfound|getaddrinfo/.test(s)) {
    return "That host name couldn't be found.";
  }
  if (/timed out|timeout|etimedout/.test(s)) {
    return "The connection timed out.";
  }
  if (/econnrefused|aggregateerror|refused/.test(s)) {
    return "Nothing answered at that host and port.";
  }
  return null;
}

export function OperatorDbConnectButton({
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

export function OperatorDbForm({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected?: () => void;
}) {
  const [type, setType] = useState<DbType>("postgres");
  const [connectionString, setConnectionString] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectResult | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    setBusy(true);
    try {
      const res = await apiFetch("/api/connectors/operator-db", {
        method: "POST",
        body: JSON.stringify({ type, connection_string: connectionString }),
      });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const body = (await res.json().catch(() => ({}))) as ConnectResult;
      if (res.status >= 500 || (body.error && !body.discovery_error)) {
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      setResult(body);
      if (body.ok) onConnected?.();
    } catch (e) {
      showConnectorError({ title: "Couldn’t save", message: (e as Error).message });
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
            Connected. Credentials verified.
          </div>
          <p className="text-[16px] leading-[19px] text-[#595959]">
            We reached your database. Reading its structure now. This runs in the
            background and your tables appear in the Data tab once it finishes.
          </p>
          {result.write_capable === "true" && (
            <div className="rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-[17px] text-amber-700">
              This credential can write. Zavi only ever reads, but a read-only
              DB user is recommended.
            </div>
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

  if (result && result.ok === false) {
    const reason = probeFailureReason(result.discovery_error);
    return (
      <FormPanel>
        <div className="flex flex-col gap-2.5">
          <div className="text-[14px] font-semibold text-[#0e0f11]">
            Couldn&apos;t connect to your database
          </div>
          <div className="rounded-[10px] border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] leading-[17px] text-rose-700">
            {reason ? `${reason} ` : ""}Check the host, port and credentials, then
            try again. Nothing was saved.
          </div>
          <div className="flex items-center gap-2.5">
            <FormPrimaryButton type="button" onClick={() => setResult(null)}>
              Try again
            </FormPrimaryButton>
            <FormSecondaryButton onClick={onClose}>Close</FormSecondaryButton>
          </div>
        </div>
      </FormPanel>
    );
  }

  return (
    <FormPanel onSubmit={onSubmit}>
      <div className="grid gap-4">
        <FormField label="DB type">
          <FormSelect
            value={type}
            onChange={(e) => setType(e.target.value as DbType)}
          >
            <option value="postgres">Postgres</option>
            <option value="mongodb">MongoDB</option>
            <option value="mysql">MySQL</option>
            <option value="dynamodb">DynamoDB</option>
          </FormSelect>
        </FormField>

        <FormField
          label="Connection string"
          hint={
            <>
              Stored encrypted in Vault. Never logged. Use a{" "}
              <strong className="font-semibold text-[#595959]">read-only</strong> DB
              user. Zavi only reads; write-capable connections may be flagged.
            </>
          }
        >
          <FormSecretInput
            show={showSecret}
            onToggle={() => setShowSecret((v) => !v)}
            value={connectionString}
            onChange={(e) => setConnectionString(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            minLength={8}
            placeholder={
              type === "postgres"
                ? "postgres://user:pass@host:5432/db"
                : type === "mongodb"
                  ? "mongodb://user:pass@host:27017/db"
                  : type === "mysql"
                    ? "mysql://user:pass@host:3306/db"
                    : "dynamodb://access_key:secret_key@us-east-1"
            }
          />
        </FormField>

        <FormNote>
          No setup needed. Zavi reads your tables automatically. Some features
          may ask you to confirm a few fields, like where bookings live.
        </FormNote>

        <div className="flex items-center gap-2.5">
          <FormPrimaryButton disabled={busy}>
            {busy ? "Detecting schema…" : "Connect & detect schema"}
          </FormPrimaryButton>
          <FormSecondaryButton onClick={onClose} disabled={busy}>
            Cancel
          </FormSecondaryButton>
        </div>
      </div>
    </FormPanel>
  );
}
