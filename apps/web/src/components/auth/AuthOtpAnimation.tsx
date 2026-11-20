"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ZaviMascot } from "@/components/ZaviMascot";

const CODE = "••••••••";
const STEP_MS = 1300;

const SHADOW_2 = "0 2px 4px -1px rgba(0,0,0,0.06), 0 6px 16px -4px rgba(0,0,0,0.10)";
const SHADOW_3 = "0 4px 8px -2px rgba(0,0,0,0.06), 0 16px 32px -8px rgba(0,0,0,0.14)";
function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  query?.addEventListener?.("change", onChange);
  return () => query?.removeEventListener?.("change", onChange);
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function useReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, reducedMotion, () => true);
}

function SkeletonMessage({ short = false }: { short?: boolean }) {
  return (
    <div aria-hidden="true" className="flex items-center gap-3 rounded-xl px-4 py-2.5 opacity-60">
      <span className="size-10 shrink-0 rounded-full bg-[#f4f4f4]" />
      <div className="min-w-0 flex-1 space-y-2">
        <span className={`block h-2.5 rounded-full bg-[#f4f4f4] ${short ? "w-2/5" : "w-3/5"}`} />
        <span className={`block h-2.5 rounded-full bg-[#f4f4f4] ${short ? "w-3/5" : "w-4/5"}`} />
      </div>
    </div>
  );
}

function GmailMark() {
  return (
    <svg width="34" height="26" viewBox="52 42 88 66" aria-hidden="true">
      <path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" />
      <path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" />
      <path fill="#fbbc04" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" />
      <path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92" />
      <path fill="#c5221f" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" />
    </svg>
  );
}

export function AuthOtpAnimation() {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => setPhase((value) => (value + 1) % 6), STEP_MS);
    return () => window.clearInterval(id);
  }, [reduce]);

  const mailArrived = reduce || phase >= 1;
  const mailOpen = reduce || phase >= 2;
  const copied = reduce || phase >= 3;
  const codeEntered = reduce || phase >= 4;

  return (
    <div
      data-testid="auth-otp-animation"
      data-phase={reduce ? "complete" : phase}
      className="w-full rounded-[28px] border border-[#e7e7e7] bg-white p-6 font-[family-name:var(--font-body)]"
      style={{ boxShadow: SHADOW_3 }}
    >
      <style>{`
        @keyframes auth-otp-mail-in { from { opacity: 0; transform: translateY(-14px) } to { opacity: 1; transform: none } }
        @keyframes auth-otp-pop { 0% { opacity: 0; transform: scale(0.6) } 60% { transform: scale(1.08) } 100% { opacity: 1; transform: scale(1) } }
        @keyframes auth-otp-digit { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
        @keyframes auth-otp-caret { 0%, 100% { opacity: 1 } 50% { opacity: 0 } }
        @keyframes auth-otp-drop { 0%, 100% { transform: none } 50% { transform: translateY(4px) } }
        .auth-otp-mail-in { animation: auth-otp-mail-in 500ms cubic-bezier(0.34,1.56,0.64,1) both }
        .auth-otp-pop { animation: auth-otp-pop 350ms cubic-bezier(0.34,1.56,0.64,1) both }
        .auth-otp-digit { animation: auth-otp-digit 220ms ease-out both }
        .auth-otp-caret { animation: auth-otp-caret 1s steps(1) infinite }
        .auth-otp-drop { animation: auth-otp-drop 1.4s ease-in-out infinite }
      `}</style>

      <div className="relative overflow-hidden rounded-2xl border border-[#e7e7e7] bg-[#fafafa]">
        <div
          className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#fafafa] transition-opacity duration-[400ms] ${
            mailArrived ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          <span
            className="flex size-16 items-center justify-center rounded-2xl border border-[#e7e7e7] bg-white"
            style={{ boxShadow: SHADOW_2 }}
          >
            <GmailMark />
          </span>
          <p className="text-[15px] font-semibold leading-5 text-[#0b0b0b]">Your mail app</p>
          <p className="-mt-1.5 text-[13px] leading-4 text-[#6f6f6f]">Gmail, Outlook, Apple Mail…</p>
        </div>

        <div className="flex items-center gap-2 border-b border-[#e7e7e7] bg-white px-4 py-3">
          {["#f26b5e", "#f5bf4f", "#58c055"].map((color) => (
            <span key={color} aria-hidden="true" className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
          ))}
          <span className="ml-2 text-[14px] font-semibold leading-5 text-[#0b0b0b]">Your inbox</span>
          <span className="ml-auto flex h-7 w-28 items-center rounded-full bg-[#f4f4f4] px-3 text-[12px] leading-4 text-[#8f8f8f]">
            Search
          </span>
        </div>

        <div className="space-y-2 p-3">
          <SkeletonMessage />
          <div
            className={`overflow-hidden rounded-xl border bg-white transition-all duration-500 ${
              mailOpen ? "border-[#d4d4d4]" : "border-[#e7e7e7]"
            } ${!reduce && phase === 1 ? "auth-otp-mail-in" : ""}`}
            style={{
              boxShadow: mailOpen ? SHADOW_2 : "none",
              transitionTimingFunction: "cubic-bezier(0.34,1.56,0.64,1)",
            }}
          >
            <div className="flex items-center gap-3 px-4 py-3">
              <ZaviMascot size={40} />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-semibold leading-5 text-[#0b0b0b]">Zavi</p>
                <p className="truncate text-[14px] leading-5 text-[#6f6f6f]">Your sign-in code</p>
              </div>
              {!mailOpen && <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-[#3263e4]" />}
            </div>

            <div
              className="grid transition-all duration-500"
              style={{
                gridTemplateRows: mailOpen ? "1fr" : "0fr",
                opacity: mailOpen ? 1 : 0,
                transitionTimingFunction: "cubic-bezier(0.34,1.56,0.64,1)",
              }}
            >
              <div className="overflow-hidden">
                <div className="border-t border-[#e7e7e7] px-4 pb-4 pt-3">
                  <span className="block h-2.5 w-4/5 rounded-full bg-[#f4f4f4]" />
                  <span className="mt-2 block h-2.5 w-3/5 rounded-full bg-[#f4f4f4]" />
                  <div className="mt-4 flex items-center gap-3">
                    <span
                      className={`rounded-xl border px-4 py-2 text-[20px] font-semibold leading-7 tracking-[0.18em] tabular-nums transition-all duration-300 ${
                        copied
                          ? "border-[#0b0b0b] bg-[#f4f4f4] text-[#0b0b0b]"
                          : "border-[#d4d4d4] bg-white text-[#545454]"
                      }`}
                    >
                      {CODE}
                    </span>
                    <span
                      className={`flex h-9 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold leading-5 transition-colors duration-300 ${
                        copied ? "bg-[#0b0b0b] text-white" : "border border-[#d4d4d4] bg-white text-[#0b0b0b]"
                      }`}
                    >
                      {copied && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={reduce ? "" : "auth-otp-pop"}>
                          <path d="M4 12.5 9.5 18 20 6.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                      {copied ? "Copied" : "Copy"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <SkeletonMessage short />
        </div>
      </div>

      <div aria-hidden="true" className={`mx-auto my-2 w-fit text-[#545454] ${reduce ? "" : "auth-otp-drop"}`}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M12 4v14m0 0 6-6m-6 6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <div
        className={`flex h-14 items-center justify-between gap-3 rounded-full border py-2 pl-5 pr-2 transition-all duration-300 ${
          codeEntered ? "border-[#d4d4d4] bg-white" : "border-[#e7e7e7] bg-[#fafafa]"
        }`}
        style={{ boxShadow: codeEntered ? SHADOW_2 : "none" }}
      >
        <span className="text-[18px] font-semibold leading-6 tracking-[0.18em] text-[#0b0b0b] tabular-nums">
          {codeEntered ? (
            CODE.split("").map((digit, index) => (
              <span
                key={`${digit}-${index}`}
                className={`inline-block ${reduce ? "" : "auth-otp-digit"}`}
                style={{ animationDelay: reduce ? undefined : `${70 * index}ms` }}
              >
                {digit}
              </span>
            ))
          ) : (
            <span aria-hidden="true" className={`inline-block h-6 w-0.5 translate-y-1 bg-[#6f6f6f] ${reduce ? "" : "auth-otp-caret"}`} />
          )}
        </span>
        <span
          className={`flex h-10 items-center rounded-full px-5 text-[15px] font-semibold leading-5 transition-colors duration-300 ${
            codeEntered ? "bg-[#0b0b0b] text-white" : "bg-[#f4f4f4] text-[#8f8f8f]"
          }`}
        >
          {codeEntered ? "You're in" : "Continue"}
        </span>
      </div>
    </div>
  );
}
