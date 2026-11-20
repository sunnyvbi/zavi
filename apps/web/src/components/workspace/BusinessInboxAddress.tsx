"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { apiFetch } from "@/lib/api";

export const INBOX_CARD_LINE = "Email Zavi here and it works on it like a teammate. Messages from your site's forms still go to your own email.";

async function loadInboxAddress(): Promise<string | null> {
  const res = await apiFetch("/api/workspace/inbox-addresses");
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { address?: unknown } | null;
  return typeof body?.address === "string" && body.address.trim() ? body.address.trim() : null;
}

function CopyAddress({ address, className }: { address: string; className: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-testid="business-inbox-copy"
      aria-label={copied ? "Copied" : `Copy ${address}`}
      onClick={() => {
        void navigator.clipboard?.writeText(address).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }, () => undefined);
      }}
      className={className}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-[#0e9f6e]" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function BusinessInboxAddress({ variant }: { variant: "inline" | "card" }) {
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadInboxAddress().then(
      (value) => { if (!cancelled) setAddress(value); },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, []);
  if (!address) return null;
  if (variant === "inline") {
    return (
      <span data-testid="business-inbox" className="inline-flex min-w-0 items-center gap-2">
        <span aria-hidden>·</span>
        <span>inbox</span>
        <span className="truncate font-mono text-ink/70">{address}</span>
        <CopyAddress address={address} className="inline-flex items-center gap-1 border-b border-ink/[0.2] text-inkMuted transition-colors hover:border-ink/50 hover:text-ink" />
      </span>
    );
  }
  return (
    <div data-testid="business-inbox" className="rounded-2xl border border-[#f0f0f0] p-4">
      <h3 className="text-[16px] font-semibold text-[#0e0f11]">Business inbox</h3>
      <p className="mt-0.5 text-[12px] leading-5 text-[#8c8c8c]">{INBOX_CARD_LINE}</p>
      <div className="mt-3 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate rounded-cta border border-[#f0f0f0] bg-[#f9f9f9] px-3 py-2 font-mono text-[13px] text-[#0e0f11]">{address}</span>
        <CopyAddress address={address} className="inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-medium text-[#0e0f11] transition-colors hover:bg-[#f9f9f9]" />
      </div>
    </div>
  );
}
