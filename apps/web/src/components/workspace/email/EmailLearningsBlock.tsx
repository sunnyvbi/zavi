"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Skeleton } from "../Skeleton";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { toast } from "@/components/ui/toast";

import {
  getLearnings,
  getRemovedLearnings,
  LEARNINGS_SEEN_EVENT,
  lookAgain,
  markLearningsSeen,
  setLearning,
  type Learning,
  type LearningAction,
  type LearningsView,
  type RemovedLearning,
} from "@/lib/workspace/emailLearningsApi";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";
const BTN = `inline-flex h-9 shrink-0 items-center justify-center rounded-cta border border-rule bg-white px-3.5 text-[13px] font-medium text-ink cursor-pointer transition-colors hover:border-inkLight hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const PRIMARY = `inline-flex h-9 shrink-0 items-center justify-center rounded-cta border border-ink bg-ink px-4 text-[13px] font-medium text-cream cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const ROW_ACTION = `inline-flex min-h-[48px] shrink-0 items-center justify-center rounded-cta border border-rule bg-white px-3 text-[13px] font-medium text-ink cursor-pointer transition-colors hover:border-inkLight hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-40 sm:h-8 sm:min-h-0 ${FOCUS}`;
const TEXT_BTN = `inline-flex h-7 shrink-0 items-center rounded-md border border-rule bg-white px-2.5 text-[12px] font-medium text-ink cursor-pointer transition-colors hover:border-inkLight hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const INPUT = `w-full min-w-0 resize-none rounded-[10px] border border-rule bg-cream px-3 py-2 text-[16px] leading-5 text-ink outline-none placeholder:text-inkLight focus:border-ink/40 sm:text-[14px] ${FOCUS}`;
const NOTE_ROW = "flex items-center gap-3 rounded-[10px] border border-rule px-3 py-2.5 text-[13px] text-inkMuted";

export const SEEN_AFTER_MS = 2500;
const CAP = 12;
const ROUTE_LABEL: Record<string, string> = { sendgrid: "SendGrid", mailchimp: "Mailchimp", klaviyo: "Klaviyo" };

export const LEARNINGS_COPY = {
  title: "What Zavi learned",
  intro: "Zavi reads these before writing each email.",
  introMember: "An owner or admin can change this list; you can suggest a line.",
  introViewer: "Only an owner or admin can change this list.",
  reading: "Reading your past emails. The first lessons appear here in a few minutes.",
  none: "Nothing yet. Zavi adds what it learns once it has enough of your own results to compare.",
  full: (n: number) => `The list is full (${CAP} lines) and every line is your team's. Zavi found ${n} more ${n === 1 ? "lesson" : "lessons"} in your results; remove a line to make room. Zavi never replaces your lines.`,
  keptStronger: (n: number) => `The list is full. Zavi kept its stronger lessons; ${n} more it found ${n === 1 ? "was" : "were"} weaker.`,
  unreadable: (tool: string) => `Could not read ${tool}'s past emails. Zavi tries again later.`,
  partial: (tool: string) => `Zavi read only part of ${tool}'s past emails so far. It reads the rest later.`,
  failed: "Zavi couldn't read your past emails yet. It will try again.",
  lookAgain: "Try now",
  stale: "Not read into drafts",
  early: "Early pattern",
  yours: "Added by your team",
  edited: "Edited by your team",
  waiting: "Waiting for an owner or admin",
  cantRecheck: "This tool is no longer connected, so Zavi can't re-check this.",
  added: "Added. Zavi reads it from the next draft.",
  suggested: "Suggested. An owner or admin decides whether Zavi reads it.",
  saved: "Saved. It is your line now: Zavi will not rewrite it.",
  removed: "Removed. Zavi will not add this lesson back.",
  restored: "Back on the list. Zavi reads it from the next draft.",
  activated: "Zavi reads it from the next draft.",
  footer: (active: number) => `${active} of ${CAP} lines in use.`,
} as const;

export const SEED_STUCK_MS = 30 * 60_000;

const EVIDENCE_TOOL: Record<string, string> = { sendgrid: "SendGrid", mailchimp: "Mailchimp", klaviyo: "Klaviyo" };

export function evidenceLine(l: Learning): string | null {
  if (l.origin !== "zavi" && !l.from_zavi) return null;
  const n = (l.stats.n_a ?? 0) + (l.stats.n_b ?? 0);
  if (!n) return null;
  const tool = l.route ? EVIDENCE_TOOL[l.route] : undefined;
  return `From ${n} of your past ${tool ? `${tool} ` : ""}emails${l.list_name && l.split !== "list" ? ` to ${l.list_name}` : ""}`;
}

function Pill({ tone, children }: { tone: "new" | "early" | "yours" | "waiting" | "stale"; children: string }) {
  const cls = {
    new: "bg-brand/10 text-brand",
    early: "bg-warnBg text-warn",
    yours: "bg-bone text-inkMuted",
    waiting: "bg-channel-geo/10 text-channel-geo",
    stale: "bg-bone text-inkMuted",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium leading-4 ${cls}`}>{children}</span>;
}

export function EmailLearningsBlock() {
  const role = useWorkspaceOptional()?.role ?? null;
  const canEdit = role === "owner" || role === "admin";
  const canSuggest = role === "member";
  const [view, setView] = useState<LearningsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState("");
  const [removed, setRemoved] = useState<RemovedLearning[] | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const newOnOpen = useRef<Set<string> | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);
  const [lookMsg, setLookMsg] = useState<string | null>(null);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const v = await getLearnings();
      if (newOnOpen.current === null) newOnOpen.current = new Set(v.items.filter((l) => l.is_new).map((l) => l.id));
      setView(v);
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let ratioOk = false;
    const update = () => setInView(ratioOk && document.visibilityState === "visible");
    const io = new IntersectionObserver(
      (entries) => {
        ratioOk = entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.4);
        update();
      },
      { threshold: [0, 0.4, 1] },
    );
    io.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  useEffect(() => {
    const fresh = view?.items.filter((l) => l.is_new) ?? [];
    if (fresh.length === 0 || !inView) return;
    const t = setTimeout(() => {
      markLearningsSeen(fresh.map((l) => ({ id: l.id, version: l.version })))
        .then(() => window.dispatchEvent(new Event(LEARNINGS_SEEN_EVENT)))
        .catch(() => undefined);
    }, SEEN_AFTER_MS);
    return () => clearTimeout(t);
  }, [view, inView]);

  const readRemoved = async () => {
    try {
      setRemoved((await getRemovedLearnings()).items);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const act = async (a: { action: LearningAction; id?: string; text?: string; version?: number }, done: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await setLearning(a);
      if (a.action !== "add" && typeof result?.id === "string" && typeof result.version === "number") {
        await markLearningsSeen([{ id: result.id, version: result.version }])
          .then(() => window.dispatchEvent(new Event(LEARNINGS_SEEN_EVENT)))
          .catch(() => undefined);
      }
      if (await load()) toast.add({ type: "success", title: done, position: "top-center", dismissible: false });
      if (a.action === "restore" || a.action === "dismiss") {
        if (showRemoved) {
          setRemoved((list) => list?.filter((l) => l.id !== a.id) ?? null);
          await readRemoved();
        } else {
          setRemoved(null);
        }
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openRemoved = async () => {
    setShowRemoved((s) => !s);
    if (removed === null) await readRemoved();
  };

  const [looking, setLooking] = useState(false);
  const lookingRef = useRef(false);
  const again = async () => {
    if (lookingRef.current) return;
    lookingRef.current = true;
    setLooking(true);
    setLookMsg(null);
    try {
      const r = await lookAgain();
      setLookMsg(r.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lookingRef.current = false;
      setLooking(false);
    }
  };

  const items = view?.items ?? [];
  const active = items.filter((l) => l.status === "active").length;
  const st = view?.state ?? null;
  const sources = Object.values(st?.sources ?? {});
  const unreadable = sources.filter((s) => s.status === "could_not_read").map((s) => ROUTE_LABEL[s.route] ?? s.route);
  const partial = sources.filter((s) => s.status === "partial").map((s) => ROUTE_LABEL[s.route] ?? s.route);
  const askedAt = st?.seed_requested_at ?? st?.updated_at ?? null;
  const stuck = !!askedAt && Date.now() - Date.parse(askedAt) > SEED_STUCK_MS;
  const nothingToRead = view?.tools_connected === false;
  const seedFailed = view !== null && !nothingToRead && !st?.seeded_at && items.length === 0 && (sources.some((s) => s.status === "could_not_read" || s.status === "partial") || stuck);
  const reading = view !== null && !nothingToRead && !st?.seeded_at && items.length === 0 && !seedFailed;
  const notes = [
    ...(seedFailed && unreadable.length === 0 && partial.length === 0 ? [{ key: "failed", testid: "email-learnings-failed", text: LEARNINGS_COPY.failed }] : []),
    ...unreadable.map((t) => ({ key: `u-${t}`, testid: undefined, text: LEARNINGS_COPY.unreadable(t) })),
    ...partial.map((t) => ({ key: `p-${t}`, testid: undefined, text: LEARNINGS_COPY.partial(t) })),
  ];

  return (
    <section ref={sectionRef} aria-labelledby="email-learnings-title" data-testid="email-learnings" className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id="email-learnings-title" className="text-[15px] font-semibold leading-5 text-ink">
            {LEARNINGS_COPY.title}
          </h3>
          <p className="mt-1 max-w-[60ch] text-[13px] leading-5 text-inkMuted">
            {LEARNINGS_COPY.intro}
            {canSuggest && ` ${LEARNINGS_COPY.introMember}`}
            {!canEdit && !canSuggest && ` ${LEARNINGS_COPY.introViewer}`}
          </p>
        </div>
        {view && (canEdit || canSuggest) && (
          <button type="button" className={BTN} disabled={busy} onClick={() => setAdding(true)} data-testid="email-learnings-add">
            {canEdit ? "Add a line" : "Suggest a line"}
          </button>
        )}
      </div>

      {!view && !error && (
        <div className="mt-4 grid gap-2">
          <Skeleton className="h-12 w-full" rounded="rounded-[10px]" />
          <Skeleton className="h-12 w-full" rounded="rounded-[10px]" />
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 flex flex-wrap items-center gap-2 text-[13px] text-danger">
          {error}
          {!view && (
            <button type="button" className={BTN} onClick={() => void load()}>
              Retry
            </button>
          )}
        </p>
      )}

      {view && (
        <div className="mt-4 grid gap-2">
          {reading && <p className="rounded-[10px] bg-brand/5 px-3 py-2 text-[13px] text-ink" data-testid="email-learnings-reading">{LEARNINGS_COPY.reading}</p>}
          {notes.map((note, i) => (
            <div key={note.key} className={NOTE_ROW} data-testid={note.testid}>
              <p className="min-w-0 flex-1">{note.text}</p>
              {i === 0 && canEdit && (
                <button type="button" className={TEXT_BTN} disabled={looking} onClick={() => void again()} data-testid="email-learnings-look-again">
                  {looking ? "Trying…" : LEARNINGS_COPY.lookAgain}
                </button>
              )}
            </div>
          ))}
          {lookMsg && (
            <p className="text-[12px] text-inkMuted">
              {lookMsg}
            </p>
          )}
          {(st?.full_skipped ?? 0) > 0 && (
            <p className="rounded-[10px] bg-warnBg px-3 py-2 text-[13px] text-warn" data-testid="email-learnings-full">
              {LEARNINGS_COPY.full(st?.full_skipped ?? 0)}
            </p>
          )}
          {(st?.full_skipped ?? 0) === 0 && (st?.kept_stronger ?? 0) > 0 && (
            <p className="rounded-[10px] bg-bone px-3 py-2 text-[13px] text-inkMuted" data-testid="email-learnings-kept">
              {LEARNINGS_COPY.keptStronger(st?.kept_stronger ?? 0)}
            </p>
          )}
          {!reading && !seedFailed && items.length === 0 && !adding && (
            <p className="rounded-xl bg-bone px-4 py-6 text-center text-[13px] leading-5 text-inkMuted" data-testid="email-learnings-none">
              {LEARNINGS_COPY.none}
            </p>
          )}

          {adding && (
            <div className="rounded-[12px] border border-ink/30 p-3">
              <label className="sr-only" htmlFor="email-learning-new">
                New line
              </label>
              <textarea
                id="email-learning-new"
                autoFocus
                rows={2}
                maxLength={300}
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder="One line, up to 300 characters."
                className={INPUT}
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className={PRIMARY}
                  disabled={busy || !newText.trim()}
                  onClick={async () => {
                    if (await act({ action: "add", text: newText.trim() }, canEdit ? LEARNINGS_COPY.added : LEARNINGS_COPY.suggested)) {
                      setNewText("");
                      setAdding(false);
                    }
                  }}
                >
                  {canEdit ? "Add" : "Suggest"}
                </button>
                <button type="button" className={BTN} onClick={() => (setAdding(false), setNewText(""))}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {items.length > 0 && (
            <ul className="grid gap-2" data-testid="email-learnings-list">
              {items.map((l) => {
                const isNew = newOnOpen.current?.has(l.id) === true;
                const dim = l.status !== "active";
                const ev = evidenceLine(l);
                return (
                  <li key={l.id} data-testid={`email-learning-${l.id}`} className={`rounded-[12px] border px-3 py-2.5 ${isNew ? "border-brand/30 bg-brand/5" : "border-rule"} ${dim ? "bg-bone/40" : ""}`}>
                    {editing === l.id ? (
                      <div>
                        <label className="sr-only" htmlFor={`email-learning-edit-${l.id}`}>
                          Edit line
                        </label>
                        <textarea
                          id={`email-learning-edit-${l.id}`}
                          autoFocus
                          rows={2}
                          maxLength={300}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          className={INPUT}
                        />
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            className={PRIMARY}
                            disabled={busy || !draft.trim()}
                            onClick={async () => {
                              if (await act({ action: "edit", id: l.id, text: draft.trim(), version: l.version }, LEARNINGS_COPY.saved)) setEditing(null);
                            }}
                          >
                            Save
                          </button>
                          <button type="button" className={BTN} onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                        <div className="min-w-0 flex-1">
                          <p className={`text-[14px] leading-[20px] ${dim ? "text-inkMuted" : "text-ink"}`}>{l.text}</p>
                          <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-inkMuted empty:hidden">
                            {isNew && <Pill tone="new">New</Pill>}
                            {l.status === "suggested" && <Pill tone="waiting">{LEARNINGS_COPY.waiting}</Pill>}
                            {l.status === "stale" && <Pill tone="stale">{LEARNINGS_COPY.stale}</Pill>}
                            {l.origin === "zavi" && l.strength === "early" && l.status === "active" && <Pill tone="early">{LEARNINGS_COPY.early}</Pill>}
                            {l.origin === "founder" && <Pill tone="yours">{l.from_zavi ? LEARNINGS_COPY.edited : LEARNINGS_COPY.yours}</Pill>}
                            {ev && <span>{ev}</span>}
                          </p>
                          {l.note && <p className="mt-1 text-[12px] text-inkMuted">{l.note}</p>}
                          {l.cant_recheck && <p className="mt-1 text-[12px] text-warn">{LEARNINGS_COPY.cantRecheck}</p>}
                        </div>
                        {canEdit && (
                          <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap" data-testid={`email-learning-actions-${l.id}`}>
                            {(l.status === "suggested" || l.status === "stale") && (
                              <button type="button" className={ROW_ACTION} disabled={busy} onClick={() => void act({ action: "activate", id: l.id, version: l.version }, LEARNINGS_COPY.activated)}>
                                {l.status === "suggested" ? "Add to the list" : "Read it again"}
                              </button>
                            )}
                            <button type="button" className={ROW_ACTION} disabled={busy} onClick={() => (setEditing(l.id), setDraft(l.text))} aria-label={`Edit: ${l.text}`}>
                              Edit
                            </button>
                            <button type="button" className={ROW_ACTION} disabled={busy} onClick={() => void act({ action: "dismiss", id: l.id, version: l.version }, LEARNINGS_COPY.removed)} aria-label={`Remove: ${l.text}`}>
                              Remove
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {view.dismissed > 0 && (
            <div>
              <button type="button" className={ROW_ACTION} onClick={() => void openRemoved()} aria-expanded={showRemoved} data-testid="email-learnings-removed-toggle">
                {showRemoved ? "Hide removed" : `Removed (${view.dismissed})`}
              </button>
              {showRemoved && removed && (
                <ul className="mt-2 grid gap-2">
                  {removed.map((l) => (
                    <li key={l.id} className="flex flex-col gap-2 rounded-[12px] border border-dashed border-rule px-3 py-2 sm:flex-row sm:items-start sm:gap-3">
                      <p className="min-w-0 flex-1 text-[13px] text-inkMuted line-through">{l.text}</p>
                      {canEdit && (
                        <button type="button" className={ROW_ACTION} disabled={busy} onClick={() => void act({ action: "restore", id: l.id, version: l.version }, LEARNINGS_COPY.restored)}>
                          Restore
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {active >= CAP && <p className="text-[12px] text-inkMuted">{LEARNINGS_COPY.footer(active)}</p>}
        </div>
      )}
    </section>
  );
}
