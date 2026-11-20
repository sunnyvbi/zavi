"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

const SIZE = {
  actionEdit: "!m-auto w-action-edit max-w-action-edit max-h-history-dialog",
  card: "!m-auto w-ca-dialog max-h-ca-dialog",
  history: "!m-auto w-history-dialog max-w-history-dialog max-h-history-dialog",
  md: "!m-auto w-[min(512px,calc(100%-32px))] max-h-[90dvh]",
  campaign: "!m-auto w-[min(540px,calc(100%-32px))] max-h-ca-dialog",
  lg: "!m-auto w-[min(768px,calc(100%-32px))] max-h-[90dvh]",
  wide: "!m-auto w-[min(1010px,calc(100%-32px))] max-h-[90dvh]",
  xl: "!m-auto w-[80vw] h-[80vh]",
} as const;
const INNER = { actionEdit: "max-h-history-dialog-body", card: "max-h-ca-dialog", history: "max-h-history-dialog-body", md: "max-h-[calc(90dvh-2px)]", campaign: "max-h-ca-dialog", lg: "max-h-[calc(90dvh-2px)]", wide: "max-h-[calc(90dvh-2px)]", xl: "h-full" } as const;
const DEFAULT_CHROME = "rounded-2xl border border-rule bg-cream text-ink shadow-2xl";

type Props = {
  label?: string;
  labelledBy?: string;
  onClose: () => void;
  busy?: boolean;
  onEscape?: () => boolean;
  closeOnBackdrop?: boolean;
  size?: keyof typeof SIZE;
  chrome?: string;
  confirmDiscard?: boolean;
  children: ReactNode;
};

export function AdsDialog(props: Props) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null | undefined>(undefined);
  useLayoutEffect(() => {
    const tab = anchor.current?.closest<HTMLElement>("[data-tab-id]");
    if (tab?.parentElement) {
      setHost(tab.parentElement);
      return;
    }
    let out: HTMLElement | null = null;
    for (let el = anchor.current?.parentElement ?? null; el && el !== document.body; el = el.parentElement) {
      if (getComputedStyle(el).display === "none") out = el.parentElement;
    }
    setHost(out);
  }, []);
  return <>
    <span ref={anchor} hidden />
    {host === undefined ? null : host ? createPortal(<AdsDialogShell {...props} />, host) : <AdsDialogShell {...props} />}
  </>;
}

function AdsDialogShell({ label, labelledBy, onClose, busy = false, onEscape, closeOnBackdrop = false, size = "md", chrome = DEFAULT_CHROME, confirmDiscard = false, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const latest = useRef({ onClose, onEscape, busy, confirmDiscard });
  latest.current = { onClose, onEscape, busy, confirmDiscard };
  const [asking, setAsking] = useState(false);
  const leave = () => { if (latest.current.confirmDiscard) setAsking(true); else latest.current.onClose(); };
  useEffect(() => { const d = dialog.current, opener = document.activeElement as HTMLElement | null; d?.showModal(); return () => { d?.close(); opener?.focus(); }; }, []);
  const own = (e: React.SyntheticEvent<HTMLDialogElement>) => e.target === e.currentTarget;
  return <dialog ref={dialog} aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy}
    onCancel={e => { if (!own(e)) return; e.preventDefault(); const { onEscape, busy } = latest.current; if (onEscape?.()) return; if (!busy) leave(); }}
    onClose={e => { const d = e.currentTarget; if (!own(e) || d.open || !d.isConnected) return; if (latest.current.busy || latest.current.confirmDiscard) d.showModal(); if (!latest.current.busy) leave(); }}
    onKeyDown={e => { if (e.key === "Escape") e.stopPropagation(); }}
    onMouseDown={e => {
      if (!closeOnBackdrop || !own(e)) return;
      const r = e.currentTarget.getBoundingClientRect();
      if ((e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) && !latest.current.busy) leave();
    }}
    className={cn("ads-dialog overflow-hidden p-0", size !== "history" && size !== "actionEdit" && size !== "card" && "max-w-none", SIZE[size], chrome, "compact:!m-0 compact:h-[100dvh] compact:max-h-none compact:w-full compact:max-w-none compact:rounded-none compact:border-0")}>
    <div className={`flex flex-col overflow-y-auto overscroll-contain ${INNER[size]} compact:h-full compact:max-h-none`}>{children}</div>
    {asking && <AdsDialog label="Discard your changes?" onClose={() => setAsking(false)}>
      <div className="space-y-2 px-5 pt-5">
        <h3 className="text-[16px] font-semibold text-ink">Discard your changes?</h3>
        <p className="text-[13px] leading-[1.5] text-inkMuted">If you close now, what you entered here is lost.</p>
      </div>
      <div className="mt-4 flex justify-end gap-2.5 border-t border-rule px-5 py-3.5">
        <button type="button" autoFocus onClick={() => setAsking(false)} className="rounded-cta px-3 py-1.5 text-[13px] font-medium text-inkMuted transition-colors hover:text-ink">Keep editing</button>
        <button type="button" onClick={() => { setAsking(false); latest.current.onClose(); }} className="rounded-cta bg-danger px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-danger/85">Discard changes</button>
      </div>
    </AdsDialog>}
  </dialog>;
}
