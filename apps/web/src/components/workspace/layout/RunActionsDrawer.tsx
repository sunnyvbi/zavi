"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cx, FOCUS_RING } from "./shared";
import { DeliverableBlock } from "./DeliverableBlock";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";
import { Markdown } from "@/components/workspace/Markdown";
import {
  recipeMarkdown,
  singleRecipeStep,
  type RecipeFindingView,
  type RecipeStepView,
} from "@/lib/workspace/recipeStep";
import { FindingHandoff } from "./FindingHandoff";
import { runFindings } from "@/lib/workspace/findingHandoff";
import { splitClosed } from "@/lib/workspace/runGroup";

export type RunAction = {
  id: string;
  body: Record<string, unknown>;
};

export type RunActionVerb = "did_it" | "archive" | "snooze";

export function RunActionsDrawer({
  channelName,
  actions,
  total,
  notDone = 0,
  busyIds,
  error,
  onClose,
  onVerb,
  onRefine,
  onOpenThread,
}: {
  channelName: string;
  actions: RunAction[];
  total: number;
  notDone?: number;
  busyIds: Set<string>;
  error: string | null;
  onClose: () => void;
  onVerb: (action: RunAction, verb: RunActionVerb) => void;
  onRefine: (action: RunAction, message: string) => Promise<void>;
  onOpenThread: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [openRefine, setOpenRefine] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [refineError, setRefineError] = useState<Record<string, string>>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (openRefine) return setOpenRefine(null);
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, openRefine]);

  const stop = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);
  const { done } = splitClosed(total, actions.length, notDone);
  const [findings] = useState<RecipeFindingView[]>(() =>
    runFindings(actions),
  );

  const send = async (a: RunAction) => {
    const text = (drafts[a.id] ?? "").trim();
    if (!text || sending) return;
    setSending(a.id);
    setRefineError((p) => ({ ...p, [a.id]: "" }));
    try {
      await onRefine(a, text);
      setDrafts((p) => ({ ...p, [a.id]: "" }));
      setOpenRefine(null);
      setSent((p) => new Set(p).add(a.id));
    } catch (e) {
      setRefineError((p) => ({
        ...p,
        [a.id]: (e as Error).message || "That didn't send. Try again in a moment.",
      }));
    } finally {
      setSending(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${channelName} actions`}
      onClick={onClose}
      className="fixed inset-0 z-50 flex justify-end bg-black/35"
    >
      <div
        ref={panelRef}
        onClick={stop}
        className="flex h-full w-full max-w-[min(760px,92vw)] flex-col border-l border-rule bg-cream shadow-elev"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-rule px-3">
          <h2 className="min-w-0 truncate text-[14px] font-semibold text-ink">
            {channelName}
          </h2>
          <span className="shrink-0 text-[12px] text-inkMuted">
            {total} {total === 1 ? "action" : "actions"}
            {done > 0 ? ` · ${done} done` : ""}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={cx("rounded-cta p-1.5 text-ink hover:bg-bone", FOCUS_RING)}
          >
            <X className="h-[18px] w-[18px]" aria-hidden />
          </button>
        </div>

        <div className="ws-scroll min-h-0 flex-1 px-4 py-3.5">
          <p className="text-[13px] leading-6 text-inkMuted">
            These are yours to do. Zavi cannot post to your site, so it has done
            the part it can. Close each one as you go.
          </p>

          <FindingHandoff findings={findings} />

          <ul className="mt-3 flex flex-col gap-2.5">
            {actions.map((a, i) => {
              const step = singleRecipeStep(a.body);
              const pos =
                typeof (a.body as { position?: unknown }).position === "number"
                  ? ((a.body as { position: number }).position as number)
                  : i + 1;
              const busy = busyIds.has(a.id);
              const redoing =
                (sending === a.id || sent.has(a.id)) && !refineError[a.id];
              return (
                <li
                  key={a.id}
                  className="rounded-2xl border border-rule bg-white p-3.5"
                >
                  {redoing ? (
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 min-w-[14px] text-[13px] font-semibold text-inkMuted">
                        {pos}.
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[16px] font-semibold leading-6 text-inkMuted">
                          {step?.title ?? "This action"}
                        </p>
                        <p className="mt-1 text-[13px] leading-5 text-inkMuted">
                          Zavi is rewriting this one. The new version will replace
                          it here.
                        </p>
                      </div>
                    </div>
                  ) : (
                  <ActionRow
                    index={pos}
                    step={step}
                    busy={busy}
                    onVerb={(v) => onVerb(a, v)}
                    onToggleRefine={() =>
                      setOpenRefine((r) => (r === a.id ? null : a.id))
                    }
                  />
                  )}

                  {openRefine === a.id && (
                    <div className="mt-2.5">
                      <div className="flex items-end gap-2 rounded-2xl border border-ink bg-white p-1.5 pl-3 shadow-[0_0_0_3px_rgba(26,26,24,0.06)]">
                        <textarea
                          autoFocus
                          rows={1}
                          value={drafts[a.id] ?? ""}
                          onChange={(e) => {
                            const el = e.currentTarget;
                            el.style.height = "auto";
                            el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
                            setDrafts((p) => ({ ...p, [a.id]: el.value }));
                          }}
                          placeholder="What should be different?"
                          aria-label="What should be different?"
                          className="max-h-24 min-h-[20px] flex-1 resize-none bg-transparent py-0.5 text-[13px] leading-6 text-ink outline-none placeholder:text-inkMuted"
                        />
                        <button
                          type="button"
                          aria-label="Send"
                          disabled={
                            sending === a.id || !(drafts[a.id] ?? "").trim()
                          }
                          onClick={() => void send(a)}
                          className={cx(
                            "h-[26px] w-[26px] shrink-0 rounded-full bg-ink text-[13px] leading-none text-cream disabled:opacity-30",
                            FOCUS_RING,
                          )}
                        >
                          ↑
                        </button>
                      </div>
                      <p className="mt-1.5 text-[12px] leading-5 text-inkMuted">
                        Zavi redoes just this one. Your other actions stay as they
                        are.
                      </p>
                    </div>
                  )}

                  {refineError[a.id] && (
                    <p
                      role="alert"
                      className="mt-2 rounded-xl bg-dangerBg px-3 py-2 text-[12px] font-medium text-danger"
                    >
                      {refineError[a.id]}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          <AuditDisclosure body={actions[0]?.body} />

          <button
            type="button"
            onClick={onOpenThread}
            className={cx(
              "mt-3.5 block text-[13px] font-medium text-inkMuted underline hover:text-ink",
              FOCUS_RING,
            )}
          >
            See how Zavi got here
          </button>

          {error && (
            <p
              role="alert"
              className="mt-3.5 rounded-xl bg-dangerBg px-3 py-2.5 text-[12px] font-medium text-danger"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function AuditDisclosure({ body }: { body?: Record<string, unknown> }) {
  const analysis = body ? recipeMarkdown(body) : null;
  if (!analysis) return null;
  return (
    <details className="mt-2.5 rounded-2xl border border-rule bg-white p-3.5">
      <summary
        className={cx(
          "cursor-pointer list-none text-[13px] font-medium text-inkMuted hover:text-ink",
          FOCUS_RING,
        )}
      >
        Show the full audit for this run
      </summary>
      <div className="mt-2.5">
        <Markdown source={analysis} disableActionLinks />
      </div>
    </details>
  );
}

function ActionRow({
  index,
  step,
  busy,
  onVerb,
  onToggleRefine,
}: {
  index: number;
  step: RecipeStepView | null;
  busy: boolean;
  onVerb: (v: RunActionVerb) => void;
  onToggleRefine: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menu = useDismissableMenu(menuRef, triggerRef);
  const pick = (v: RunActionVerb) => {
    menu.close();
    onVerb(v);
  };
  return (
    <>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 min-w-[14px] text-[13px] font-semibold text-inkMuted">
          {index}.
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold leading-6 text-ink [overflow-wrap:anywhere]">
            {step?.title ?? "This action"}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {step?.blocking && (
              <span className="rounded-full bg-ink px-2 py-0.5 text-[11px] font-medium text-cream">
                Blocking
              </span>
            )}
            {step?.effort && (
              <span className="rounded-full border border-rule bg-bone px-2 py-0.5 text-[11px] text-inkMuted">
                {step.effort}
              </span>
            )}
          </div>
        </div>
      </div>

      {step?.deliverable && (
        <DeliverableBlock deliverable={step.deliverable} className="ml-[22px] mt-2" />
      )}
      {step?.body && (
        <div className="ml-[22px] mt-1.5 text-ink [overflow-wrap:anywhere] [&_p]:text-[16px] [&_li]:text-[16px] [&_p]:leading-6 [&_li]:leading-6">
          <Markdown source={step.body} breaks disableActionLinks />
        </div>
      )}
      {step?.evidence?.length ? (
        <ul className="ml-[22px] mt-1.5 space-y-0.5">
          {step.evidence.map((e, j) => (
            <li
              key={j}
              className="text-[12px] leading-5 text-inkMuted [overflow-wrap:anywhere]"
            >
              {e}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="ml-[22px] mt-2.5 flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            menu.close(false);
            onToggleRefine();
          }}
          className={cx(
            "inline-flex h-8 items-center rounded-cta px-1.5 text-[13px] font-medium text-inkMuted hover:bg-bone hover:text-ink",
            FOCUS_RING,
          )}
        >
          Refine
        </button>
        <span className="flex-1" />
        <div ref={menuRef} className="relative">
          <button
            ref={triggerRef}
            type="button"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onClick={menu.toggle}
            className={cx(
              "h-8 w-8 rounded-cta text-[14px] leading-none text-inkMuted hover:bg-bone hover:text-ink",
              FOCUS_RING,
            )}
          >
            ⋯
          </button>
          {menu.open && (
            <div
              role="menu"
              className="absolute right-0 top-8 z-10 min-w-[150px] rounded-xl border border-rule bg-white p-1 shadow-elev"
            >
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => pick("snooze")}
                className={cx(
                  "block w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink hover:bg-bone disabled:opacity-50",
                  FOCUS_RING,
                )}
              >
                Not now
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => pick("archive")}
                className={cx(
                  "block w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink hover:bg-bone disabled:opacity-50",
                  FOCUS_RING,
                )}
              >
                Didn&apos;t do it
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => onVerb("did_it")}
          className={cx(
            "h-8 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-cream hover:bg-inkSoft disabled:opacity-50",
            FOCUS_RING,
          )}
        >
          Did it
        </button>
      </div>
    </>
  );
}
