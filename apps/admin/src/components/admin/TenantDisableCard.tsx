"use client";

import { useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type DisabledState = { at: string | null; reason: string | null };

type Result = { changed: boolean; disabled_at: string | null; warnings: string[] };

export async function setTenantDisabled(tenantId: string, disabled: boolean, reason: string): Promise<Result> {
  const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/disabled`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(disabled ? { disabled, reason } : { disabled, reason: reason || undefined }),
  });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
  return { changed: !!r.changed, disabled_at: r.disabled_at ?? null, warnings: Array.isArray(r.warnings) ? r.warnings : [] };
}

const DISABLE_EFFECTS = [
  "Sign-in is blocked for every member, and open sessions stop working.",
  "Agents, Autopilot and all scheduled work stop. Connector credentials stop being handed out.",
  "Live ads keep running in the customer's own ad accounts, but Zavi stops touching them.",
  "A live Stripe plan is set to cancel at the end of the current period. No refund.",
  "The owner gets an email saying the workspace is disabled.",
];

const ENABLE_EFFECTS = [
  "Members can sign in again and scheduled work picks up.",
  "If Zavi set the Stripe plan to cancel, that is undone (only while the period has not ended).",
  "The owner gets an email saying the workspace is back on.",
];

function TenantDisableDialog({
  tenantId,
  workspaceName,
  disabling,
  open,
  onClose,
  onDone,
}: {
  tenantId: string;
  workspaceName: string;
  disabling: boolean;
  open: boolean;
  onClose: () => void;
  onDone: (next: DisabledState) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const reasonOk = !disabling || reason.trim().length >= 3;

  function close() {
    if (busy) return;
    setReason("");
    setError(null);
    setWarnings(null);
    onClose();
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await setTenantDisabled(tenantId, disabling, reason.trim());
      onDone(disabling ? { at: r.disabled_at ?? new Date().toISOString(), reason: reason.trim() } : { at: null, reason: null });
      const notes = r.changed ? r.warnings : ["Nothing changed: the workspace was already in this state.", ...r.warnings];
      if (notes.length > 0) setWarnings(notes);
      else {
        setBusy(false);
        setReason("");
        onClose();
        return;
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  const effects = disabling ? DISABLE_EFFECTS : ENABLE_EFFECTS;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto rounded-2xl shadow-2xl">
        <DialogHeader>
          <DialogTitle>{disabling ? "Disable workspace" : "Enable workspace"}</DialogTitle>
          <DialogDescription>
            {workspaceName}. {disabling ? "This is reversible." : "This turns it back on."}
          </DialogDescription>
        </DialogHeader>

        {warnings ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-800">
              {disabling ? "Disabled" : "Enabled"}, with notes:
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <div>
              <p className="mb-1 text-sm font-medium text-slate-800">What happens</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                {effects.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
              {disabling && (
                <p className="mt-2 text-xs text-slate-500">
                  Published sites are not taken offline by this action.
                </p>
              )}
            </div>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-800">
                Reason{disabling ? " (required, staff only, not sent to the customer)" : " (optional)"}
              </span>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder={disabling ? "e.g. Customer asked to close their account" : ""}
              />
            </label>
            {error && <p className="text-sm text-rose-700">{error}</p>}
          </>
        )}

        <DialogFooter>
          {warnings ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant={disabling ? "destructive" : "default"}
                onClick={confirm}
                disabled={busy || !reasonOk}
              >
                {busy ? "Saving…" : disabling ? "Disable workspace" : "Enable workspace"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TenantDisableCard({
  tenantId,
  workspaceName,
  state,
  onChange,
}: {
  tenantId: string;
  workspaceName: string;
  state: DisabledState;
  onChange: (next: DisabledState) => void;
}) {
  const [open, setOpen] = useState(false);
  const disabled = !!state.at;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className={`rounded px-1.5 py-0.5 text-xs ${disabled ? "bg-rose-100 text-rose-800" : "bg-emerald-50 text-emerald-800"}`}>
        {disabled ? "disabled" : "active"}
      </span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50"
      >
        {disabled ? "Enable workspace" : "Disable workspace"}
      </button>
      <TenantDisableDialog
        tenantId={tenantId}
        workspaceName={workspaceName}
        disabling={!disabled}
        open={open}
        onClose={() => setOpen(false)}
        onDone={onChange}
      />
    </span>
  );
}

export function TenantDisabledBanner({
  tenantId,
  workspaceName,
  state,
  onChange,
}: {
  tenantId: string;
  workspaceName: string;
  state: DisabledState;
  onChange: (next: DisabledState) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!state.at) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
      <span>
        <strong>Disabled {new Date(state.at).toLocaleDateString()}</strong>
        {state.reason ? ` · ${state.reason}` : ""}
      </span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-rose-400 bg-white px-2 py-0.5 text-xs font-medium text-rose-800 hover:bg-rose-100"
      >
        Enable workspace
      </button>
      <TenantDisableDialog
        tenantId={tenantId}
        workspaceName={workspaceName}
        disabling={false}
        open={open}
        onClose={() => setOpen(false)}
        onDone={onChange}
      />
    </div>
  );
}
