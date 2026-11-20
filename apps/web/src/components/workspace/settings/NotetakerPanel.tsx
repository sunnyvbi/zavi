"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Link2,
  Clock,
  Calendar,
  ChevronDown,
  Search,
  Plus,
  Mail,
  Hash,
  X,
  TriangleAlert,
  Check,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/ui/toast";
import { Skeleton } from "../Skeleton";
import { TeamsConnectPanel } from "./TeamsConnectPanel";

type MeetingRow = {
  id: string;
  status: string;
  source: string;
  meeting_url: string;
  scheduled_for: string;
  atoms_count: number;
  error: string | null;
  created_at: string;
};

export type RecapDestination = "slack" | "email" | "off";

type Settings = {
  enabled: boolean;
  meeting_url: string;
  days_of_week: number[];
  join_time: string;
  timezone: string;
};

export type RecapState = { destination: RecapDestination | null; channelName: string | null };

type MeetingMinutes = {
  tldr?: string;
  decisions?: string[];
  action_items?: { text: string; owner?: string | null; due_date?: string | null }[];
  topics?: string[];
  open_questions?: string[];
};
type MeetingNotes = { minutes: MeetingMinutes | null; transcript: string; created_at: string; delete_after: string };

type SlackChannel = { id: string; name: string };
type Atom = {
  id: string;
  atom_type: string;
  title: string;
  body: string;
  owner: string | null;
  status: string;
};

const BORDER = "#f0f0f0";
const CARD =
  "rounded-block border border-[#f0f0f0] bg-white px-4 py-[19px] text-[#0e0f11]";
const FIELD_BOX =
  "flex h-10 items-center gap-2 rounded-[10px] border border-[#f0f0f0] bg-white px-2.5 focus-within:border-[#027bff]";
const SEARCH_BOX = FIELD_BOX.replace("rounded-[10px]", "rounded-full").replace("px-2.5", "px-3");
const INPUT =
  "min-w-0 flex-1 bg-transparent text-[14px] font-medium text-[#0e0f11] outline-none placeholder:text-[#bfbfbf]";

type IconProps = { className?: string };
const IconLink = ({ className = "h-5 w-5" }: IconProps) => <Link2 className={className} strokeWidth={1.5} aria-hidden />;
const IconClock = ({ className = "h-5 w-5" }: IconProps) => <Clock className={className} strokeWidth={1.5} aria-hidden />;
const IconCalendar = ({ className = "h-5 w-5" }: IconProps) => <Calendar className={className} strokeWidth={1.5} aria-hidden />;
const IconChevron = ({ className = "h-5 w-5" }: IconProps) => <ChevronDown className={className} strokeWidth={1.5} aria-hidden />;
const IconSearch = ({ className = "h-5 w-5" }: IconProps) => <Search className={className} strokeWidth={1.5} aria-hidden />;
const IconPlus = ({ className = "h-5 w-5" }: IconProps) => <Plus className={className} strokeWidth={1.5} aria-hidden />;
const IconMail = ({ className = "h-5 w-5" }: IconProps) => <Mail className={className} strokeWidth={1.5} aria-hidden />;
const IconSlack = ({ className = "h-5 w-5" }: IconProps) => <Hash className={className} strokeWidth={1.5} aria-hidden />;
const IconX = ({ className = "h-5 w-5" }: IconProps) => <X className={className} strokeWidth={1.5} aria-hidden />;
const IconAlert = ({ className = "h-6 w-6" }: IconProps) => <TriangleAlert className={className} strokeWidth={1.6} aria-hidden />;
const IconCheck = ({ className }: IconProps) => <Check className={className} strokeWidth={2.5} aria-hidden />;

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange?: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className={`relative h-[28px] w-[44px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        checked ? "bg-[#0e0f11]" : "bg-[#d9d9d9]"
      }`}
    >
      <span
        className={`absolute top-1 flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-[0_1px_3px_rgba(16,18,20,0.2)] transition-all ${
          checked ? "left-5" : "left-1"
        }`}
      >
        {checked ? <IconCheck className="h-3 w-3 text-[#0e0f11]" /> : null}
      </span>
    </button>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[20px] font-semibold leading-[25px] text-[#0e0f11]">{children}</p>
  );
}
function CardDesc({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-[13px] leading-5 text-[#595959]">{children}</p>;
}
function FieldLabel({
  children,
  hint,
}: {
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <span className="text-[14px] font-medium leading-5 tracking-[0.14px] text-[#1f1f1f]">
      {children}
      {hint ? <span className="text-[#595959]">{hint}</span> : null}
    </span>
  );
}
function Divider({ className = "" }: { className?: string }) {
  return <div className={`h-px w-full bg-[${BORDER}] ${className}`} style={{ backgroundColor: BORDER }} />;
}
function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = "", ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-cta bg-[#0e0f11] px-4 text-[16px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-[#f0f0f0] disabled:text-[#bfbfbf] ${className}`}
    />
  );
}
function TertiaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = "", children, ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-cta border border-[#f0f0f0] bg-white px-3.5 text-[16px] font-semibold text-[#1f1f1f] transition-colors hover:bg-[#f9f9f9] disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}
function SelectField({
  icon,
  value,
  onChange,
  disabled,
  children,
  className = "",
}: {
  icon?: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative ${FIELD_BOX} ${disabled ? "opacity-60" : ""} ${className}`}>
      {icon ? <span className="text-[#595959]">{icon}</span> : null}
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT} appearance-none pr-5`}
      >
        {children}
      </select>
      <IconChevron className="pointer-events-none absolute right-2.5 h-5 w-5 text-[#595959]" />
    </div>
  );
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_PRESETS: { label: string; days: number[] }[] = [
  { label: "Every Weekday (Monday to Friday)", days: [1, 2, 3, 4, 5] },
  { label: "Every Day", days: [0, 1, 2, 3, 4, 5, 6] },
  { label: "Every Monday", days: [1] },
  { label: "Every Tuesday", days: [2] },
  { label: "Every Wednesday", days: [3] },
  { label: "Every Thursday", days: [4] },
  { label: "Every Friday", days: [5] },
  { label: "Every Saturday", days: [6] },
  { label: "Every Sunday", days: [0] },
];
const sameDays = (a: number[], b: number[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();
function daysLabel(days: number[]): string {
  const p = DAY_PRESETS.find((x) => sameDays(x.days, days));
  if (p) return p.label.replace(/^Every /, "").replace(" (Monday to Friday)", "");
  return [...days].sort().map((d) => DAY_SHORT[d]).join(", ");
}
function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  if (Number.isNaN(h)) return hhmm;
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}
function tzShort(timezone: string): string {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value ?? ""
    );
  } catch {
    return "";
  }
}
function timezoneOptions(current: string): string[] {
  let zones: string[];
  try {
    zones = (
      Intl as unknown as { supportedValuesOf: (k: string) => string[] }
    ).supportedValuesOf("timeZone");
  } catch {
    zones = [
      "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
      "UTC", "Europe/London", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney",
    ];
  }
  if (current && !zones.includes(current)) zones = [current, ...zones];
  return zones;
}

function SkelCardHeader({ toggle = true }: { toggle?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <Skeleton className="h-[18px] w-52" />
        <Skeleton className="mt-2.5 h-3 w-full max-w-[520px]" />
        <Skeleton className="mt-1.5 h-3 w-3/4 max-w-[420px]" />
      </div>
      {toggle ? <Skeleton className="h-7 w-11 shrink-0" rounded="rounded-full" /> : null}
    </div>
  );
}
function SkelField({ w = "w-40" }: { w?: string }) {
  return (
    <div>
      <Skeleton className={`h-3 ${w}`} />
      <Skeleton className="mt-2 h-10 w-full" rounded="rounded-[10px]" />
    </div>
  );
}
function NotetakerSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="space-y-6">
      {}
      <Skeleton className="h-10 w-full" rounded="rounded-[10px]" />

      {}
      <div className={CARD}>
        <SkelCardHeader />
        <Skeleton className="mt-4 h-px w-full" rounded="rounded-none" />
        <div className="mt-5 space-y-5">
          <SkelField w="w-56" />
          <div className="rounded-[16px] border border-[#f0f0f0] bg-[#f9f9f9] p-4">
            <div className="flex flex-wrap gap-4">
              <div className="w-[151px] shrink-0"><SkelField w="w-16" /></div>
              <div className="w-[224px] shrink-0"><SkelField w="w-20" /></div>
              <div className="w-[280px] shrink-0"><SkelField w="w-10" /></div>
            </div>
            <Skeleton className="mt-4 h-3 w-full max-w-[560px]" />
          </div>
        </div>
      </div>

      {}
      <div className={CARD}>
        <SkelCardHeader />
        <Skeleton className="mt-4 h-px w-full" rounded="rounded-none" />
        <div className="mt-5 space-y-4">
          <SkelField w="w-36" />
          <div className="rounded-[16px] border border-[#f0f0f0] p-4">
            <Skeleton className="h-4 w-28" />
            <div className="mt-4 space-y-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <Skeleton className="h-3.5 w-48" />
                    <Skeleton className="mt-1.5 h-3 w-64" />
                  </div>
                  <Skeleton className="h-7 w-11 shrink-0" rounded="rounded-full" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {}
      <div className={CARD}>
        <SkelCardHeader toggle={false} />
        <div className="mt-4 flex gap-3">
          <Skeleton className="h-10 flex-1" rounded="rounded-[10px]" />
          <Skeleton className="h-10 w-24" rounded="rounded-[10px]" />
        </div>
      </div>

      <span className="sr-only">Loading notetaker settings…</span>
    </div>
  );
}

function cancelledDetail(error: string | null): string {
  if (error === "cancelled_notetaker_off") return "cancelled: Notetaker was turned off";
  if (error === "cancelled_link_cleared") return "cancelled: meeting link was cleared";
  if (error === "cancel_failed") return "couldn't cancel: remove it from the meeting manually";
  return "cancelled";
}

export function asRecapDestination(v: unknown): RecapDestination | null {
  return v === "slack" || v === "email" || v === "off" ? v : null;
}

function normalizeChannel(v: string): string {
  return v.trim().replace(/^#+/, "").trim().toLowerCase();
}

export function recapSummary(r: RecapState): string {
  if (r.destination === "slack") return `Meeting summaries post to #${r.channelName ?? "your channel"} in Slack.`;
  if (r.destination === "email") return "Meeting summaries are emailed to the owner and whoever sent Zavi to the call.";
  if (r.destination === "off") return "Meeting summaries stay in Zavi. Nothing is posted or emailed.";
  return "No one has chosen where meeting summaries go yet, so they stay in Zavi. Nothing is posted or emailed.";
}

const RECAP_OPTIONS: { value: RecapDestination; title: string; desc: string; icon: React.ReactNode }[] = [
  { value: "slack", title: "Post to a Slack channel", desc: "Zavi posts the summary there, with the transcript attached.", icon: <IconSlack /> },
  { value: "email", title: "Email the summary", desc: "To the workspace owner and whoever sent Zavi to the call.", icon: <IconMail /> },
  { value: "off", title: "Don’t share it", desc: "Notes stay in Zavi. Nothing is posted or emailed.", icon: <IconX /> },
];

export function RecapDestinationChooser({
  heading,
  recap,
  slackConnected,
  suggestions,
  onSaved,
  showRetention = false,
}: {
  heading: string;
  recap: RecapState;
  slackConnected: boolean | null;
  suggestions: SlackChannel[];
  onSaved: (next: RecapState) => void;
  showRetention?: boolean;
}) {
  const groupId = useId();
  const [choice, setChoice] = useState<RecapDestination | null>(recap.destination);
  const [channel, setChannel] = useState(recap.channelName ? `#${recap.channelName}` : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setChoice(recap.destination);
    setChannel(recap.channelName ? `#${recap.channelName}` : "");
  }, [recap.destination, recap.channelName]);

  const unchanged =
    choice === recap.destination && (choice !== "slack" || normalizeChannel(channel) === (recap.channelName ?? ""));
  const canSave = choice !== null && !saving && !unchanged && (choice !== "slack" || normalizeChannel(channel).length > 0);

  const save = async () => {
    if (!choice) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/workspace/notetaker-recap", {
        method: "PUT",
        body: JSON.stringify(choice === "slack" ? { destination: choice, slack_channel: channel } : { destination: choice }),
      });
      const body = (await res.json().catch(() => null)) as {
        slack_channel_name?: string | null;
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        setError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      onSaved({
        destination: choice,
        channelName: choice === "slack" ? body?.slack_channel_name ?? normalizeChannel(channel) : null,
      });
    } catch (err) {
      setError((err as Error).message ?? "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <CardTitle>{heading}</CardTitle>
      <CardDesc>Choose one. Applies to every meeting Zavi joins.</CardDesc>
      {recap.destination === null ? (
        <div role="status" className="mt-4 flex gap-3 rounded-[12px] border border-[#ffce70] bg-[#fffaf0] p-3">
          <span className="shrink-0 text-[#946300]"><IconAlert className="h-5 w-5" /></span>
          <p className="text-[13px] leading-5 text-[#946300]">
            Nobody has chosen yet, so meeting summaries stay in Zavi. Nothing is posted or emailed until you choose.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-[13px] leading-5 text-[#454545]">{recapSummary(recap)}</p>
      )}

      <div role="radiogroup" aria-label={heading} className="mt-4 space-y-2">
        {RECAP_OPTIONS.map((o) => {
          const on = choice === o.value;
          return (
            <div key={o.value} className={`rounded-[12px] border px-3 py-2.5 ${on ? "border-[#0e0f11]" : "border-[#f0f0f0]"}`}>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name={`recap-${groupId}`}
                  value={o.value}
                  checked={on}
                  onChange={() => {
                    setChoice(o.value);
                    setError(null);
                  }}
                  className="mt-1 h-4 w-4 accent-[#0e0f11]"
                  aria-label={o.title}
                />
                <span className="mt-0.5 text-[#595959]">{o.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[16px] font-medium leading-5 text-[#0e0f11]">{o.title}</span>
                  <span className="block text-[12px] leading-[18px] text-[#595959]">{o.desc}</span>
                </span>
              </label>
              {o.value === "slack" && on ? (
                <div className="mt-3 pl-7">
                  <div className={FIELD_BOX}>
                    <span className="text-[#595959]"><IconSlack /></span>
                    <input
                      value={channel}
                      onChange={(e) => setChannel(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && canSave && (e.preventDefault(), void save())}
                      list={`recap-channels-${groupId}`}
                      placeholder="#standups"
                      aria-label="Slack channel name"
                      className={INPUT}
                    />
                  </div>
                  <datalist id={`recap-channels-${groupId}`}>
                    {suggestions.map((c) => (
                      <option key={c.id} value={`#${c.name}`} />
                    ))}
                  </datalist>
                  <p className="mt-1.5 text-[12px] text-[#8c8c8c]">
                    {slackConnected === false
                      ? "Connect Slack in Integrations first."
                      : "Type the channel’s name. For a private channel, invite @Zavi to it first."}
                  </p>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <PrimaryButton onClick={() => void save()} disabled={!canSave}>
          {saving ? "Saving…" : "Save"}
        </PrimaryButton>
        {error ? (
          <span role="alert" className="text-[13px] text-[#cb2029]">
            {error}
          </span>
        ) : null}
      </div>

      {showRetention ? (
        <p className="mt-4 text-[13px] leading-5 text-[#595959]">
          Zavi keeps each meeting’s summary and transcript for 30 days, then deletes them. The recording is deleted
          after transcription.
        </p>
      ) : null}
    </div>
  );
}

export function CaptureNotes({ captureId }: { captureId: string }) {
  const [notes, setNotes] = useState<MeetingNotes | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiFetch(`/api/workspace/notetaker-meetings/${captureId}/notes`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { notes: MeetingNotes | null };
        if (alive) setNotes(data.notes ?? null);
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [captureId]);

  if (err) return <p className="px-6 py-4 text-[13px] text-[#cb2029]">Couldn’t load the notes: {err}</p>;
  if (notes === undefined) {
    return (
      <div className="space-y-2 px-6 py-4">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    );
  }
  if (notes === null) {
    return (
      <p className="px-6 py-4 text-[13px] text-[#595959]">
        No summary or transcript is saved for this meeting. Zavi keeps them for 30 days after a meeting.
      </p>
    );
  }
  const m: MeetingMinutes = notes.minutes ?? {};
  const list = (label: string, items: string[] | undefined) =>
    items && items.length > 0 ? (
      <div className="mt-3">
        <p className="text-[13px] font-semibold text-[#0e0f11]">{label}</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px] leading-5 text-[#1f1f1f]">
          {items.map((i, k) => (
            <li key={k}>{i}</li>
          ))}
        </ul>
      </div>
    ) : null;
  const actions = (m.action_items ?? []).map(
    (a) => `${a.text}${a.owner ? ` (${a.owner})` : ""}${a.due_date ? ` (due ${a.due_date})` : ""}`,
  );
  const hasSummary =
    Boolean(m.tldr?.trim()) ||
    [m.decisions, m.topics, m.open_questions].some((x) => (x ?? []).length > 0) ||
    actions.length > 0;
  const keptUntil = new Date(notes.delete_after).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return (
    <div className="border-b border-[#f0f0f0] px-6 py-4">
      <p className="text-[14px] font-semibold text-[#0e0f11]">Summary</p>
      {hasSummary ? (
        <>
          {m.tldr?.trim() ? <p className="mt-1 text-[13px] leading-5 text-[#1f1f1f]">{m.tldr}</p> : null}
          {list("Decisions", m.decisions)}
          {list("Action items", actions)}
          {list("Topics", m.topics)}
          {list("Open questions", m.open_questions)}
        </>
      ) : (
        <p className="mt-1 text-[13px] text-[#595959]">No written summary for this meeting. The transcript is below.</p>
      )}
      {notes.transcript.trim() ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[13px] font-semibold text-[#0e0f11]">Transcript</summary>
          <pre className="mt-2 max-h-[240px] overflow-y-auto whitespace-pre-wrap rounded-[10px] bg-[#f9f9f9] p-3 font-sans text-[12px] leading-[18px] text-[#1f1f1f]">
            {notes.transcript}
          </pre>
        </details>
      ) : null}
      <p className="mt-3 text-[12px] text-[#8c8c8c]">Kept in Zavi until {keptUntil}, then deleted.</p>
    </div>
  );
}

export function NotetakerPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [s, setS] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinMsg, setJoinMsg] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [query, setQuery] = useState("");
  const [openCapture, setOpenCapture] = useState<MeetingRow | null>(null);
  const [channels, setChannels] = useState<SlackChannel[]>([]);
  const [slackConnected, setSlackConnected] = useState<boolean | null>(null);
  const [recap, setRecap] = useState<RecapState>({ destination: null, channelName: null });
  const [askBeforeJoin, setAskBeforeJoin] = useState(false);

  const [blockedDraft, setBlockedDraft] = useState("");
  const [oneOffUrl, setOneOffUrl] = useState("");
  const [oneOffDate, setOneOffDate] = useState("");
  const [oneOffTime, setOneOffTime] = useState("09:00");
  const [oneOffTz, setOneOffTz] = useState("America/Los_Angeles");
  const isMounted = useRef(true);
  const lastSaved = useRef<string>("");

  const comingSoon = useCallback((feature: string) => {
    toast.add({
      type: "warning",
      title: `${feature} isn’t available yet. This feature is coming soon.`,
      timeout: 4200,
    });
  }, []);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/workspace/notetaker-settings");
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        if (isMounted.current) setError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as Settings & {
        recap_destination?: string | null;
        slack_channel_name?: string | null;
      };
      if (isMounted.current) {
        setRecap({ destination: asRecapDestination(data.recap_destination), channelName: data.slack_channel_name ?? null });
        const next: Settings = {
          enabled: Boolean(data.enabled),
          meeting_url: data.meeting_url ?? "",
          days_of_week: data.days_of_week ?? [1, 2, 3, 4, 5],
          join_time: data.join_time ?? "09:30",
          timezone:
            data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles",
        };
        lastSaved.current = JSON.stringify(next);
        setS(next);
        setOneOffTz(next.timezone);
      }
      if (readOnly) return;
      try {
        const chRes = await apiFetch("/api/workspace/slack-channels");
        if (chRes.ok) {
          const chData = (await chRes.json()) as { slack_connected?: boolean; channels?: SlackChannel[] };
          if (isMounted.current) {
            setSlackConnected(Boolean(chData.slack_connected));
            setChannels(chData.channels ?? []);
          }
        } else if (isMounted.current) setSlackConnected(false);
      } catch {
        if (isMounted.current) setSlackConnected(false);
      }
    } catch (err) {
      if (isMounted.current) setError((err as Error).message ?? "Unknown error");
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [readOnly]);

  const loadMeetings = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/notetaker-meetings");
      if (!res.ok) return;
      const data = (await res.json()) as { meetings: MeetingRow[] };
      if (isMounted.current) setMeetings(data.meetings ?? []);
    } catch {
    }
  }, []);

  useEffect(() => {
    void load();
    void loadMeetings();
  }, [load, loadMeetings]);

  const save = useCallback(async (next: Settings) => {
    if (JSON.stringify(next) === lastSaved.current) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    setSaveNote(null);
    setCancelError(null);
    try {
      const res = await apiFetch("/api/workspace/notetaker-settings", {
        method: "PUT",
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        if (isMounted.current) setError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      lastSaved.current = JSON.stringify(next);
      const okBody = (await res.json().catch(() => null)) as { note?: string; cancel_error?: string } | null;
      if (isMounted.current) {
        setSaveNote(typeof okBody?.note === "string" && okBody.note ? okBody.note : null);
        setCancelError(typeof okBody?.cancel_error === "string" && okBody.cancel_error ? okBody.cancel_error : null);
        setSaved(true);
        setTimeout(() => isMounted.current && setSaved(false), 2000);
      }
    } catch (err) {
      if (isMounted.current) setError((err as Error).message ?? "Unknown error");
    } finally {
      if (isMounted.current) setSaving(false);
    }
  }, []);

  const commit = useCallback(
    (patch: Partial<Settings>) =>
      setS((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...patch };
        void save(next);
        return next;
      }),
    [save],
  );

  const joinNow = useCallback(async () => {
    setJoining(true);
    setJoinMsg(null);
    try {
      const res = await apiFetch("/api/workspace/notetaker-join", {
        method: "POST",
        body: JSON.stringify({ meeting_url: joinUrl }),
      });
      const data = (await res.json().catch(() => null)) as {
        deduped?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        if (isMounted.current) setJoinMsg(data?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      if (isMounted.current) {
        setJoinMsg(
          data?.deduped
            ? "Zavi is already in that meeting."
            : "Zavi is on its way. Admit it from the waiting room.",
        );
        setJoinUrl("");
        void loadMeetings();
      }
    } catch (err) {
      if (isMounted.current) setJoinMsg((err as Error).message ?? "Unknown error");
    } finally {
      if (isMounted.current) setJoining(false);
    }
  }, [joinUrl, loadMeetings]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return meetings;
    return meetings.filter((m) => {
      const label = m.source === "adhoc" ? "summoned call" : "recurring meeting";
      return `${label} ${m.status} ${new Date(m.scheduled_for).toLocaleString()}`
        .toLowerCase()
        .includes(q);
    });
  }, [meetings, query]);

  const addBlocked = () => comingSoon("Auto-join title rules");

  const requestJoin = () => {
    if (recap.destination === null) {
      setAskBeforeJoin(true);
      return;
    }
    void joinNow();
  };

  if (error && !s) return <p className="text-[13px] text-[#cb2029]">{error}</p>;

  if (loading || !s) return <NotetakerSkeleton />;

  const dayValue = DAY_PRESETS.find((p) => sameDays(p.days, s.days_of_week))?.label ?? "__custom__";
  const status = saving ? (
    <span className="text-[12px] text-[#8c8c8c]">Saving…</span>
  ) : error ? (
    <span className="text-[12px] text-[#cb2029]">{error}</span>
  ) : cancelError ? (
    <span role="alert" className="text-[12px] text-[#cb2029]">
      {cancelError}
    </span>
  ) : saveNote ? (
    <span role="status" className="text-[12px] text-[#946300]">
      {saveNote}
    </span>
  ) : saved ? (
    <span className="text-[12px] text-[#8c8c8c]">Saved ✓</span>
  ) : null;

  const searchBar = (
    <div className={SEARCH_BOX}>
      <span className="text-[#8c8c8c]">
        <IconSearch />
      </span>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search captures"
        aria-label="Search captures"
        className={INPUT}
      />
    </div>
  );

  if (readOnly) {
    return (
      <div className="space-y-6">
        {searchBar}
        <div className={CARD}>
          <CardTitle>Zavi joins your meetings</CardTitle>
          <CardDesc>
            Zavi Notetaker joins your team meetings, announces itself, transcribes the call, and
            saves the important parts (blockers, commitments, decisions) to your company brain.
            Durable facts wait for approval; the recording is deleted after transcription.
          </CardDesc>
          <p className="mt-3 text-[13px] leading-5 text-[#454545]">{recapSummary(recap)}</p>
        </div>
        <UpcomingJoins settings={s} />
        <RecentCaptures meetings={filtered} query={query} onQuery={setQuery} onView={setOpenCapture} />
        {openCapture ? <SelectItemsModal capture={openCapture} onClose={() => setOpenCapture(null)} /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {searchBar}

      {}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 max-w-[763px]">
            <CardTitle>Join a recurring meeting</CardTitle>
            <CardDesc>
              Zavi joins your recurring meetings, transcribes the call, and saves key takeaways (blockers, commitments, decisions) to your company brain. Recordings deleted after
              transcription. Internal meetings only.
            </CardDesc>
          </div>
          <Toggle label="Enable recurring meeting" checked={s.enabled} disabled={saving} onChange={() => commit({ enabled: !s.enabled })} />
        </div>
        <Divider className="mt-4" />

        <div className="mt-5 space-y-5">
          <label className="block">
            <FieldLabel hint=" (optional; Zoom, Google Meet, or Teams)">Recurring meeting link</FieldLabel>
            <div className={`mt-2 ${FIELD_BOX}`}>
              <span className="text-[#595959]"><IconLink /></span>
              <input
                type="url"
                value={s.meeting_url}
                onChange={(e) => setS({ ...s, meeting_url: e.target.value })}
                onBlur={() => save(s)}
                placeholder="https://meet.google.com/abc-defg-hij"
                className={INPUT}
              />
            </div>
          </label>

          <div className="rounded-[16px] border border-[#f0f0f0] bg-[#f9f9f9] p-4">
            <div className="flex flex-wrap items-end gap-4">
              <label className="block w-[151px] shrink-0">
                <FieldLabel>Join Time</FieldLabel>
                <div className={`mt-2 ${FIELD_BOX}`}>
                  <span className="text-[#595959]"><IconClock /></span>
                  <input
                    type="time"
                    value={s.join_time}
                    onChange={(e) => commit({ join_time: e.target.value })}
                    className={INPUT}
                  />
                </div>
              </label>
              <label className="block w-[224px] shrink-0">
                <FieldLabel>Timezone</FieldLabel>
                <SelectField className="mt-2" value={s.timezone} onChange={(v) => commit({ timezone: v })}>
                  {timezoneOptions(s.timezone).map((tz) => (
                    <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
                  ))}
                </SelectField>
              </label>
              <label className="block w-[300px] shrink-0">
                <FieldLabel>Day</FieldLabel>
                <SelectField
                  className="mt-2"
                  icon={<IconCalendar />}
                  value={dayValue}
                  onChange={(v) => {
                    const p = DAY_PRESETS.find((x) => x.label === v);
                    if (p) commit({ days_of_week: p.days });
                  }}
                >
                  {dayValue === "__custom__" && (
                    <option value="__custom__">Custom ({daysLabel(s.days_of_week)})</option>
                  )}
                  {DAY_PRESETS.map((p) => (
                    <option key={p.label} value={p.label}>{p.label}</option>
                  ))}
                </SelectField>
              </label>
            </div>
            <p className="mt-4 text-[16px] leading-5 text-[#454545]">
              By keeping this on you confirm your team knows meetings are recorded and transcribed.
              Zavi announces itself in the meeting chat every time it joins.
            </p>
          </div>
          {status ? <div className="flex justify-end">{status}</div> : null}
        </div>
      </div>

      {}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 max-w-[763px]">
            <CardTitle>Join meetings from your calendar</CardTitle>
            <CardDesc>
              Zavi joins meetings straight from your Google Calendar invites, with no link to paste. It
              announces itself when it joins. Use the rules below to control which meetings it enters.
            </CardDesc>
          </div>
          <Toggle label="Enable calendar auto-join" checked={false} onChange={() => comingSoon("Google Calendar auto-join")} />
        </div>
        <Divider className="mt-4" />

        <div className="mt-5 space-y-4">
          <label className="block">
            <FieldLabel>Connected calendar</FieldLabel>
            <div className={`mt-2 h-11 ${FIELD_BOX.replace("h-10", "h-11")}`}>
              {}
              <img
                src="/integrations/google-calendar.svg"
                alt=""
                aria-hidden
                className="h-5 w-5"
              />
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[#595959]">
                Connect your Google Calendar
              </span>
              <button
                type="button"
                onClick={() => comingSoon("Google Calendar connection")}
                className="text-[16px] font-semibold text-[#027bff] hover:underline"
              >
                Connect
              </button>
            </div>
          </label>

          <div className="rounded-[16px] border border-[#f0f0f0] p-4">
            <p className="text-[16px] font-semibold text-[#0e0f11]">Auto-join rules</p>
            <div className="mt-4">
              {[
                { key: "skip1on1", t: "Skip 1:1 meetings", d: "Don’t join events with only one other attendee.", on: false },
                { key: "skipExternal", t: "Skip meetings with external guests", d: "Don’t auto-join if anyone outside your domain is invited.", on: true },
                { key: "skipPrivate", t: "Skip private & out-of-office events", d: "Ignore events marked private, tentative, or OOO.", on: true },
              ].map((r, i) => (
                <div key={r.key}>
                  {i > 0 ? <Divider /> : null}
                  <div className="flex items-center justify-between gap-4 py-3">
                    <div>
                      <p className="text-[16px] font-medium leading-5 text-[#0e0f11]">{r.t}</p>
                      <p className="text-[12px] leading-[18px] text-[#595959]">{r.d}</p>
                    </div>
                    <Toggle label={r.t} checked={r.on} onChange={() => comingSoon("Calendar auto-join rules")} />
                  </div>
                </div>
              ))}
            </div>

            <Divider className="my-1" />
            <div className="mt-4">
              <FieldLabel>Never join meetings with these words in the title</FieldLabel>
              <div className="mt-2 flex gap-3">
                <div className={FIELD_BOX + " flex-1"}>
                  <span className="text-[#8c8c8c]"><IconSearch /></span>
                  <input
                    value={blockedDraft}
                    onChange={(e) => setBlockedDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addBlocked())}
                    placeholder="interview"
                    className={INPUT}
                  />
                </div>
                <TertiaryButton onClick={addBlocked}><IconPlus className="h-4 w-4" /> Add</TertiaryButton>
              </div>
            </div>

            <div className="mt-4 flex gap-3 rounded-[12px] border border-[#ffce70] bg-[#fffaf0] p-4">
              <span className="shrink-0 text-[#946300]"><IconAlert /></span>
              <p className="text-[13px] leading-5 text-[#946300]">
                <span className="font-semibold">Consent matters for external calls.</span> Recording
                laws in many regions require every participant to agree. When a meeting has guests
                outside your domain, Zavi won’t auto-join unless you allow it per meeting, and it
                always announces itself first.
              </p>
            </div>
          </div>
        </div>
      </div>

      {}
      <div className={CARD}>
        <CardTitle>Schedule a one-off meeting</CardTitle>
        <CardDesc>
          For a meeting that isn’t recurring but is coming up: a kickoff, a review, a panel. Zavi
          joins once at the time you set and shares the summary where your team chose.
        </CardDesc>
        <Divider className="mt-4" />
        <div className="mt-5 space-y-5">
          <label className="block">
            <FieldLabel hint=" (optional; Zoom, Google Meet, or Teams)">Meeting link</FieldLabel>
            <div className={`mt-2 ${FIELD_BOX}`}>
              <span className="text-[#595959]"><IconLink /></span>
              <input value={oneOffUrl} onChange={(e) => setOneOffUrl(e.target.value)} placeholder="https://meet.google.com/rab-pitd-bvy" className={INPUT} />
            </div>
          </label>
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex items-end gap-0">
              <label className="block">
                <FieldLabel>Date &amp; Time</FieldLabel>
                <div className="mt-2 flex h-10 items-center rounded-[10px] border border-[#f0f0f0] bg-white px-2.5 focus-within:border-[#027bff]">
                  <span className="text-[#595959]"><IconCalendar /></span>
                  <input type="date" value={oneOffDate} onChange={(e) => setOneOffDate(e.target.value)} className={`${INPUT} ml-2 w-[130px]`} />
                  <span className="mx-2 h-6 w-px bg-[#f0f0f0]" />
                  <span className="text-[#595959]"><IconClock /></span>
                  <input type="time" value={oneOffTime} onChange={(e) => setOneOffTime(e.target.value)} className={`${INPUT} ml-2 w-[92px]`} />
                </div>
              </label>
            </div>
            <label className="block w-[311px]">
              <FieldLabel>Timezone</FieldLabel>
              <SelectField className="mt-2" value={oneOffTz} onChange={setOneOffTz}>
                {timezoneOptions(oneOffTz).map((tz) => (
                  <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
                ))}
              </SelectField>
            </label>
          </div>
          <PrimaryButton onClick={() => comingSoon("One-off scheduling")}>Schedule</PrimaryButton>
        </div>
      </div>

      {}
      <div className={CARD}>
        <CardTitle>Send Zavi to a call now</CardTitle>
        <CardDesc>
          Paste any Zoom, Meet, or Teams link. Zavi joins within a minute, announces itself, and
          shares the summary after the call where your team chose below.
        </CardDesc>
        <div className="mt-4 flex gap-3">
          <div className={FIELD_BOX + " flex-1"}>
            <span className="text-[#595959]"><IconLink /></span>
            <input
              type="url"
              value={joinUrl}
              onChange={(e) => setJoinUrl(e.target.value)}
              placeholder="https://meet.google.com/xxx-xxxx-xxx"
              className={INPUT}
            />
          </div>
          <PrimaryButton onClick={requestJoin} disabled={joining || joinUrl.trim().length < 8}>
            {joining ? "Sending…" : "Join now"}
          </PrimaryButton>
        </div>
        {askBeforeJoin && recap.destination === null ? (
          <div className="mt-4 rounded-[16px] border border-[#ffce70] bg-[#fffaf0] p-4">
            <RecapDestinationChooser
              heading="Before Zavi joins: where should the summary go?"
              recap={recap}
              slackConnected={slackConnected}
              suggestions={channels}
              onSaved={(next) => {
                setRecap(next);
                setAskBeforeJoin(false);
                void joinNow();
              }}
            />
          </div>
        ) : null}
        {!s.enabled ? (
          <p className="mt-2 text-[12px] text-[#8c8c8c]">Turn on “Join a recurring meeting” above to let Zavi join calls.</p>
        ) : null}
        {joinMsg ? <p className="mt-2 text-[13px] text-[#595959]">{joinMsg}</p> : null}
      </div>

      {}
      <TeamsConnectPanel readOnly={readOnly} />

      {}
      <div className={CARD}>
        <RecapDestinationChooser
          heading="Where meeting summaries go"
          recap={recap}
          slackConnected={slackConnected}
          suggestions={channels}
          onSaved={setRecap}
          showRetention
        />
      </div>

      {}
      <UpcomingJoins settings={s} />

      {}
      <RecentCaptures meetings={filtered} query={query} onQuery={setQuery} onView={setOpenCapture} />

      {openCapture ? <SelectItemsModal capture={openCapture} onClose={() => setOpenCapture(null)} /> : null}
    </div>
  );
}

function UpcomingJoins({ settings }: { settings: Settings }) {
  const tz = tzShort(settings.timezone);
  return (
    <div className="rounded-block border border-[#f0f0f0] bg-white px-4 py-[19px]">
      <CardTitle>Upcoming joins</CardTitle>
      <CardDesc>Everything Zavi is scheduled to join. Cancel any before it starts.</CardDesc>
      {settings.enabled ? (
        <div className="mt-4 flex items-center gap-3">
          <span className="h-3 w-3 shrink-0 rounded-full bg-[#027bff]" />
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-medium leading-6 text-[#0e0f11]">
              {settings.meeting_url ? "Recurring meeting" : "Recurring meeting (no link set)"}
            </p>
            <p className="text-[13px] leading-5 text-[#595959]">
              Recurring · {daysLabel(settings.days_of_week)} · {formatTime(settings.join_time)}{tz ? ` ${tz}` : ""}
            </p>
          </div>
          <span className="text-[13px] text-[#595959]">Recurring</span>
        </div>
      ) : (
        <p className="mt-4 text-[13px] text-[#595959]">
          Nothing scheduled yet. Turn on a recurring meeting above and it’ll appear here.
        </p>
      )}
    </div>
  );
}

function RecentCaptures({
  meetings,
  query,
  onQuery,
  onView,
}: {
  meetings: MeetingRow[];
  query: string;
  onQuery: (q: string) => void;
  onView: (m: MeetingRow) => void;
}) {
  return (
    <div className="rounded-block border border-[#f0f0f0] bg-white px-4 py-[19px]">
      <CardTitle>Recent captures</CardTitle>
      <CardDesc>
        Open a meeting to read its summary and transcript (kept for 30 days). Durable facts wait for your approval
        before they’re saved to the brain.
      </CardDesc>
      <div className={`mt-4 ${SEARCH_BOX}`}>
        <span className="text-[#8c8c8c]"><IconSearch /></span>
        <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search captures" aria-label="Search captures" className={INPUT} />
      </div>

      {meetings.length === 0 ? (
        <p className="mt-4 text-[13px] text-[#595959]">{query ? "No captures match your search." : "No captures yet."}</p>
      ) : (
        <div className="mt-4 rounded-[16px] border border-[#f0f0f0] px-4">
          {meetings.map((m, i) => {
            const title = m.source === "adhoc" ? "Summoned call" : "Recurring meeting";
            const when = new Date(m.scheduled_for).toLocaleString(undefined, {
              day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
            });
            const dot =
              m.status === "ingested"
                ? "bg-[#167f50]"
                : m.status === "failed"
                  ? "bg-[#cb2029]"
                  : m.status === "cancelled"
                    ? m.error === "cancel_failed"
                      ? "bg-[#cb2029]"
                      : "bg-[#8c8c8c]"
                    : "bg-[#946300]";
            const detail =
              m.status === "ingested"
                ? `${m.atoms_count} items captured`
                : m.status === "failed"
                  ? `failed: ${m.error ? m.error.slice(0, 48) : "no recording (no one joined)"}`
                  : m.status === "cancelled"
                    ? cancelledDetail(m.error)
                    : m.status.replace(/_/g, " ");
            return (
              <div key={m.id}>
                {i > 0 ? <Divider /> : null}
                <div className="flex items-center gap-3 py-3">
                  <span className={`h-3 w-3 shrink-0 rounded-full ${dot}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[16px] font-medium leading-6 text-[#0e0f11]">{when} · {title}</p>
                    <p className="text-[13px] leading-5 text-[#595959]">{detail}</p>
                  </div>
                  {m.status === "ingested" ? (
                    <TertiaryButton onClick={() => onView(m)}>View</TertiaryButton>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SelectItemsModal({ capture, onClose }: { capture: MeetingRow; onClose: () => void }) {
  const [atoms, setAtoms] = useState<Atom[] | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiFetch(`/api/workspace/notetaker-meetings/${capture.id}/atoms`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { atoms: Atom[] };
        if (!alive) return;
        setAtoms(data.atoms ?? []);
        setChecked(Object.fromEntries((data.atoms ?? []).map((a) => [a.id, a.status !== "rejected"])));
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [capture.id]);

  const selectedCount = Object.values(checked).filter(Boolean).length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Meeting notes"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-[560px] flex-col overflow-hidden rounded-block bg-white shadow-[0_32px_64px_-12px_rgba(16,18,20,0.45)]"
        onClick={(e) => e.stopPropagation()}
      >
        {}
        <div className="flex shrink-0 items-center justify-between border-b border-[#f0f0f0] px-6 py-4">
          <p className="text-[16px] font-semibold text-[#0e0f11]">Meeting notes</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-cta text-[#595959] transition-colors hover:bg-[#f9f9f9] hover:text-[#1f1f1f]"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>

        {}
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <CaptureNotes captureId={capture.id} />
          <p className="px-6 pt-4 text-[14px] font-semibold text-[#0e0f11]">Items for the company brain</p>
          {err ? (
            <p className="px-6 py-6 text-[13px] text-[#cb2029]">Couldn’t load items: {err}</p>
          ) : atoms === null ? (
            <div className="space-y-3 px-6 py-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="h-5 w-5 rounded" />
                  <div className="flex-1">
                    <Skeleton className="h-3.5 w-40" />
                    <Skeleton className="mt-1.5 h-3 w-64" />
                  </div>
                </div>
              ))}
            </div>
          ) : atoms.length === 0 ? (
            <p className="px-6 py-8 text-center text-[13px] text-[#595959]">No items were distilled from this capture.</p>
          ) : (
            atoms.map((a, i) => {
              const on = checked[a.id];
              return (
                <label
                  key={a.id}
                  className={`flex cursor-pointer items-start gap-4 px-6 py-3 ${i > 0 ? "border-t border-[#f0f0f0]" : ""}`}
                >
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                      on ? "border-[#0e0f11] bg-[#0e0f11] text-white" : "border-[#d9d9d9] bg-white"
                    }`}
                  >
                    {on ? <IconCheck className="h-3 w-3" /> : null}
                  </span>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on ?? false}
                    onChange={() => setChecked((p) => ({ ...p, [a.id]: !p[a.id] }))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[16px] font-medium leading-5 text-[#0e0f11]">
                      {a.title}
                      {a.owner ? <span className="font-normal text-[#8c8c8c]"> · {a.owner}</span> : null}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] leading-4 text-[#595959]">
                      {a.body || a.atom_type.replace(/_/g, " ")}
                    </span>
                  </span>
                </label>
              );
            })
          )}
        </div>

        {}
        {atoms && atoms.length > 0 ? (
          <div className="shrink-0 border-t border-[#f0f0f0] px-6 py-4">
            {saveNote ? (
              <div className="mb-3 flex items-start gap-2 rounded-[10px] border border-[#ffce70] bg-[#fffaf0] px-3 py-2">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#946300]" strokeWidth={1.6} aria-hidden />
                <span className="text-[12px] leading-[18px] text-[#946300]">{saveNote}</span>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] text-[#595959]">{selectedCount} of {atoms.length} selected</span>
              <PrimaryButton
                onClick={() =>
                  setSaveNote(
                    "Saving a hand-picked subset isn’t available yet. This is coming soon. These captured items already await your approval in Needs you before they’re written to the brain.",
                  )
                }
              >
                Save to brain
              </PrimaryButton>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
