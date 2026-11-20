"use client";

import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { CardButton } from "./CardButton";
import { CardDialog, DialogHead } from "./CardDialog";

const field = "mt-4 w-full resize-y rounded-xl border border-ca-strong bg-ca-bg p-3 text-ca-row text-ca-xdark placeholder:text-ca-secondary focus-visible:shadow-ca-focus focus-visible:outline-none";

export function InfoDialog({ open, title, about, onClose }: { open: boolean; title: string; about: ReactNode; onClose: () => void }) {
  return (
    <CardDialog open={open} label="Details" onClose={onClose}>
      <div className="overflow-y-auto px-8 pb-6 pt-8">
        <h3 className="min-w-0 break-words pr-10 text-ca-dialog-lg font-semibold tracking-tight text-ca-xdark [overflow-wrap:anywhere]">{title}</h3>
        <h4 className="mt-5 text-ca-dialog-h font-semibold text-ca-xdark">What it is</h4>
        {typeof about === "string" ? <p className="mt-1 whitespace-pre-line text-ca-body text-ca-secondary">{about}</p> : <div className="mt-1 text-ca-body text-ca-secondary">{about}</div>}
      </div>
      <div className="px-8 pb-8">
        <CardButton variant="primary" onClick={onClose}>Got it</CardButton>
      </div>
    </CardDialog>
  );
}

export function TextDialog({ open, heading, subtitle, initial, placeholder, submit, rows = 3, onSubmit, onClose }: {
  open: boolean;
  heading: string;
  subtitle: string;
  initial: string;
  placeholder?: string;
  submit: "Send" | "Save";
  rows?: number;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const [seen, setSeen] = useState(open);
  if (open !== seen) {
    setSeen(open);
    if (open) setText(initial);
  }
  return (
    <CardDialog open={open} label={heading} onClose={onClose}>
      <form className="p-6" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSubmit(text); onClose(); } }}>
        <DialogHead title={heading} subtitle={subtitle} />
        <textarea aria-label={placeholder ?? heading} rows={rows} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} className={field} />
        <div className="mt-4 flex gap-2">
          <CardButton type="submit" variant="primary" disabled={!text.trim()}>
            {submit === "Save" && <Check className="size-4" aria-hidden />}
            {submit}
          </CardButton>
          <CardButton onClick={onClose}>Cancel</CardButton>
        </div>
      </form>
    </CardDialog>
  );
}

export function ConfirmDialog({ open, heading, body, confirm, onConfirm, onClose }: { open: boolean; heading: string; body: string; confirm: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <CardDialog open={open} label={heading} onClose={onClose}>
      <div className="p-6">
        <DialogHead title={heading} />
        <p className="mt-2 text-ca-body text-ca-secondary">{body}</p>
        <div className="mt-4 flex gap-2">
          <CardButton variant="primary" onClick={() => { onConfirm(); onClose(); }}>{confirm}</CardButton>
          <CardButton onClick={onClose}>Cancel</CardButton>
        </div>
      </div>
    </CardDialog>
  );
}
