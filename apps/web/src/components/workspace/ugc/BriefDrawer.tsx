"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AD_RIGHTS_DAYS,
  BUSINESS_FEE_BPS,
  CREATOR_FEE_BPS,
  CREATOR_NICHES,
  CREATOR_VIDEO_CHANNEL_SPECS,
  CREATOR_VIDEO_PREFILL,
  isCreatorVideoChannel,
  type CreatorVideoChannel,
} from "@zavi/shared";
import { CalendarClock, Check, Clock, Copy, Lock, MapPin, Repeat2, Users, Wallet } from "lucide-react";
import type { BriefWorkbenchResponse, TenantBrief } from "@/components/humans/humanPostedBriefs";
import type { HumanBrief, HumanBriefsResponse } from "@/components/humans/humanTypes";
import { feesFor, money, notifyBriefsChanged, shortDay, useUgcDrawer } from "./hub";
import { BTN_PRIMARY, BTN_SECONDARY, CARD, DrawerNote, FIELD, ProductQuestion, SideDrawer } from "./ui";
import { callJson } from "./useCards";
import { loadBudgetHint } from "./CreatorHiringCards";
import { creatorBudgetSource, perVideoCents, type BudgetHint } from "./creatorCards";
import { DatePicker } from "./DatePicker";
import { canPublishBrief, canSaveBrief, shownBriefErrors, type BriefFieldKey, type BriefFieldValues } from "./briefValidation";

const PLATFORMS = ["TikTok", "Instagram", "YouTube", "X", "LinkedIn"];

function earliestAnswerBy(): string {
  const now = new Date();
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const utc = now.toISOString().slice(0, 10);
  return local > utc ? local : utc;
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = `date-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div className="block">
      <span id={`${id}-label`} className="text-[14px] font-medium text-ink">{label}</span>
      <div className="mt-1.5">
        <DatePicker id={id} labelledBy={`${id}-label`} min={earliestAnswerBy()} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

function Field({ label, hint, error, errorId, children }: { label: string; hint?: string; error?: string; errorId?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[14px] font-medium text-ink">{label}</span>
      {hint && <span className="ml-1.5 text-[13px] text-inkMuted">{hint}</span>}
      <div className="mt-1.5">{children}</div>
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-[13px] text-danger">
          {error}
        </p>
      )}
    </label>
  );
}

const BAD_FIELD = FIELD.replace("border-rule", "border-danger").replace("focus:border-inkMuted", "focus:border-danger");
const FIELD_KEYS: readonly string[] = ["title", "angle", "hook", "format", "deliverables", "budget", "days", "cap", "locations", "note"];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-t border-rule pt-4">
      <h2 className="text-[16px] font-bold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex min-h-9 cursor-pointer items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inkMuted border px-3.5 text-[14px] font-medium transition-colors ${
        on ? "border-ink bg-ink text-cream" : "border-rule bg-cream text-ink hover:bg-bone"
      }`}
    >
      {on && <Check className="mr-1.5 h-4 w-4" aria-hidden="true" />}
      {label}
    </button>
  );
}

const digits = (v: string) => v.replace(/\D/g, "");
const PLACEHOLDER = /^Write (what|the hook|the format)|^Untitled brief$/;
const clean = (v: string | null | undefined) => (v && !PLACEHOLDER.test(v) ? v : "");

type Draft = {
  title: string;
  angle: string;
  hook: string;
  format: string;
  deliverables: string;
  platforms: string[];
  budget: string;
  days: string;
  niches: string[];
  locations: string;
  answerBy: string;
  cap: string;
  note: string;
  product: boolean;
  rights: string;
};

export type Prefill = {
  budget: BudgetHint;
  source: Pick<HumanBrief, "title" | "angle" | "hook"> | null;
};

export function angleSource(briefs: HumanBrief[], from: CreatorVideoChannel): Prefill["source"] {
  const usable = briefs.filter((b) => b.source_channel === from && b.status !== "cancelled" && clean(b.angle) && clean(b.hook));
  usable.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return usable[0] ?? null;
}

export function prefillFor(from: CreatorVideoChannel, p: Prefill = { budget: null, source: null }): Draft {
  const spec = CREATOR_VIDEO_CHANNEL_SPECS[from];
  return {
    ...draftFrom(null),
    title: `${spec.name} creator video`,
    angle: clean(p.source?.angle),
    hook: clean(p.source?.hook),
    format: CREATOR_VIDEO_PREFILL.format,
    deliverables: String(CREATOR_VIDEO_PREFILL.deliverables),
    platforms: [spec.platform],
    budget: p.budget ? String(Math.round(perVideoCents(p.budget) / 100)) : "",
    rights: String(CREATOR_VIDEO_PREFILL.ad_rights_days),
  };
}

export function budgetSentence(budget: BudgetHint): string | null {
  return creatorBudgetSource(budget);
}

const DEFAULT_AD_RIGHTS_DAYS = CREATOR_VIDEO_PREFILL.ad_rights_days;

const carried = new Map<string, { error: string | null; saved: boolean }>();

function draftFrom(b: TenantBrief | null): Draft {
  return {
    title: clean(b?.title),
    angle: clean(b?.angle),
    hook: clean(b?.hook),
    format: clean(b?.format),
    deliverables: b?.deliverables ? String(b.deliverables) : "1",
    platforms: b?.filters?.platforms ?? [],
    budget: b?.budget_usd !== null && b?.budget_usd !== undefined ? String(Math.round(Number(b.budget_usd))) : "",
    days: b?.delivery_days ? String(b.delivery_days) : "",
    niches: b?.filters?.niches ?? [],
    locations: (b?.filters?.locations ?? []).join(", "),
    answerBy: b?.answer_by ? b.answer_by.slice(0, 10) : "",
    cap: b?.applicant_cap ? String(b.applicant_cap) : "20",
    note: b?.decline_note ?? "",
    product: b?.product_needed === true,
    rights: b?.ad_rights_days ? String(b.ad_rights_days) : String(DEFAULT_AD_RIGHTS_DAYS),
  };
}

function toInput(d: Draft, from: CreatorVideoChannel | null) {
  const list = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return {
    title: d.title.trim(),
    angle: d.angle.trim(),
    hook: d.hook.trim(),
    format: d.format.trim(),
    deliverables: d.deliverables ? Number(d.deliverables) : null,
    lane: "ugc_video",
    budget_usd: d.budget ? Number(d.budget) : null,
    delivery_days: d.days ? Number(d.days) : null,
    applicant_cap: d.cap ? Number(d.cap) : null,
    answer_by: d.answerBy ? `${d.answerBy}T23:59:59.000Z` : null,
    decline_note: d.note.trim() || null,
    product_needed: d.product,
    ad_rights_days: d.rights ? Number(d.rights) : null,
    filters: { niches: d.niches, platforms: d.platforms, locations: list(d.locations) },
    ...(from ? { source_channel: from } : {}),
  };
}

export function BriefDrawer() {
  const drawer = useUgcDrawer();
  const briefId = drawer.params.brief ?? null;
  const [bench, setBench] = useState<BriefWorkbenchResponse | null>(null);
  const [loaded, setLoaded] = useState(briefId === null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!briefId) {
      setBench(null);
      setLoaded(true);
      return;
    }
    let alive = true;
    setLoaded(false);
    void callJson<BriefWorkbenchResponse>(`/api/humans/briefs/${encodeURIComponent(briefId)}/workbench`).then((r) => {
      if (!alive) return;
      if (r.ok) setBench(r.data);
      else setLoadError(r.message);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [briefId]);

  const posted = Boolean(bench?.brief.posted_at);
  const fromRaw = drawer.params.from;
  const from = !briefId && isCreatorVideoChannel(fromRaw) ? fromRaw : null;
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  useEffect(() => {
    if (!from) return;
    let alive = true;
    setPrefill(null);
    void Promise.all([loadBudgetHint(), callJson<HumanBriefsResponse>("/api/humans/briefs")]).then(([budget, briefs]) => {
      if (alive) setPrefill({ budget, source: briefs.ok ? angleSource(briefs.data.briefs ?? [], from) : null });
    });
    return () => {
      alive = false;
    };
  }, [from]);
  const reposted = drawer.params.reposted === "1" && !posted;
  const title = posted
    ? bench?.brief.closed_at
      ? "Closed brief"
      : "Published brief"
    : reposted
      ? "Edit the copy, then publish"
      : from
      ? `Get a creator video for ${CREATOR_VIDEO_CHANNEL_SPECS[from].name}`
      : "Post a brief to Zavi creators";

  return (
    <SideDrawer title={title} onClose={drawer.close}>
      {!loaded || (from && !prefill) ? (
        <DrawerNote>Loading the brief…</DrawerNote>
      ) : loadError ? (
        <DrawerNote>{loadError}</DrawerNote>
      ) : posted && bench ? (
        <PublishedBrief bench={bench} />
      ) : (
        <>
          {reposted && (
            <div role="status" className="mb-4 flex items-start gap-3 rounded-xl border border-rule bg-creamDeep px-4 py-3 text-[14px] leading-relaxed text-ink">
              <Copy className="mt-0.5 h-4 w-4 shrink-0 text-inkMuted" aria-hidden="true" />
              <div>
                <p className="font-semibold">This is a copy of your closed brief</p>
                <p className="mt-0.5 text-inkSoft">
                  Change what you need, then publish. Creators see it as a new brief, with a new answer-by date set when you publish.
                </p>
              </div>
            </div>
          )}
          {from && (
            <div className="mb-4 rounded-xl border border-rule bg-creamDeep px-4 py-3 text-[14px] leading-relaxed text-ink">
              <p className="font-semibold">From {CREATOR_VIDEO_CHANNEL_SPECS[from].name}</p>
              <p className="mt-1 text-inkSoft">
                Zavi filled this in for {CREATOR_VIDEO_CHANNEL_SPECS[from].placement}: 9:16, 30 seconds, ad rights for{" "}
                {CREATOR_VIDEO_PREFILL.ad_rights_days} days.
                {budgetSentence(prefill?.budget ?? null) && <> {budgetSentence(prefill?.budget ?? null)}</>}
                {prefill?.budget && <> This estimate was refreshed when you opened the editor and may differ from the card.</>}
                {!prefill?.source && <> Add the angle and hook for your business.</>}
                {prefill?.source && <> The angle and hook are from your brief &ldquo;{prefill.source.title || "Untitled brief"}&rdquo;.</>}{" "}
                Change anything before you publish.
              </p>
            </div>
          )}
          <BriefEditor key={briefId ?? from ?? "new"} briefId={briefId} bench={bench} from={from} prefill={prefill} />
        </>
      )}
    </SideDrawer>
  );
}

function Fact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-rule bg-cream px-3 py-2.5">
      <dt className="flex items-center gap-1.5 text-[12px] text-inkMuted">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 text-[15px] font-semibold text-ink tabular-nums">{value}</dd>
    </div>
  );
}

function PublishedBrief({ bench }: { bench: BriefWorkbenchResponse }) {
  const drawer = useUgcDrawer();
  const b = bench.brief;
  const closed = Boolean(b.closed_at);
  const n = bench.applicant_count;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repost = async () => {
    setBusy(true);
    setError(null);
    const r = await callJson<{ brief: TenantBrief }>(`/api/humans/briefs/${encodeURIComponent(b.id)}/repost`, { body: {}, idempotent: true });
    setBusy(false);
    if (r.ok) {
      notifyBriefsChanged();
      drawer.open("brief", { brief: r.data.brief.id, reposted: "1" });
    } else setError(r.message);
  };
  const icon = "h-3.5 w-3.5";
  const day = shortDay;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-inkMuted">
        <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${closed ? "bg-bone text-inkMuted" : "bg-successBg text-success"}`}>
          {closed ? "Closed" : "Open"}
        </span>
        {b.posted_at && <span>Posted {day(b.posted_at)}</span>}
        {closed && <span>· Closed {day(b.closed_at)}</span>}
      </div>
      <div className={CARD}>
        <h2 className="text-[20px] leading-snug font-bold text-ink">{b.title}</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-inkSoft">{b.angle}</p>
        <p className="mt-3 text-[14px] leading-relaxed text-inkSoft">
          <span className="font-semibold text-ink">Hook: </span>
          {b.hook}
        </p>
        <p className="mt-1 text-[14px] text-inkSoft">
          <span className="font-semibold text-ink">Format: </span>
          {b.format}
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-2">
          <Fact icon={<Users className={icon} aria-hidden="true" />} label="Applied" value={b.applicant_cap ? `${n} of ${b.applicant_cap}` : String(n)} />
          <Fact icon={<CalendarClock className={icon} aria-hidden="true" />} label="Answer by" value={day(b.answer_by) || "Not set"} />
          <Fact
            icon={<Wallet className={icon} aria-hidden="true" />}
            label="Budget"
            value={b.budget_usd ? `${money(Math.round(Number(b.budget_usd) * 100))} per video` : "Not set"}
          />
          <Fact icon={<Clock className={icon} aria-hidden="true" />} label="Deliver in" value={b.delivery_days ? `${b.delivery_days} days` : "Not set"} />
        </dl>
        <p className="mt-4 flex items-center gap-1.5 text-[12px] text-inkMuted">
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          {closed ? "Closed briefs can't be edited or reopened. Make a copy to post it again." : "Published briefs can't be edited. To change it, close it and repost a copy."}
        </p>
      </div>
      {error && <p className="rounded-lg bg-dangerBg px-3 py-2 text-[13px] text-danger">{error}</p>}
      {asking ? (
        <div role="group" aria-label="Confirm repost" className="rounded-2xl border border-rule bg-creamDeep p-4">
          <p className="text-[15px] font-semibold text-ink">{closed ? "Make an editable copy of this brief?" : "Close this brief and start a copy?"}</p>
          <ul className="mt-2 grid gap-1.5 text-[14px] leading-relaxed text-inkSoft">
            {!closed && <li>Creators can no longer apply to this brief. Nobody gets a message.</li>}
            {!closed && n > 0 && (
              <li>
                {n === 1 ? "The 1 applicant stays" : `The ${n} applicants stay`} listed under this closed brief.
              </li>
            )}
            <li>You get a draft copy to edit. Nothing is posted until you publish it.</li>
          </ul>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button type="button" disabled={busy} onClick={() => setAsking(false)} className={BTN_SECONDARY}>
              Not yet
            </button>
            <button type="button" disabled={busy} onClick={() => void repost()} className={`${BTN_PRIMARY} inline-flex items-center gap-1.5`}>
              {closed ? <Copy className="h-4 w-4" aria-hidden="true" /> : <Repeat2 className="h-4 w-4" aria-hidden="true" />}
              {busy ? (closed ? "Copying" : "Closing") : closed ? "Make a copy" : "Close and repost"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => drawer.open("applicants", { brief: b.id })} className={BTN_PRIMARY}>
            See {n} {n === 1 ? "applicant" : "applicants"}
          </button>
          <button type="button" onClick={() => setAsking(true)} className={`${BTN_SECONDARY} inline-flex items-center gap-1.5`}>
            {closed ? <Copy className="h-4 w-4" aria-hidden="true" /> : <Repeat2 className="h-4 w-4" aria-hidden="true" />}
            {closed ? "Make a copy" : "Close and repost"}
          </button>
        </div>
      )}
    </div>
  );
}

function BriefEditor({
  briefId,
  bench,
  from = null,
  prefill = null,
}: {
  briefId: string | null;
  bench: BriefWorkbenchResponse | null;
  from?: CreatorVideoChannel | null;
  prefill?: Prefill | null;
}) {
  const drawer = useUgcDrawer();
  const [d, setD] = useState<Draft>(() =>
    from && !bench ? prefillFor(from, prefill ?? undefined) : draftFrom(bench?.brief ?? null),
  );
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [error, setError] = useState<string | null>(() => (briefId ? carried.get(briefId)?.error ?? null : null));
  const [saved, setSaved] = useState(() => (briefId ? carried.get(briefId)?.saved ?? false : false));
  useEffect(() => {
    if (briefId && bench) carried.delete(briefId);
  }, [briefId, bench]);
  const [confirming, setConfirming] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<BriefFieldKey>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    if (FIELD_KEYS.includes(k)) setTouched((t) => (t.has(k as BriefFieldKey) ? t : new Set(t).add(k as BriefFieldKey)));
    setSaved(false);
    setConfirming(false);
    setD((x) => ({ ...x, [k]: v }));
  };
  const flip = (k: "platforms" | "niches", v: string) =>
    set(k, d[k].includes(v) ? d[k].filter((x) => x !== v) : [...d[k], v]);

  const budgetN = Number(d.budget) || 0;
  const budgetFees = budgetN > 0 ? feesFor(budgetN * 100) : null;
  const values: BriefFieldValues = {
    title: d.title,
    angle: d.angle,
    hook: d.hook,
    format: d.format,
    deliverables: d.deliverables,
    budget: d.budget,
    days: d.days,
    cap: d.cap,
    locations: d.locations,
    note: d.note,
  };
  const errs = shownBriefErrors(values, touched, showAll);
  const ready = canSaveBrief(values);
  const publishable = canPublishBrief(values);
  const check = (k: BriefFieldKey) => ({
    "aria-invalid": Boolean(errs[k]),
    "aria-describedby": errs[k] ? `brief-${k}-error` : undefined,
    className: errs[k] ? BAD_FIELD : FIELD,
  });
  const err = (k: BriefFieldKey) => ({ error: errs[k], errorId: `brief-${k}-error` });

  const save = useCallback(async (): Promise<string | null> => {
    const input = toInput(d, briefId ? null : from);
    if (!briefId) {
      const r = await callJson<{ brief: TenantBrief }>("/api/humans/briefs", { body: input });
      if (!r.ok) {
        setError(r.message);
        return null;
      }
      notifyBriefsChanged();
      return r.data.brief.id;
    }
    const r = await callJson<BriefWorkbenchResponse>(`/api/humans/briefs/${encodeURIComponent(briefId)}`, {
      method: "PATCH",
      body: input,
    });
    if (!r.ok) {
      setError(r.message);
      return null;
    }
    notifyBriefsChanged();
    return briefId;
  }, [d, briefId, from]);

  const onSave = async () => {
    setBusy("save");
    setError(null);
    const id = await save();
    setBusy(null);
    if (!id) return;
    setSaved(true);
    if (id !== briefId) {
      carried.set(id, { error: null, saved: true });
      drawer.open("brief", { brief: id });
    }
  };

  const onPublish = async () => {
    if (!publishable) return;
    setBusy("publish");
    setError(null);
    const id = await save();
    if (!id) {
      setBusy(null);
      setConfirming(false);
      return;
    }
    const r = await callJson<unknown>(`/api/humans/briefs/${encodeURIComponent(id)}/publish`, { body: {} });
    setBusy(null);
    if (!r.ok) {
      setError(r.message);
      setConfirming(false);
      if (id !== briefId) {
        carried.set(id, { error: r.message, saved: false });
        drawer.open("brief", { brief: id });
      }
      return;
    }
    notifyBriefsChanged();
    drawer.close();
  };

  const business = bench?.creator_preview.business_name ?? "";

  return (
    <div className="grid gap-5">
      <DrawerNote>You can change anything while it is a draft. Once you publish, the brief can&apos;t be edited.</DrawerNote>
      <form className={`${CARD} grid gap-4`} onSubmit={(e) => e.preventDefault()}>
        <div>
          <p className="text-[13px] font-semibold text-inkMuted">
            {bench?.brief.rationale && !/^Written by hand/.test(bench.brief.rationale) ? "Drafted by Zavi, change anything" : "Your draft, change anything"}
          </p>
          <h1 className="text-[22px] font-bold tracking-tight text-ink">Draft brief</h1>
        </div>
        <Section title="The video">
          <Field label="Title" {...err("title")}>
            <input {...check("title")} value={d.title} onChange={(e) => set("title", e.target.value)} placeholder="What the video is for" />
          </Field>
          <Field label="Angle" hint="what the video is about" {...err("angle")}>
            <textarea rows={3} {...check("angle")} value={d.angle} onChange={(e) => set("angle", e.target.value)} />
          </Field>
          <Field label="Hook" hint="the first seconds" {...err("hook")}>
            <textarea rows={2} {...check("hook")} value={d.hook} onChange={(e) => set("hook", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Format" {...err("format")}>
              <input {...check("format")} value={d.format} onChange={(e) => set("format", e.target.value)} placeholder="For example, vertical video, 30 seconds" />
            </Field>
            <Field label="How many videos" hint="1 to 20" {...err("deliverables")}>
              <input inputMode="numeric" {...check("deliverables")} value={d.deliverables} onChange={(e) => set("deliverables", digits(e.target.value).slice(0, 3))} />
            </Field>
          </div>
          <ProductQuestion value={d.product} onChange={(v) => set("product", v)} />
        </Section>
        <Section title="Where it runs">
          <div>
            <p className="text-[14px] font-semibold text-ink">
              Ad rights <span className="ml-1.5 text-[13px] font-normal text-inkMuted">how long you may run the video in your ads</span>
            </p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {AD_RIGHTS_DAYS.map((n) => (
                <Toggle key={n} label={`${n} days`} on={d.rights === String(n)} onClick={() => set("rights", String(n))} />
              ))}
            </div>
          </div>
          <div>
            <p className="text-[14px] font-semibold text-ink">Platforms</p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {PLATFORMS.map((p) => (
                <Toggle key={p} label={p} on={d.platforms.includes(p)} onClick={() => flip("platforms", p)} />
              ))}
            </div>
          </div>
        </Section>
        <Section title="Money and time">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Budget per video" hint="in dollars, creators set their own price" {...err("budget")}>
              <input inputMode="numeric" {...check("budget")} value={d.budget} onChange={(e) => set("budget", digits(e.target.value).slice(0, 7))} />
            </Field>
            <Field label="Days to deliver" hint="1 to 90, after you hire" {...err("days")}>
              <input inputMode="numeric" {...check("days")} value={d.days} onChange={(e) => set("days", digits(e.target.value).slice(0, 3))} />
            </Field>
          </div>
          <p className="text-[13px] text-inkSoft">
            Your budget guides applications; creators set their own prices. You pay the agreed price plus Zavi&apos;s {BUSINESS_FEE_BPS / 100}% fee, shown before hire. Saving or publishing this brief does not charge you.
          </p>
          {budgetFees && (
            <p className="text-[13px] text-inkSoft">
              For example, at an agreed price of {money(budgetFees.price_cents)} per video, your total would be {money(budgetFees.business_total_cents)} including the fee. This is an estimate, not a booking price.
            </p>
          )}
          <DateField label="Answer everyone by" value={d.answerBy} onChange={(v) => set("answerBy", v)} />
        </Section>
        <Section title="Who can apply">
          <div>
            <p className="text-[14px] font-semibold text-ink">Niches</p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {}
              {[...CREATOR_NICHES, ...d.niches.filter((n) => !(CREATOR_NICHES as readonly string[]).includes(n))].map((n) => (
                <Toggle key={n} label={n} on={d.niches.includes(n)} onClick={() => flip("niches", n)} />
              ))}
            </div>
          </div>
          <Field label="Locations" hint="cities or regions, comma separated" {...err("locations")}>
            <input {...check("locations")} value={d.locations} onChange={(e) => set("locations", e.target.value)} placeholder="Leave empty for anywhere" />
          </Field>
          <Field label="Application limit" hint="1 to 500" {...err("cap")}>
            <input inputMode="numeric" {...check("cap")} value={d.cap} onChange={(e) => set("cap", digits(e.target.value).slice(0, 4))} />
          </Field>
          <Field label="Note to people you don't hire" hint="sent once your payment goes through" {...err("note")}>
            <textarea rows={2} {...check("note")} value={d.note} onChange={(e) => set("note", e.target.value)} />
          </Field>
        </Section>
        {error && <p className="rounded-lg bg-dangerBg px-3 py-2 text-[13px] text-danger">{error}</p>}
        {confirming ? (
          <div role="group" aria-label="Confirm publish" className="flex flex-wrap items-center justify-end gap-2 border-t border-rule pt-4">
            <span className="mr-auto text-[14px] font-semibold text-ink">Publish for good? You can&apos;t edit it after.</span>
            <button type="button" disabled={busy !== null} onClick={() => setConfirming(false)} className={BTN_SECONDARY}>
              Not yet
            </button>
            <button type="button" disabled={busy !== null || !publishable} onClick={() => void onPublish()} className={BTN_PRIMARY}>
              {busy === "publish" ? "Publishing" : "Yes, publish"}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule pt-4">
            {!publishable && (
              <span className="mr-auto text-[13px] text-inkMuted">
                To publish: title, angle, hook, format, how many videos, budget, days to deliver and application limit.
              </span>
            )}
            {ready && saved && <span className="mr-auto text-[13px] text-mintDeep">Draft saved.</span>}
            <button type="button" disabled={busy !== null || !ready} onClick={() => void onSave()} className={BTN_SECONDARY}>
              {busy === "save" ? "Saving" : "Save draft"}
            </button>
            <button
              type="button"
              disabled={busy !== null || !ready}
              onClick={() => (publishable ? setConfirming(true) : setShowAll(true))}
              className={BTN_PRIMARY}
            >
              Publish
            </button>
          </div>
        )}
      </form>

      <aside>
        <p className="mb-2 text-[13px] font-bold tracking-[0.09em] text-inkMuted uppercase">What creators see</p>
        <div className={CARD}>
          {business && <p className="text-[13px] text-inkMuted">{business}</p>}
          <p className="mt-0.5 text-[20px] font-bold text-ink">{d.title || "Your title"}</p>
          <p className="mt-2 text-[14px] leading-relaxed text-inkSoft">{d.angle || "Your angle shows here."}</p>
          <p className="mt-2 text-[14px] leading-relaxed text-inkSoft">
            <span className="font-semibold text-ink">Hook: </span>
            {d.hook || "Not set"}
          </p>
          <p className="mt-1 text-[14px] text-inkSoft">
            <span className="font-semibold text-ink">Format: </span>
            {d.format || "Not set"} · {d.deliverables || "1"} {Number(d.deliverables) === 1 ? "video" : "videos"}
          </p>
          <p className="mt-1 text-[13px] text-inkMuted">UGC video: you post it and run it as an ad</p>
          {d.rights && (
            <p className="mt-1 text-[13px] text-inkMuted">Ad rights for {d.rights} days</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {[...d.platforms, ...d.niches].map((t) => (
              <span key={t} className="rounded-full bg-creamDeep px-2.5 py-0.5 text-[12px] text-inkSoft">
                {t}
              </span>
            ))}
          </div>
          <dl className="mt-4 grid gap-2 text-[14px]">
            {(
              [
                [<Wallet key="w" className="h-4 w-4" aria-hidden="true" />, "Budget", budgetN ? money(budgetN * 100) : "Not set"],
                [<Clock key="c" className="h-4 w-4" aria-hidden="true" />, "Deliver in", d.days ? `${d.days} days` : "Not set"],
                [<MapPin key="m" className="h-4 w-4" aria-hidden="true" />, "Where", d.locations || "Anywhere"],
                [
                  <CalendarClock key="a" className="h-4 w-4" aria-hidden="true" />,
                  "Answer by",
                  d.answerBy ? new Date(`${d.answerBy}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "Not set",
                ],
              ] as const
            ).map(([icon, k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-2 text-inkMuted">
                  {icon} {k}
                </dt>
                <dd className="text-right font-semibold text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          {budgetFees && (
            <p className="mt-3 rounded-lg bg-creamDeep px-3 py-2 text-[13px] text-inkSoft">
              Creator preview: at {money(budgetFees.price_cents)}, the creator receives {money(budgetFees.creator_payout_cents)} after Zavi&apos;s {CREATOR_FEE_BPS / 100}%.
            </p>
          )}
          <div className="mt-4 flex items-center justify-between gap-2">
            <span className="text-[13px] text-inkMuted">{d.cap ? `Up to ${d.cap} applications` : ""}</span>
            <span className="flex flex-col items-end gap-1" data-testid="preview-apply">
              <span
                aria-hidden="true"
                className="inline-flex min-h-9 items-center rounded-full border border-dashed border-inkMuted px-4 text-[14px] font-medium text-inkMuted select-none"
              >
                Apply
              </span>
              <span className="text-[11px] text-inkMuted">Creators see this button</span>
            </span>
          </div>
        </div>
      </aside>
    </div>
  );
}
