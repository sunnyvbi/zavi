"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";
import { readSitePreview, readSiteLayout, type SiteDesignLayout, type SiteDesignPreview } from "./useSiteDesign";

export type SiteTemplateCard = {
  id: string;
  label: string;
  blurb: string;
  good_for: string;
  idea: string;
  layout: SiteDesignLayout;
  fonts: { display: string; body: string };
  theme_css: string;
  preview: SiteDesignPreview;
};

export type PickedTemplate = { id: string; label: string; idea: string };

const ID = /^[a-z][a-z0-9-]{1,40}$/;
const THEME_CSS_MAX = 64_000;

function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

export function readSiteTemplates(raw: unknown): SiteTemplateCard[] {
  const list = (raw as { templates?: unknown } | null)?.templates;
  if (!Array.isArray(list)) return [];
  const out: SiteTemplateCard[] = [];
  for (const item of list.slice(0, 24)) {
    const t = (item ?? {}) as Record<string, unknown>;
    const id = typeof t.id === "string" && ID.test(t.id) ? t.id : null;
    const label = text(t.label, 60);
    const idea = text(t.idea, 400);
    const preview = readSitePreview(t.preview);
    const fonts = t.fonts as { display?: unknown; body?: unknown } | undefined;
    const css = typeof t.theme_css === "string" && t.theme_css.length <= THEME_CSS_MAX ? t.theme_css : null;
    if (!id || !label || !idea || !preview || !css || typeof fonts?.display !== "string" || typeof fonts?.body !== "string") continue;
    out.push({
      id,
      label,
      blurb: text(t.blurb, 160) ?? "",
      good_for: text(t.good_for, 160) ?? "",
      idea,
      layout: readSiteLayout(t.layout),
      fonts: { display: fonts.display, body: fonts.body },
      theme_css: css,
      preview,
    });
  }
  return out;
}

export function unfilledBlanks(idea: string, template: PickedTemplate | null): string[] {
  return template ? templateBlanks(idea) : [];
}

const BLANK = /\[[^\[\]\n]{1,60}\]/g;
const BLANK_PART = /^\[[^\[\]\n]{1,60}\]$/;

export function templateBlanks(idea: string): string[] {
  return [...new Set(idea.match(BLANK) ?? [])];
}

export function ideaParts(idea: string): Array<{ text: string; blank: boolean }> {
  return idea
    .split(/(\[[^\[\]\n]{1,60}\])/)
    .filter((text) => text.length > 0)
    .map((text) => ({ text, blank: BLANK_PART.test(text) }));
}

export const ANSWER_MAX = 120;

export function cleanAnswer(raw: string): string {
  return raw.replace(/[\[\]\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, ANSWER_MAX).trim();
}

export function fillTemplateIdea(idea: string, answers: Readonly<Record<string, string>>): string {
  return idea.replace(BLANK, (blank) => cleanAnswer(answers[blank] ?? "") || blank);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function blankLabel(blank: string): string {
  return blank.replace(/^\[|\]$/g, "").trim();
}

export function blankQuestion(blank: string): string {
  const b = blankLabel(blank);
  const low = b.toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^(who|what) you (\S+)(.*)$/i.exec(b))) return `${cap(m[1]!.toLowerCase())} do you ${m[2]}${m[3]}?`;
  if ((m = /^(who|what) it is(.*)$/i.exec(b))) return `${cap(m[1]!.toLowerCase())} is it${m[2]}?`;
  if (/^(who|what|where|when|which|how)\b/i.test(b)) return `${cap(b)}?`;
  if (low === "address") return "What is the address?";
  if (/^(town|city|place|area|location|neighbou?rhood|country|region)\b/i.test(b)) return `Which ${b} is it in?`;
  if (/\bname\b/i.test(b)) return `What is the ${b}?`;
  if (b.includes(",") && / or /i.test(b)) return `Which is it: ${b}?`;
  if (/^(kind|type|sort) of /i.test(b)) return `What ${b} is it?`;
  if (/ and /i.test(b) || (/s$/i.test(b) && !/ss$/i.test(b))) return `What are your ${b}?`;
  return `What is your ${b}?`;
}

export function blanksHint(blanks: readonly string[]): string {
  return `Fill in ${blanks.length === 1 ? "the part" : "the parts"} in brackets first: ${blanks.join(", ")}.`;
}

let cached: SiteTemplateCard[] | null = null;
let inflight: Promise<SiteTemplateCard[]> | null = null;

async function load(): Promise<SiteTemplateCard[]> {
  if (cached) return cached;
  inflight ??= fetch(apiUrl("/api/public/site-templates"))
    .then(async (res) => {
      if (!res.ok) throw new Error(`templates ${res.status}`);
      const list = readSiteTemplates(await res.json());
      if (list.length === 0) throw new Error("templates empty");
      cached = list;
      return list;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function resetSiteTemplatesCache() {
  cached = null;
  inflight = null;
}

export type SiteTemplatesState = { templates: SiteTemplateCard[] | null; failed: boolean; retry: () => void };

export function useSiteTemplates(enabled: boolean): SiteTemplatesState {
  const [templates, setTemplates] = useState<SiteTemplateCard[] | null>(cached);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || templates) return;
    let live = true;
    setFailed(false);
    load().then(
      (list) => live && setTemplates(list),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [enabled, templates, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { templates, failed, retry };
}
