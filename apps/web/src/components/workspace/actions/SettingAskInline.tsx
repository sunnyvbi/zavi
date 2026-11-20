"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { settingsFieldUnit } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { announceChannelSettingsChanged } from "@/lib/workspace/onTabReturn";
import { CardButton } from "./card/CardButton";
import { settingAskValue, type AskableSetting } from "./settingAsk";
import { AmountInput, amountAffixes } from "./AmountInput";

type Row = { item?: unknown; status?: unknown };

function savedValue(rows: unknown): string {
  const first = Array.isArray(rows) ? (rows as Row[]).find((r) => r.status !== "dismissed" && r.status !== "paused") : undefined;
  return typeof first?.item === "string" ? first.item : "";
}

async function errorText(res: Response): Promise<string> {
  if (res.status === 403) return "Only a workspace owner or admin can save this.";
  const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } | string; message?: unknown } | null;
  const nested = body && typeof body.error === "object" ? body.error?.message : undefined;
  const message = typeof nested === "string" ? nested : typeof body?.message === "string" ? body.message : null;
  return message ?? "Zavi could not save this. Try again.";
}

export function useSettingAsk({
  slug,
  field,
  busy,
  onSaved,
}: {
  slug: string;
  field: AskableSetting | null;
  busy?: boolean;
  onSaved: () => void | Promise<void>;
}): { panel: ReactNode; primary: ReactNode } {
  const formId = useId();
  const inputId = useId();
  const helpId = useId();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const fieldId = field?.id ?? null;

  useEffect(() => {
    if (!fieldId) return;
    let cancelled = false;
    void apiFetch(`/api/channels/${slug}/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { fields?: Record<string, unknown> } | null) => {
        const saved = savedValue(body?.fields?.[fieldId]);
        if (cancelled || !saved) return;
        setCurrent(saved);
        setValue((typed) => (typed ? typed : saved));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [slug, fieldId]);

  if (!field) return { panel: null, primary: null };

  const unit = settingsFieldUnit(slug, field.id);
  const { prefix, suffix } = field.kind === "number" ? amountAffixes(unit, field.prefix, field.suffix) : { prefix: undefined, suffix: undefined };
  const save = async () => {
    const parsed = settingAskValue(field, value);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/channels/${slug}/settings/${encodeURIComponent(field.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ item: parsed.value }] }),
      });
      if (!res.ok) {
        setError(await errorText(res));
        return;
      }
      announceChannelSettingsChanged();
      await onSaved();
    } catch {
      setError("Zavi could not save this. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };
  const locked = saving || !!busy;

  const panel = (
    <form
      id={formId}
      data-testid="setting-ask"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="rounded-xl bg-ca-subtle p-4"
    >
      <label htmlFor={inputId} className="block text-ca-action font-semibold text-ca-xdark">
        {field.label}
      </label>
      <AmountInput
        className="mt-2.5"
        prefix={prefix}
        suffix={suffix}
        id={inputId}
        data-testid="setting-ask-input"
        inputMode={field.kind === "number" ? "decimal" : "url"}
        placeholder={field.kind === "number" ? "1,200" : field.placeholder}
        value={value}
        disabled={locked}
        invalid={!!error}
        aria-describedby={helpId}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
      />
      <p
        id={helpId}
        role={error ? "alert" : undefined}
        data-testid={error ? "setting-ask-error" : undefined}
        className={`mt-2 max-w-[60ch] text-ca-action ${error ? "text-ca-danger" : "text-ca-secondary"}`}
      >
        {error ?? field.help ?? null}
      </p>
    </form>
  );

  const primary = (
    <CardButton
      type="submit"
      form={formId}
      variant="primary"
      data-testid="setting-ask-save"
      disabled={locked || !value.trim()}
    >
      <Check className="size-4" aria-hidden />
      {saving ? "Saving…" : current && current === value.trim() ? "Keep this value" : "Save"}
    </CardButton>
  );

  return { panel, primary };
}
