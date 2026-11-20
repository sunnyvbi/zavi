"use client";

import { useId, useRef } from "react";
import { cn } from "@/lib/cn";
import { VOICE_MAX, type PostMode } from "@/lib/workspace/channelPrefsApi";
import { cardButton } from "../../actions/card/styles";
import { SettingsSection } from "./SettingsSection";
import { useChannelPrefs } from "./useChannelPrefs";

const MODES: ReadonlyArray<{ value: PostMode; title: string; line: string }> = [
  { value: "ask", title: "Ask me first", line: "Every post waits in Needs you until you approve it." },
  { value: "auto", title: "Go ahead on my behalf", line: "Zavi posts on schedule. You can still pause it." },
];

export type ModeControl = {
  value: PostMode | null;
  onChange: (mode: PostMode) => void;
  busy: boolean;
  locked: boolean;
  error: string | null;
  loadError: string | null;
  onRetry: () => void;
  note?: string | null;
};

export function PostingSettings({ slug, name, canEdit, mode }: { slug: string; name: string; canEdit: boolean; mode?: ModeControl }) {
  const { prefs, loadError, error, edit, save, retry } = useChannelPrefs(slug);
  const voiceId = useId();
  const voiceDirty = useRef(false);
  const locked = !canEdit;

  if (loadError) {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-ca-action text-ca-danger">
        {loadError}
        <button type="button" onClick={retry} className={cn(cardButton.base, cardButton.secondary)}>Try again</button>
      </p>
    );
  }
  if (!prefs) return <div aria-busy className="h-96 animate-pulse rounded-2xl bg-ca-subtle motion-reduce:animate-none" />;

  return (
    <>
      {mode && <SettingsSection id={`${slug}-mode`} title="Before Zavi posts">
        {mode.loadError ? (
          <p role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-ca-action text-ca-danger">
            {mode.loadError}
            <button type="button" onClick={mode.onRetry} className={cn(cardButton.base, cardButton.secondary)}>Try again</button>
          </p>
        ) : mode.value === null ? (
          <div aria-busy className="mt-3 h-[124px] animate-pulse rounded-xl bg-ca-subtle motion-reduce:animate-none" />
        ) : (
        <div role="radiogroup" aria-labelledby={`${slug}-mode`} className="mt-3 flex flex-col gap-2">
          {MODES.map((m) => {
            const on = mode.value === m.value;
            const off = mode.locked || mode.busy;
            return (
              <label
                key={m.value}
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ca-focus",
                  on ? "border-ca-action bg-ca-subtle" : "border-ca-strong hover:bg-ca-hover",
                  off ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                )}
              >
                <input
                  type="radio"
                  name={`${slug}-mode`}
                  value={m.value}
                  checked={on}
                  disabled={off}
                  onChange={() => mode.onChange(m.value)}
                  className="mt-1 size-4 accent-ca-action"
                />
                <span>
                  <span className="block text-ca-facts font-semibold text-ca-xdark">{m.title}</span>
                  <span className="block text-ca-action text-ca-secondary">{m.line}</span>
                </span>
              </label>
            );
          })}
        </div>
        )}
        {mode.note && <p className="mt-2 text-ca-action text-ca-secondary">{mode.note}</p>}
        {mode.error && <p role="alert" className="mt-2 text-ca-action text-ca-danger">{mode.error}</p>}
      </SettingsSection>}

      <SettingsSection id={`${slug}-voice`} title="How it sounds">
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={voiceId} className="text-ca-action font-medium text-ca-dark">Voice on {name}</label>
            <span id={`${voiceId}-n`} className="text-ca-eyebrow tabular-nums text-ca-muted">{prefs.voice.length}/{VOICE_MAX}</span>
          </div>
          <textarea
            id={voiceId}
            rows={3}
            maxLength={VOICE_MAX}
            aria-describedby={`${voiceId}-n`}
            value={prefs.voice}
            disabled={locked}
            placeholder="Plain and friendly. Short sentences. No hype."
            onChange={(e) => {
              voiceDirty.current = true;
              edit("voice", e.target.value);
            }}
            onBlur={(e) => {
              if (!voiceDirty.current) return;
              voiceDirty.current = false;
              void save("voice", e.target.value.trim());
            }}
            className="min-h-24 w-full resize-y rounded-xl border border-ca-strong bg-ca-bg px-3 py-3 text-ca-facts text-ca-dark outline-none transition placeholder:text-ca-muted focus:border-ca-border-focus focus:shadow-ca-ring disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>
      </SettingsSection>

      {locked && <p className="text-ca-action text-ca-secondary">Only a workspace owner or admin can change these settings.</p>}
      {error && <p role="alert" className="text-ca-action text-ca-danger">{error}</p>}
    </>
  );
}
