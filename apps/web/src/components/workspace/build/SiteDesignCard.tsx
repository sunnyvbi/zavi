"use client";

import { useId, useRef, useState } from "react";
import { Check, ChevronRight, Circle, Loader2 } from "lucide-react";
import { cx, FOCUS_RING } from "../layout/shared";
import { useSiteDesign, type SiteDesign, type SiteDesignLook } from "@/lib/workspace/useSiteDesign";
import { lookFontsHref, useLookFonts } from "./LookPreview";
import { LookPicker } from "./LookPicker";

export { lookFontsHref, useLookFonts };

function PlanList({ design }: { design: SiteDesign }) {
  const { plan, checklist } = design;
  const found = (kind: string, label: string): boolean | null => {
    if (!checklist) return null;
    const item = checklist.items.find((i) => i.kind === kind && i.label === label);
    return item ? item.found : null;
  };
  const Mark = ({ ok }: { ok: boolean | null }) =>
    ok === null ? null : ok ? (
      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink" aria-label="on the site" />
    ) : (
      <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-inkMuted" aria-label="not found on the site yet" />
    );
  const hasPlan = plan.sections.length > 0 || plan.audience || plan.facts.length > 0;
  if (!hasPlan && !checklist) return null;
  return (
    <details className="group/plan mt-3 rounded-xl border border-rule bg-cream" data-testid="site-design-plan">
      <summary
        className={cx(
          "flex cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3.5 py-2.5 text-[13px] font-semibold leading-5 text-ink [&::-webkit-details-marker]:hidden",
          FOCUS_RING,
        )}
      >
        <span className="min-w-0">
          The plan
          {checklist && <span className="font-normal text-inkMuted"> · {checklist.found} of {checklist.total} on the site</span>}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-inkMuted transition-transform group-open/plan:rotate-90 motion-reduce:transition-none" aria-hidden />
      </summary>
      <div className="space-y-3 border-t border-rule px-3.5 pb-3.5 pt-3 text-[13px] leading-5 text-inkMuted">
        {(plan.audience || plan.positioning) && (
          <div className="space-y-1">
            {plan.audience && (
              <p>
                <span className="font-medium text-ink">For: </span>
                {plan.audience}
              </p>
            )}
            {plan.positioning && <p>{plan.positioning}</p>}
          </div>
        )}
        {plan.sections.length > 0 && (
          <ol className="space-y-1.5">
            {plan.sections.map((s) => (
              <li key={s.id} className="flex items-start gap-2">
                <Mark ok={found("section", s.name)} />
                <span className="min-w-0">
                  <span className="font-medium text-ink">{s.name}</span>: {s.headline}
                </span>
              </li>
            ))}
          </ol>
        )}
        {plan.main_action && (
          <p className="flex items-start gap-2 border-t border-rule pt-3">
            <Mark ok={found("action", plan.main_action)} />
            <span>
              <span className="font-medium text-ink">Main action: </span>
              {plan.main_action}
            </span>
          </p>
        )}
        {plan.facts.length > 0 && (
          <ul className="space-y-1.5">
            {plan.facts.map((f) => (
              <li key={f} className="flex items-start gap-2">
                <Mark ok={found("fact", f)} />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function LookPalette({ look, size = "md" }: { look: SiteDesignLook; size?: "sm" | "md" }) {
  const colors = [look.swatches.background, look.swatches.primary, look.swatches.accent];
  return (
    <span data-testid="site-look-palette" aria-hidden className="flex shrink-0 -space-x-1.5">
      {colors.map((color, i) => (
        <span
          key={`${color}-${i}`}
          className={cx("rounded-full border border-ca-strong ring-2 ring-ca-bg", size === "sm" ? "size-4" : "size-5")}
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  );
}

export function LookSwitch({
  design,
  picking,
  pickError,
  onPick,
  className,
}: {
  design: SiteDesign;
  picking: string | null;
  pickError: string | null;
  onPick: (id: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const looks = design.looks;
  const chosen = looks.find((l) => l.id === design.chosen) ?? looks[0]!;
  const busy = picking !== null;
  const sectionRef = useRef<HTMLElement>(null);
  const focusLook = (id: string) => {
    (sectionRef.current?.querySelector(`[data-testid="site-look-option-${id}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <section
      ref={sectionRef}
      aria-label="Website look"
      data-testid="site-look-switch"
      data-open={open ? "true" : undefined}
      className={cx("mt-3 rounded-2xl border border-ca-border bg-ca-bg shadow-ca-sm", className)}
    >
      <button
        type="button"
        data-testid="site-look-change"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cx("flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-ca-hover", FOCUS_RING)}
      >
        <LookPalette look={chosen} />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium leading-4 text-ca-secondary">Website look</span>
          <span data-testid="site-look-current" className="block truncate text-[14px] font-semibold leading-5 text-ca-xdark">
            {chosen.label}
          </span>
        </span>
        <span className="shrink-0 text-[13px] font-medium text-ca-secondary">{open ? "Done" : "Change"}</span>
        <ChevronRight
          className={cx("size-4 shrink-0 text-ca-secondary transition-transform duration-ca-rise ease-ca-standard motion-reduce:transition-none", open && "rotate-90")}
          aria-hidden
        />
      </button>
      {open && (
        <div id={panelId} className="border-t border-ca-border px-3 pb-3 pt-2.5 motion-safe:animate-ca-rise">
          <p className="px-1 text-[13px] leading-5 text-ca-secondary">Switch colours and fonts while it builds, for free.</p>
          <div role="radiogroup" aria-label="Website looks" className="mt-2 grid grid-cols-1 gap-1.5 [container-type:inline-size] [@container(min-width:420px)]:grid-cols-2">
            {looks.map((look, i) => {
              const selected = look.id === design.chosen;
              const loading = picking === look.id;
              return (
                <button
                  key={look.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busy}
                  tabIndex={selected || (!looks.some((l) => l.id === design.chosen) && i === 0) ? 0 : -1}
                  data-testid={`site-look-option-${look.id}`}
                  onClick={() => {
                    if (!selected && !busy) onPick(look.id);
                  }}
                  onKeyDown={(e) => {
                    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                    if (!step || looks.length < 2) return;
                    e.preventDefault();
                    focusLook(looks[(i + step + looks.length) % looks.length]!.id);
                  }}
                  className={cx(
                    "flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                    selected ? "border-ca-action bg-ca-subtle" : "border-ca-border hover:bg-ca-hover",
                    busy && !loading && "cursor-not-allowed opacity-60",
                    FOCUS_RING,
                  )}
                >
                  <LookPalette look={look} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold leading-5 text-ca-xdark">{look.label}</span>
                    {look.mood && <span className="block truncate text-[12px] leading-4 text-ca-secondary">{look.mood}</span>}
                  </span>
                  {loading ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-ca-secondary motion-reduce:animate-none" aria-label="Switching" />
                  ) : selected ? (
                    <Check className="size-4 shrink-0 text-ca-xdark" strokeWidth={2.5} aria-hidden />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {pickError && (
        <p role="alert" className="px-4 pb-3 text-[13px] leading-5 text-danger">
          {pickError}
        </p>
      )}
    </section>
  );
}

export function SiteDesignCardView({
  design,
  picking,
  onPick,
  pickError,
  starting = null,
  started = null,
  startError = null,
  onStart,
  inReplyGutter = false,
}: {
  design: SiteDesign;
  picking: string | null;
  pickError: string | null;
  onPick: (id: string) => void;
  starting?: string | null;
  started?: string | null;
  startError?: string | null;
  onStart?: (id: string) => void | Promise<unknown>;
  inReplyGutter?: boolean;
}) {
  useLookFonts(design.looks);
  const gutter = inReplyGutter ? "ml-[34px]" : "";
  if (design.awaiting_pick && !started && onStart) {
    if (inReplyGutter) return null;
    return (
      <section
        aria-label="Your site's look"
        data-testid="site-design"
        data-awaiting-pick={design.awaiting_pick ? "true" : undefined}
        className={cx("mt-3 rounded-2xl border border-rule bg-creamDeep/35 px-3.5 py-3", gutter)}
      >
        <p className="text-[12px] font-medium leading-4 text-inkMuted">Design brief</p>
        <h3 className="mt-1 text-[14px] font-semibold leading-5 text-ink">Pick a website</h3>
        <LookPicker design={design} starting={starting} started={started} startError={startError} onStart={onStart} />
        <PlanList design={design} />
      </section>
    );
  }
  if (design.locked === null) {
    return (
      <LookSwitch design={design} picking={picking} pickError={pickError} onPick={onPick} className={gutter} />
    );
  }
  return pickError ? (
    <p role="alert" className={cx("mt-3 text-[12px] leading-5 text-danger", gutter)}>
      {pickError}
    </p>
  ) : null;
}

export function SiteDesignCard({ runId, buildActive, inReplyGutter = false }: { runId: string | null; buildActive: boolean; inReplyGutter?: boolean }) {
  const { design, picking, pickError, pick, starting, started, startError, start } = useSiteDesign(runId, buildActive);
  if (!design || design.looks.length === 0) return null;
  return (
    <SiteDesignCardView
      design={design}
      picking={picking}
      pickError={pickError}
      onPick={(id) => void pick(id)}
      starting={starting}
      started={started}
      startError={startError}
      onStart={start}
      inReplyGutter={inReplyGutter}
    />
  );
}
