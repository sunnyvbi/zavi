"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { cardDisclosure, cardText } from "../actions/card/styles";
import type { BoxEmail } from "./EmailWorkDesign";

const SHOWN = 2;

export function EmailText({ emails, selected, onSelect, extra }: { emails: BoxEmail[]; selected: number; onSelect: (i: number) => void; extra?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const i = Math.min(Math.max(selected, 0), emails.length - 1);
  const email = emails[i];
  if (!email) return null;
  const long = email.paragraphs.length > SHOWN;
  const paragraphs = open ? email.paragraphs : email.paragraphs.slice(0, SHOWN);
  return (
    <div data-testid="email-box" className="flex min-w-0 flex-col gap-3">
      {emails.length > 1 && (
        <div role="tablist" aria-label="Emails" className="flex flex-wrap gap-1.5">
          {emails.map((e, n) => (
            <button
              key={n}
              type="button"
              role="tab"
              aria-selected={n === i}
              onClick={() => {
                setOpen(false);
                onSelect(n);
              }}
              className={cn("inline-flex min-h-8 items-center rounded-full px-3 text-ca-action font-semibold", n === i ? "bg-ca-action text-ca-on-action" : "border border-ca-strong text-ca-primary hover:bg-ca-hover")}
            >
              {e.tab?.title ?? `Email ${n + 1}`}
              {e.tab?.when && <small className={cn("ml-1.5 text-[12px] font-normal", n === i ? "text-ca-on-action/80" : "text-ca-secondary")}>{e.tab.when}</small>}
            </button>
          ))}
        </div>
      )}
      <div>
        <p className={cardText.body}>Subject: <span data-testid="email-box-subject">{email.subject}</span></p>
        {email.preview && <p data-testid="email-box-preview" className="text-ca-action text-ca-secondary">{email.preview}</p>}
      </div>
      <div className={cn(cardText.body, "flex flex-col gap-3")}>
        {paragraphs.map((p, n) => (
          <p key={n} className="whitespace-pre-line">{p}</p>
        ))}
      </div>
      {long && (
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cn(cardDisclosure, "mt-0 self-start")}>
          {open ? "Show less" : "Read more"}
        </button>
      )}
      {extra && <div className="flex min-w-0 flex-col gap-3 [&>div]:!px-0 [&>div]:!pb-0">{extra}</div>}
    </div>
  );
}
