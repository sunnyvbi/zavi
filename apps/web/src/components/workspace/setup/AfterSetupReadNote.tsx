"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { uploadAll } from "./ImportFlow";
import { ACCEPT } from "./importFiles";
import { namesOf, summarizeReads } from "./importReads";
import { saveAfterRead } from "./importReadState";
import { formFromFacts, type CompanyForm } from "./polish";
import { useSetupOptional } from "./SetupProvider";
import * as copy from "./setupCopy";

const BTN = "inline-flex h-8 shrink-0 items-center rounded-cta border border-rule bg-cream px-3 text-[13px] font-semibold text-ink hover:bg-creamDeep";

export function AfterSetupReadNote() {
  const setup = useSetupOptional();
  const s = setup?.state && setup.state.enabled ? setup.state : null;
  const afterRead = setup?.afterRead ?? null;
  const all = setup?.imports?.files;
  const reads = summarizeReads(afterRead ? (all ?? []).filter((f) => afterRead.files.includes(f.id)) : all);
  const [filled, setFilled] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const settled = reads.reading.length === 0;

  useEffect(() => {
    if (!afterRead || !settled || filled !== null || !reads.done.length || !afterRead.untouched.length) return;
    void (async () => {
      try {
        const res = await apiFetch("/api/connectors/company-facts");
        const body = (await res.json().catch(() => null)) as { facts?: Array<{ key: string; value_text: string | null }> } | null;
        if (!res.ok) return;
        const now = formFromFacts(body?.facts ?? []);
        const val = (k: string) => {
          const v = now[k as keyof CompanyForm];
          return Array.isArray(v) ? v.join(", ") : v;
        };
        setFilled(afterRead.untouched.filter((u) => val(u.key) && val(u.key) !== u.value).map((u) => u.label));
      } catch {
      }
    })();
  }, [afterRead, settled, filled, reads.done.length]);

  const failedOnly = reads.failed.length > 0 && !reads.done.length && !reads.stored.length;
  const settledShown = !!afterRead && !!s?.done && settled && (failedOnly || reads.done.length > 0);
  useEffect(() => {
    if (settledShown) saveAfterRead(null);
  }, [settledShown]);

  if (!s || !s.done) return null;
  if (!afterRead && settled) return null;

  if (!settled) {
    const name = namesOf(reads.reading);
    return (
      <div role="status" className="mb-3 rounded-xl bg-creamDeep px-4 py-3 text-[14px] leading-6 text-ink">
        <p>{s.draft.status === "none" ? copy.afterWaiting(name) : copy.afterReadingOnly(name)}</p>
        <p className="text-inkMuted">{copy.AFTER_LEAVE}</p>
      </div>
    );
  }
  if (failedOnly) {
    const f = reads.failed[0];
    return (
      <div role="status" className="mb-3 flex items-center gap-3 rounded-xl bg-marigold/15 px-4 py-3 text-[14px] leading-6 text-ink">
        <span className="flex-1">{copy.afterFailed(namesOf(reads.failed), f.reason ?? "unknown error")}</span>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          data-testid="after-retry-input"
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (!picked.length) return;
            setBusy(true);
            const ids: string[] = [];
            void uploadAll(picked, (r) => {
              if ("remove" in r) ids.push(r.id);
            })
              .then((n) => {
                if (afterRead && ids.length) setup?.setAfterRead?.({ ...afterRead, files: [...afterRead.files, ...ids] });
                return n > 0 ? setup?.imports?.refresh() : undefined;
              })
              .finally(() => setBusy(false));
          }}
        />
        <button type="button" className={BTN} disabled={busy} onClick={() => input.current?.click()}>
          {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />}
          {copy.TRY_ANOTHER_FILE}
        </button>
      </div>
    );
  }
  if (!reads.done.length) return null;
  return (
    <p role="status" className="mb-3 rounded-xl bg-creamDeep px-4 py-3 text-[14px] leading-6 text-ink">
      <b>{copy.afterReadLine(namesOf(reads.done))}</b>
      {filled && filled.length > 0 && afterRead?.untouched.length ? copy.afterFilled(filled) : null}
      {copy.AFTER_CONFLICTS}
    </p>
  );
}
