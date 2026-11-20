"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { cx, FOCUS_RING } from "../layout/shared";
import type { GeoPrompt } from "./types";

type PromptSet = { active: GeoPrompt[]; suggested: GeoPrompt[] };

async function apiMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return body?.error?.message ?? fallback;
}

const BASELINE_NOTE =
  "Changing the set starts a new baseline: only sweeps that asked the same prompts are compared.";

export function GeoPromptSetup({
  brand,
  autoStart = false,
  onChanged,
}: {
  brand: string | null;
  autoStart?: boolean;
  onChanged: () => void;
}) {
  const [set, setSet] = useState<PromptSet | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const read = useCallback(async (): Promise<PromptSet | null> => {
    try {
      const res = await apiFetch("/api/geo/prompts");
      if (!res.ok) return null;
      const body = (await res.json()) as Partial<PromptSet>;
      const next = {
        active: Array.isArray(body.active) ? body.active : [],
        suggested: Array.isArray(body.suggested) ? body.suggested : [],
      };
      setSet(next);
      setChosen(new Set(next.suggested.map((p) => p.id)));
      return next;
    } catch {
      return null;
    }
  }, []);

  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  });

  useEffect(() => {
    let alive = true;
    void (async () => {
      const current = await read();
      if (!alive || !autoStart || started.current) return;
      if (!current || current.active.length > 0) return;
      started.current = true;
      setStarting(true);
      try {
        const res = await apiFetch("/api/geo/prompts/starter", { method: "POST" });
        if (!res.ok) {
          setError(await apiMessage(res, "Zavi couldn't pick prompts just now."));
          return;
        }
        await read();
        onChangedRef.current();
      } catch {
        setError("Zavi couldn't pick prompts just now.");
      } finally {
        setStarting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [autoStart, read]);

  const suggest = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/geo/prompts/suggest", { method: "POST" });
      if (!res.ok) {
        setError(await apiMessage(res, "Zavi couldn't draft prompts just now."));
        return;
      }
      await read();
    } catch {
      setError("Zavi couldn't draft prompts just now.");
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    const ids = [...chosen];
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/geo/prompts/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        setError(await apiMessage(res, "Those prompts didn't save."));
        return;
      }
      await read();
      onChanged();
    } catch {
      setError("Those prompts didn't save.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    setSet((cur) =>
      cur
        ? {
            active: cur.active.filter((p) => p.id !== id),
            suggested: cur.suggested.filter((p) => p.id !== id),
          }
        : cur,
    );
    setChosen((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
    try {
      const res = await apiFetch(`/api/geo/prompts/${id}`, { method: "DELETE" });
      if (res.ok) onChanged();
    } catch {
    }
  };

  const toggle = (id: string) =>
    setChosen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const active = set?.active ?? [];
  const suggested = set?.suggested ?? [];

  if (starting) {
    return (
      <p className="mt-2.5 flex items-center gap-2 text-[13px] leading-5 text-inkMuted" aria-live="polite">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
        Zavi is choosing the questions to track…
      </p>
    );
  }

  return (
    <div className="mt-2.5">
      {active.length > 0 && (
        <>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-inkMuted">
            Tracked prompts ({active.length})
          </p>
          <ul className="mt-1.5 flex flex-col gap-2">
            {active.map((p) => (
              <li key={p.id} className="flex items-start gap-2.5">
                <span className="min-w-0 flex-1 text-[13px] leading-5 text-ink [overflow-wrap:anywhere]">
                  {p.prompt_text}
                  {p.rationale ? (
                    <span className="block text-[12px] leading-4 text-inkMuted">{p.rationale}</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  onClick={() => void remove(p.id)}
                  className={cx("shrink-0 text-[13px] text-inkMuted underline hover:text-ink", FOCUS_RING)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {suggested.length > 0 && (
        <>
          <p className={cx("text-[11px] font-semibold uppercase tracking-wide text-inkMuted", active.length > 0 && "mt-3")}>
            Waiting for you ({suggested.length})
          </p>
          <ul className="mt-1.5 flex flex-col gap-2">
            {suggested.map((p) => (
              <li key={p.id} className="flex items-start gap-2.5">
                <input
                  id={`geo-prompt-${p.id}`}
                  type="checkbox"
                  checked={chosen.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className={cx("mt-[3px] h-3.5 w-3.5 shrink-0 accent-[#2563eb]", FOCUS_RING)}
                />
                <label
                  htmlFor={`geo-prompt-${p.id}`}
                  className="min-w-0 flex-1 text-[13px] leading-5 text-ink [overflow-wrap:anywhere]"
                >
                  {p.prompt_text}
                  {p.rationale ? (
                    <span className="block text-[12px] leading-4 text-inkMuted">{p.rationale}</span>
                  ) : null}
                </label>
                <button
                  type="button"
                  onClick={() => void remove(p.id)}
                  className={cx("shrink-0 text-[13px] text-inkMuted underline hover:text-ink", FOCUS_RING)}
                >
                  Decline
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {suggested.length > 0 && (
          <button
            type="button"
            disabled={busy || chosen.size === 0}
            onClick={() => void accept()}
            className={cx(
              "inline-flex h-8 items-center gap-2 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-cream hover:bg-inkSoft disabled:opacity-50",
              FOCUS_RING,
            )}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
            Track {chosen.size} {chosen.size === 1 ? "prompt" : "prompts"}
          </button>
        )}
        <button
          type="button"
          disabled={busy || !brand}
          onClick={() => void suggest()}
          title={brand ? undefined : "Add your company name in Settings first."}
          className={cx(
            "inline-flex h-8 items-center gap-2 rounded-full border border-rule bg-white px-3.5 text-[13px] font-semibold text-ink hover:bg-creamDeep disabled:opacity-50",
            FOCUS_RING,
          )}
        >
          {busy && suggested.length === 0 && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          )}
          {active.length > 0 || suggested.length > 0 ? "Suggest more" : "Suggest prompts"}
        </button>
        <span className="text-[12px] leading-4 text-inkMuted">{BASELINE_NOTE}</span>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-[13px] font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
