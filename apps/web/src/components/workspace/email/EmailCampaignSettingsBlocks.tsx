"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { Switch } from "@/components/ui/Switch";
import { BrandPreview } from "./BrandPreview";
import { Skeleton } from "../Skeleton";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { isMember } from "@/lib/members";
import { connectorSetupHref } from "../growth/growthPresentation";
import { useAutoDismissMessage } from "./useAutoDismissMessage";
import {
  draftEmailTemplate,
  getEmailAutoSend,
  EmailSettingsError,
  getEmailChannelSettings,
  getEmailTemplate,
  getEmailTestLists,
  getSendgridGroups,
  getSendgridSenders,
  GROUP_FIELD,
  goToEmailFooterSettings,
  saveEmailChannelSetting,
  saveEmailTemplate,
  SENDER_FIELD,
  SENDGRID_CONNECTED_EVENT,
  setEmailAutoSend,
  type EmailAutoSend,
  type EmailTemplate,
  type SendgridGroup,
  type SendgridSender,
  type TestListRouteView,
} from "@/lib/workspace/emailCampaignSettingsApi";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";
const INPUT = `h-10 w-full min-w-0 rounded-[10px] border border-rule bg-cream px-3 text-[16px] leading-5 text-ink outline-none placeholder:text-inkLight focus:border-ink/40 disabled:cursor-not-allowed disabled:bg-creamDeep disabled:text-inkMuted sm:text-[14px] ${FOCUS}`;
const BTN = `inline-flex h-10 shrink-0 items-center justify-center rounded-cta border border-rule bg-white px-3.5 cursor-pointer transition-colors hover:border-inkLight hover:bg-creamDeep text-[13px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const BTN_PRIMARY = `inline-flex h-10 shrink-0 items-center justify-center rounded-cta border border-ink bg-ink px-4 cursor-pointer transition-opacity hover:opacity-90 text-[13px] font-medium text-cream disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const ROW = "grid gap-2 p-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-6";
const ROW_HEAD = "text-[13px] font-medium leading-5 text-ink sm:pt-1.5";
const ROW_LABEL = "text-[13px] font-medium leading-5 text-ink sm:pt-2.5";
const ROW_HELP = "mt-0.5 block text-[12px] font-normal leading-[18px] text-inkMuted";
const LABEL = "grid gap-1.5 text-[13px] font-medium text-ink";
const NOTE = "text-[13px] leading-5";
const CHEVRON = "pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-inkMuted";
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const pickerValue = (v: string) => {
  const hex = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(hex)) return `#${[...hex.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
  return "#000000";
};

function ColorField({ id, label, value, disabled, onChange }: { id: string; label: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const valid = HEX.test(value.trim());
  return (
    <div className="grid w-40 min-w-0 gap-1.5">
      <label htmlFor={id} className="text-[12px] font-medium text-inkMuted">
        {label}
      </label>
      <span className="relative block min-w-0">
        <input
          type="color"
          aria-label={`Pick ${label.toLowerCase()}`}
          data-testid={`swatch-${label}`}
          value={pickerValue(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={`absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 cursor-pointer appearance-none rounded-full border border-rule bg-transparent p-0 disabled:cursor-not-allowed [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-0 ${valid ? "" : "[&::-moz-color-swatch]:opacity-0 [&::-webkit-color-swatch]:opacity-0"} ${FOCUS}`}
        />
        <input id={id} className={`${INPUT} pl-10`} value={value} placeholder="#1a73e8" disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      </span>
    </div>
  );
}

function useCanEdit(): boolean {
  const role = useWorkspaceOptional()?.role ?? null;
  return role !== null && !isMember(role);
}

const LoadError = ({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
    {message}
    <button type="button" className={BTN} onClick={onRetry}>
      Retry
    </button>
  </p>
);

export const CONNECT_HREF = connectorSetupHref("email");
export const connectToolHref = (name: string) =>
  name === "SendGrid" ? CONNECT_HREF : `/workspace?tab=brain&q=${encodeURIComponent(name)}#integrations`;

function RowBlock({ id, title, intro, children }: { id: string; title: string; intro?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className={ROW}>
      <div>
        <h3 id={`${id}-title`} className={ROW_HEAD}>
          {title}
        </h3>
        {intro && <small className={ROW_HELP}>{intro}</small>}
      </div>
      <div className="grid min-w-0 content-start gap-3">{children}</div>
    </section>
  );
}

const Loading = () => <Skeleton className="h-10 w-full" rounded="rounded-[10px]" />;

const ReadOnlyNote = ({ what }: { what: string }) => (
  <p className={`${NOTE} text-inkMuted`}>Only a workspace owner or admin can change {what}.</p>
);

type SendgridState = {
  senders: SendgridSender[];
  groups: SendgridGroup[];
  sender: string;
  group: string;
};

export function EmailSendgridBlock() {
  const canEdit = useCanEdit();
  const [state, setState] = useState<SendgridState | null>(null);
  const [stored, setStored] = useState<{ sender: string; group: string }>({ sender: "", group: "" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const savedNote = useAutoDismissMessage();
  const [loadTry, setLoadTry] = useState(0);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    setNotConnected(false);
    Promise.all([getSendgridSenders(), getSendgridGroups(), getEmailChannelSettings()])
      .then(([senders, groups, settings]) => {
        if (!live) return;
        const sender = settings[SENDER_FIELD]?.[0] ?? "";
        const group = settings[GROUP_FIELD]?.[0] ?? "";
        setStored({ sender, group });
        setState({ senders: senders.filter((x) => x.verified), groups, sender, group });
      })
      .catch((e: Error) => {
        if (!live) return;
        if (e instanceof EmailSettingsError && e.code === "sendgrid_not_connected") setNotConnected(true);
        else setLoadError(e.message);
      });
    return () => {
      live = false;
    };
  }, [loadTry]);

  useEffect(() => {
    const again = () => setLoadTry((v) => v + 1);
    window.addEventListener(SENDGRID_CONNECTED_EVENT, again);
    return () => window.removeEventListener(SENDGRID_CONNECTED_EVENT, again);
  }, []);

  const senderAvailable = !!state && state.senders.some((sender) => sender.id === state.sender);
  const groupAvailable = !!state && state.groups.some((group) => group.id === state.group);

  const pick = (change: Partial<Pick<SendgridState, "sender" | "group">>) => {
    if (!state) return;
    setState({ ...state, ...change });
    savedNote.clear();
    setError(null);
  };

  const save = async () => {
    if (!state || busy) return;
    const next = { sender: state.sender, group: state.group };
    if (!senderAvailable || !groupAvailable) {
      savedNote.clear();
      setError(
        !next.sender
          ? "Pick a verified SendGrid sender before saving."
          : !senderAvailable
            ? "The saved sender is no longer verified in SendGrid. Pick another sender before saving."
            : !next.group
              ? "Pick an unsubscribe group before saving."
              : "The saved unsubscribe group is no longer in SendGrid. Pick another group before saving.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    savedNote.clear();
    try {
      if (next.sender !== stored.sender) {
        await saveEmailChannelSetting(SENDER_FIELD, next.sender ? [next.sender] : []);
      }
      if (next.group !== stored.group) await saveEmailChannelSetting(GROUP_FIELD, next.group ? [next.group] : []);
      setStored(next);
      savedNote.show("Saved. New email cards use this sender and group.");
    } catch (e) {
      const message = (e as Error).message;
      try {
        const settings = await getEmailChannelSettings();
        const actual = {
          sender: settings[SENDER_FIELD]?.[0] ?? "",
          group: settings[GROUP_FIELD]?.[0] ?? "",
        };
        setStored(actual);
        setState({ ...state, ...actual });
        setError(`${message} Zavi could not confirm every change; the current saved sender and group are shown.`);
      } catch {
        setError(`${message} Zavi also could not reload the saved values. Refresh before trying again.`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <RowBlock id="email-sendgrid" title="SendGrid sender">
      {!state && !loadError && !notConnected && <Loading />}
      {notConnected && (
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-bone px-3 py-2.5 text-[13px] text-ink">
          <span>SendGrid is not connected.</span>
          <a href={CONNECT_HREF} className={`font-medium underline underline-offset-2 ${FOCUS}`}>
            Connect SendGrid
          </a>
        </div>
      )}
      {loadError && <LoadError message={loadError} onRetry={() => setLoadTry((v) => v + 1)} />}
      {state && (
        <>
          <label className={LABEL}>
            Send from
            <span className="relative block min-w-0">
              <select
                className={`${INPUT} appearance-none pr-9`}
                value={state.sender}
                disabled={!canEdit || busy}
                onChange={(e) => pick({ sender: e.target.value })}
              >
                <option value="">Pick a verified sender</option>
                {state.sender && !senderAvailable && <option value={state.sender}>Saved sender is no longer available</option>}
                {state.senders.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.from_name ? `${x.from_name} <${x.from_email}>` : x.from_email}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden className={CHEVRON} />
            </span>
          </label>
          <label className={LABEL}>
            Unsubscribe group
            <span className="relative block min-w-0">
              <select
                className={`${INPUT} appearance-none pr-9`}
                value={state.group}
                disabled={!canEdit || busy}
                onChange={(e) => pick({ group: e.target.value })}
              >
                <option value="">Pick an unsubscribe group</option>
                {state.group && !groupAvailable && <option value={state.group}>Saved group is no longer available</option>}
                {state.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.is_default ? `${g.name} (default)` : g.name}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden className={CHEVRON} />
            </span>
          </label>
          {canEdit ? (
            <div>
              <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          ) : (
            <ReadOnlyNote what="the sender" />
          )}
          {error && (
            <p role="alert" className={`${NOTE} text-danger`}>
              {error}
            </p>
          )}
          {!error && ((state.sender && !senderAvailable) || (state.group && !groupAvailable)) && (
            <p role="alert" className={`${NOTE} text-danger`}>
              {state.sender && !senderAvailable ? "The saved sender is no longer verified in SendGrid. Pick another sender." : "The saved unsubscribe group is no longer in SendGrid. Pick another group."}
            </p>
          )}
          {savedNote.message && (
            <p role="status" className={`${NOTE} text-ink`}>
              {savedNote.message}
            </p>
          )}
        </>
      )}
    </RowBlock>
  );
}

const EMPTY: EmailTemplate = {
  logo_url: null,
  brand_color: "#111827",
  button_color: "#111827",
  font_key: "system",
  sign_off: "",
  postal_address: null,
  show_cards: false,
};

async function storedPostalAddress(fallback: string | null): Promise<string | null> {
  const current = await getEmailTemplate();
  const fromTemplate = current?.template?.postal_address?.trim();
  return fromTemplate || fallback?.trim() || null;
}

const TEMPLATE_KEYS = ["logo_url", "brand_color", "button_color", "font_key", "sign_off", "show_cards"] as const;
const sameTemplate = (a: EmailTemplate, b: EmailTemplate) => TEMPLATE_KEYS.every((k) => (a[k] ?? null) === (b[k] ?? null));
const fontLabel = (f: string) => (f ? f[0]!.toUpperCase() + f.slice(1) : f);

export function EmailTemplateBlock() {
  const [t, setT] = useState<EmailTemplate | null>(null);
  const [base, setBase] = useState<EmailTemplate | null>(null);
  const [fonts, setFonts] = useState<string[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "draft" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const templateSaved = useAutoDismissMessage();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTry, setLoadTry] = useState(0);
  const [needsFooter, setNeedsFooter] = useState(false);
  const [draftName, setDraftName] = useState<string | null>(null);
  const tenantName = useWorkspaceOptional()?.tenantName ?? null;

  useEffect(() => {
    let live = true;
    setLoadError(null);
    getEmailTemplate()
      .then((r) => {
        if (!live) return;
        const saved = r?.template && typeof r.template === "object" ? r.template : null;
        setFonts(Array.isArray(r?.fonts) ? r.fonts : []);
        setCanEdit(r?.can_edit === true);
        setIsSaved(!!saved);
        const loaded = saved ? { ...EMPTY, ...saved } : EMPTY;
        setT(loaded);
        setBase(loaded);
      })
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [loadTry]);

  const set = <K extends keyof EmailTemplate>(k: K, v: EmailTemplate[K]) => {
    if (t) setT({ ...t, [k]: v });
    setNotice(null);
    templateSaved.clear();
  };

  const run = async (kind: "save" | "draft") => {
    if (!t) return;
    if (kind === "draft" && isSaved) {
      const replace = await confirmAction({
        title: "Replace this template draft?",
        description: "Zavi will draft the template again from your brand. Your current saved template stays live until you review and save the new draft.",
        confirmLabel: "Draft again",
      });
      if (!replace) return;
    }
    setBusy(kind);
    setError(null);
    setNeedsFooter(false);
    setNotice(null);
    templateSaved.clear();
    try {
      if (kind === "draft") {
        const { draft } = await draftEmailTemplate();
        const { company_name: draftCompany, ...rest } = draft;
        setT(rest);
        setDraftName(draftCompany?.trim() || null);
        setNotice(isSaved && base && sameTemplate(rest, base) ? "Zavi drafted the same template you already have. Nothing to save." : "Drafted from your brand. Check it, then save.");
      } else {
        const postal = await storedPostalAddress(t.postal_address);
        if (!postal) {
          setNeedsFooter(true);
          setError("Add your postal address in Settings > Footer first. Every marketing email needs one.");
          return;
        }
        const payload: EmailTemplate = {
          logo_url: t.logo_url?.trim() || null,
          brand_color: t.brand_color,
          button_color: t.button_color,
          font_key: t.font_key,
          sign_off: t.sign_off,
          postal_address: postal,
          show_cards: t.show_cards,
        };
        const { template } = await saveEmailTemplate(payload);
        setT(template);
        setBase(template);
        setIsSaved(true);
        templateSaved.show("Saved. New emails use this template; emails already proposed keep the one they were drafted with.");
      }
    } catch (e) {
      const message = (e as Error).message;
      if (kind === "save") {
        try {
          const current = await getEmailTemplate();
          const saved = current.template && typeof current.template === "object" ? current.template : null;
          const reloaded = saved ? { ...EMPTY, ...saved } : EMPTY;
          setT(reloaded);
          setBase(reloaded);
          setIsSaved(!!saved);
          setError(`${message} Zavi could not confirm the save; the current saved template is shown.`);
        } catch {
          setError(`${message} Zavi also could not reload the saved template. Refresh before saving again.`);
        }
      } else {
        setError(message);
      }
    } finally {
      setBusy(null);
    }
  };

  const disabled = !canEdit || busy !== null;
  const dirty = !!t && !!base && !sameTemplate(t, base);
  const showSave = canEdit && (dirty || !isSaved);
  const showBar = !!t && (showSave || !canEdit || !!error || !!notice || !!templateSaved.message || needsFooter);
  return (
    <div data-testid="email-template" className="min-w-0 divide-y divide-rule">
      <div className="flex flex-wrap items-center gap-3 p-5">
        <p className="min-w-0 flex-1 text-[13px] leading-5 text-inkMuted">
          {isSaved
            ? "Your postal address and unsubscribe link are in Footer."
            : "Not saved yet. Zavi drafts one from your brand the first time it proposes an email; you can draft and edit it here first."}
        </p>
        {t && canEdit && (
          <button type="button" className={`${BTN} ml-auto`} disabled={busy !== null} onClick={() => void run("draft")}>
            {busy === "draft" ? "Drafting…" : "Draft from brand"}
          </button>
        )}
      </div>
      {!t && !loadError && (
        <div className="p-5">
          <Loading />
        </div>
      )}
      {loadError && (
        <div className="p-5">
          <LoadError message={loadError} onRetry={() => setLoadTry((v) => v + 1)} />
        </div>
      )}
      {t && (
        <div className="min-w-0 [container-type:inline-size]">
          <div className="grid min-w-0 [@container(min-width:760px)]:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
            <div className="min-w-0 divide-y divide-rule">
              <div className={ROW}>
                <label htmlFor="email-template-logo" className={ROW_LABEL}>
                  Logo link
                </label>
                <input
                  id="email-template-logo"
                  className={INPUT}
                  value={t.logo_url ?? ""}
                  placeholder="https://yoursite.com/logo.png"
                  disabled={disabled}
                  onChange={(e) => set("logo_url", e.target.value)}
                />
              </div>
              <div role="group" aria-labelledby="email-template-colors" className={ROW}>
                <p id="email-template-colors" className={ROW_LABEL}>
                  Colors
                </p>
                <div className="flex min-w-0 flex-wrap gap-4">
                  <ColorField id="email-template-brand-color" label="Brand color" value={t.brand_color} disabled={disabled} onChange={(v) => set("brand_color", v)} />
                  <ColorField id="email-template-button-color" label="Button color" value={t.button_color} disabled={disabled} onChange={(v) => set("button_color", v)} />
                </div>
              </div>
              <div className={ROW}>
                <label htmlFor="email-template-font" className={ROW_LABEL}>
                  Font
                </label>
                <span className="relative block min-w-0 max-w-[220px]">
                  <select id="email-template-font" className={`${INPUT} appearance-none pr-9`} value={t.font_key} disabled={disabled} onChange={(e) => set("font_key", e.target.value)}>
                    {(fonts.length ? fonts : [t.font_key]).map((f) => (
                      <option key={f} value={f}>
                        {fontLabel(f)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown aria-hidden className={CHEVRON} />
                </span>
              </div>
              <div className={ROW}>
                <label htmlFor="email-template-sign-off" className={ROW_LABEL}>
                  Sign-off
                </label>
                <input id="email-template-sign-off" className={INPUT} value={t.sign_off} disabled={disabled} onChange={(e) => set("sign_off", e.target.value)} />
              </div>
              <div className={ROW}>
                <p className={ROW_LABEL}>Product cards</p>
                <div className="flex min-w-0 items-start gap-3 sm:pt-2">
                  <Switch checked={t.show_cards} label="Show product cards" disabled={disabled} onCheckedChange={(v) => set("show_cards", v)} />
                  <div className="min-w-0">
                    <p className="text-[14px] leading-5 text-ink">Show product cards</p>
                    <p className="text-[12px] leading-[18px] text-inkMuted">Products, plans or listings from your data.</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="min-w-0 border-t border-rule p-5 [@container(min-width:760px)]:border-l [@container(min-width:760px)]:border-t-0">
              <BrandPreview template={t} name={tenantName || draftName} />
            </div>
          </div>
        </div>
      )}
      {showBar && (
        <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-4">
          <div className="mr-auto grid min-w-0 gap-2">
            {!canEdit && <ReadOnlyNote what="the template" />}
            {error && (
              <p role="alert" className={`${NOTE} text-danger`}>
                {error}
              </p>
            )}
            {needsFooter && (
              <div>
                <button type="button" className={BTN} onClick={goToEmailFooterSettings}>
                  Open Footer settings
                </button>
              </div>
            )}
            {(notice ?? templateSaved.message) && (
              <p role="status" className={`${NOTE} text-ink`}>
                {notice ?? templateSaved.message}
              </p>
            )}
          </div>
          {showSave && (
            <button type="button" className={BTN_PRIMARY} disabled={busy !== null} onClick={() => void run("save")}>
              {busy === "save" ? "Saving…" : "Save template"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export const AUTO_SEND_COPY =
  "Zavi sends by itself to lists of up to 1,000 people, once per list every 7 days. The rest waits for your approval.";
export const AUTO_SEND_ON_AUTOPILOT_OFF = "On, but Autopilot is off, so Zavi will not send by itself";
export const AUTO_SEND_UNREADABLE = "Zavi can't read all your lists right now, so this can't be turned on yet. Try again in a few minutes.";

type CoveredList = { key: string; name: string; tool: string; count: string | null; reason: string | null };
type Covered = { yes: CoveredList[]; no: CoveredList[] } | null;

const peopleCount = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`;

async function listsAutoSendCovers(): Promise<Covered> {
  try {
    const r = await getEmailTestLists({ fresh: true });
    if (r.routes.some((route) => route.status === "partial" || route.status === "unreadable")) return null;
    const yes: CoveredList[] = [];
    const no: CoveredList[] = [];
    for (const route of r.routes as TestListRouteView[]) {
      for (const l of route.lists) {
        if (l.marked) continue;
        const base = { key: `${route.route}:${l.id}`, name: l.name, tool: route.label };
        if (l.people === null) no.push({ ...base, count: null, reason: "size not known" });
        else if (l.people > AUTO_SEND_CAP) no.push({ ...base, count: peopleCount(l.people), reason: "over 1,000" });
        else yes.push({ ...base, count: peopleCount(l.people), reason: null });
      }
    }
    return { yes, no };
  } catch {
    return null;
  }
}

function CoveredLists({ title, lists, muted }: { title: string; lists: CoveredList[]; muted?: boolean }) {
  return (
    <section aria-label={title} className="grid gap-1.5">
      <p className="text-[12px] font-medium tracking-wide text-inkMuted">
        {title} <span className="tabular-nums">· {lists.length}</span>
      </p>
      <ul className="divide-y divide-rule rounded-[12px] border border-rule">
        {lists.map((l) => (
          <li key={l.key} className="flex min-w-0 items-center gap-3 px-3 py-2">
            <span title={l.name} className={`min-w-0 flex-1 truncate ${muted ? "text-inkSoft" : "text-ink"}`}>
              {l.name}
            </span>
            <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[12px] tabular-nums text-inkMuted">
              <span>{l.count ? `${l.tool} · ${l.count}` : l.tool}</span>
              {l.reason && <span className="rounded-full bg-bone px-2 py-0.5 text-[11.5px] font-medium text-inkMuted">{l.reason}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const AUTO_SEND_CAP = 1000;

export function useEmailAutoSend() {
  const canEdit = useCanEdit();
  const [state, setState] = useState<EmailAutoSend | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const on = state?.on ?? null;
  const autopilotOff = state?.autopilot === false;

  const load = useCallback(() => {
    let live = true;
    setLoadError(null);
    getEmailAutoSend()
      .then((v) => live && setState(v))
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, []);
  const [loadTry, setLoadTry] = useState(0);
  useEffect(() => load(), [load, loadTry]);

  const flip = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (next) {
        const covered = await listsAutoSendCovers();
        if (covered === null) {
          setError(AUTO_SEND_UNREADABLE);
          return;
        }
        const ok = await confirmAction({
          title: "Let Autopilot send emails?",
          description: autopilotOff
            ? "Autopilot is off, so nothing sends by itself yet. Once you turn Autopilot on, Zavi will send emails by itself, including drafts nobody has reviewed, to up to 1,000 people per email and at most once per list every 7 days."
            : "Zavi will then send emails by itself, including drafts nobody has reviewed, to up to 1,000 people per email and at most once per list every 7 days.",
          confirmLabel: "Allow Autopilot to send",
          size: "lg",
          body: (
            <div className="grid gap-3 text-[13px] leading-[18px] text-ink">
              <div className="grid max-h-[240px] gap-4 overflow-y-auto overscroll-contain pr-0.5">
                {covered.yes.length > 0 ? (
                  <CoveredLists title="Can send by itself" lists={covered.yes} />
                ) : (
                  <p className="text-inkMuted">No list yet. It covers new lists of 1,000 people or fewer as you add them.</p>
                )}
                {covered.no.length > 0 && <CoveredLists title="Waits for your approval" lists={covered.no} muted />}
              </div>
              <p className="text-[12px] text-inkMuted">Test lists are never sent to.</p>
            </div>
          ),
        });
        if (!ok) return;
      }
      await setEmailAutoSend(next);
      setState(await getEmailAutoSend());
    } catch (e) {
      const message = (e as Error).message;
      try {
        setState(await getEmailAutoSend());
        setError(`${message} Zavi could not confirm the change; the current saved setting is shown.`);
      } catch {
        setState(null);
        setLoadError("Zavi could not confirm whether Autopilot may send email. Retry before relying on this setting.");
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  return { on, autopilotOff, loadError, error, busy, canEdit, flip, retry: () => setLoadTry((v) => v + 1) };
}

export function EmailAutoSendBlock() {
  const { on, autopilotOff, loadError, error, busy, canEdit, flip, retry } = useEmailAutoSend();
  return (
    <RowBlock id="email-auto-send" title="Send without asking" intro={AUTO_SEND_COPY}>
      {on === null && !loadError && <Skeleton className="h-6 w-28" />}
      {loadError && <LoadError message={loadError} onRetry={retry} />}
      {on !== null && (
        <div>
          <div className="flex min-h-[40px] items-center gap-3">
            <Switch checked={on} label="Send without asking" disabled={!canEdit || busy} onCheckedChange={(next) => void flip(next)} />
            <span className="text-[13px] leading-5 text-inkMuted">{on ? (autopilotOff ? AUTO_SEND_ON_AUTOPILOT_OFF : "On, within the limits above") : "Off"}</span>
          </div>
          {error && (
            <p role="alert" className="mt-2 text-[13px] leading-5 text-danger">
              {error}
            </p>
          )}
          {!canEdit && (
            <div className="mt-2">
              <ReadOnlyNote what="Autopilot sending" />
            </div>
          )}
        </div>
      )}
      {on === null && error && (
        <p role="alert" className="text-[13px] leading-5 text-danger">
          {error}
        </p>
      )}
    </RowBlock>
  );
}
