"use client";

import { useState, type ReactNode } from "react";
import { MessageSquare, MoreHorizontal, Repeat2, Send, ThumbsUp } from "lucide-react";

export type LinkedInPostPage = { name: string | null; logo_url: string | null };

function PageMark({ name, logoUrl, pending }: { name: string; logoUrl?: string | null; pending?: boolean }) {
  const [brokenLogo, setBrokenLogo] = useState<string | null>(null);
  const initial = name.trim().charAt(0).toUpperCase();
  if (logoUrl?.startsWith("https://") && brokenLogo !== logoUrl) return <img src={logoUrl} alt="" referrerPolicy="no-referrer" onError={() => setBrokenLogo(logoUrl)} className="size-12 shrink-0 rounded border border-rule object-cover" />;
  if (initial) return <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded border border-rule bg-creamDeep text-[18px] font-semibold text-inkSoft">{initial}</span>;
  return pending ? <span aria-hidden className="size-12 shrink-0 animate-pulse rounded border border-rule bg-creamDeep motion-reduce:animate-none" /> : null;
}

export function LinkedInPostPreview({ name, logoUrl, text, textReal, pending, media, href }: { name: string; logoUrl?: string | null; text: string; textReal: boolean; pending?: boolean; media?: ReactNode; href?: string | null }) {
  return <article aria-label="LinkedIn post preview" className="relative mx-auto w-full max-w-[555px] overflow-hidden rounded-2xl border border-rule bg-white text-ink shadow-sm">
    {href && <a href={href} target="_blank" rel="noreferrer" aria-label="Open this post on LinkedIn" className="absolute inset-0 z-10 rounded-2xl" />}
    <header className="flex items-start gap-2 px-4 pb-2 pt-3">
      <PageMark name={name} logoUrl={logoUrl} pending={pending} />
      <span className="min-w-0 flex-1 leading-tight">
        {name || !pending ? <span className="block truncate text-[14px] font-semibold text-ink">{name || "LinkedIn post"}</span> : <span aria-hidden className="mt-1 block h-3 w-1/2 animate-pulse rounded-full bg-bone motion-reduce:animate-none" />}
        <span className="mt-0.5 block text-[12px] text-inkMuted">Promoted</span>
      </span>
      <MoreHorizontal aria-hidden className="size-5 shrink-0 text-inkMuted" />
    </header>
    {pending && !textReal
      ? <div aria-busy="true" data-testid="post-preview-skeleton" className="px-4 pb-3">
        <span className="sr-only">{text}</span>
        {["w-full", "w-11/12", "w-full", "w-2/3"].map((width, i) => <span key={i} aria-hidden className={`my-1 block h-3 animate-pulse rounded-full bg-bone motion-reduce:animate-none ${width}`} />)}
      </div>
      : text === "" && media ? null : <div className={textReal ? "whitespace-pre-wrap break-words px-4 pb-3 text-[14px] leading-5 text-ink" : "flex min-h-24 items-center justify-center whitespace-pre-wrap px-6 py-5 text-center text-sm text-inkMuted"}>{text}</div>}
    {media}
    <footer aria-hidden className="mx-3 grid grid-cols-4 border-t border-rule py-1 text-[12px] font-semibold text-inkMuted">
      {([[ThumbsUp, "Like"], [MessageSquare, "Comment"], [Repeat2, "Repost"], [Send, "Send"]] as const).map(([Icon, label]) => <span key={label} className="flex min-w-0 items-center justify-center gap-1 rounded py-2.5"><Icon className="size-4 shrink-0" /><span className="truncate">{label}</span></span>)}
    </footer>
  </article>;
}
