"use client";

import { useEffect, useRef, useState } from "react";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { isMember } from "@/lib/members";
import { getEmailPause, setEmailPause, type EmailPauseState, type EmailSendHold } from "@/lib/workspace/emailCampaignSettingsApi";
import { registerSessionScopedCache } from "@/lib/workspace/sessionScopedCache";
import { onTabReturn } from "@/lib/workspace/onTabReturn";
import { ChannelTitleBadgeSlot } from "../layout/ChannelHeaderRow";
import { useRereadWhileFailed } from "./useRereadWhileFailed";

export const EMAIL_SENDING_COPY = {
  label: "Email sending",
  shortLabel: "Email",
  on: "On",
  paused: "Paused",
  off: "Off",
  intro: "One switch for every email Zavi sends, whichever tool it goes through.",
  pauseTitle: "Pause all email?",
  pauseBody:
    "Zavi sends nothing through SendGrid, Mailchimp, Klaviyo or its own sender until you turn it back on. A send by Zavi's own sender that is already going out stops before its next email; a campaign your email tool already accepted cannot be called back. Emails planned while paused are skipped.",
  resumeTitle: "Turn email sending on?",
  resumeBody:
    "Approved and planned emails can go out again from now on, but an approved email that has waited more than a day since you approved it is dropped, not sent late, and needs a new draft. Emails skipped while paused stay skipped.",
  readOnly: "Only a workspace owner or admin can pause or resume email.",
  unknown: "Zavi could not confirm whether email is paused.",
  stoppedByZavi: "Zavi sender stopped",
  held: {
    abuse: "Zavi stopped its own sender for this workspace after too many spam reports or bounces.",
    global: "Zavi's own sender is stopped for every workspace right now.",
    disabled: "Zavi's own sender is switched off for this workspace. Contact support to turn it back on.",
    unknown: "Zavi could not confirm that its own sender is running, so it is treated as stopped for now.",
  },
  toolsStillSend: "Your email tools still send.",
} as const;

let lastPaused: boolean | null = null;
let lastHeld: EmailSendHold | null = null;
export const forgetPaused = () => {
  lastPaused = null;
  lastHeld = null;
};
const remember = (v: boolean) => {
  lastPaused = v;
  registerSessionScopedCache(forgetPaused);
  return v;
};
export async function loadEmailPause(): Promise<EmailPauseState> {
  const s = await getEmailPause();
  lastHeld = s.held;
  remember(s.paused);
  return s;
}

export function EmailSendingSwitch() {
  const role = useWorkspaceOptional()?.role ?? null;
  const canEdit = role !== null && !isMember(role);
  const [paused, setPaused] = useState<boolean | null>(lastPaused);
  const [held, setHeld] = useState<EmailSendHold | null>(lastHeld);
  const apply = (s: EmailPauseState) => {
    lastHeld = s.held;
    setHeld(s.held);
    setPaused(remember(s.paused));
  };
  const [cold] = useState(lastPaused === null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadTry, setLoadTry] = useState(0);
  const quiet = useRef(false);
  useRereadWhileFailed(loadError !== null && !busy, () => {
    quiet.current = true;
    setLoadTry((v) => v + 1);
  });

  useEffect(() => {
    let live = true;
    if (!quiet.current) {
      setLoadError(null);
      setError(null);
    }
    quiet.current = false;
    getEmailPause()
      .then((s) => {
        if (!live) return;
        apply(s);
        setLoadError(null);
      })
      .catch((e: Error) => {
        if (!live) return;
        forgetPaused();
        setPaused(null);
        setHeld(null);
        setLoadError(e.message || EMAIL_SENDING_COPY.unknown);
      });
    return () => {
      live = false;
    };
  }, [loadTry]);

  const busyRef = useRef(false);
  busyRef.current = busy;
  useEffect(() => {
    let live = true;
    let seq = 0;
    const refresh = () => {
      if (document.visibilityState === "hidden" || busyRef.current) return;
      const mine = ++seq;
      getEmailPause()
        .then((s) => {
          if (live && mine === seq && !busyRef.current) apply(s);
        })
        .catch(() => {});
    };
    const stopListening = onTabReturn(refresh);
    return () => {
      live = false;
      stopListening();
    };
  }, []);

  const flip = async () => {
    if (busy || paused === null || !canEdit) return;
    const next = !paused;
    const ok = await confirmAction(
      next
        ? { title: EMAIL_SENDING_COPY.pauseTitle, description: EMAIL_SENDING_COPY.pauseBody, confirmLabel: "Pause all email", tone: "danger" }
        : { title: EMAIL_SENDING_COPY.resumeTitle, description: EMAIL_SENDING_COPY.resumeBody, confirmLabel: "Turn on" },
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      setPaused(remember(await setEmailPause(next)));
    } catch (e) {
      const message = (e as Error).message;
      try {
        apply(await getEmailPause());
        setError((e as { code?: string }).code === "email_resume_incomplete" ? message : `${message} The saved state is shown.`);
      } catch {
        forgetPaused();
        setPaused(null);
        setHeld(null);
        setLoadError(EMAIL_SENDING_COPY.unknown);
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  const on = paused === false;
  const heldBase = held ? EMAIL_SENDING_COPY.held[held] : null;
  const heldReason = heldBase && paused === false ? `${heldBase} ${EMAIL_SENDING_COPY.toolsStillSend}` : heldBase;
  const describedBy = [canEdit ? "email-sending-state" : "email-sending-state email-sending-readonly", heldReason ? "email-sending-held" : null].filter(Boolean).join(" ");
  return (
    <span
      data-testid="email-sending"
      className="inline-flex min-w-0 items-center gap-2 text-[13px] compact:flex-wrap compact:gap-y-1"
      title={heldReason ? (canEdit ? heldReason : `${heldReason} ${EMAIL_SENDING_COPY.readOnly}`) : canEdit ? EMAIL_SENDING_COPY.intro : EMAIL_SENDING_COPY.readOnly}
    >
      {paused !== null && heldReason && (
        <ChannelTitleBadgeSlot>
          <span
            data-testid="email-held-badge"
            title={heldReason}
            className="inline-flex items-center gap-1.5 rounded-full bg-danger/10 px-2.5 py-0.5 text-[12px] font-medium leading-5 text-danger"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
            {EMAIL_SENDING_COPY.stoppedByZavi}
            <span className="sr-only">{heldReason}</span>
          </span>
        </ChannelTitleBadgeSlot>
      )}
      {paused === true && (
        <ChannelTitleBadgeSlot>
          <span
            data-testid="email-paused-badge"
            className="inline-flex items-center gap-1.5 rounded-full bg-marigoldDeep/10 px-2.5 py-0.5 text-[12px] font-medium leading-5 text-marigoldDeep"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
            {EMAIL_SENDING_COPY.paused}
          </span>
        </ChannelTitleBadgeSlot>
      )}
      {paused !== null ? (
        <span className={cn("inline-flex min-w-0 items-center gap-2", cold && "animate-fade-in motion-reduce:animate-none")}>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={EMAIL_SENDING_COPY.label}
            aria-describedby={describedBy}
            aria-disabled={!canEdit || busy}
            onClick={() => void flip()}
            className={cn(
              "flex h-6 w-[30px] shrink-0 items-center rounded-full border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-2 focus-visible:ring-offset-cream aria-disabled:cursor-not-allowed",
              !canEdit && "opacity-60",
            )}
          >
            <span
              aria-hidden
              data-testid="email-sending-track"
              className={cn("relative block h-[18px] w-[30px] overflow-hidden rounded-full transition-colors duration-200 motion-reduce:transition-none", on ? "bg-ink" : "bg-ink/15")}
            >
              <span
                className={cn(
                  "absolute left-[2px] top-[2px] h-[14px] w-[14px] rounded-full shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-[transform,background-color] duration-200 ease-out motion-reduce:transition-none",
                  on ? "translate-x-[12px] bg-cream" : "translate-x-0 bg-inkMuted",
                )}
              />
            </span>
          </button>
          <span data-testid="email-sending-label" className="whitespace-nowrap font-medium text-ink compact:hidden">{EMAIL_SENDING_COPY.label}</span>
          <span data-testid="email-sending-label-short" className="hidden whitespace-nowrap font-medium text-ink compact:inline">{EMAIL_SENDING_COPY.shortLabel}</span>
          <span id="email-sending-state" className="sr-only">
            {on ? EMAIL_SENDING_COPY.on : EMAIL_SENDING_COPY.off}
          </span>
          {!canEdit && (
            <span id="email-sending-readonly" className="sr-only">
              {EMAIL_SENDING_COPY.readOnly}
            </span>
          )}
          {heldReason && (
            <span id="email-sending-held" className="sr-only">
              {heldReason}
            </span>
          )}
        </span>
      ) : loadError ? (
        <span role="alert" className="inline-flex items-center gap-1.5 text-danger">
          <span className="truncate compact:sr-only">{EMAIL_SENDING_COPY.unknown}</span>
          <button type="button" className="inline-flex h-7 cursor-pointer items-center rounded-lg border border-rule bg-white px-2.5 text-[12px] font-medium text-ink transition-colors hover:border-inkLight hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30" onClick={() => setLoadTry((v) => v + 1)}>
            Retry
          </button>
        </span>
      ) : (
        <span aria-hidden data-testid="email-sending-checking" className="inline-flex items-center gap-2">
          <span className="block h-[18px] w-[30px] animate-pulse rounded-full bg-creamDeep motion-reduce:animate-none" />
          <span className="block h-3 w-24 animate-pulse rounded-md bg-creamDeep motion-reduce:animate-none" />
        </span>
      )}
      {error && (
        <span role="alert" title={error} className="max-w-[16rem] whitespace-normal break-words text-[12px] text-danger compact:max-w-none compact:basis-full compact:whitespace-normal compact:break-words">
          {error}
        </span>
      )}
    </span>
  );
}
