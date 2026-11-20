"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";

export function StepDeliverable({ label, content }: { label: string | null; content: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="mt-4 max-w-prose overflow-hidden rounded-xl border border-rule bg-creamDeep">
      <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2">
        <p className="min-w-0 truncate text-detail font-medium text-inkMuted">{label?.trim() || "Ready to paste"}</p>
        <IconButton
          type="button"
          onClick={() => void copy()}
          label={copied ? "Copied" : "Copy"}
          className="inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-rule bg-cream text-ink hover:bg-creamDeep"
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
        </IconButton>
      </div>
      <pre className="whitespace-pre-wrap px-4 py-3.5 font-sans text-sm leading-6 text-ink">{content}</pre>
    </div>
  );
}

