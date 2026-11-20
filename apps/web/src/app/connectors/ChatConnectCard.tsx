"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { apiFetch } from "@/lib/api";

export type ChatConnectStep = "idle" | "linking" | "wait" | "checking";

const CHAT_CONNECT_BASE_ERRORS: Record<string, string> = {
  unauthenticated: "Your session expired. Reload the page and try again.",
  no_active_tenant: "No active workspace on this session. Reload the page and try again.",
  membership_revoked: "You're no longer a member of this workspace.",
  auth_db_error: "Couldn't verify your session. Try again in a moment.",
  forbidden: "Only an owner or admin can connect this.",
  link_mint_failed: "Couldn't create a connect link. Try again.",
};

export function expiresLabel(expiresIn?: number): string {
  const min = typeof expiresIn === "number" && expiresIn > 0 ? Math.max(1, Math.floor(expiresIn / 60)) : 15;
  return `Expires in ${min} minute${min === 1 ? "" : "s"}.`;
}

export const CHAT_CONNECT_POLL_WINDOW_MS = 15 * 60 * 1000;

export function useChatConnect<T>(opts: {
  linkPath: string;
  statusPath: string;
  errors: Record<string, string>;
  accept: (json: T) => boolean;
  autoStart?: boolean;
  pollMs?: number;
}) {
  const [step, setStep] = useState<ChatConnectStep>(opts.autoStart ? "linking" : "idle");
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [notYet, setNotYet] = useState(false);
  const baseline = useRef<{ connected: boolean; chats: number } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function startLink(fresh?: unknown) {
    const body = fresh === false ? {} : { fresh: true };
    setError("");
    setNotYet(false);
    setStep("linking");
    try {
      if (opts.pollMs) {
        baseline.current = null;
        try {
          const pre = await apiFetch(opts.statusPath);
          if (pre.ok) {
            const j = (await pre.json()) as { connected?: boolean; chats?: number };
            baseline.current = { connected: !!j.connected, chats: j.chats ?? 0 };
          }
        } catch {
        }
        if (!mounted.current) return;
      }
      const res = await apiFetch(opts.linkPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as T & { error?: { code?: string } };
      if (!res.ok || !opts.accept(json)) {
        const code = String(json?.error?.code);
        setError(
          opts.errors[code] ?? CHAT_CONNECT_BASE_ERRORS[code] ?? "Couldn't create a connect link.",
        );
        setStep("idle");
        return;
      }
      setData(json);
      setStep("wait");
    } catch (e) {
      setError((e as Error).message);
      setStep("idle");
    }
  }

  async function checkConnected() {
    setError("");
    setNotYet(false);
    setStep("checking");
    try {
      const res = await apiFetch(opts.statusPath);
      if (!res.ok) {
        setError(
          res.status === 401
            ? "Your session expired. Reload the page and try again."
            : `Couldn't check the connection (HTTP ${res.status}). Try again.`,
        );
        setStep("wait");
        return;
      }
      const json = (await res.json()) as { connected?: boolean };
      if (json.connected) {
        window.location.reload();
        return;
      }
      setNotYet(true);
    } catch (e) {
      setError((e as Error).message);
    }
    setStep("wait");
  }

  const autoStarted = useRef(false);
  useEffect(() => {
    if (!opts.autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void startLink(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { pollMs, statusPath } = opts;
  useEffect(() => {
    if (!pollMs || !data) return;
    const startedAt = Date.now();
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (stopped || inFlight) return;
      if (Date.now() - startedAt >= CHAT_CONNECT_POLL_WINDOW_MS) return stop();
      inFlight = true;
      try {
        const res = await apiFetch(statusPath);
        if (stopped || !res.ok) return;
        const json = (await res.json()) as { connected?: boolean; chats?: number };
        if (stopped) return;
        const now = { connected: !!json.connected, chats: json.chats ?? 0 };
        const base = baseline.current;
        if (base === null) {
          baseline.current = now;
          return;
        }
        if (now.connected && (!base.connected || now.chats > base.chats)) {
          stop();
          window.location.reload();
        }
      } catch {
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void tick(), pollMs);
    function stop() {
      stopped = true;
      clearInterval(timer);
    }
    void tick();
    return stop;
  }, [data, pollMs, statusPath]);

  return { step, data, error, notYet, setError, startLink, checkConnected };
}

export function ChatConnectCard({
  title,
  blurb,
  icon,
  onClose,
  error,
  inline = false,
  children,
}: {
  title: string;
  blurb: ReactNode;
  icon?: string;
  onClose: () => void;
  error?: string;
  inline?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, inline]);

  return (
    <>
      {!inline && (
        <div
          aria-hidden
          onClick={onClose}
          className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-[2px]"
        />
      )}
      <div
        role={inline ? "region" : "dialog"}
        aria-modal={inline ? undefined : "true"}
        aria-label={title}
        className={
          inline
            ? "w-full rounded-2xl border border-neutral-200 bg-white p-4 text-base"
            : "fixed left-1/2 top-1/2 z-[70] w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-neutral-200 bg-white p-4 text-base shadow-[0_24px_60px_rgba(0,0,0,0.25)]"
        }
      >
        <div className="flex items-start gap-3">
          {icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={icon}
              alt=""
              aria-hidden
              className="mt-0.5 h-9 w-9 shrink-0 rounded-[10px] border border-neutral-200 bg-white object-contain p-1.5"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-semibold leading-[22px]">{title}</div>
            <div className="mt-1 text-xs leading-[17px] text-neutral-500">{blurb}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="mt-4">{children}</div>
        {error ? (
          <div role="alert" className="mt-3 text-xs text-red-600">
            {error}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function MintButton({
  step,
  onClick,
  label,
  busyLabel,
}: {
  step: ChatConnectStep;
  onClick: () => void;
  label: string;
  busyLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={step === "linking"}
      className="rounded-cta bg-neutral-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
    >
      {step === "linking" ? busyLabel : label}
    </button>
  );
}

export function CheckStep({
  n,
  title,
  step,
  checkLabel,
  onCheck,
  onRemint,
  notYet,
  notYetText,
}: {
  n: number;
  title: string;
  step: ChatConnectStep;
  checkLabel: string;
  onCheck: () => void;
  onRemint: () => void;
  notYet: boolean;
  notYetText: string;
}) {
  return (
    <li>
      <div className="text-xs font-medium">
        {n}. {title}
      </div>
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          onClick={onCheck}
          disabled={step === "checking"}
          className="rounded-cta bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {step === "checking" ? "Checking…" : checkLabel}
        </button>
        <button
          type="button"
          onClick={onRemint}
          disabled={step === "checking"}
          className="rounded-cta px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
        >
          Get a new one
        </button>
      </div>
      {notYet ? <div className="mt-1 text-xs text-neutral-500">{notYetText}</div> : null}
    </li>
  );
}

export function ConnectQR({ value, caption }: { value: string; caption: string }) {
  return (
    <div className="mt-2 hidden items-center gap-3 sm:flex">
      {}
      <div className="ph-no-capture rounded-md border border-neutral-200 bg-white p-2 dark:border-neutral-700">
        <QRCodeSVG
          value={value}
          size={148}
          level="M"
          marginSize={2}
          bgColor="#ffffff"
          fgColor="#000000"
        />
      </div>
      <div className="max-w-[12rem] text-xs text-neutral-500">{caption}</div>
    </div>
  );
}

export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1 flex items-center gap-2">
      <span className="text-xs text-neutral-500">{label}</span>
      <code data-replay-mask="" className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs dark:bg-neutral-800">
        {value}
      </code>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard
            ?.writeText(value)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {});
        }}
        className="rounded px-1.5 py-0.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
