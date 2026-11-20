"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { ChatConnectCard, ConnectQR, CopyField, MintButton, expiresLabel } from "./ChatConnectCard";
import { PHONE_SURFACES, type PhoneSurfaceSlug } from "./phoneSurfaces";

type Step = "idle" | "linking" | "await_code" | "confirming" | "done";

function codeErrors(slug: PhoneSurfaceSlug, appName: string): Record<string, string> {
  return {
    bad_code: "That code doesn't match. Check the code Zavi sent you.",
    no_pending: "No pending connection. Send the pre-filled message first.",
    expired: "That code expired. Start again to get a new one.",
    too_many_attempts: "Too many attempts. Start again to get a new code.",
    [`${slug}_disabled`]: `${appName} isn't configured on this workspace yet.`,
    whatsapp_number_missing: "WhatsApp isn't fully configured on this workspace yet.",
    not_admin: `Only an owner or admin can connect ${appName}.`,
    forbidden: `Only an owner or admin can connect ${appName}.`,
  };
}

export function PhoneBindForm({
  surface,
  onClose,
  inline,
}: {
  surface: PhoneSurfaceSlug;
  onClose: () => void;
  inline?: boolean;
}) {
  const s = PHONE_SURFACES[surface];
  const errors = codeErrors(surface, s.appName);
  const [step, setStep] = useState<Step>("linking");
  const [url, setUrl] = useState("");
  const [prefill, setPrefill] = useState("");
  const [number, setNumber] = useState("");
  const [expiresIn, setExpiresIn] = useState<number | undefined>(undefined);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  async function startLink(fresh?: unknown) {
    setError("");
    if (fresh !== false) setCode("");
    setStep("linking");
    try {
      const res = await apiFetch(`/api/connectors/${surface}/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fresh === false ? {} : { fresh: true }),
      });
      const json = (await res.json()) as Record<string, unknown> & { error?: { code?: string } };
      const link = s.readLink(json);
      if (!res.ok || !link.url) {
        setError(errors[String(json?.error?.code)] ?? "Couldn't create a connect link.");
        setStep("idle");
        return;
      }
      setUrl(link.url);
      setPrefill(typeof json.prefill === "string" ? json.prefill : "");
      setNumber(link.number);
      setExpiresIn(typeof json.expires_in === "number" ? json.expires_in : undefined);
      setStep("await_code");
    } catch (e) {
      setError((e as Error).message);
      setStep("idle");
    }
  }

  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    void startLink(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm() {
    const trimmed = code.trim();
    if (!trimmed) return;
    setError("");
    setStep("confirming");
    try {
      const res = await apiFetch(`/api/connectors/${surface}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: { code?: string } };
      if (!res.ok || !json.ok) {
        setError(errors[String(json?.error?.code)] ?? "Couldn't confirm that code.");
        setStep("await_code");
        return;
      }
      setStep("done");
      setTimeout(() => window.location.reload(), 700);
    } catch (e) {
      setError((e as Error).message);
      setStep("await_code");
    }
  }

  return (
    <ChatConnectCard
      title={`Connect ${s.appName}`}
      blurb="Send one message, then type the code Zavi replies with."
      onClose={onClose}
      error={error}
      inline={inline}
    >
      {step === "idle" || step === "linking" ? (
        <MintButton
          step={step === "linking" ? "linking" : "idle"}
          onClick={startLink}
          label="Try again"
          busyLabel="Creating link…"
        />
      ) : null}

      {step === "await_code" || step === "confirming" ? (
        <ol className="space-y-3">
          <li>
            <div className="text-xs font-medium">1. Send the pre-filled message in {s.appName}</div>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className={`mt-1 inline-block rounded-md px-3 py-2 text-xs font-medium text-white ${s.openClassName}`}
            >
              {s.openLabel}
            </a>
            <button
              type="button"
              onClick={() => void startLink()}
              disabled={step === "confirming"}
              className="ml-2 rounded-cta px-3 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
            >
              Get a new link
            </button>
            <div className="mt-1 text-xs text-neutral-500">
              Don&apos;t edit the message. The code in it is what links your workspace.
            </div>
            <ConnectQR value={url} caption={s.qrCaption} />
            {number && prefill ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-neutral-500">
                  Can&apos;t scan? Send it by hand
                </summary>
                <div className="mt-1">
                  <CopyField label="Message" value={number} />
                  <CopyField label="with" value={prefill} />
                </div>
              </details>
            ) : null}
          </li>
          <li>
            <div className="text-xs font-medium">2. Enter the code Zavi replies with</div>
            <div className="mt-1 flex gap-2">
              <input
                data-replay-mask=""
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && confirm()}
                placeholder="K7Q2-9F3M"
                autoComplete="off"
                spellCheck={false}
                className="w-40 rounded-md border border-neutral-300 px-2 py-1.5 font-mono text-xs uppercase"
              />
              <button
                type="button"
                onClick={confirm}
                disabled={step === "confirming" || !code.trim()}
                className="rounded-cta bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {step === "confirming" ? "Checking…" : "Confirm"}
              </button>
            </div>
            <div className="mt-1 text-xs text-neutral-500">{expiresLabel(expiresIn)}</div>
          </li>
        </ol>
      ) : null}

      {step === "done" ? (
        <div className="text-xs font-medium text-green-700">
          Connected. You can message your agents from {s.appName} now.
        </div>
      ) : null}
    </ChatConnectCard>
  );
}
