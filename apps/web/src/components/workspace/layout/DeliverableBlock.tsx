"use client";

import { useEffect, useRef, useState } from "react";
import { cx, FOCUS_RING } from "./shared";
import type { RecipeDeliverableView } from "@/lib/workspace/recipeStep";

export function DeliverableBlock({
  deliverable,
  className,
}: {
  deliverable: RecipeDeliverableView;
  className?: string;
}) {
  if (!deliverable.parts) return <OneDeliverable deliverable={deliverable} className={className} />;
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      {deliverable.parts.map((p, i) => (
        <OneDeliverable key={i} deliverable={{ kind: deliverable.kind, kindLabel: deliverable.kindLabel, label: p.label, content: p.content }} />
      ))}
    </div>
  );
}

function OneDeliverable({
  deliverable,
  className,
}: {
  deliverable: RecipeDeliverableView;
  className?: string;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(deliverable.content);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied("idle"), 2000);
  };

  return (
    <div className={cx("rounded-2xl border border-rule bg-bone p-3", className)}>
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-ink px-2 py-0.5 text-[11px] font-medium text-cream">
          {deliverable.kindLabel}
        </span>
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-inkMuted">
          {deliverable.label}
        </p>
        <button
          type="button"
          onClick={copy}
          className={cx(
            "h-8 shrink-0 rounded-full border border-rule bg-white px-3 text-[13px] font-medium text-ink hover:bg-creamDeep",
            FOCUS_RING,
          )}
        >
          {copied === "copied" ? "Copied" : copied === "failed" ? "Select to copy" : "Copy"}
        </button>
        <span aria-live="polite" className="sr-only">
          {copied === "copied" ? "Copied to clipboard" : ""}
        </span>
      </div>
      <p className="mt-2 max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-xl bg-white p-3 text-[16px] leading-6 text-ink [overflow-wrap:anywhere]">
        {deliverable.content}
      </p>
    </div>
  );
}
