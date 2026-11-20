"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  BASE_TONES,
  type BaseTone,
  type Personalization,
  type PersonalizationPatch,
} from "../personalization/usePersonalization";
import { FactRow, GrowthSection, SectionAction, CardDivider, SubLabel } from "./GrowthSection";
import { SettledSection } from "@/components/ui/SettledSection";
import { VoiceBars } from "./GrowthMemoSkeleton";
import { BTN_TEXT, Section } from "../personalization/shared";

export const BRAND_VOICE_MAX = 2000;
const RULES_MAX = 2000;
const MAX_NEVER_SAY = 25;
const MAX_WORD_CHARS = 40;

export const TONE_LABEL: Record<BaseTone, string> = {
  default: "Default",
  concise: "Concise",
  friendly: "Friendly",
  professional: "Professional",
  direct: "Direct",
};

export const NEVER_SAY_PREFIX = "Never use these words or phrases: ";

export function neverSayToRule(words: string[]): string {
  const kept = words.map((w) => w.trim()).filter(Boolean).slice(0, MAX_NEVER_SAY);
  return kept.length === 0 ? "" : `${NEVER_SAY_PREFIX}${kept.join(", ")}.`.slice(0, RULES_MAX);
}

export function ruleToNeverSay(rule: string): string[] {
  const text = rule.trim();
  if (!text.toLowerCase().startsWith(NEVER_SAY_PREFIX.toLowerCase())) return [];
  return splitWords(text.slice(NEVER_SAY_PREFIX.length).replace(/\.$/, ""));
}

export function splitWords(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const word = raw.trim().slice(0, MAX_WORD_CHARS);
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= MAX_NEVER_SAY) break;
  }
  return out;
}

function otherRules(rule: string): string {
  return ruleToNeverSay(rule).length > 0 ? "" : rule.trim();
}

export type BrandKit = {
  primary: string;
  accent: string | null;
  bg: string | null;
  text: string | null;
  source: "scrape" | "default" | "manual";
  source_url: string | null;
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const COLOUR_FIELDS = [
  ["primary", "Main"],
  ["accent", "Accent"],
  ["bg", "Background"],
  ["text", "Text"],
] as const;

type ColourDraft = Record<(typeof COLOUR_FIELDS)[number][0], string>;

const toColourDraft = (k: BrandKit): ColourDraft => ({
  primary: k.primary ?? "",
  accent: k.accent ?? "",
  bg: k.bg ?? "",
  text: k.text ?? "",
});

export function invalidColour(draft: ColourDraft): string | null {
  if (!HEX.test(draft.primary)) return "Main colour must be a hex value like #1A73FF.";
  for (const [key, label] of COLOUR_FIELDS.slice(1)) {
    const v = draft[key].trim();
    if (v && !HEX.test(v)) return `${label} colour must be a hex value like #1A73FF.`;
  }
  return null;
}

type Draft = {
  brand_voice: string;
  base_tone: BaseTone;
  warm: boolean;
  enthusiastic: boolean;
  never_say: string;
};

const toDraft = (p: Personalization): Draft => ({
  brand_voice: p.brand_voice,
  base_tone: p.base_tone,
  warm: p.warm,
  enthusiastic: p.enthusiastic,
  never_say: ruleToNeverSay(p.response_rules).join(", "),
});

export function GrowthBrandVoice({
  data,
  loading,
  loadError,
  canEdit,
  onSave,
  variant = "growth",
  editRequest = 0,
}: {
  data: Personalization | null;
  loading: boolean;
  loadError: string | null;
  canEdit: boolean;
  onSave: (patch: PersonalizationPatch) => Promise<Personalization>;
  variant?: "growth" | "memo" | "personalization";
  editRequest?: number;
}) {
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [kit, setKit] = useState<BrandKit | null>(null);
  const [colours, setColours] = useState<ColourDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing && data) setDraft(toDraft(data));
  }, [data, editing]);

  const [kitSettled, setKitSettled] = useState(false);
  const loadKit = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/brand-kit");
      const body = (await res.json().catch(() => null)) as { brand_kit?: BrandKit } | null;
      if (res.ok && body?.brand_kit) setKit(body.brand_kit);
    } catch {
    } finally {
      setKitSettled(true);
    }
  }, []);

  useEffect(() => {
    void loadKit();
  }, [loadKit]);

  const [voiceDraft, setVoiceDraft] = useState<{ value: string; from: string } | null>(null);
  const [voiceDrafting, setVoiceDrafting] = useState(false);
  const [voiceDraftDone, setVoiceDraftDone] = useState(false);
  const wantsVoiceDraft = canEdit && data !== null && !data.brand_voice.trim();
  useEffect(() => {
    if (!wantsVoiceDraft) {
      setVoiceDraft(null);
      return;
    }
    let cancelled = false;
    setVoiceDrafting(true);
    void (async () => {
      try {
        const res = await apiFetch("/api/workspace/brand-voice-draft", { method: "POST" });
        if (!res.ok) return;
        const body = (await res.json()) as { draft?: { value: string; from: string } | null };
        if (!cancelled) setVoiceDraft(body.draft ?? null);
      } catch {
      } finally {
        if (!cancelled) {
          setVoiceDrafting(false);
          setVoiceDraftDone(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wantsVoiceDraft]);

  const useVoiceDraft = async () => {
    if (!voiceDraft) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ brand_voice: voiceDraft.value.slice(0, BRAND_VOICE_MAX) });
    } catch (e) {
      setError((e as Error).message || "Could not save the brand voice.");
    } finally {
      setSaving(false);
    }
  };

  const dismissVoiceDraft = async () => {
    try {
      const res = await apiFetch("/api/workspace/brand-voice-draft/dismiss", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setVoiceDraft(null);
      setError(null);
    } catch {
      setError("Could not dismiss that. Try again.");
    }
  };

  const startEdit = (seedVoice?: string) => {
    if (!data) return;
    setDraft(seedVoice === undefined ? toDraft(data) : { ...toDraft(data), brand_voice: seedVoice });
    setColours(kit ? toColourDraft(kit) : null);
    setError(null);
    setEditing(true);
  };

  const rowRef = useRef<HTMLDivElement>(null);
  const startEditRef = useRef(startEdit);
  startEditRef.current = startEdit;
  useEffect(() => {
    if (editRequest === 0) return;
    startEditRef.current();
    rowRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [editRequest]);

  const commit = async () => {
    if (!draft || !data) return;
    if (colours) {
      const bad = invalidColour(colours);
      if (bad) {
        setError(bad);
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const rules = neverSayToRule(splitWords(draft.never_say));
      const keep = otherRules(data.response_rules);
      await onSave({
        brand_voice: draft.brand_voice.slice(0, BRAND_VOICE_MAX),
        base_tone: draft.base_tone,
        warm: draft.warm,
        enthusiastic: draft.enthusiastic,
        response_rules: [keep, rules].filter(Boolean).join(" ").slice(0, RULES_MAX),
      });
      if (colours && kit && JSON.stringify(colours) !== JSON.stringify(toColourDraft(kit))) {
        const res = await apiFetch("/api/workspace/brand-kit", {
          method: "PUT",
          body: JSON.stringify({
            primary: colours.primary,
            accent: colours.accent.trim() || null,
            bg: colours.bg.trim() || null,
            text: colours.text.trim() || null,
          }),
        });
        const body = (await res.json().catch(() => null)) as { brand_kit?: BrandKit } | null;
        if (!res.ok) throw new Error("The colours could not be saved.");
        if (body?.brand_kit) setKit(body.brand_kit);
      }
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the brand voice.");
    } finally {
      setSaving(false);
    }
  };

  const resetColours = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/workspace/brand-kit", { method: "DELETE" });
      const body = (await res.json().catch(() => null)) as { brand_kit?: BrandKit } | null;
      if (!res.ok) throw new Error("The colours could not be reset.");
      if (body?.brand_kit) {
        setKit(body.brand_kit);
        setColours(toColourDraft(body.brand_kit));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The colours could not be reset.");
    } finally {
      setSaving(false);
    }
  };

  const neverSay = data ? ruleToNeverSay(data.response_rules) : [];
  const tone = data
    ? [TONE_LABEL[data.base_tone], data.warm ? "Warm" : null, data.enthusiastic ? "Enthusiastic" : null].filter(
        (t): t is string => Boolean(t) && t !== "Default",
      )
    : [];

  const body = (
    <>
      {loadError ? (
        <p role="alert" className="text-sm text-warn dark:text-marigold">
          Brand voice could not be loaded.
        </p>
      ) : loading || !data || !draft ? (
        <div role="status" aria-label="Loading brand voice" className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : editing ? (
        <>
          <SubLabel>How we sound</SubLabel>
          <textarea
            aria-label="How we sound"
            value={draft.brand_voice}
            onChange={(e) => setDraft({ ...draft, brand_voice: e.target.value.slice(0, BRAND_VOICE_MAX) })}
            placeholder="Warm and plain-spoken. Short sentences. We answer the question first, then add the detail."
            rows={4}
            className="mt-2 w-full resize-none rounded-lg border border-rule bg-transparent px-3 py-2 text-[14px] text-ink placeholder:text-inkMuted focus:border-inkMuted focus:outline-none"
          />
          <p className="mt-1 text-xs tabular-nums text-inkMuted">
            {draft.brand_voice.length} of {BRAND_VOICE_MAX} characters
          </p>

          <CardDivider />
          <SubLabel>Tone</SubLabel>
          <div className="mt-2 flex flex-wrap gap-2">
            {BASE_TONES.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={draft.base_tone === t}
                onClick={() => setDraft({ ...draft, base_tone: t })}
                className={`rounded-full border px-3 py-1 text-sm compact:min-h-[40px] ${
                  draft.base_tone === t
                    ? "border-ink bg-ink text-cream"
                    : "border-rule text-ink hover:bg-creamDeep"
                }`}
              >
                {TONE_LABEL[t]}
              </button>
            ))}
            {(["warm", "enthusiastic"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={draft[k]}
                onClick={() => setDraft({ ...draft, [k]: !draft[k] })}
                className={`rounded-full border px-3 py-1 text-sm capitalize compact:min-h-[40px] ${
                  draft[k] ? "border-ink bg-ink text-cream" : "border-rule text-ink hover:bg-creamDeep"
                }`}
              >
                {k}
              </button>
            ))}
          </div>

          <CardDivider />
          <SubLabel>Never say</SubLabel>
          <input
            aria-label="Words to never say"
            value={draft.never_say}
            onChange={(e) => setDraft({ ...draft, never_say: e.target.value })}
            placeholder="artisanal, curated, game-changing"
            className="mt-2 w-full rounded-lg border border-rule bg-transparent px-3 py-2 text-[14px] text-ink placeholder:text-inkMuted focus:border-inkMuted focus:outline-none"
          />
          <p className="mt-1 text-xs text-inkMuted">Separate words with commas.</p>

          {colours && (
            <>
              <CardDivider />
              <SubLabel>Colours</SubLabel>
              <div className="mt-2 flex flex-wrap gap-4">
                {COLOUR_FIELDS.map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-sm text-ink">
                    <span
                      aria-hidden="true"
                      className="h-7 w-7 rounded-md border border-rule"
                      style={{ background: HEX.test(colours[key]) ? colours[key] : "transparent" }}
                    />
                    <span className="sr-only">{label} colour</span>
                    <input
                      aria-label={`${label} colour`}
                      value={colours[key]}
                      onChange={(e) => setColours({ ...colours, [key]: e.target.value })}
                      placeholder={key === "primary" ? "#1a73ff" : "optional"}
                      className="w-28 rounded-lg border border-rule bg-transparent px-2 py-1.5 font-mono text-sm text-ink placeholder:text-inkMuted focus:border-inkMuted focus:outline-none"
                    />
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-inkMuted">
                {kit?.source === "manual" ? (
                  <>
                    Set by hand, so your site is no longer read for these.{" "}
                    <button type="button" onClick={() => void resetColours()} className="underline">
                      Use my site&rsquo;s colours again
                    </button>
                  </>
                ) : (
                  "Editing these stops the weekly read of your site, so your choice stays."
                )}
              </p>
            </>
          )}

          <div className="mt-4 flex items-center gap-3 compact:flex-wrap">
            <button
              type="button"
              onClick={() => void commit()}
              disabled={saving}
              className="rounded-cta bg-ink px-3.5 py-2 text-sm font-medium text-cream disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
                setDraft(toDraft(data));
              }}
              className="text-sm text-inkMuted hover:text-ink"
            >
              Cancel
            </button>
            <span className="ml-auto text-xs text-inkMuted compact:basis-full">Takes effect on the next agent run.</span>
          </div>
        </>
      ) : (
        <>
          <SubLabel>How we sound</SubLabel>
          {data.brand_voice.trim() ? (
            <>
              <p className={`whitespace-pre-wrap text-sm leading-relaxed text-ink ${data.brand_voice.length > 180 && !voiceOpen ? "line-clamp-2" : ""}`}>
                {data.brand_voice}
              </p>
              {data.brand_voice.length > 180 && (
                <button
                  type="button"
                  aria-expanded={voiceOpen}
                  onClick={() => setVoiceOpen((v) => !v)}
                  className="mt-1 text-[13px] font-semibold text-inkSoft underline underline-offset-2 hover:text-ink"
                >
                  {voiceOpen ? "Show less" : "Show more"}
                </button>
              )}
            </>
          ) : voiceDraft && canEdit ? (
            <div className="rounded-xl border border-dashed border-rule px-3.5 py-3">
              <p className="text-[13px] text-inkMuted">{`Zavi drafted this from ${voiceDraft.from}:`}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink">{voiceDraft.value}</p>
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void useVoiceDraft()}
                  className="rounded-cta bg-ink px-3 py-1.5 text-sm font-medium text-cream disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Use this"}
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(voiceDraft.value)}
                  className="text-sm text-inkMuted underline underline-offset-2 hover:text-ink"
                >
                  Edit first
                </button>
                <button
                  type="button"
                  onClick={() => void dismissVoiceDraft()}
                  className="ml-auto text-sm text-inkMuted hover:text-ink"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-sm text-inkMuted">
                Not set yet. Describe how your company talks, and every agent writes that way.
              </p>
              {voiceDrafting && canEdit && (
                <p role="status" className="mt-1 text-xs text-inkMuted">
                  Zavi is reading your site to suggest one…
                </p>
              )}
            </>
          )}

          {kit && (
            <>
              <CardDivider />
              <SubLabel>Colours</SubLabel>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {COLOUR_FIELDS.map(([key, label]) =>
                  kit[key] ? (
                    <span key={key} className="flex items-center gap-2 text-sm text-inkMuted">
                      <span
                        aria-hidden="true"
                        className="h-7 w-7 rounded-md border border-rule"
                        style={{ background: kit[key] as string }}
                      />
                      <span className="font-mono text-xs">{kit[key]}</span>
                      <span className="sr-only">{label}</span>
                    </span>
                  ) : null,
                )}
                <span className="text-xs text-inkMuted">
                  {kit.source === "manual"
                    ? "Set by hand"
                    : kit.source === "scrape"
                      ? `Read from ${kit.source_url ? new URL(kit.source_url).hostname : "your site"}`
                      : "We could not read your site’s colours, so these are ours"}
                </span>
              </div>
            </>
          )}

          {(tone.length > 0 || neverSay.length > 0) && (
            <>
              <CardDivider />
              <div className="grid gap-4 compact:gap-3 sm:grid-cols-2">
                {tone.length > 0 && (
                  <div>
                    <SubLabel>Tone</SubLabel>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {tone.map((t) => (
                        <span key={t} className="rounded-full border border-rule px-3 py-1 text-sm text-ink">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {neverSay.length > 0 && (
                  <div>
                    <SubLabel>Never say</SubLabel>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {neverSay.map((w) => (
                        <span
                          key={w}
                          className="rounded-full border border-rule px-3 py-1 text-sm text-inkMuted line-through"
                        >
                          {w}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-warn dark:text-marigold">
          {error}
        </p>
      )}
    </>
  );

  const showEdit = canEdit && data !== null && !editing;
  if (variant === "personalization") {
    return (
      <Section
        id="brand-voice"
        title="Brand Voice"
        description="How your company sounds. Every agent writes in this voice on its next run - the same card as on the Growth page."
        updatedAt={data?.updated_at}
        aside={
          showEdit ? (
            <button type="button" onClick={() => startEdit()} aria-label="Edit brand voice" className={BTN_TEXT}>
              Edit
            </button>
          ) : undefined
        }
      >
        {body}
      </Section>
    );
  }

  const inUse = data?.brand_voice.trim()
    ? data.updated_by === null
      ? "drafted from your site \u00b7 in use"
      : "used by every agent"
    : undefined;

  if (variant === "memo") {
    const settled =
      loadError !== null || (!loading && kitSettled && (data === null || draft !== null) && (!wantsVoiceDraft || voiceDraftDone));
    return (
      <SettledSection
        ready={settled}
        holdOnRefresh={false}
        skeleton={<VoiceBars ariaLabel="Loading brand voice" />}
      >
      <div ref={rowRef}>
        <FactRow
          label="Brand voice"
          action={
            showEdit ? (
              <SectionAction onClick={() => startEdit()} label="Edit brand voice">
                Edit
              </SectionAction>
            ) : undefined
          }
        >
          {body}
          {inUse && !editing && <p className="mt-2 text-[13px] text-inkMuted">{inUse}</p>}
        </FactRow>
      </div>
      </SettledSection>
    );
  }

  return (
    <GrowthSection
      title="Brand Voice"
      count={inUse}
      action={
        showEdit ? (
          <SectionAction onClick={() => startEdit()} label="Edit brand voice">
            Edit
          </SectionAction>
        ) : undefined
      }
    >
      {body}
    </GrowthSection>
  );
}
