"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { Copy, ExternalLink, Globe, Monitor, MoreHorizontal, Rocket, Settings } from "lucide-react";
import { GithubMark } from "../GithubMark";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";

export const MOBILE_ACTIONS_LABEL = "More actions";
export const MOBILE_NOT_LIVE = "Not live yet";
export const MOBILE_COPIED = "Copied";

export type BuildMobileActionsProps = {
  onPreview: () => void;
  publish: { label: string; disabledReason: string | null; onSelect: () => void; prominent?: boolean };
  liveUrl: string | null;
  onSettings: () => void;
  onDomains?: (() => void) | null;
  github: { label: string; disabledReason: string | null; onSelect: () => void } | null;
};

const ITEM =
  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[14px] text-ink transition-colors hover:bg-bone focus-visible:bg-bone focus-visible:outline-none aria-disabled:cursor-not-allowed aria-disabled:text-inkLight aria-disabled:hover:bg-transparent";

export function BuildMobileActions({ onPreview, publish, liveUrl, onSettings, onDomains, github }: BuildMobileActionsProps) {
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const { open, setOpen, toggle } = useDismissableMenu(rootRef, buttonRef);
  const menuId = useId();

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  const copyLive = async () => {
    if (!liveUrl) return;
    try {
      await navigator.clipboard.writeText(liveUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      return;
    }
  };

  return (
    <div ref={rootRef} data-testid="build-mobile-actions" className="relative flex items-center gap-1 lg:hidden">
      {publish.prominent && !publish.disabledReason && (
        <button
          type="button"
          data-testid="build-mobile-publish"
          onClick={publish.onSelect}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[#0e0f11] px-3 text-[13px] font-medium text-white transition-colors hover:bg-[#2a2b2e]"
        >
          <Rocket className="h-3.5 w-3.5" aria-hidden />
          {publish.label}
        </button>
      )}
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-label={MOBILE_ACTIONS_LABEL}
        title={MOBILE_ACTIONS_LABEL}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#454545] transition-colors hover:bg-[#f4f4f4] hover:text-[#0e0f11]"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={MOBILE_ACTIONS_LABEL}
          className="absolute right-0 top-[calc(100%+8px)] z-40 w-[260px] max-w-[calc(100vw-32px)] rounded-xl border border-rule bg-white p-1.5 shadow-pop"
        >
          <button type="button" role="menuitem" onClick={run(onPreview)} className={ITEM}>
            <Monitor className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />
            Preview
          </button>
          <MenuAction
            label={publish.label}
            reason={publish.disabledReason}
            onSelect={run(publish.onSelect)}
            icon={<Rocket className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />}
          />
          {liveUrl ? (
            <>
              <a
                role="menuitem"
                href={liveUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className={ITEM}
              >
                <ExternalLink className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />
                <span className="min-w-0 flex-1 truncate">Open {liveHost(liveUrl)}</span>
              </a>
              <button type="button" role="menuitem" onClick={() => void copyLive()} className={ITEM}>
                <Copy className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />
                {copied ? MOBILE_COPIED : "Copy live address"}
              </button>
            </>
          ) : (
            <MenuAction
              label="Live address"
              reason={MOBILE_NOT_LIVE}
              onSelect={() => {}}
              icon={<ExternalLink className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />}
            />
          )}
          <button type="button" role="menuitem" onClick={run(onSettings)} className={ITEM}>
            <Settings className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />
            App settings
          </button>
          {onDomains && (
            <button type="button" role="menuitem" onClick={run(onDomains)} className={ITEM}>
              <Globe className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />
              Domains
            </button>
          )}
          {github && (
            <MenuAction
              label={github.label}
              reason={github.disabledReason}
              onSelect={run(github.onSelect)}
              icon={<GithubMark className="h-4 w-4 shrink-0 text-inkMuted" />}
            />
          )}
        </div>
      )}
    </div>
  );
}

function MenuAction({
  label,
  reason,
  onSelect,
  icon,
}: {
  label: string;
  reason: string | null;
  onSelect: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={reason ? true : undefined}
      onClick={reason ? undefined : onSelect}
      className={ITEM}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {reason && <span className="block text-[12px] leading-4 text-inkMuted">{reason}</span>}
      </span>
    </button>
  );
}

function liveHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
