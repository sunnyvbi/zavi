"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, Copy } from "lucide-react";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/toast";
import { Skeleton } from "../Skeleton";
import { toolStates } from "./EmailConnectTiles";
import { getEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";
import {
  addSendingDomain,
  getSendingDomain,
  removeSendingDomain,
  saveSendingDomainSetting,
  verifySendingDomain,
  EmailBulkError,
  type SendingDomain,
  type SendingDomainState,
} from "@/lib/workspace/emailBulkApi";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";
const INPUT = `h-10 rounded-lg border border-rule bg-cream px-3 text-[16px] leading-5 text-ink outline-none placeholder:text-inkLight focus:border-ink/40 disabled:cursor-not-allowed disabled:bg-creamDeep disabled:text-inkMuted sm:text-[14px] ${FOCUS}`;
const BTN = `inline-flex h-10 shrink-0 items-center justify-center rounded-cta border border-rule bg-white px-3.5 cursor-pointer transition-colors hover:border-inkLight hover:bg-creamDeep text-[13px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const BTN_PRIMARY = `inline-flex h-10 shrink-0 items-center justify-center rounded-cta border border-ink bg-ink px-4 cursor-pointer transition-opacity hover:opacity-90 text-[13px] font-medium text-cream disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const BTN_TEXT = `inline-flex h-8 shrink-0 cursor-pointer items-center rounded-lg border border-rule bg-white px-2.5 text-[12px] font-medium transition-colors hover:border-inkLight hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const ROW = "grid gap-2 p-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-6";
const HOSTNAME_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function bareDomain(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^.*@/, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
  return HOSTNAME_RE.test(host) ? host : null;
}

const ZAVI_OWN_DOMAINS = ["zaviagent.com", "thepraxis.ai"];

function isZaviDomain(host: string): boolean {
  return ZAVI_OWN_DOMAINS.some((z) => host === z || host.endsWith(`.${z}`));
}

export const SAVED_SHOWN_MS = 3_000;

const NOT_VERIFIED = "Verify your domain once so inboxes trust your emails. Zavi can't send until it's verified.";
const CANT_SEND_UNTIL_VERIFIED = "Zavi can't send until it's verified.";

const PILLS: Record<SendingDomain["status"] | "none" | "saved", { label: string; tint: string; dot: string }> = {
  verified: { label: "Verified", tint: "bg-mintDeep/15", dot: "bg-mintDeep" },
  pending: { label: "Waiting for DNS", tint: "bg-marigold/15", dot: "bg-marigoldDeep" },
  failed: { label: "Check failed", tint: "bg-coral/10", dot: "bg-danger" },
  none: { label: "Not set up", tint: "bg-bone", dot: "bg-inkLight" },
  saved: { label: "Saved", tint: "bg-mintDeep/15", dot: "bg-mintDeep" },
};

function StatusPill({ status }: { status: SendingDomain["status"] | "none" | "saved" }) {
  const pill = PILLS[status];
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[12px] font-medium text-ink ${pill.tint}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${pill.dot}`} />
      {pill.label}
    </span>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? `Copied ${label}` : failed ? `Could not copy ${label}` : `Copy ${label}`}
      title={copied ? "Copied" : failed ? "Could not copy. Select the text and copy it." : "Copy"}
      onClick={() => {
        const write = navigator.clipboard?.writeText(value) ?? Promise.reject(new Error("no clipboard"));
        write.then(
          () => {
            setFailed(false);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {
            setCopied(false);
            setFailed(true);
            setTimeout(() => setFailed(false), 4000);
          },
        );
      }}
      className={`inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-rule bg-white text-inkMuted transition-colors hover:border-inkLight hover:bg-creamDeep ${FOCUS}`}
    >
      {copied ? <Check aria-hidden className="h-4 w-4 text-mintDeep" /> : <Copy aria-hidden className="h-4 w-4" />}
    </button>
  );
}

function RecordField({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
  return (
    <>
      <dt className="pt-2 text-[12px] font-medium text-inkMuted">{label}</dt>
      <dd className="flex min-w-0 items-start gap-1 rounded-lg bg-bone py-0.5 pl-2.5 pr-0.5 ring-1 ring-inset ring-rule">
        <code className="min-w-0 flex-1 py-1.5 font-mono text-[13px] leading-5 text-ink [overflow-wrap:anywhere]">
          {value}
        </code>
        <CopyButton value={value} label={copyLabel} />
      </dd>
    </>
  );
}

export function SendingDomainBlock({ onChange, toolsPending = false }: { onChange?: (state: SendingDomainState) => void; toolsPending?: boolean }) {
  const [state, setState] = useState<SendingDomainState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"add" | "check" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"saved" | "cleared" | null>(null);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(null), SAVED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [saved]);

  const apply = useCallback(
    (next: SendingDomainState) => {
      setState(next);
      onChange?.(next);
    },
    [onChange],
  );

  const [loadTry, setLoadTry] = useState(0);
  useEffect(() => {
    let live = true;
    setLoadError(null);
    getSendingDomain()
      .then((s) => {
        if (!live) return;
        apply(s);
        setDraft(s.domain?.domain ?? s.suggested_domain ?? "");
      })
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [apply, loadTry]);

  const [sendToolConnected, setSendToolConnected] = useState(false);
  const bulkReady = state?.bulk_email_ready;
  useEffect(() => {
    if (bulkReady !== false) return;
    let live = true;
    getEmailTestLists()
      .then((view) => {
        if (!live) return;
        const states = toolStates(view);
        setSendToolConnected((["mailchimp", "klaviyo", "sendgrid"] as const).some((t) => states.get(t) === "connected"));
      })
      .catch(() => live && setSendToolConnected(false));
    return () => {
      live = false;
    };
  }, [bulkReady]);

  const startOver = async () => {
    if (!state?.domain) return;
    const d = state.domain;
    if (d.status === "verified") {
      const ok = await confirmAction({
        title: "Use a different domain?",
        description: `Bulk email keeps going out from ${d.from_address} until you add the new domain. Once you add it, bulk email stops until the new domain is verified, and a send running at that moment is held. Some held sends can only be resumed by Zavi staff.`,
        confirmLabel: "Use a different domain",
      });
      if (!ok) return;
    }
    if (!state.bulk_email_ready) {
      const ok = await confirmAction({
        title: `Remove ${d.domain} to change it?`,
        description: "Zavi can't set up a new domain while bulk email is not set up, so the current one has to be removed first. You can then save the domain you want. Your contact lists are kept.",
        confirmLabel: "Remove and change",
        tone: "danger",
      });
      if (!ok) return;
      await removeNow(d.domain);
      return;
    }
    setDraft(d.domain);
    setEditing(true);
    setError(null);
  };

  const add = async (again?: string) => {
    if (!state) return;
    setBusy("add");
    setError(null);
    setSaved(null);
    try {
      if (!state.bulk_email_ready) {
        const host = draft.trim() ? bareDomain(draft) : "";
        if (host === null) {
          setError("Enter a domain like example.com.");
          return;
        }
        if (host && isZaviDomain(host)) {
          setError("Use your own domain, not Zavi's.");
          return;
        }
        if (!host && !state.suggested_domain) {
          setError("Enter a domain like example.com.");
          return;
        }
        await saveSendingDomainSetting(host);
        apply({ ...state, suggested_domain: host || null });
        setDraft(host);
        setSaved(host ? "saved" : "cleared");
        toast.add({ type: "success", title: host ? "Your sending domain is saved" : "Your sending domain is cleared", position: "top-center", dismissible: false, timeout: SAVED_SHOWN_MS });
        return;
      }
      const host = again ?? bareDomain(draft);
      if (!host) {
        setError("Enter a domain like example.com.");
        return;
      }
      const domain = await addSendingDomain(host);
      apply({ ...state, domain, suggested_domain: null });
      setEditing(false);
    } catch (e) {
      const message = (e as Error).message;
      if (e instanceof EmailBulkError && e.status >= 400 && e.status < 500) {
        setError(message);
        return;
      }
      try {
        const current = await getSendingDomain();
        apply(current);
        setDraft(current.domain?.domain ?? current.suggested_domain ?? draft.trim());
        setEditing(!current.domain);
        setError(`${message} Your saved domain is shown below.`);
      } catch {
        setError(`${message} Zavi also could not reload the saved domain. Refresh before trying again.`);
      }
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    if (!state) return;
    setBusy("check");
    setError(null);
    try {
      apply({ ...state, domain: await verifySendingDomain() });
    } catch (e) {
      const message = (e as Error).message;
      if (e instanceof EmailBulkError && e.status >= 400 && e.status < 500) {
        setError(message);
        return;
      }
      try {
        const current = await getSendingDomain();
        apply(current);
        setDraft(current.domain?.domain ?? current.suggested_domain ?? "");
        setError(`${message} Zavi could not confirm the check; the current domain status is shown.`);
      } catch {
        setError(`${message} Zavi also could not reload the domain status. Refresh before checking again.`);
      }
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!state?.domain) return;
    const confirmed = await confirmAction({
      title: `Remove ${state.domain.domain}?`,
      description: "Bulk email stops until you verify a domain again. Your contact lists are kept.",
      confirmLabel: "Remove domain",
      tone: "danger",
    });
    if (!confirmed) return;
    await removeNow("");
  };

  const removeNow = async (nextDraft: string) => {
    if (!state?.domain) return;
    setBusy("remove");
    setError(null);
    try {
      await removeSendingDomain();
      try {
        const current = await getSendingDomain();
        apply(current);
      } catch {
        apply({ ...state, domain: null, suggested_domain: null });
        setError("The domain was removed, but Zavi could not reload this page. Refresh to confirm.");
      }
      setDraft(nextDraft);
      setEditing(false);
    } catch (e) {
      const message = (e as Error).message;
      try {
        const current = await getSendingDomain();
        apply(current);
        setDraft(current.domain?.domain ?? current.suggested_domain ?? "");
        setEditing(false);
        setError(`${message} Zavi could not confirm the removal; the current saved domain is shown.`);
      } catch {
        setError(`${message} Zavi also could not reload the saved domain. Refresh before trying again.`);
      }
    } finally {
      setBusy(null);
    }
  };

  const d = state?.domain ?? null;
  const waiting = toolsPending && !!state && !d;
  const showForm = !!state && !waiting && (!d || editing);
  const manage =
    d && state?.can_manage ? (
      <>
        <button type="button" disabled={busy !== null} onClick={() => void startOver()} className={`${BTN_TEXT} text-ink`}>
          Change
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void remove()} className={`${BTN_TEXT} text-danger`}>
          {busy === "remove" ? "Removing…" : "Remove"}
        </button>
      </>
    ) : null;

  return (
    <section aria-labelledby="sending-domain-title" data-testid="sending-domain" className={ROW}>
      <div className="flex flex-wrap content-start items-center gap-2 sm:flex-col sm:items-start sm:gap-1.5 sm:pt-1.5">
        <h3 id="sending-domain-title" className="text-[13px] font-medium leading-5 text-ink">
          Sending domain
        </h3>
        {state && !d && !waiting && <StatusPill status={!state.bulk_email_ready && state.suggested_domain ? "saved" : "none"} />}
      </div>

      <div className="grid min-w-0 gap-3">
        {((!state && !loadError) || waiting) && <Skeleton className="h-10 w-full" rounded="rounded-lg" />}
        {loadError && (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
            {loadError}
            <button type="button" onClick={() => setLoadTry((v) => v + 1)} className={BTN}>
              Retry
            </button>
          </p>
        )}

        {state && !waiting && !state.bulk_email_ready && (
          <p className="rounded-lg bg-bone px-3 py-2.5 text-[13px] leading-5 text-inkSoft">
            Zavi can&apos;t send from your domain yet. Save it now and Zavi checks it later.
            {!sendToolConnected && " To send today, connect Mailchimp, Klaviyo or SendGrid."}
          </p>
        )}

        {d && !editing && d.status === "verified" && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span title={d.from_address} className="min-w-0 max-w-full truncate font-mono text-[14px] leading-5 text-ink">
              {d.from_address}
            </span>
            <StatusPill status="verified" />
            {manage && <span className="ml-auto flex items-center gap-4">{manage}</span>}
          </div>
        )}

        {d && !editing && d.status !== "verified" && (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 truncate font-mono text-[14px] leading-5 text-ink">{d.domain}</span>
              <StatusPill status={d.status} />
            </div>
            <p className="text-[14px] leading-5 text-ink">
              {d.dns_records.length === 0
                ? "Zavi has no DNS records to show for "
                : `Add ${d.dns_records.length === 1 ? "this record" : `these ${d.dns_records.length} records`} where you manage DNS for `}
              <span className="font-semibold">{d.domain}</span>
              {d.dns_records.length === 0
                ? state?.bulk_email_ready
                  ? " yet. Add the domain again to get them."
                  : " yet. Remove it and save it again once bulk email is set up."
                : ", then check."}
              {state?.bulk_email_ready && ` ${CANT_SEND_UNTIL_VERIFIED}`}
            </p>
            {d.dns_records.length > 0 && (
              <div>
                <ol className="divide-y divide-rule overflow-hidden rounded-xl border border-rule">
                  {d.dns_records.map((r) => (
                    <li key={`${r.type}:${r.host}`} className="px-3 py-3">
                      <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-inkMuted">
                        <span className="rounded-md bg-bone px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink">
                          {r.type}
                        </span>
                      </div>
                      <dl className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
                        <RecordField label="Host" value={r.host} copyLabel={`the ${r.type} name`} />
                        <RecordField label="Value" value={r.data} copyLabel={`the ${r.type} value`} />
                      </dl>
                    </li>
                  ))}
                </ol>
                <p className="mt-2 text-[12px] leading-[18px] text-inkMuted">
                  Some DNS providers add your domain to the host on their own. If yours does, leave the domain off the end
                  of the host.
                </p>
              </div>
            )}
            {d.last_error && (
              <div className="flex gap-2 rounded-lg bg-marigold/15 px-3 py-2 text-[13px] leading-[18px] text-ink">
                <AlertCircle aria-hidden className="mt-px h-4 w-4 shrink-0 text-marigoldDeep" />
                <p>{d.last_error}</p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-4">
              {d.dns_records.length === 0 && state?.bulk_email_ready && (
                <button
                  type="button"
                  disabled={!state.can_manage || busy !== null}
                  onClick={() => void add(d.domain)}
                  className={BTN_PRIMARY}
                >
                  {busy === "add" ? "Adding…" : "Add domain again"}
                </button>
              )}
              <button
                type="button"
                disabled={!state?.can_manage || busy !== null}
                onClick={() => void check()}
                className={BTN_PRIMARY}
              >
                {busy === "check" ? "Checking…" : "Check now"}
              </button>
              {manage}
            </div>
            {!state?.can_manage && (
              <p className="text-[13px] leading-5 text-inkMuted">
                Only a workspace owner or admin can check the sending domain. Ask one of them to check it.
              </p>
            )}
          </>
        )}

        {showForm && (
          <div className="grid min-w-0 gap-2">
            {!d && state.bulk_email_ready && <p className="text-[13px] leading-5 text-inkMuted">{NOT_VERIFIED}</p>}
            <div className="flex min-w-0 gap-2">
              <label className="sr-only" htmlFor="sending-domain-input">
                Your domain
              </label>
              <input
                id="sending-domain-input"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="example.com"
                value={draft}
                disabled={!state.can_manage || busy !== null}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSaved(null);
                }}
                className={`${INPUT} min-w-0 flex-1`}
              />
              <button
                type="button"
                disabled={!state.can_manage || busy !== null || (state.bulk_email_ready ? !draft.trim() || (!!d && (d.status === "verified" || d.dns_records.length > 0) && (bareDomain(draft) ?? draft.trim()) === d.domain) : (bareDomain(draft) ?? draft.trim()) === (state.suggested_domain ?? ""))}
                onClick={() => void add()}
                className={BTN_PRIMARY}
              >
                {state.bulk_email_ready ? (busy === "add" ? "Adding…" : "Add domain") : busy === "add" ? "Saving…" : "Save domain"}
              </button>
              {editing && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                  }}
                  className={`${BTN} text-inkMuted`}
                >
                  Cancel
                </button>
              )}
            </div>
            {!state.can_manage && (
              <p className="text-[13px] leading-5 text-inkMuted">
                Only a workspace owner or admin can set the sending domain. Ask one of them to add it.
              </p>
            )}
            {saved === "saved" && (
              <p role="status" data-testid="sending-domain-saved" className="flex items-start gap-2 rounded-lg bg-mintDeep/15 px-3 py-2.5 text-[13px] leading-5 text-ink">
                <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-mintDeep" />
                Saved. Zavi checks this domain&apos;s records on its next run.
              </p>
            )}
            {saved === "cleared" && (
              <p role="status" className="text-[13px] leading-5 text-ink">
                Cleared. Zavi has no sending domain saved.
              </p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-[13px] leading-5 text-danger">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
