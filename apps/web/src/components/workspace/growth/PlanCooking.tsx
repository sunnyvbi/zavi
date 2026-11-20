"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import { Bell, Mail } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { SETUP_QUESTIONS, SETUP_STEP_KEYS } from "../setup/setupQuestionsCopy";

export const PLAN_COOK_MS = 15 * 60_000;
const TICK_MS = 10_000;
const startKey = (tenant: string) => `zavi:plan-cook-start:${tenant}`;
const alertKey = (tenant: string) => `zavi:plan-alert:${tenant}`;

export type PlanAlert = "browser" | "email";

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}
function permission(): NotificationPermission | "unsupported" {
  return typeof window !== "undefined" && "Notification" in window ? window.Notification.permission : "unsupported";
}

export function toldUs(slots: Array<{ key?: unknown; answer?: unknown }>): string[] {
  const out: string[] = [];
  for (const q of SETUP_QUESTIONS) {
    if (!SETUP_STEP_KEYS.includes(q.key)) continue;
    const answer = slots.find((s) => s.key === q.key)?.answer;
    if (typeof answer !== "string" || !answer.trim()) continue;
    for (const option of q.options) if (answer.includes(option)) out.push(option);
  }
  return out;
}

export function minutesLine(left: number): string {
  return left > 1 ? `About ${left} minutes.` : left === 1 ? "About a minute." : "Almost there.";
}

export function usePlanReadyAlert(tenant: string | null, cooking: boolean, ready: boolean, company: string): void {
  const wasCooking = useRef(false);
  useEffect(() => {
    if (cooking) wasCooking.current = true;
    if (!ready || !wasCooking.current || !tenant) return;
    wasCooking.current = false;
    writeStore(startKey(tenant), null);
    if (readStore(alertKey(tenant)) !== "browser" || permission() !== "granted") return;
    try {
      const n = new window.Notification("Your growth plan is ready", { body: `Zavi finished the plan for ${company}. Open it to see where to start.` });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      return;
    }
  }, [tenant, cooking, ready, company]);
}

export function PlanCooking({ tenant }: { tenant: string | null }) {
  const id = useId();
  const [told, setTold] = useState<string[]>([]);
  const [leftMs, setLeftMs] = useState(PLAN_COOK_MS);
  const [alert, setAlert] = useState<PlanAlert | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/workspace/growth-interview");
        if (!res.ok) return;
        const body = (await res.json()) as { slots?: Array<{ key?: unknown; answer?: unknown }> };
        if (!stopped) setTold(toldUs(body.slots ?? []));
      } catch {
        return;
      }
    })();
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (!tenant) return;
    const saved = readStore(alertKey(tenant));
    setAlert(saved === "email" || (saved === "browser" && permission() === "granted") ? saved : null);
    const stored = Number(readStore(startKey(tenant)));
    const start = stored > 0 ? stored : Date.now();
    if (!(stored > 0)) writeStore(startKey(tenant), String(start));
    const tick = () => setLeftMs(Math.max(0, start + PLAN_COOK_MS - Date.now()));
    tick();
    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [tenant]);

  const choose = (next: PlanAlert) => {
    setAlert(next);
    setBlocked(false);
    if (tenant) writeStore(alertKey(tenant), next);
  };
  const allow = async () => {
    if (permission() === "granted") return choose("browser");
    if (permission() !== "default") return setBlocked(true);
    setAsking(true);
    try {
      const answer = await window.Notification.requestPermission();
      if (answer === "granted") choose("browser");
      else setBlocked(true);
    } catch {
      setBlocked(true);
    } finally {
      setAsking(false);
    }
  };

  const line = minutesLine(Math.ceil(leftMs / 60_000));
  const pct = Math.min(95, Math.max(3, Math.round((1 - leftMs / PLAN_COOK_MS) * 100)));
  const pill = "inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full px-4 text-[14px] font-semibold leading-5 transition-colors duration-150 disabled:cursor-wait disabled:opacity-70 motion-reduce:transition-none";

  return (
    <section data-testid="plan-cooking" aria-labelledby={`${id}-cook`} className="mb-6 overflow-hidden rounded-3xl border border-rule bg-bone">
      <div className="p-5">
        <div className="flex items-center gap-4">
          <span aria-hidden className="relative flex size-14 shrink-0 items-center justify-center">
            <Image src="/mascots/poses/zavi-front.webp" alt="" width={44} height={44} className="size-11 object-contain" />
            <span className="absolute -right-1 -top-1 flex size-3.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-ink opacity-40 motion-reduce:animate-none" />
              <span className="relative size-3.5 rounded-full border-2 border-bone bg-ink" />
            </span>
          </span>
          <h1 id={`${id}-cook`} className="min-w-0 flex-1 text-[26px] font-semibold leading-[34px] tracking-[-0.5px] text-ink">Zavi is cooking your plan</h1>
        </div>
        {told.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:pl-[72px]">
            <span className="text-[14px] leading-5 text-inkMuted">From what you told us:</span>
            <ul className="contents">
              {told.map((t) => (
                <li key={t} className="inline-flex min-h-7 items-center rounded-full border border-rule bg-cream px-2.5 text-[13px] font-medium leading-5 text-ink">{t}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="border-t border-rule bg-cream px-5 py-3">
        <div role="progressbar" aria-label="Writing your plan" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={line} className="h-1.5 overflow-hidden rounded-full bg-rule">
          <div className="h-full rounded-full bg-ink transition-[width] duration-700 ease-out motion-reduce:transition-none" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <p role="status" className="text-[15px] font-medium leading-6 text-ink">{line}</p>
          {alert === "browser" ? (
            <p className="inline-flex items-center gap-2 text-[14px] font-medium text-ink"><Bell className="h-4 w-4" aria-hidden />We&apos;ll alert you here when it&apos;s ready.</p>
          ) : alert === "email" ? (
            <p className="inline-flex items-center gap-2 text-[14px] font-medium text-ink"><Mail className="h-4 w-4" aria-hidden />We&apos;ll email you when it&apos;s ready.</p>
          ) : blocked ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-[14px] text-inkSoft">
              <span>{permission() === "unsupported" ? "This browser can't show alerts on this page." : "Your browser blocked notifications for this site."}</span>
              <button type="button" onClick={() => choose("email")} className={`${pill} bg-ink text-cream hover:bg-ink/90`}>
                <Mail className="h-4 w-4" aria-hidden />Email me instead
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => void allow()} disabled={asking} className={`${pill} bg-ink text-cream hover:bg-ink/90`}>
                <Bell className="h-[18px] w-[18px]" aria-hidden />
                {asking ? "Waiting for your browser…" : "Allow notifications"}
              </button>
              <button type="button" onClick={() => choose("email")} className="cursor-pointer text-[14px] font-medium text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink">
                or email me
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
