"use client";

import { useState, type ReactNode } from "react";
import { CircleAlert, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";

export function alertWords(text: string): { title: string; rest: string | null } {
  const sentences = text.trim().split(/(?<=\.)\s+/);
  const first = sentences[0] ?? "";
  const [head, tail] = first.split(/,\s+so\s+/);
  const title = tail ? `${head}.` : first;
  const after = sentences.slice(1).join(" ");
  const rest = after || (tail ? tail.charAt(0).toUpperCase() + tail.slice(1) : "");
  return { title, rest: rest || null };
}

export function ReadProblemAlert({ text, action, step = false }: { text: string; action?: ReactNode; step?: boolean }) {
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  if (gone) return null;
  const { title, rest } = alertWords(text);
  const dismiss = () => {
    setLeaving(true);
    window.setTimeout(() => setGone(true), 160);
  };
  return (
    <div
      role="status"
      data-testid={step ? "channel-setup-step" : "channel-read-problem"}
      className={cn(
        step ? "bg-bone" : "bg-warnBg",
        step ? "items-center" : "items-start", "flex animate-ca-rise gap-3 rounded-2xl px-5 py-3.5 text-[14px] leading-6 text-ink transition-[opacity,transform] duration-150 ease-out motion-reduce:animate-none motion-reduce:transition-none",
        leaving && "-translate-y-1 scale-[0.98] opacity-0",
      )}
    >
      {step ? <Info className="mt-0.5 size-5 shrink-0 text-inkMuted" aria-hidden /> : <CircleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />}
      <p className="min-w-0 flex-1">
        <strong className="font-semibold">{title}</strong>
        {rest && <> {rest}</>}
        {action && !step && <> {action}</>}
      </p>
      {step ? action : <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="-mr-1 grid size-7 shrink-0 place-items-center rounded-full text-inkMuted transition-colors hover:bg-black/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
      >
        <X className="size-4" aria-hidden />
      </button>}
    </div>
  );
}
