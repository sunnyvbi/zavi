"use client";

import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { isMember } from "@/lib/members";
import { ApiError, newRequestId } from "@/lib/workspace/channelActionsApi";
import { getEmailChannelSettings, getEmailTestLists, getSendgridGroups, getSendgridSenders, GROUP_FIELD, readFailureMessage, SENDER_FIELD, type EmailSendHold, type SendgridGroup, type SendgridSender, type TestListRoute, type TestListRouteView } from "@/lib/workspace/emailCampaignSettingsApi";
import { EMAIL_SENDING_COPY, loadEmailPause } from "./EmailSendingSwitch";
import { getPlan, isAmbiguousPlanError, planEmail, plannedTooFar, plannedTooSoon, PLAN_LEAD_HOURS, PLAN_MAX_DAYS, PLAN_TOO_FAR, PLAN_TOO_SOON, PLAN_FALLBACK, wallInstant, newRequestId as newPlanRequestId } from "@/lib/workspace/emailPlanApi";
import { getSentEmails, type SentEmail } from "@/lib/workspace/emailResultsApi";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { upgradeOnPlanRefusal, useChannelPlanLock } from "../actions/channelPlanLock";
import { ActionModal, m } from "../actions/topActions/ActionModal";
import { announceChannelActionsChanged, announceChannelRunStarted, startTopAction } from "../actions/topActions/api";
import { pasteEmail, PasteEmailError } from "@/lib/workspace/emailPasteApi";
import { HTML_SOURCE_WARNING, looksLikeHtml, mergeTagIn, mergeTagWarning, pastedWithLinks } from "./pasteText";
import { getSendingDomain } from "@/lib/workspace/emailBulkApi";
import { gotoEmailSettings } from "./emailSettingsNav";
import { PlanWhenFields } from "./PlanWhenFields";
import { needsKeyLine, TEST_LIST_COPY, toolProblemLine } from "./EmailTestListsBlock";
import { loadFooterPostal, postalAddressProblem, type PostalProblem } from "./postalAddress";
import { EMAIL_PLAN_CHANGED_EVENT } from "@/lib/workspace/emailCardEvents";
import { useRereadWhileFailed } from "./useRereadWhileFailed";

export { EMAIL_PLAN_CHANGED_EVENT };
export const NEW_CAMPAIGN_KEY = "new_email";
export const BRIEF_MIN = 3;
export const BRIEF_MAX = 2000;
export const PLANNED_BRIEF_MAX = 120;
export const PASTE_MIN = 20;
export const PASTE_MAX = 10_000;
export const SUBJECT_MAX = 150;
export const SUBJECT_GOOD = 60;
export const LIST_REST_DAYS = 7;
export const PASTE_HINT = "Your words go in as written, in your saved template. Zavi adds your subject as the heading and a Read more button to the first https link in your email, or to your website if there is none.";
export const PASTE_DONE = "Your email is on this page. Your words are as you wrote them, with your subject as the heading and a Read more button added. Send yourself a test, then approve it. Nothing is sent before that.";
export const ZAVI_SENDER_STOPPED = "Nothing can be written or sent to this list until it is back.";
export const WRITE_UNSURE = "Zavi could not confirm it started. Press Write it again: it is the same request, so it cannot start twice.";
export const HELD_PLAN_DROPPED = "Started over. Check Coming up before you plan it again: the last plan may have gone through.";
export const HELD_LIST_GONE = "The list from your last try is no longer available. Pick a list to plan again.";
export const ZAVI_SENDER_NOT_READY = "Zavi can't send to your lists yet: finish Sending setup, or connect SendGrid, Mailchimp or Klaviyo.";
export const IDEAS = ["Announce something new", "Win back people who went quiet", "Share a seasonal offer"] as const;
export const withIdea = (idea: string, text: string) => {
  const used = IDEAS.find((i) => text.startsWith(`${i}:`));
  return `${idea}: ${(used ? text.slice(used.length + 1) : text).trimStart()}`;
};
export const PLANNED_SEND_RULE = "It goes out only when an owner or admin approves it, or Autopilot is allowed to send it.";
export const PLAN_DROPS_LINES = "Planned emails can't keep a subject or preview text. Zavi writes both when it drafts.";

const ONE_LINE = /[\u0000-\u001f\u007f]/;

export type CampaignList = { key: string; route: TestListRoute; id: string; name: string; source: string; people: number | null; test: boolean; needsConsent?: boolean; consentedVersion?: boolean };

export const keyRejectedListsLine = (label: string) => `${label} rejected the key Zavi has saved, so its lists can't load.`;

export function campaignLists(routes: TestListRouteView[]): { lists: CampaignList[]; unreadable: string[]; needsKey: string[]; keyRejected: string[] } {
  const lists: CampaignList[] = [];
  const unreadable: string[] = [];
  const needsKey: string[] = [];
  const keyRejected: string[] = [];
  for (const r of routes) {
    if (r.route !== "zavi_list" && toolProblemLine(r.status, r.error) === TEST_LIST_COPY.keyRejected) keyRejected.push(r.label);
    else if (r.status === "partial" || r.status === "unreadable") unreadable.push(r.label);
    if (r.status === "needs_permissions") needsKey.push(r.label);
    if (r.status === "needs_permissions" || r.status === "not_connected") continue;
    for (const l of r.lists) lists.push({ key: `${r.route}:${l.id}`, route: r.route, id: l.id, name: l.name, source: r.label, people: l.people, test: l.marked, ...(l.needs_consent ? { needsConsent: true } : {}), ...(l.consented_version ? { consentedVersion: true } : {}) });
  }
  return { lists, unreadable, needsKey, keyRejected };
}

export type PlanPending = { key: string; angle: string; date: string; time: string };
export type CampaignDraft = { pick: string; mode: "ai" | "paste"; prompt: string; paste: string; subject: string; preview: string; when: "approve" | "time"; date: string; time: string };

export function campaignDraftFromInputs(i: Record<string, unknown>): CampaignDraft | null {
  if (typeof i.route !== "string" || typeof i.list_id !== "string") return null;
  const word = (v: unknown) => (typeof v === "string" ? v : "");
  const pasted = (i.pasted ?? null) as { subject?: unknown; preview_text?: unknown; body?: unknown } | null;
  return {
    pick: `${i.route}:${i.list_id}`,
    mode: pasted ? "paste" : "ai",
    prompt: word(i.brief),
    paste: word(pasted?.body),
    subject: word(pasted ? pasted.subject : i.subject),
    preview: word(pasted ? pasted.preview_text : i.preview_text),
    when: "approve",
    date: "",
    time: "09:00",
  };
}
export type CampaignSession = { runId: string; lastAsk: string | null; planId: string; planPending: PlanPending | null; draft?: CampaignDraft | null };

const STILL_STARTING = "Zavi is still starting this. Check the page in a minute.";

export function newCampaignSession(): CampaignSession {
  return { runId: newRequestId(), lastAsk: null, planId: newPlanRequestId(), planPending: null };
}

type Mode = "ai" | "paste";
type When = "approve" | "time";
type Footer = { known: boolean; postal: boolean; problem: PostalProblem };
type ZaviSender = "loading" | "ready" | "not_ready" | "unknown";
type SendgridSetup = "loading" | "ready" | "sender" | "group" | "unknown";

export const SENDGRID_SETUP_COPY = {
  label: "SendGrid sender and unsubscribe group",
  sender: "Pick a verified sender in Sending.",
  group: "Pick an unsubscribe group in Sending.",
  unknown: "Zavi could not check SendGrid just now",
} as const;

export function sendgridSetupProblem(senders: SendgridSender[], groups: SendgridGroup[], senderId: string, groupId: string): "sender" | "group" | null {
  const verified = senders.filter((s) => s.verified);
  if (senderId ? !verified.some((s) => s.id === senderId) : verified.length !== 1) return "sender";
  if (groupId ? !groups.some((g) => g.id === groupId) : groups.filter((g) => g.is_default).length !== 1) return "group";
  return null;
}
type StepKey = "to" | "email" | "checks" | "when";
type Missing = { text: string; step: StepKey; target: string };
function zoneName(zone: string, date: string, time: string): string {
  try {
    const at = date && time ? wallInstant({ date, time }, zone) : null;
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(at ? new Date(at) : new Date());
    const short = parts.find((p) => p.type === "timeZoneName")?.value;
    return short && short !== zone ? `${short}, ${zone}` : zone;
  } catch {
    return zone;
  }
}
const LIST_TARGET = 'input[type="radio"]:not([disabled]), button:not([disabled])';
const STEP_TITLE: Record<StepKey, string> = { to: "To", email: "Email", checks: "Zavi checks", when: "When" };
const FIELD =
  "w-full rounded-[8px] border border-rule bg-white px-3 text-[16px] text-ink outline-none placeholder:text-inkLight focus:border-ink disabled:bg-bone disabled:text-inkMuted sm:text-[14px]";
const SMALL_BUTTON = "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md border border-rule bg-white px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-creamDeep disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent";
const option = (on: boolean, off?: boolean) =>
  cn(
    "flex gap-2.5 rounded-xl border px-3 py-2.5 transition-colors",
    off ? "cursor-not-allowed border-rule opacity-60" : on ? "cursor-pointer border-ink bg-creamDeep" : "cursor-pointer border-rule hover:border-inkLight hover:bg-creamDeep",
  );

const listCard = (on: boolean, off: boolean) =>
  cn(
    "flex min-h-[60px] items-center gap-3 rounded-xl border px-4 py-3 transition-colors",
    off ? "cursor-not-allowed border-rule bg-white opacity-60" : on ? "cursor-pointer border-ink bg-creamDeep ring-1 ring-ink" : "cursor-pointer border-rule bg-white hover:border-inkLight hover:bg-creamDeep",
  );

const whenOption = (on: boolean, off?: boolean) =>
  cn(
    "flex min-h-[56px] gap-3 rounded-xl border px-4 py-3.5 transition-colors",
    off ? "cursor-not-allowed border-rule opacity-60" : on ? "cursor-pointer border-ink bg-creamDeep" : "cursor-pointer border-rule bg-white hover:border-inkLight hover:bg-creamDeep",
  );

function Radio(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className">) {
  return (
    <span className="relative mt-px flex h-5 w-5 shrink-0">
      <input type="radio" className="peer sr-only" {...props} />
      <span aria-hidden className="h-5 w-5 rounded-full border-2 border-inkLight bg-white transition-colors peer-hover:border-inkMuted peer-checked:border-ink peer-disabled:opacity-50 peer-focus-visible:ring-2 peer-focus-visible:ring-ink/25 peer-focus-visible:ring-offset-2" />
      <span aria-hidden className="pointer-events-none absolute inset-0 m-auto h-2.5 w-2.5 scale-0 rounded-full bg-ink transition-transform peer-checked:scale-100" />
    </span>
  );
}

function Step({ n, step, ok, checking = false, children }: { n: number; step: StepKey; ok: boolean; checking?: boolean; children: ReactNode }) {
  const title = STEP_TITLE[step];
  return (
    <section data-step={step} tabIndex={-1} className="grid scroll-mt-4 grid-cols-[24px_minmax(0,1fr)] gap-3 border-b border-rule py-5 outline-none first-of-type:pt-4 last:border-b-0 last:pb-4" aria-label={title}>
      <span
        aria-hidden
        data-testid="new-campaign-step-marker"
        data-done={ok ? "true" : "false"}
        data-checking={checking ? "true" : "false"}
        className={cn(
          "grid h-6 w-6 place-items-center rounded-full text-[12px] font-semibold tabular-nums",
          ok ? "bg-success/15 text-success" : "bg-creamDeep text-inkMuted",
        )}
      >
        {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : ok ? <Check className="h-3.5 w-3.5" strokeWidth={2.75} /> : n}
      </span>
      <div className="min-w-0">
        <h3 className="mb-3 text-[14px] font-semibold leading-6 text-ink">
          {title}
          <span className="sr-only">{checking ? " (checking)" : ok ? " (done)" : " (not done)"}</span>
        </h3>
        {children}
      </div>
    </section>
  );
}

export function CampaignStarted({ heading, text, rows, action }: { heading: string; text: string; rows: { label: string; value: string }[]; action: ReactNode }) {
  return (
    <div role="status" data-testid="new-campaign-started">
      <div className="flex items-center gap-3 pr-8">
        <span aria-hidden className="grid h-9 w-9 shrink-0 animate-fade-in place-items-center rounded-full bg-success/15 text-success motion-reduce:animate-none">
          <Check className="h-[18px] w-[18px]" strokeWidth={2.5} />
        </span>
        <h3 className="text-[18px] font-semibold leading-6 tracking-tight text-ink">{heading}</h3>
      </div>
      <p className="mt-3 text-[14px] leading-[22px] text-inkMuted">{text}</p>
      {rows.length > 0 && (
        <dl className="mt-4 divide-y divide-rule border-y border-rule text-[14px] leading-5">
          {rows.map((row) => (
            <div key={row.label} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-2.5">
              <dt className="text-inkMuted">{row.label}</dt>
              <dd className="min-w-0 break-words font-medium text-ink">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-5 flex justify-end">{action}</div>
    </div>
  );
}

function CheckRow({ ok, checking = false, label, hint }: { ok: boolean; checking?: boolean; label: string; hint?: ReactNode }) {
  if (ok && !checking) return null;
  return (
    <li className="flex items-start gap-3" data-checking={checking ? "true" : "false"}>
      <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center">
        {checking ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-inkMuted motion-reduce:animate-none" />
        ) : ok ? (
          <Check className="h-3.5 w-3.5 animate-fade-in text-success motion-reduce:animate-none" strokeWidth={2.5} />
        ) : (
          <TriangleAlert className="h-3.5 w-3.5 animate-fade-in text-warn motion-reduce:animate-none" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn("text-[14px] leading-5", checking ? "text-inkMuted" : "text-ink")}>{label}</span>
        <span className="sr-only">{checking ? "checking" : ok ? "passed" : "needs attention"}</span>
        {checking ? <span className="text-[13px] leading-5 text-inkMuted">Checking…</span> : hint && <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 text-inkMuted">{hint}</span>}
      </div>
    </li>
  );
}

export const DONE_CLOSE_MS = 6000;

export function NewCampaignDialog({
  slug,
  channelName,
  onClose,
  session: given,
}: {
  slug: string;
  channelName: string;
  onClose: () => void;
  session?: CampaignSession;
}) {
  const own = useRef<CampaignSession | null>(null);
  if (!given && !own.current) own.current = newCampaignSession();
  const session = given ?? own.current!;
  const held = session.planPending;
  const [kept] = useState(() => {
    const draft = session.draft ?? null;
    session.draft = null;
    return draft;
  });
  const planLock = useChannelPlanLock();
  const role = useWorkspaceOptional()?.role ?? null;
  const canSend = role !== null && !isMember(role);
  const [lists, setLists] = useState<CampaignList[] | null>(null);
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const [needsKey, setNeedsKey] = useState<string[]>([]);
  const [keyRejected, setKeyRejected] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tryN, setTryN] = useState(0);
  const [footer, setFooter] = useState<Footer>({ known: false, postal: false, problem: null });
  const [footerChecking, setFooterChecking] = useState(true);
  const [zaviSender, setZaviSender] = useState<ZaviSender>("loading");
  const [senderHold, setSenderHold] = useState<EmailSendHold | null | undefined>(undefined);
  const formRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const missingId = useId();
  const [pick, setPick] = useState(held?.key ?? kept?.pick ?? "");
  const [mode, setMode] = useState<Mode>(kept?.mode ?? "ai");
  const [prompt, setPrompt] = useState(held?.angle ?? kept?.prompt ?? "");
  const [paste, setPaste] = useState(kept?.paste ?? "");
  const [subject, setSubject] = useState(kept?.subject ?? "");
  const [preview, setPreview] = useState(kept?.preview ?? "");
  const [when, setWhen] = useState<When>(held ? "time" : (kept?.when ?? "approve"));
  const [date, setDate] = useState(held?.date ?? kept?.date ?? "");
  const [time, setTime] = useState(held?.time ?? kept?.time ?? "09:00");
  const [zone, setZone] = useState<string | null>(null);
  const [zoneFailed, setZoneFailed] = useState(false);
  const [zoneTry, setZoneTry] = useState(0);
  const [footerTry, setFooterTry] = useState(0);
  const [, setClockRead] = useState(0);
  const [busy, setBusy] = useState(false);
  const pressing = useRef(false);
  const [done, setDone] = useState<string | null>(null);
  const [doneHref, setDoneHref] = useState<string | null>(null);
  const [plannedDone, setPlannedDone] = useState<{ when: string; to: string; about: string } | null>(null);
  const [sent, setSent] = useState<SentEmail[] | null | undefined>(undefined);
  const [planUnsure, setPlanUnsure] = useState(held !== null);
  const [error, setError] = useState<string | null>(
    held ? "Zavi could not confirm the last plan went through. Press Plan it again: it is the same request, so it cannot be planned twice. Or check Coming up." : null,
  );

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [error]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!done || doneHref) return;
    const t = setTimeout(() => closeRef.current(), DONE_CLOSE_MS);
    return () => clearTimeout(t);
  }, [done, doneHref]);

  const quietLists = useRef(false);
  useRereadWhileFailed(loadError !== null, () => {
    quietLists.current = true;
    setTryN((n) => n + 1);
  });
  useEffect(() => {
    let live = true;
    const quiet = quietLists.current;
    quietLists.current = false;
    if (!quiet) setLoadError(null);
    getEmailTestLists({ fresh: tryN > 0 && !quiet })
      .then((r) => {
        if (!live) return;
        setLoadError(null);
        const out = campaignLists(Array.isArray(r?.routes) ? r.routes : []);
        setLists(out.lists);
        setUnreadable(out.unreadable);
        setNeedsKey(out.needsKey);
        setKeyRejected(out.keyRejected);
        const real = out.lists.filter((l) => !l.test);
        if (!session.planPending) setPick((p) => (real.some((l) => l.key === p) ? p : real.length === 1 ? real[0].key : ""));
      })
      .catch((e: unknown) => {
        if (!live) return;
        const why = readFailureMessage(e, "");
        setLoadError(why ? `Could not load your lists. ${why}` : "Could not load your lists.");
      });
    return () => {
      live = false;
    };
  }, [tryN]);

  useEffect(() => {
    const pending = session.planPending;
    if (!planUnsure || !lists || !pending) return;
    if (lists.some((l) => l.key === pending.key && !l.test)) return;
    session.planPending = null;
    session.planId = newPlanRequestId();
    setPlanUnsure(false);
    const real = lists.filter((l) => !l.test);
    setPick(real.length === 1 ? real[0].key : "");
    setError(HELD_LIST_GONE);
  }, [lists, planUnsure]);

  useEffect(() => {
    let live = true;
    setFooterChecking(true);
    loadFooterPostal().then((postal) => {
      if (!live) return;
      setFooterChecking(false);
      const problem = postalAddressProblem(postal);
      setFooter({ known: postal !== null, postal: problem === null, problem });
    });
    return () => {
      live = false;
    };
  }, [footerTry]);

  const [senderTry, setSenderTry] = useState(0);
  const [sendgridSetup, setSendgridSetup] = useState<SendgridSetup>("loading");
  const [sendgridTry, setSendgridTry] = useState(0);
  useEffect(() => {
    let live = true;
    if (senderTry > 0) setZaviSender("loading");
    getSendingDomain()
      .then((s) => {
        if (!live) return;
        if (typeof s?.bulk_email_ready !== "boolean") setZaviSender("unknown");
        else setZaviSender(s.bulk_email_ready && s.domain?.status === "verified" ? "ready" : "not_ready");
      })
      .catch(() => live && setZaviSender("unknown"));
    return () => {
      live = false;
    };
  }, [senderTry]);

  useEffect(() => {
    let live = true;
    loadEmailPause()
      .then((s) => live && setSenderHold(s.held))
      .catch(() => live && setSenderHold(null));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    getSentEmails()
      .then((v) => live && setSent(Array.isArray(v) ? v : []))
      .catch(() => live && setSent(null));
    return () => {
      live = false;
    };
  }, []);

  const chosen = lists?.find((l) => l.key === pick && !l.test) ?? null;
  const subj = subject.trim();
  const prev = preview.trim();
  const brief = prompt.trim();
  const body = paste.trim();
  const planned = mode === "ai" && when === "time";
  const subjectBad = (mode === "paste" && subj.length === 0) || subj.length > SUBJECT_MAX || ONE_LINE.test(subject);
  const previewBad = prev.length > SUBJECT_MAX || ONE_LINE.test(preview);
  const contentOk =
    mode === "ai"
      ? brief.length >= BRIEF_MIN && brief.length <= (planned ? PLANNED_BRIEF_MAX : BRIEF_MAX) && (planned || (!subjectBad && !previewBad))
      : body.length >= PASTE_MIN && body.length <= PASTE_MAX && !subjectBad && !previewBad;
  const tooSoon = planned && !planUnsure && !!zone && !!date && !!time && plannedTooSoon({ date, time }, zone);
  const tooFar = planned && !planUnsure && !!date && !!time && !tooSoon && plannedTooFar({ date, time }, zone);
  const whenOk = when === "approve" || (planned && !!date && !!time && !tooSoon && !tooFar);
  useEffect(() => {
    if (!planned || zone) return;
    let live = true;
    setZoneFailed(false);
    getPlan()
      .then((v) => {
        if (!live) return;
        if (v.timezone && !v.timezone_unread) setZone(v.timezone);
        else setZoneFailed(true);
      })
      .catch(() => live && setZoneFailed(true));
    return () => {
      live = false;
    };
  }, [planned, zone, zoneTry]);
  const sendgridRoute = chosen?.route === "sendgrid";
  useEffect(() => {
    if (!sendgridRoute) return;
    let live = true;
    setSendgridSetup("loading");
    Promise.all([getSendgridSenders(), getSendgridGroups(), getEmailChannelSettings()])
      .then(([senders, groups, settings]) => {
        if (live) setSendgridSetup(sendgridSetupProblem(senders, groups, settings[SENDER_FIELD]?.[0]?.trim() ?? "", settings[GROUP_FIELD]?.[0]?.trim() ?? "") ?? "ready");
      })
      .catch(() => live && setSendgridSetup("unknown"));
    return () => {
      live = false;
    };
  }, [sendgridRoute, sendgridTry]);
  const sendgridBlocks = sendgridRoute && sendgridSetup !== "ready";
  const footerUnknown = !footer.known;
  const footerBlocks = !footer.postal;
  const emptyList = chosen?.people === 0;
  const needsConsent = chosen?.needsConsent === true && !(planned && chosen.consentedVersion === true);
  const zaviRoute = chosen?.route === "zavi_list";
  const listsChecking = lists === null && !loadError;
  const blockingChecksRunning = footerChecking || listsChecking || (zaviRoute && zaviSender === "loading") || (sendgridRoute && sendgridSetup === "loading");
  const checksRunning = blockingChecksRunning || sent === undefined;
  const zaviNotReady = zaviRoute && zaviSender === "not_ready";
  const zaviStopped = zaviRoute && !!senderHold;
  const zaviBlocks = zaviRoute && (zaviSender !== "ready" || senderHold !== null);
  const lastToList =
    chosen && sent
      ? sent
          .filter((e) => e.route === chosen.route && (e.list_id ? e.list_id === chosen.id : e.list_name === chosen.name) && e.started_at)
          .map((e) => Date.parse(e.started_at as string))
          .filter((t) => Number.isFinite(t) && Date.now() - t < LIST_REST_DAYS * 86_400_000)
          .sort((a, b) => b - a)[0] ?? null
      : null;
  const valid = canSend && !!chosen && contentOk && whenOk && !footerBlocks && !emptyList && !needsConsent && !zaviBlocks && !sendgridBlocks;

  const locked = busy || planUnsure;
  const briefMax = planned ? PLANNED_BRIEF_MAX : BRIEF_MAX;
  const missing: Missing | null = (() => {
    if (valid || !canSend || busy) return null;
    if (!chosen) {
      if (lists === null && !loadError) return null;
      return { text: lists !== null && lists.length === 0 && unreadable.length === 0 && keyRejected.length === 0 ? "Add a list to continue" : "Pick a list to continue", step: "to", target: LIST_TARGET };
    }
    if (emptyList) return { text: "Pick a list with people on it", step: "to", target: LIST_TARGET };
    if (needsConsent) return { text: "Confirm this list agreed to hear from you, or pick another", step: "checks", target: '[data-field="consent"]' };
    if (zaviStopped) return { text: "Wait for Zavi's sender to be back or pick a list from your email tool", step: "to", target: LIST_TARGET };
    if (zaviNotReady) return { text: "Finish Sending setup or pick a list from your email tool", step: "checks", target: '[data-field="sending"]' };
    if (zaviRoute && zaviSender === "unknown") return { text: "Check Zavi's sender again to continue", step: "checks", target: '[data-field="sending-retry"]' };
    if (!footerChecking && footer.known && footerBlocks) return { text: footer.problem === "placeholder" ? "Replace the placeholder postal address to continue" : "Add your postal address to continue", step: "checks", target: '[data-field="postal"]' };
    if (sendgridRoute && sendgridSetup === "sender") return { text: "Pick a SendGrid sender to continue", step: "checks", target: '[data-field="sendgrid-setup"]' };
    if (sendgridRoute && sendgridSetup === "group") return { text: "Pick a SendGrid unsubscribe group to continue", step: "checks", target: '[data-field="sendgrid-setup"]' };
    if (sendgridRoute && sendgridSetup === "unknown") return { text: "Check SendGrid again to continue", step: "checks", target: '[data-field="sendgrid-retry"]' };
    if (mode === "ai" && brief.length < BRIEF_MIN) return { text: "Say what the email should do", step: "email", target: '[data-field="brief"]' };
    if (mode === "ai" && brief.length > briefMax) return { text: `Shorten your note to ${briefMax.toLocaleString("en-US")} characters`, step: "email", target: '[data-field="brief"]' };
    if (mode === "paste" && body.length < PASTE_MIN) return { text: "Paste your email to continue", step: "email", target: '[data-field="body"]' };
    if (mode === "paste" && body.length > PASTE_MAX) return { text: `Shorten your email to ${PASTE_MAX.toLocaleString("en-US")} characters`, step: "email", target: '[data-field="body"]' };
    if (!planned && subjectBad) return { text: mode === "paste" && subj.length === 0 ? "Add a subject to continue" : "Fix the subject to continue", step: "email", target: '[data-field="subject"]' };
    if (!planned && previewBad) return { text: "Fix the preview text to continue", step: "email", target: '[data-field="preview"]' };
    if (blockingChecksRunning) return { text: "Zavi is checking your setup", step: "checks", target: '[data-testid="new-campaign-checks"]' };
    if (footerUnknown) return { text: "Check your footer again to continue", step: "checks", target: '[data-field="footer-retry"]' };
    if (footerBlocks) return { text: footer.problem === "placeholder" ? "Replace the placeholder postal address to continue" : "Add your postal address to continue", step: "checks", target: '[data-field="postal"]' };
    if (tooSoon) return { text: `Pick a time at least ${PLAN_LEAD_HOURS} hours ahead to continue`, step: "when", target: '[data-field="day"]' };
    if (tooFar) return { text: `Pick a day at most ${PLAN_MAX_DAYS} days ahead to continue`, step: "when", target: '[data-field="day"]' };
    if (!whenOk) return { text: "Pick a day and time to continue", step: "when", target: '[data-field="day"]' };
    return null;
  })();
  const reveal = (need: Missing) => {
    const section = formRef.current?.querySelector<HTMLElement>(`[data-step="${need.step}"]`);
    if (!section) return;
    section.scrollIntoView?.({ behavior: "smooth", block: "center" });
    (section.querySelector<HTMLElement>(need.target) ?? section).focus({ preventScroll: true });
  };
  const goto = (section: "footer" | "contacts" | "sending") => {
    session.draft = { pick, mode, prompt, paste, subject, preview, when, date, time };
    onClose();
    gotoEmailSettings(section);
  };

  const dropHeldPlan = () => {
    session.planId = newPlanRequestId();
    session.planPending = null;
    setPlanUnsure(false);
    setError(HELD_PLAN_DROPPED);
  };

  async function submit() {
    if (!chosen || !valid || busy || pressing.current) return;
    if (planned && !planUnsure && ((zone && plannedTooSoon({ date, time }, zone)) || plannedTooFar({ date, time }, zone))) {
      setClockRead((n) => n + 1);
      return;
    }
    pressing.current = true;
    try {
      await press(chosen);
    } finally {
      pressing.current = false;
    }
  }

  async function press(chosen: CampaignList) {
    setBusy(true);
    setError(null);
    if (planned) {
      try {
        const out = await planEmail({ route: chosen.route, list_id: chosen.id, date, time, angle: brief, request_id: session.planId });
        window.dispatchEvent(new CustomEvent(EMAIL_PLAN_CHANGED_EVENT));
        session.planId = newPlanRequestId();
        session.planPending = null;
        setPlanUnsure(false);
        setPlannedDone({ when: out.label, to: out.list_name || chosen.name, about: brief });
        setDone(`Zavi drafts it the day before. ${PLANNED_SEND_RULE}`);
      } catch (e) {
        if (isAmbiguousPlanError(e)) {
          window.dispatchEvent(new CustomEvent(EMAIL_PLAN_CHANGED_EVENT));
          session.planPending = { key: chosen.key, angle: brief, date, time };
          setPlanUnsure(true);
          setError("Zavi could not confirm it was planned. Press Plan it again: it is the same request, so it cannot be planned twice. Or close this and check Coming up.");
        } else {
          session.planId = newPlanRequestId();
          session.planPending = null;
          setPlanUnsure(false);
          setError((e as Error).message || "Zavi could not plan this. Try again.");
        }
      } finally {
        setBusy(false);
      }
      return;
    }
    if (mode !== "ai") {
      const pasteIn = { route: chosen.route, list_id: chosen.id, pasted: { subject: subj, ...(prev ? { preview_text: prev } : {}), body } };
      const pasteAsk = JSON.stringify({ paste: pasteIn });
      if (session.lastAsk !== null && session.lastAsk !== pasteAsk) session.runId = newRequestId();
      session.lastAsk = pasteAsk;
      const rid = session.runId;
      try {
        const card = await pasteEmail(pasteIn, rid);
        if (session.runId === rid) {
          session.runId = newRequestId();
          session.lastAsk = null;
        }
        announceChannelActionsChanged(slug);
        setDoneHref(card.link);
        setDone(PASTE_DONE);
      } catch (e) {
        if (e instanceof PasteEmailError && e.status >= 400 && e.status < 500 && !e.code.startsWith("idempotency_") && session.runId === rid) {
          session.runId = newRequestId();
          session.lastAsk = null;
        }
        if (e instanceof PasteEmailError && upgradeOnPlanRefusal(planLock, new ApiError(e.message, e.status, { error: { code: e.code, required_tier: e.requiredTier } }))) {
          onClose();
          return;
        }
        setError((e as Error).message || "Zavi could not add this. Try again.");
      } finally {
        setBusy(false);
      }
      return;
    }
    const inputs: Record<string, unknown> =
      mode === "ai"
        ? { route: chosen.route, list_id: chosen.id, brief, ...(subj ? { subject: subj } : {}), ...(prev ? { preview_text: prev } : {}) }
        : { route: chosen.route, list_id: chosen.id, pasted: { subject: subj, ...(prev ? { preview_text: prev } : {}), body } };
    const asked = JSON.stringify(inputs);
    if (session.lastAsk !== null && session.lastAsk !== asked) session.runId = newRequestId();
    session.lastAsk = asked;
    const rid = session.runId;
    try {
      let r = await startTopAction(slug, NEW_CAMPAIGN_KEY, rid, inputs);
      for (let i = 0; i < 3 && !r.run_id; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        r = await startTopAction(slug, NEW_CAMPAIGN_KEY, rid, inputs);
      }
      if (!r.run_id) {
        announceChannelRunStarted(slug);
        throw new Error(STILL_STARTING);
      }
      announceChannelRunStarted(slug, r.run_id);
      if (session.runId === rid) {
        session.runId = newRequestId();
        session.lastAsk = null;
      }
      setDone(
        mode === "ai"
          ? "Zavi is writing it. The email lands on this page for you to send yourself a test and approve. Nothing is sent before that."
          : PASTE_DONE,
      );
    } catch (e) {
      if (upgradeOnPlanRefusal(planLock, e)) {
        onClose();
        return;
      }
      if (e instanceof ApiError && e.status === 402) setError(e.message || "You are out of credits for this. Top up, then try again.");
      else if (e instanceof ApiError && (e.status === 0 || (e.status >= 500 && e.message === PLAN_FALLBACK))) setError(WRITE_UNSURE);
      else setError((e as Error).message || "Zavi could not start this. Try again.");
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && session.runId === rid) {
        session.runId = newRequestId();
        session.lastAsk = null;
      }
    } finally {
      setBusy(false);
    }
  }

  const subjectChecked = mode === "paste" || (!!subj && !planned);
  const subjectFits = subj.length > 0 && subj.length <= SUBJECT_GOOD;
  const allChecksPass =
    !checksRunning && footer.postal && !!chosen && !emptyList && !needsConsent && !zaviBlocks && !sendgridBlocks && sent !== null && lastToList === null && (!subjectChecked || subjectFits);
  const noLists = lists !== null && lists.length === 0 && unreadable.length === 0 && needsKey.length === 0 && keyRejected.length === 0;
  const quietUnreadable = lists !== null && lists.length > 0;
  const seg = (on: boolean) =>
    cn(
      "inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[8px] px-4 text-[13px] font-medium transition-colors disabled:cursor-default",
      on ? "bg-white text-ink shadow-[0_1px_2px_rgb(0_0_0/0.10),0_0_0_1px_rgb(var(--c-rule))]" : "text-inkMuted hover:text-ink",
    );
  const counter = (n: number, max: number) => <span className={cn("shrink-0 whitespace-nowrap tabular-nums", n > max && "text-danger")}>{`${n.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`}</span>;

  return (
    <ActionModal
      eyebrow={channelName}
      title="New campaign"
      sub=""
      onClose={onClose}
      busy={busy}
      hint={
        done ? undefined : (
          <span className="flex flex-col items-start gap-1">
            {missing && (
              <button
                type="button"
                id={missingId}
                data-testid="new-campaign-missing"
                className="inline-flex items-center gap-2 text-left text-[13px] font-medium leading-5 text-ink"
                onClick={() => reveal(missing)}
              >
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                {missing.text}
              </button>
            )}
            <span className="text-[12px] leading-4 text-inkMuted">{canSend ? (planned ? PLANNED_SEND_RULE : "Nothing is sent until an owner or admin approves it.") : "Only an owner or admin can start a campaign."}</span>
          </span>
        )
      }
      footer={
        <>
          <button type="button" className={cn(m.cancel, "inline-flex h-11 items-center justify-center whitespace-nowrap py-0")} disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={cn(m.primary, "inline-flex h-11 items-center justify-center whitespace-nowrap py-0")} disabled={!valid || busy} aria-describedby={missing ? missingId : undefined} onClick={() => void submit()}>
            {busy ? "Starting…" : planned ? "Plan it" : mode === "ai" ? "Write it" : "Add it for approval"}
          </button>
        </>
      }
      bare={!!done}
      size={done ? "md" : "lg"}
    >
      {done ? (
        <CampaignStarted
          heading={planned ? "Email planned" : mode === "ai" ? "Zavi is writing your email" : "Your email is added"}
          text={done}
          rows={
            plannedDone
              ? [
                  { label: "To", value: plannedDone.to },
                  { label: "When", value: plannedDone.when },
                  { label: "About", value: plannedDone.about },
                ]
              : [
                  ...(chosen?.name ? [{ label: "To", value: chosen.name }] : []),
                  ...(subj ? [{ label: "Subject", value: subj }] : []),
                ]
          }
          action={
            doneHref ? (
              <a href={doneHref} className={cn(m.primary, "inline-flex h-10 items-center justify-center px-5 py-0")}>
                Open the email
              </a>
            ) : (
              <button type="button" className={cn(m.primary, "inline-flex h-10 items-center justify-center px-5 py-0")} onClick={onClose}>
                Done
              </button>
            )
          }
        />
      ) : (
      <div ref={formRef} data-testid="new-campaign" className="-my-4">
        {error && (
          <p ref={errorRef} role="alert" className={cn("mt-4 flex flex-wrap items-center gap-x-2 gap-y-1", m.error)}>
            {error}
            {planUnsure && !busy && (
              <button type="button" data-testid="new-campaign-drop-plan" className={SMALL_BUTTON} onClick={dropHeldPlan}>
                Start over
              </button>
            )}
          </p>
        )}
        <Step n={1} step="to" ok={!!chosen}>
          {loadError && (
            <p role="alert" className={cn("mb-2 flex flex-wrap items-center gap-2", m.error)}>
              {loadError}
              <button type="button" className={SMALL_BUTTON} onClick={() => setTryN((n) => n + 1)}>
                Retry
              </button>
            </p>
          )}
          {lists === null && !loadError && <p className="text-[14px] leading-5 text-inkMuted">Loading your lists…</p>}
          {noLists && (
            <p data-testid="new-campaign-no-lists" className="text-[14px] leading-6 text-inkMuted">
              No list to send to yet. Connect your email tool on Overview, or{" "}
              <button type="button" className="font-medium text-ink underline disabled:opacity-50" disabled={busy} onClick={() => goto("contacts")}>
                upload contacts in Settings
              </button>
              .
            </p>
          )}
          {lists && lists.length > 0 && (
            <div role="radiogroup" aria-label="Who gets it" className="grid gap-2.5 sm:grid-cols-2">
              {lists.map((l) => (
                <label key={l.key} className={listCard(pick === l.key, l.test)}>
                  <Radio name="campaign-list" value={l.key} checked={pick === l.key} disabled={l.test || locked} onChange={() => setPick(l.key)} />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5 text-[14px] font-medium leading-5 text-ink">
                      {l.name}
                      {l.test && <span className="rounded-full bg-creamDeep px-2 py-0.5 text-[11px] font-medium text-inkMuted">Test</span>}
                    </span>
                    <span className="mt-0.5 block text-[13px] leading-5 text-inkMuted">
                      {[l.people !== null ? `${l.people.toLocaleString("en-US")} ${l.people === 1 ? "person" : "people"}` : null, l.source].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {lists !== null &&
            needsKey.map((label) => (
              <p key={label} data-testid="new-campaign-needs-key" className={cn("text-[13px] leading-5 text-inkMuted", lists.length > 0 && "mt-2")}>
                {needsKeyLine(label)}
              </p>
            ))}
          {lists !== null &&
            keyRejected.map((label) => (
              <p
                key={label}
                data-testid="new-campaign-key-rejected"
                role={quietUnreadable ? undefined : "alert"}
                className={cn("mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-5", quietUnreadable ? "text-inkMuted" : "text-danger")}
              >
                {keyRejectedListsLine(label)}
                <button type="button" className={SMALL_BUTTON} disabled={busy} onClick={() => goto("sending")}>
                  Reconnect in Sending
                </button>
              </p>
            ))}
          {unreadable.length > 0 && (
            <p
              data-testid="new-campaign-unreadable"
              role={quietUnreadable ? undefined : "alert"}
              className={cn("mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-5", quietUnreadable ? "text-inkMuted" : "text-danger")}
            >
              {`Lists from ${unreadable.join(", ")} could not be loaded just now.`}
              <button type="button" className={SMALL_BUTTON} onClick={() => setTryN((n) => n + 1)}>
                Retry
              </button>
            </p>
          )}
        </Step>

        <Step n={2} step="email" ok={contentOk}>
          <div role="group" aria-label="How to write the email" className="mb-3 inline-flex items-center gap-0.5 rounded-[11px] bg-creamDeep p-[3px]">
            <button type="button" aria-pressed={mode === "ai"} disabled={locked} className={seg(mode === "ai")} onClick={() => setMode("ai")}>
              Zavi writes it
            </button>
            <button
              type="button"
              aria-pressed={mode === "paste"}
              disabled={locked}
              className={seg(mode === "paste")}
              onClick={() => {
                setMode("paste");
                setWhen("approve");
              }}
            >
              Paste my email
            </button>
          </div>
          {mode === "ai" ? (
            <div>
              <textarea
                aria-label="What should this email do?"
                data-field="brief"
                className={cn(FIELD, "block min-h-[112px] resize-y py-3 leading-6")}
                value={prompt}
                maxLength={BRIEF_MAX}
                disabled={locked}
                placeholder="What should this email do? e.g. Tell new signups about our spring sale: 20% off every plan until Sunday."
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {IDEAS.map((idea) => (
                  <button
                    key={idea}
                    type="button"
                    disabled={locked}
                    onClick={() => setPrompt((p) => withIdea(idea, p).slice(0, BRIEF_MAX))}
                    className="inline-flex h-9 cursor-pointer items-center rounded-full border border-rule px-3.5 text-[13px] text-inkSoft transition-colors hover:border-inkLight hover:bg-creamDeep hover:text-ink disabled:cursor-default disabled:opacity-50"
                  >
                    {idea}
                  </button>
                ))}
              </div>
              <p className="mt-2.5 flex justify-end text-[12px] leading-5 text-inkMuted">
                {counter(brief.length, planned ? PLANNED_BRIEF_MAX : BRIEF_MAX)}
              </p>
            </div>
          ) : (
            <div>
              <textarea
                aria-label="Email body"
                data-field="body"
                className={cn(FIELD, "block h-40 min-h-[96px] resize-y py-2.5")}
                value={paste}
                maxLength={PASTE_MAX}
                disabled={busy}
                placeholder="Paste the email body here. Zavi adds your footer and unsubscribe link."
                onChange={(e) => setPaste(e.target.value)}
                onPaste={(e) => {
                  const kept = pastedWithLinks(e.clipboardData.getData("text/html"), e.clipboardData.getData("text/plain"));
                  if (kept === null) return;
                  e.preventDefault();
                  const el = e.currentTarget;
                  const next = el.value.slice(0, el.selectionStart) + kept + el.value.slice(el.selectionEnd);
                  setPaste(next.slice(0, PASTE_MAX));
                }}
              />
              <p className="mt-2.5 flex justify-between gap-3 text-[12px] leading-5 text-inkMuted">
                <span>{PASTE_HINT}</span>
                {counter(body.length, PASTE_MAX)}
              </p>
              {(() => {
                const tag = mergeTagIn(body, subj, prev);
                const html = looksLikeHtml(body);
                if (!tag && !html) return null;
                return (
                  <div role="note" data-paste-warning className="mt-2 space-y-1 text-[12px] text-warn">
                    {tag && <p>{mergeTagWarning(tag)}</p>}
                    {html && <p>{HTML_SOURCE_WARNING}</p>}
                  </div>
                );
              })()}
            </div>
          )}
          {!planned && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-[13px] font-medium text-inkMuted">
                {mode === "ai" ? "Subject (optional)" : "Subject"}
                <input
                  data-field="subject"
                  className={cn(FIELD, "h-11")}
                  value={subject}
                  maxLength={SUBJECT_MAX + 50}
                  disabled={busy}
                  placeholder={mode === "ai" ? "Zavi writes one if you leave this empty" : ""}
                  aria-invalid={subject.length > 0 && subjectBad}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </label>
              <label className="grid gap-1.5 text-[13px] font-medium text-inkMuted">
                Preview text (optional)
                <input data-field="preview" className={cn(FIELD, "h-11")} value={preview} maxLength={SUBJECT_MAX + 50} disabled={busy} placeholder="The short line beside the subject in the inbox" aria-invalid={previewBad} onChange={(e) => setPreview(e.target.value)} />
              </label>
            </div>
          )}
        </Step>

        <Step n={3} step="checks" ok={!!chosen && contentOk && footer.postal && !emptyList && !needsConsent && !zaviBlocks && !sendgridBlocks} checking={checksRunning}>
          <ul data-testid="new-campaign-checks" className="flex flex-col gap-3">
            <CheckRow
              ok={footer.postal}
              checking={footerChecking}
              label="Footer has your postal address"
              hint={
                footer.postal ? undefined : footer.known ? (
                  <>
                    {footer.problem === "placeholder" && <span data-testid="new-campaign-postal-placeholder">It still looks like a placeholder.</span>}
                    <button type="button" data-field="postal" className={SMALL_BUTTON} disabled={busy} onClick={() => goto("footer")}>
                      {footer.problem === "placeholder" ? "Fix it in Settings" : "Add it in Settings"}
                    </button>
                  </>
                ) : (
                  <>
                    <span>Zavi could not read your footer just now</span>
                    <button type="button" data-field="footer-retry" className={SMALL_BUTTON} disabled={busy} onClick={() => setFooterTry((n) => n + 1)}>
                      Try again
                    </button>
                  </>
                )
              }
            />
            {zaviRoute && (
              <CheckRow
                ok={zaviSender === "ready" && senderHold === null}
                checking={zaviSender === "loading" || (senderHold === undefined && zaviSender === "ready")}
                label={senderHold ? EMAIL_SENDING_COPY.stoppedByZavi : "Zavi can send to this list"}
                hint={
                  senderHold ? (
                    <span data-testid="new-campaign-zavi-sender-stopped">{`${EMAIL_SENDING_COPY.held[senderHold]} ${ZAVI_SENDER_STOPPED}`}</span>
                  ) : zaviSender === "not_ready" ? (
                    <>
                      <span data-testid="new-campaign-zavi-sender">{ZAVI_SENDER_NOT_READY}</span>
                      <button type="button" data-field="sending" className={SMALL_BUTTON} disabled={busy} onClick={() => goto("sending")}>
                        Set it up in Settings
                      </button>
                    </>
                  ) : zaviSender === "unknown" ? (
                    <>
                      <span data-testid="new-campaign-zavi-sender-unknown">Zavi could not check its sender just now</span>
                      <button type="button" data-field="sending-retry" className={SMALL_BUTTON} disabled={busy} onClick={() => setSenderTry((n) => n + 1)}>
                        Check again
                      </button>
                    </>
                  ) : zaviSender === "loading" || senderHold === undefined ? (
                    "Checking…"
                  ) : undefined
                }
              />
            )}
            {sendgridRoute && (
              <CheckRow
                ok={sendgridSetup === "ready"}
                checking={sendgridSetup === "loading"}
                label={SENDGRID_SETUP_COPY.label}
                hint={
                  sendgridSetup === "sender" || sendgridSetup === "group" ? (
                    <>
                      <span data-testid="new-campaign-sendgrid-setup">{SENDGRID_SETUP_COPY[sendgridSetup]}</span>
                      <button type="button" data-field="sendgrid-setup" className={SMALL_BUTTON} disabled={busy} onClick={() => goto("sending")}>
                        Set it up in Settings
                      </button>
                    </>
                  ) : sendgridSetup === "unknown" ? (
                    <>
                      <span data-testid="new-campaign-sendgrid-unknown">{SENDGRID_SETUP_COPY.unknown}</span>
                      <button type="button" data-field="sendgrid-retry" className={SMALL_BUTTON} disabled={busy} onClick={() => setSendgridTry((n) => n + 1)}>
                        Check again
                      </button>
                    </>
                  ) : sendgridSetup === "loading" ? (
                    "Checking…"
                  ) : undefined
                }
              />
            )}
            {subjectChecked && <CheckRow ok={subjectFits} label={`Subject under ${SUBJECT_GOOD} characters`} hint={subj ? `${subj.length} characters` : "Add a subject"} />}
            <CheckRow
              ok={sent !== null && lastToList === null}
              checking={sent === undefined}
              label={`One email per list in ${LIST_REST_DAYS} days`}
              hint={
                lastToList !== null
                  ? `This list got one on ${new Date(lastToList).toLocaleDateString("en-US", { month: "short", day: "numeric" })}. You can still send it.`
                  : sent === null
                    ? "Zavi could not check past sends just now"
                    : sent === undefined
                      ? "Checking…"
                      : undefined
              }
            />
            <CheckRow
              ok={!!chosen && !emptyList && !needsConsent}
              checking={listsChecking}
              label="A real list with people on it"
              hint={
                !chosen ? (
                  "Pick a list"
                ) : emptyList ? (
                  "This list has no one on it"
                ) : needsConsent ? (
                  <>
                    <span data-testid="new-campaign-list-consent">Nobody has confirmed the people on this list agreed to hear from you, so Zavi cannot send to it</span>
                    <button type="button" data-field="consent" className={SMALL_BUTTON} disabled={busy} onClick={() => goto("contacts")}>
                      Confirm it in Settings
                    </button>
                  </>
                ) : undefined
              }
            />
            {allChecksPass && (
              <li data-testid="new-campaign-checks-passed" className="flex items-center gap-3 text-[14px] leading-5 text-ink">
                <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <Check className="h-3.5 w-3.5 animate-fade-in text-success motion-reduce:animate-none" strokeWidth={2.5} />
                </span>
                All checks passed
              </li>
            )}
            {chosen?.needsConsent === true && !needsConsent && (
              <li data-testid="new-campaign-list-newer-import" className="pl-8 text-[13px] leading-5 text-inkMuted">
                A newer import is waiting for consent. This email goes only to the people already confirmed.
              </li>
            )}
          </ul>
        </Step>

        <Step n={4} step="when" ok={whenOk}>
          <div role="radiogroup" aria-label="When it goes out" className="flex flex-col gap-2.5 text-[14px] text-ink">
            <label className={cn("items-center", whenOption(when === "approve"))}>
              <Radio name="campaign-when" checked={when === "approve"} disabled={locked} onChange={() => setWhen("approve")} />
              <span className="font-medium">As soon as it&apos;s approved</span>
            </label>
            <div className={cn("flex-wrap items-center", whenOption(when === "time", mode === "paste"), "cursor-default")}>
              <label className={cn("flex flex-1 items-center gap-3", mode === "paste" ? "cursor-not-allowed" : "cursor-pointer")}>
                <Radio name="campaign-when" checked={when === "time"} disabled={locked || mode === "paste"} onChange={() => setWhen("time")} />
                <span className="font-medium">Pick a time</span>
              </label>
              {mode === "paste" ? (
                <span className="text-[13px] leading-5 text-inkMuted">Only for emails Zavi writes</span>
              ) : (
                when === "time" && (
                  <span className="flex basis-full pl-8">
                    <PlanWhenFields zone={zone} date={date} time={time} up invalid={tooSoon || tooFar} disabled={locked} onDate={setDate} onTime={setTime} />
                  </span>
                )
              )}
            </div>
            {tooSoon && (
              <p data-testid="new-campaign-too-soon" className="text-[13px] leading-5 text-danger">
                {`${PLAN_TOO_SOON} To send sooner, pick As soon as it's approved.`}
              </p>
            )}
            {tooFar && (
              <p data-testid="new-campaign-too-far" className="text-[13px] leading-5 text-danger">
                {PLAN_TOO_FAR}
              </p>
            )}
            {planned && zoneFailed && !zone && (
              <p data-testid="new-campaign-zone-unread" className="flex flex-wrap items-center gap-2 text-[13px] leading-5 text-danger">
                Zavi could not read your workspace&apos;s time zone, so it cannot check this time yet.
                <button type="button" data-field="zone-retry" className={SMALL_BUTTON} disabled={busy} onClick={() => setZoneTry((n) => n + 1)}>
                  Try again
                </button>
              </p>
            )}
            {planned && (subj || prev) && (
              <p data-testid="new-campaign-plan-drops-lines" className="px-1 text-[13px] leading-5 text-warn">
                {PLAN_DROPS_LINES}
              </p>
            )}
            {planned && <p className="px-1 text-[13px] leading-5 text-inkMuted">{`On your workspace's clock${zone ? `, ${zoneName(zone, date, time)}` : ""}. Zavi drafts it the day before from your note, up to ${PLANNED_BRIEF_MAX} characters.`}</p>}
          </div>
        </Step>
      </div>
      )}
    </ActionModal>
  );
}
