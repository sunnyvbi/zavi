"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import { Skeleton } from "../Skeleton";
import { ESP_TAGS, isUnsubscribeLink } from "../actions/blanks";
import { postalAddressProblem } from "./postalAddress";
import {
  EMAIL_FOOTER_SAVED_EVENT,
  getEmailChannelSettings,
  getEmailTemplate,
  POSTAL_FIELD,
  saveEmailChannelSetting,
  saveTemplatePostalAddress,
  SENDER_FIELD,
  UNSUBSCRIBE_FIELD,
} from "@/lib/workspace/emailCampaignSettingsApi";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";
const INPUT = `w-full min-w-0 rounded-[10px] border border-rule bg-cream px-3 text-[16px] leading-5 text-ink outline-none placeholder:text-inkLight focus:border-ink/40 disabled:cursor-not-allowed disabled:bg-creamDeep disabled:text-inkMuted sm:text-[14px] ${FOCUS}`;
const BTN = `inline-flex h-10 shrink-0 items-center justify-center rounded-cta border border-rule bg-white px-3.5 cursor-pointer transition-colors hover:border-inkLight hover:bg-creamDeep text-[13px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const BTN_SAVE = `inline-flex h-10 shrink-0 items-center justify-center rounded-cta border border-ink bg-ink px-4 cursor-pointer transition-opacity hover:opacity-90 text-[13px] font-medium text-cream disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const ROW = "grid gap-2 p-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-6";
const ROW_LABEL = "text-[13px] font-medium leading-5 text-ink sm:pt-2.5";

const POSTAL_MAX = 300;

type Stored = { templatePostal: string; settingPostal: string; unsubscribe: string; esp: string; sendgrid: boolean; canEdit: boolean };

function toolNote(s: Stored): string | null {
  const tags = s.esp ? ESP_TAGS[s.esp] : undefined;
  if (tags) return `${tags.name} adds each person's unsubscribe link. Leave this empty.`;
  if (s.esp === "sendgrid" || s.sendgrid) return "SendGrid adds each person's unsubscribe link. Leave this empty.";
  return null;
}

export function EmailFooterSection() {
  const [stored, setStored] = useState<Stored | null>(null);
  const [postal, setPostal] = useState("");
  const [unsubscribe, setUnsubscribe] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTry, setLoadTry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    Promise.all([getEmailTemplate(), getEmailChannelSettings()])
      .then(([t, settings]) => {
        if (!live) return;
        const first = (id: string) => settings[id]?.[0]?.trim() ?? "";
        const next: Stored = {
          templatePostal: t?.template?.postal_address?.trim() ?? "",
          settingPostal: first(POSTAL_FIELD),
          unsubscribe: first(UNSUBSCRIBE_FIELD),
          esp: first("esp"),
          sendgrid: !!first(SENDER_FIELD),
          canEdit: t?.can_edit === true,
        };
        setStored(next);
        setPostal(next.templatePostal);
        setUnsubscribe(next.unsubscribe);
      })
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [loadTry]);

  const shownPostal = stored ? stored.templatePostal : "";
  const dirty = !!stored && (postal.trim() !== shownPostal || unsubscribe.trim() !== stored.unsubscribe);
  const note = stored ? toolNote(stored) : null;

  const save = async () => {
    if (!stored) return;
    const p = postal.trim();
    const u = unsubscribe.trim();
    if (!p && shownPostal) {
      setError("Every marketing email needs a postal address, so it cannot be removed. Change it instead.");
      return;
    }
    if (p.length > POSTAL_MAX) {
      setError(`The postal address is too long (${POSTAL_MAX} characters at most).`);
      return;
    }
    if (u && u !== stored.unsubscribe && !isUnsubscribeLink(u)) {
      setError("Use a web address that starts with https://, or your email tool's unsubscribe tag, like *|UNSUB|*.");
      return;
    }
    setError(null);
    setBusy(true);
    let next = stored;
    let wrote = false;
    try {
      const postalChanged = !!p && p !== next.templatePostal;
      if (postalChanged) {
        await saveTemplatePostalAddress(p);
        next = { ...next, templatePostal: p };
        wrote = true;
      }
      if (postalChanged && p !== next.settingPostal) {
        await saveEmailChannelSetting(POSTAL_FIELD, [p]);
        next = { ...next, settingPostal: p };
        wrote = true;
      }
      if (u !== next.unsubscribe) {
        await saveEmailChannelSetting(UNSUBSCRIBE_FIELD, u ? [u] : []);
        next = { ...next, unsubscribe: u };
        wrote = true;
      }
      setPostal(p);
      setUnsubscribe(u);
      toast.add({ type: "success", title: "Your footer is saved", position: "top-center", dismissible: false });
    } catch (e) {
      setError(`${(e as Error).message} Nothing after that was saved.`);
    } finally {
      setStored(next);
      setBusy(false);
      if (wrote) window.dispatchEvent(new CustomEvent(EMAIL_FOOTER_SAVED_EVENT));
    }
  };

  const disabled = !stored?.canEdit || busy;
  return (
    <section id="email-settings-footer" aria-labelledby="email-settings-footer-title" className="flex scroll-mt-6 flex-col gap-3">
      <h2 id="email-settings-footer-title" className="text-[18px] font-semibold leading-6 tracking-tight text-ink">
        Footer
      </h2>
      {!stored && !loadError && (
        <div className="rounded-2xl border border-rule bg-white p-5">
          <Skeleton className="h-10 w-full" rounded="rounded-[10px]" />
        </div>
      )}
      {loadError && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
          {loadError}
          <button type="button" className={BTN} onClick={() => setLoadTry((v) => v + 1)}>
            Retry
          </button>
        </p>
      )}
      {stored && (
        <div className="min-w-0 divide-y divide-rule rounded-2xl border border-rule bg-white">
          <div className={ROW}>
            <label htmlFor="email-footer-postal" className={ROW_LABEL}>
              Postal address
              <small className="block text-[12px] font-normal leading-[18px] text-inkMuted">Required by US law</small>
            </label>
            <div className="grid min-w-0 gap-2">
              <textarea
                id="email-footer-postal"
                className={`${INPUT} min-h-[64px] py-2`}
                rows={2}
                maxLength={POSTAL_MAX}
                placeholder="Street, city, state, ZIP"
                value={postal}
                disabled={disabled}
                aria-describedby={postalAddressProblem(postal) === "placeholder" ? "email-footer-postal-placeholder" : undefined}
                onChange={(e) => setPostal(e.target.value)}
              />
              <p data-testid="footer-drafts-note" className="text-[12px] leading-[18px] text-inkMuted">
                New emails use this footer. Emails already drafted keep theirs.
              </p>
              {postalAddressProblem(postal) === "placeholder" && (
                <p id="email-footer-postal-placeholder" data-testid="footer-postal-placeholder" className="text-[12px] leading-[18px] text-danger">
                  This still looks like a placeholder. Zavi can&apos;t send until it is your real postal address.
                </p>
              )}
            </div>
          </div>
          <div className={ROW}>
            <label htmlFor="email-footer-unsubscribe" className={ROW_LABEL}>
              Unsubscribe link
            </label>
            <div className="grid min-w-0 gap-2">
              <input
                id="email-footer-unsubscribe"
                type="text"
                inputMode="url"
                autoComplete="off"
                className={`${INPUT} h-10`}
                placeholder={note ? "Optional" : "Added by your email tool when connected"}
                value={unsubscribe}
                disabled={disabled}
                aria-describedby="email-footer-unsubscribe-note"
                onChange={(e) => setUnsubscribe(e.target.value)}
              />
              <p id="email-footer-unsubscribe-note" data-testid="footer-unsubscribe-note" className="text-[12px] leading-[18px] text-inkMuted">
                {note ?? "Your email tool's unsubscribe link (https://) or tag. Emails Zavi sends get their own link."}
              </p>
            </div>
          </div>
          {(dirty || error || !stored.canEdit) && (
            <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-4">
              {!stored.canEdit && <p className="mr-auto text-[13px] leading-5 text-inkMuted">Only a workspace owner or admin can change the footer.</p>}
              {error && (
                <p role="alert" className="mr-auto min-w-0 text-[13px] leading-5 text-danger">
                  {error}
                </p>
              )}
              {stored.canEdit && (
                <button type="button" className={BTN_SAVE} disabled={busy || !dirty} onClick={() => void save()}>
                  {busy ? "Saving…" : "Save footer"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
