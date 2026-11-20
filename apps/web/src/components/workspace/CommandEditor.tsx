"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import type { TenantCommand } from "@/lib/workspace/tenantCommands";
import { Input, Textarea } from "@/components/Input";

const SLUG_RE = /^[a-z][a-z0-9-]{0,39}$/;
const RESERVED_SLUGS = new Set([
  "feedback",
  "clear",
  "help",
  "run",
  "decision",
]);
const INSTRUCTIONS_MAX = 8000;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 200;

export function CommandEditor({
  initial,
  onSaved,
  onCancel,
}: {
  initial: TenantCommand | null;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const isEdit = initial != null;
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructionsMd, setInstructionsMd] = useState(
    initial?.instructions_md ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slugError = (() => {
    if (!slug) return "Required.";
    if (!SLUG_RE.test(slug)) {
      return "Lowercase letters/digits/hyphens, start with a letter, 1–40 chars.";
    }
    if (RESERVED_SLUGS.has(slug)) {
      return "Reserved by a built-in command. Pick another.";
    }
    return null;
  })();
  const nameError = !name ? "Required." : null;
  const instructionsLen = instructionsMd.length;
  const instructionsError =
    instructionsLen > INSTRUCTIONS_MAX
      ? `Too long (${instructionsLen} / ${INSTRUCTIONS_MAX}).`
      : null;

  const canSave =
    !saving && !slugError && !nameError && !instructionsError;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/commands", {
        method: "POST",
        body: JSON.stringify({
          slug,
          name,
          description,
          instructions_md: instructionsMd,
        }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as
          | { error?: { message?: string; code?: string } }
          | null;
        setError(
          json?.error?.message ??
            `Save failed (${res.status}).`,
        );
        setSaving(false);
        return;
      }
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-ink">
          {isEdit ? `Edit /${initial!.slug}` : "New command"}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          className="text-[13px] text-inkMuted hover:text-ink"
        >
          Cancel
        </button>
      </div>

      <div>
        <label className="block text-[14px] font-medium text-ink">
          Slug
        </label>
        <Input
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          disabled={isEdit}
          placeholder="onboard-host"
          className="mt-1 font-mono"
        />
        <div className="mt-1 text-[12px] text-inkMuted">
          {slugError ? (
            <span className="text-coral">{slugError}</span>
          ) : (
            <span>
              Invoked as <code>/{slug || "your-slug"}</code> in agent chats.
              {isEdit ? " Slug is immutable after creation." : ""}
            </span>
          )}
        </div>
      </div>

      <div>
        <label className="block text-[14px] font-medium text-ink">
          Name
        </label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
          placeholder="Host onboarding"
          className="mt-1"
        />
        {nameError && (
          <div className="mt-1 text-[12px] text-coral">{nameError}</div>
        )}
      </div>

      <div>
        <label className="block text-[14px] font-medium text-ink">
          Description (optional)
        </label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
          placeholder="Walks a new host through the activation checklist."
          className="mt-1"
        />
      </div>

      <div>
        <label className="flex items-baseline justify-between text-[14px] font-medium text-ink">
          <span>Instructions (Markdown)</span>
          <span
            className={`font-mono text-[12px] ${
              instructionsError ? "text-coral" : "text-inkMuted"
            }`}
          >
            {instructionsLen} / {INSTRUCTIONS_MAX}
          </span>
        </label>
        <Textarea
          value={instructionsMd}
          onChange={(e) => setInstructionsMd(e.target.value)}
          rows={12}
          placeholder={
            "Always start by asking what state the host is in.\n" +
            "Quote the seller-host pricing table.\n" +
            "Keep replies under 200 words."
          }
          className="mt-1 font-mono text-[13px] leading-[1.5]"
        />
        {instructionsError && (
          <div className="mt-1 text-[12px] text-coral">{instructionsError}</div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-coral/30 bg-coral/5 px-3 py-2 text-[13px] text-coral">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-cta border border-ink/15 px-3 py-1.5 text-[13px] text-ink hover:bg-bone"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canSave}
          className="rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:bg-inkSoft disabled:cursor-not-allowed disabled:bg-bone"
        >
          {saving ? "Saving…" : isEdit ? "Save changes" : "Create command"}
        </button>
      </div>
    </div>
  );
}
