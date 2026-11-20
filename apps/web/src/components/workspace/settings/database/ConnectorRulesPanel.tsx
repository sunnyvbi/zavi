"use client";

import { useEffect, useState } from "react";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { FormPanel, FormPrimaryButton } from "../formControls";
import { showConnectorError } from "../connectorErrorDialog";
import { getConnector, removeConnector, type ConnectorStatus } from "./databaseApi";
import { CodeBlock, OkRow } from "./DatabaseSetupPanel";
import { whatCanLeaveText } from "./databaseTile";

const dangerBtn =
  "inline-flex h-10 cursor-pointer items-center justify-center rounded-cta border border-rose-200 bg-white px-4 text-[16px] font-semibold leading-[20px] text-rose-700 hover:bg-rose-50 disabled:opacity-50";

function LockNote() {
  return (
    <p className="flex items-center gap-1.5 text-[12px] text-[#8a8a8a]">
      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      Only owners and admins can remove the connector.
    </p>
  );
}

export async function confirmAndRemoveConnector(): Promise<string | null> {
  const ok = await confirmAction({
    title: "Remove the Zavi Connector?",
    description: "Its token stops working now and agents stop reading your database. Your privacy settings and data access log are kept.",
    confirmLabel: "Remove connector",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!ok) return null;
  try {
    return (await removeConnector()).removal_command;
  } catch (e) {
    showConnectorError({ title: "Couldn’t remove the connector", message: (e as Error).message });
    return null;
  }
}

export function ConnectorRemovedPanel({ removalCommand, onDone }: { removalCommand: string; onDone: () => void }) {
  return (
    <FormPanel>
      <div className="flex flex-col gap-3">
        <OkRow>Connector removed. Its token no longer works.</OkRow>
        <div className="grid gap-2">
          <span className="text-[13px] font-medium leading-[18px] text-[#595959]">Last step, on your server</span>
          <p className="text-[14px] text-[#595959]">This stops the connector and deletes its local data, including the saved password.</p>
          <CodeBlock code={removalCommand} label="On the connector machine" />
        </div>
        <div>
          <FormPrimaryButton type="button" onClick={onDone}>
            Done
          </FormPrimaryButton>
        </div>
      </div>
    </FormPanel>
  );
}

export function ConnectorRulesPanel({ onDone, onRemoved }: { onDone: () => void; onRemoved: (removalCommand: string) => void }) {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getConnector()
      .then((s) => live && setStatus(s))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, []);

  const machine = status && status.paired ? status.machine ?? "your server" : "your server";
  const rules = status && status.paired ? status.rules ?? null : null;

  return (
    <FormPanel>
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-[16px] font-semibold text-[#0e0f11]">Rules (read-only)</p>
          <p className="mt-0.5 text-[14px] leading-[20px] text-[#595959]">
            Zavi cannot change these. To change them, open localhost:7801/rules on {machine}.
          </p>
        </div>
        {error && <p className="text-[14px] text-rose-700">Couldn’t load the connector. Try again in a moment.</p>}
        {!error && status === null && <p className="text-[14px] text-[#8a8a8a]">Loading…</p>}
        {status && !status.paired && <p className="text-[14px] text-[#595959]">No connector is paired.</p>}
        {status && status.paired && (
          <div className="rounded-[12px] border border-[#f0f0f0] px-3.5 py-3">
            <p className="mb-2 text-[13px] font-medium leading-[18px] text-[#595959]">Your rules, as your connector reports them</p>
            {rules ? (
              <dl className="grid gap-x-6 gap-y-1.5 text-[14px] sm:grid-cols-[150px_1fr]">
                <dt className="text-[#8c8c8c]">Allowed</dt>
                <dd className="break-words text-[#1f1f1f]">{rules.allowed_tables.length ? rules.allowed_tables.join(", ") : "Nothing yet"}</dd>
                <dt className="text-[#8c8c8c]">Blocked</dt>
                <dd className="break-words text-[#1f1f1f]">{rules.blocked_fields.length ? rules.blocked_fields.join(", ") : "Nothing"}</dd>
                <dt className="text-[#8c8c8c]">What can leave</dt>
                <dd className="text-[#1f1f1f]">{whatCanLeaveText(rules)}</dd>
              </dl>
            ) : (
              <p className="text-[14px] text-[#595959]">
                Your connector has not reported rules yet. On {machine}, open http://localhost:7801 to add your database and save rules.
              </p>
            )}
          </div>
        )}
        <LockNote />
        <div className="flex items-center gap-2.5">
          <FormPrimaryButton type="button" onClick={onDone}>
            Done
          </FormPrimaryButton>
          <button
            type="button"
            className={dangerBtn}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const cmd = await confirmAndRemoveConnector();
              setBusy(false);
              if (cmd !== null) onRemoved(cmd);
            }}
          >
            Remove connector
          </button>
        </div>
      </div>
    </FormPanel>
  );
}
