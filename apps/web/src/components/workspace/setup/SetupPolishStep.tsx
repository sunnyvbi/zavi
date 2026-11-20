"use client";

import { useEffect, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { PRIMARY, SkipButton, StickyActions } from "./SetupSteps";
import * as copy from "./setupCopy";
import { NextChevron } from "@/components/ui/NextChevron";
import { useSetupPolishForm, type Fillable } from "./useSetupPolishForm";

const shown = (value: string | string[]) => Array.isArray(value) ? (value.length ? value.join(", ") : "none") : value;
const FIELD = "block h-11 w-full rounded-xl border border-rule bg-cream px-4 text-[14px] text-ink placeholder:text-inkMuted focus:border-ink focus:outline-none";
const LABEL = "mb-1.5 block text-[14px] font-medium text-inkMuted";

export function SetupPolishStep({ onFinish, onSkip, onDirtyChange }: { onFinish: (problems: string[]) => Promise<void>; onSkip?: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const {
    before, form, compDraft, setCompDraft, busy, prefillSettled, prefillFailed,
    touched, fromFile, sugg, importsGaveUp, factsGaveUp, awaitingFileFacts,
    compSearch, edit, useGuess, useFileValue, keepMine, readingName, finish, fromFiles, dirty,
  } = useSetupPolishForm(onFinish);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const note = (k: Fillable): ReactNode => {
    const offer = sugg[k];
    if (offer) {
      return (
        <span role="note" className="mt-2 block rounded-xl bg-creamDeep px-3 py-2.5 text-[13px] leading-5 text-ink">
          {copy.fileSays(offer.file, shown(offer.value))}
          <span className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => useFileValue(k)} className="inline-flex h-8 items-center rounded-cta border border-rule bg-cream px-3 text-[13px] font-semibold text-ink hover:bg-creamDeep">
              {k === "competitors" ? copy.USE_FILE_LIST : copy.USE_FILE_LINE}
            </button>
            <button type="button" onClick={() => keepMine(k)} className="inline-flex h-8 items-center rounded-cta px-3 text-[13px] font-semibold text-inkMuted hover:text-ink">
              {copy.KEEP_MINE}
            </button>
          </span>
        </span>
      );
    }
    const tag = fromFile[k];
    if (tag) {
      return (
        <span className="mt-1.5 flex items-center gap-2.5 text-[13px]">
          <span className="inline-flex items-center rounded-full bg-success/10 px-2.5 py-0.5 font-semibold text-success">{copy.fromFile(tag.file)}</span>
          <button type="button" onClick={() => useGuess(k)} className="font-semibold text-inkMuted underline-offset-2 hover:text-ink hover:underline">
            {copy.USE_WEBSITE_GUESS}
          </button>
        </span>
      );
    }
    return null;
  };

  const competitorHint =
    compSearch === "found" && form.competitors.length > 0 && !touched.has("competitors") ? (
      <span className="mt-1.5 block text-[13px] text-inkMuted">{copy.COMPETITORS_FOUND}</span>
    ) : compSearch === "none" && form.competitors.length === 0 ? (
      <span className="mt-1.5 block text-[13px] text-inkMuted">{copy.NO_COMPETITORS_FOUND}</span>
    ) : null;
  return (
    <div className="space-y-6">
      <p className="text-[14px] leading-6 text-inkMuted">{readingName ? copy.polishIntroReading(readingName) : copy.polishIntro(fromFiles, before.domain.trim() !== "")}</p>
      <div>
        <p className="text-[16px] font-semibold text-ink">Company details</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label><span className={LABEL}>Company name</span>
              <input className={FIELD} value={form.company_name} onChange={(e) => edit("company_name", { ...form, company_name: e.target.value })} /></label>
            {note("company_name")}
          </div>
          <label><span className={LABEL}>Website</span>
            <input className={FIELD} value={form.domain} onChange={(e) => edit("domain", { ...form, domain: e.target.value })} /></label>
        </div>
        <div className="mt-4">
          <label className="block"><span className={LABEL}>What you do, in one line</span>
            <input className={FIELD} value={form.what_we_sell} onChange={(e) => edit("what_we_sell", { ...form, what_we_sell: e.target.value })} /></label>
          {note("what_we_sell")}
        </div>
        <div className="mt-4">
          <span className={LABEL}>Competitors to track</span>
          <div className="flex flex-wrap items-center gap-2">
            {form.competitors.map((c) => (
              <span key={c} className="inline-flex h-9 items-center gap-2 rounded-lg border border-rule px-3 text-[14px] font-medium text-ink">
                {c}
                <button type="button" aria-label={`Remove ${c}`} onClick={() => edit("competitors", { ...form, competitors: form.competitors.filter((x) => x !== c) })} className="text-inkMuted hover:text-ink">×</button>
              </span>
            ))}
            <form onSubmit={(e) => { e.preventDefault(); const v = compDraft.trim(); if (v && !form.competitors.includes(v)) edit("competitors", { ...form, competitors: [...form.competitors, v] }); setCompDraft(""); }}>
              <input value={compDraft} onChange={(e) => setCompDraft(e.target.value)} placeholder="Add a competitor" aria-label="Add a competitor" className={cn(FIELD, "h-9 w-44")} />
            </form>
            {compSearch === "loading" && (
              <span role="status" className="inline-flex h-9 items-center gap-2 text-[13px] text-inkMuted">
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                {copy.FINDING_COMPETITORS}
              </span>
            )}
          </div>
          {note("competitors") ?? competitorHint}
        </div>
      </div>
      {(importsGaveUp || factsGaveUp) && (
        <p role="status" className="text-[13px] text-inkMuted">{copy.FILE_DETAILS_FAILED}</p>
      )}
      {prefillSettled && prefillFailed && (
        <p role="status" className="text-[13px] text-inkMuted">Some of your details didn&rsquo;t load. You can still finish and fix them later in Company Details.</p>
      )}
      <StickyActions skip={onSkip && !busy ? <SkipButton onSkip={onSkip} /> : undefined}>
        <button type="button" className={PRIMARY} disabled={busy || !prefillSettled || awaitingFileFacts} onClick={() => void finish()}>
          {busy ? copy.SAVING_LABEL : <>{copy.FINISH_LABEL} <NextChevron /></>}
        </button>
      </StickyActions>
    </div>
  );
}
