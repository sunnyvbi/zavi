"use client";

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import Link from "next/link";
import { Building2, Check, Copy } from "lucide-react";
import { AFFILIATE_PLANS, usd, yearOne } from "@/app/affiliates/terms";
import { creatorApi } from "@/lib/creator/api";
import { AFFILIATE_BASE, affiliateBaseForOrigin } from "@/lib/creator/affiliate-link";

export function useAffiliateBase(): string {
  const [base, setBase] = useState(AFFILIATE_BASE);
  useEffect(() => { setBase(affiliateBaseForOrigin(window.location.origin)); }, []);
  return base;
}

export const AFFILIATE_RULES_LINE =
  "Works on any page of zaviagent.com for 60 days after someone clicks it. Say you are a Zavi affiliate when you share your link. No ads on the Zavi name, no spam, and you can't refer yourself or your own company.";

export const BUSINESS_SIGNUP_HREF = "/start";

export const PRO_TITLE = "Set up your business to get 90 days of Pro";

export function proLine(hasBusiness: boolean): string {
  return hasBusiness
    ? "Your business is set up. Our team turns on your 90 days of Pro."
    : "Your creator account has no business on it. Set one up on Zavi and our team turns on 90 days of Pro for it.";
}

type CardEl = (p: { children: ReactNode; className?: string }) => ReactElement;

export function AffiliateLinkCard({
  link,
  Card,
  small,
  className = "",
  onCopyFailed,
}: {
  link: string;
  Card: CardEl;
  small: string;
  className?: string;
  onCopyFailed: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      onCopyFailed();
    }
  };
  return (
    <Card className={className}>
      <p className="text-[13px] text-muted">Your link</p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 break-all rounded-xl bg-[#f3f4f6] px-3 py-2.5 font-sans text-[14px] text-foreground">{link}</code>
        <button type="button" onClick={copy} className={`${small} shrink-0`}>
          {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-muted">{AFFILIATE_RULES_LINE}</p>
    </Card>
  );
}

export function AffiliateTermsCard({ Card }: { Card: CardEl }) {
  return (
    <Card>
      <p className="text-[14px] font-semibold text-foreground">What you earn</p>
      <p className="mt-1 text-[14px] leading-relaxed text-muted">
        100% of a referred customer&apos;s first 2 monthly subscription payments, then 30% of every payment through their 12th month.
      </p>
      <ul className="mt-3 divide-y divide-black/[0.06] rounded-xl border border-black/[0.07] bg-white">
        {AFFILIATE_PLANS.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-4 py-2.5">
            <span className="text-[14px] text-foreground">
              {p.name} <span className="text-muted">at {usd(p.price)} a month</span>
            </span>
            <span className="shrink-0 whitespace-nowrap text-[14px] font-semibold tabular-nums text-foreground">{usd(yearOne(p.price))} in year one</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[13px] leading-relaxed text-muted">
        Per customer, on monthly plans, if they stay 12 months with no refunds. Each commission waits 30 days for refunds, then goes to your bank through
        Stripe once you have $20 ready.
      </p>
    </Card>
  );
}

export function useHasBusiness(): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    let live = true;
    creatorApi
      .home()
      .then((h) => {
        if (live) setHas(!!h.in_any_company);
      })
      .catch(() => {
      });
    return () => {
      live = false;
    };
  }, []);
  return has;
}

export function ProRow({ small, hasBusiness }: { small: string; hasBusiness: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Building2 className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-[200px] flex-1 text-[14px] text-foreground">
        {PRO_TITLE}
        <span className="block text-[13px] text-muted">{proLine(hasBusiness)}</span>
      </span>
      {hasBusiness ? null : (
        <Link href={BUSINESS_SIGNUP_HREF} className={small}>
          Set up your business
        </Link>
      )}
    </div>
  );
}
