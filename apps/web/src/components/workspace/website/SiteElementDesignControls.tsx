"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Brush, Check, ImagePlus, LayoutTemplate, Link2, Loader2, Wand2 } from "lucide-react";
import type { SelectedElement } from "./editorProtocol";
import { CreditRefusalNotice } from "../CreditRefusalNotice";
import { PhotoMaskPainter } from "./PhotoMaskPainter";
import { creditRefusalFrom, type CreditRefusal } from "@/lib/workspace/creditRefusal";
import {
  SITE_DESIGN_SAVED,
  TONE_LABEL,
  layoutLabel,
  loadSiteDesignEdit,
  loadSitePhoto,
  saveSiteDesignEdit,
  type SiteDesignOp,
  type SitePhotoPreview,
  type SiteSectionInfo,
} from "@/lib/workspace/siteDesignEdit";

const SITE_IMAGE_SRC = /^\/images\/[^/?#]+$/;

type Note = { ok: boolean; text: string } | null;

export function isSitePhoto(selected: Pick<SelectedElement, "tag" | "attrs">): boolean {
  return selected.tag === "img" && SITE_IMAGE_SRC.test(selected.attrs?.src ?? "");
}

export function SiteElementDesignControls({
  appId,
  path,
  selected,
  onSectionChanged,
}: {
  appId: string;
  path: string;
  selected: SelectedElement;
  onSectionChanged?: (message: string) => void;
}) {
  const sectionId = selected.section ?? null;
  const [swapped, setSwapped] = useState<string | null>(null);
  const photo = isSitePhoto(selected) ? (swapped ?? selected.attrs!.src!) : null;
  const hasPhoto = photo !== null;
  const [section, setSection] = useState<SiteSectionInfo | null>(null);
  const [sectionMessage, setSectionMessage] = useState<string | null>(null);
  const [imageAi, setImageAi] = useState(false);
  const [imageMask, setImageMask] = useState(false);
  const [painting, setPainting] = useState<SitePhotoPreview | "loading" | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [refusal, setRefusal] = useState<CreditRefusal | null>(null);
  const [prompt, setPrompt] = useState("");
  const [link, setLink] = useState("");
  const gen = useRef(0);
  useEffect(() => () => { gen.current += 1; }, []);

  useEffect(() => {
    gen.current += 1;
    const mine = gen.current;
    setSection(null);
    setSectionMessage(null);
    setNote(null);
    setRefusal(null);
    setPrompt("");
    setLink("");
    setBusy(null);
    setSwapped(null);
    setPainting(null);
    if (!sectionId && !hasPhoto) return;
    setLoading(true);
    void loadSiteDesignEdit(appId, { section: sectionId, path }).then((r) => {
      if (mine !== gen.current) return;
      setLoading(false);
      if (!r.ok) {
        setSectionMessage(r.message);
        return;
      }
      setSection(r.state.section);
      setSectionMessage(r.state.section_message);
      setImageAi(r.state.image_ai);
      setImageMask(r.state.image_ai_mask);
    });
  }, [appId, path, sectionId, hasPhoto, selected.selector]);

  const run = useCallback(
    async (key: string, op: SiteDesignOp, ok?: (r: Extract<Awaited<ReturnType<typeof saveSiteDesignEdit>>, { ok: true }>) => string) => {
      if (busy) return;
      const mine = gen.current;
      setBusy(key);
      setNote(null);
      setRefusal(null);
      const r = await saveSiteDesignEdit(appId, op, path);
      if (mine !== gen.current) return;
      setBusy(null);
      if (!r.ok) {
        const card = op.kind === "image" ? creditRefusalFrom({ error: { code: r.code } }, "photo") : null;
        if (card) setRefusal(card);
        else setNote({ ok: false, text: r.message });
        return;
      }
      if (r.image) {
        setSwapped(r.image.src);
        setPainting(null);
      }
      const text = ok ? ok(r) : SITE_DESIGN_SAVED;
      if (op.kind === "section" && onSectionChanged) {
        onSectionChanged(text);
        return;
      }
      if (r.section) setSection(r.section);
      setNote({ ok: true, text });
    },
    [appId, path, busy, onSectionChanged],
  );

  const openPainter = useCallback(
    async (src: string) => {
      if (busy || painting) return;
      const mine = gen.current;
      setPainting("loading");
      setNote(null);
      setRefusal(null);
      const r = await loadSitePhoto(appId, src);
      if (mine !== gen.current) return;
      if (!r.ok) {
        setPainting(null);
        setNote({ ok: false, text: r.message });
        return;
      }
      setPainting(r.photo);
    },
    [appId, busy, painting],
  );

  if (!sectionId && !photo) return null;

  const imageOk = (r: { image: { places: number } | null }) =>
    r.image && r.image.places > 1 ? `Swapped in ${r.image.places} places. ${SITE_DESIGN_SAVED}` : SITE_DESIGN_SAVED;
  const describe = prompt.replace(/\s+/g, " ").trim();
  const linkOk = /^https:\/\/\S{4,}$/i.test(link.trim());

  return (
    <div className="flex basis-full flex-col gap-2 border-t border-[#f0f0f0] px-2 pb-1 pt-2 text-[12px] leading-5 text-[#454545]">
      {loading && (
        <span role="status" className="inline-flex items-center gap-1.5 text-[#8c8c8c]">
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          Loading design options…
        </span>
      )}

      {sectionId && !loading && section && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Section">
          <LayoutTemplate className="h-3.5 w-3.5 text-[#8c8c8c]" aria-hidden />
          <span className="font-medium text-[#0e0f11]">{layoutLabel(section.component)} section</span>
          {section.variants.length > 0 && (
            <select
              aria-label="Section layout"
              value={section.variant ?? ""}
              disabled={!!busy}
              onChange={(e) => e.target.value && void run("layout", { kind: "section", section_id: section.id, variant: e.target.value })}
              className="h-7 rounded-lg border border-[#f0f0f0] bg-white px-1.5 text-[12px] text-[#0e0f11] outline-none disabled:opacity-60"
            >
              {!section.variant && <option value="">Layout…</option>}
              {section.variants.map((v) => (
                <option key={v} value={v}>
                  {layoutLabel(v)}
                </option>
              ))}
            </select>
          )}
          {section.tones.length > 0 && (
            <select
              aria-label="Section background"
              value={section.tone ?? ""}
              disabled={!!busy}
              onChange={(e) => e.target.value && void run("tone", { kind: "section", section_id: section.id, tone: e.target.value })}
              className="h-7 rounded-lg border border-[#f0f0f0] bg-white px-1.5 text-[12px] text-[#0e0f11] outline-none disabled:opacity-60"
            >
              {!section.tone && <option value="">Background…</option>}
              {section.tones.map((t) => (
                <option key={t} value={t}>
                  {TONE_LABEL[t] ?? layoutLabel(t)}
                </option>
              ))}
            </select>
          )}
          <SmallBtn
            label="Move section up"
            disabled={!section.can_move_up || !!busy}
            busy={busy === "up"}
            onClick={() => void run("up", { kind: "section", section_id: section.id, move: "up" })}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </SmallBtn>
          <SmallBtn
            label="Move section down"
            disabled={!section.can_move_down || !!busy}
            busy={busy === "down"}
            onClick={() => void run("down", { kind: "section", section_id: section.id, move: "down" })}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </SmallBtn>
          {(busy === "layout" || busy === "tone") && <Loader2 className="h-3.5 w-3.5 animate-spin text-[#8c8c8c] motion-reduce:animate-none" aria-hidden />}
        </div>
      )}
      {sectionId && !loading && !section && sectionMessage && <span className="text-[#8c8c8c]">{sectionMessage}</span>}

      {photo && !loading && (
        <div className="flex flex-col gap-1.5" aria-label="Photo">
          {imageAi && (
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-[#f0f0f0] px-2">
                <Wand2 className="h-3.5 w-3.5 shrink-0 text-[#8c8c8c]" aria-hidden />
                <input
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    setNote(null);
                    setRefusal(null);
                  }}
                  maxLength={600}
                  disabled={!!busy}
                  placeholder="Describe the photo you want, or what to change…"
                  aria-label="Describe the photo"
                  className="h-7 min-w-[160px] flex-1 bg-transparent text-[12px] text-[#0e0f11] outline-none placeholder:text-[#b0b0b0] disabled:opacity-60"
                />
              </div>
              <PillBtn
                disabled={describe.length < 3 || !!busy}
                busy={busy === "generate"}
                onClick={() => void run("generate", { kind: "image", src: photo, mode: "generate", text: describe }, imageOk)}
              >
                <ImagePlus className="h-3.5 w-3.5" aria-hidden />
                New photo
              </PillBtn>
              <PillBtn
                disabled={describe.length < 3 || !!busy}
                busy={busy === "edit"}
                onClick={() => void run("edit", { kind: "image", src: photo, mode: "edit", text: describe }, imageOk)}
              >
                <Wand2 className="h-3.5 w-3.5" aria-hidden />
                Change this photo
              </PillBtn>
              {imageMask && (
                <PillBtn disabled={!!busy || painting !== null} busy={painting === "loading"} onClick={() => void openPainter(photo)}>
                  <Brush className="h-3.5 w-3.5" aria-hidden />
                  Change part of this photo
                </PillBtn>
              )}
            </div>
          )}
          {imageAi && imageMask && painting && painting !== "loading" && (
            <PhotoMaskPainter
              photo={painting}
              busy={busy === "mask"}
              canApply={describe.length >= 3 && !busy}
              onCancel={() => setPainting(null)}
              onApply={(mask) => void run("mask", { kind: "image", src: photo, mode: "edit", text: describe, mask }, imageOk)}
            />
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-[#f0f0f0] px-2">
              <Link2 className="h-3.5 w-3.5 shrink-0 text-[#8c8c8c]" aria-hidden />
              <input
                value={link}
                onChange={(e) => {
                  setLink(e.target.value);
                  setNote(null);
                }}
                disabled={!!busy}
                placeholder="https://… photo address"
                aria-label="Photo address"
                className="h-7 min-w-[160px] flex-1 bg-transparent text-[12px] text-[#0e0f11] outline-none placeholder:text-[#b0b0b0] disabled:opacity-60"
              />
            </div>
            <PillBtn
              disabled={!linkOk || !!busy}
              busy={busy === "url"}
              onClick={() => void run("url", { kind: "image", src: photo, mode: "url", text: link.trim() }, imageOk)}
            >
              Use this photo
            </PillBtn>
          </div>
          {imageAi && !busy && <span className="text-[#8c8c8c]">AI photos use credits. A photo from a link is free.</span>}
          {(busy === "generate" || busy === "edit" || busy === "mask") && (
            <span role="status" className="text-[#8c8c8c]">
              Making the photo. This can take up to a minute.
            </span>
          )}
          {refusal && <CreditRefusalNotice refusal={refusal} />}
        </div>
      )}

      {note && (
        <span role={note.ok ? "status" : "alert"} className={`inline-flex items-start gap-1.5 ${note.ok ? "" : "text-[#cb2029]"}`}>
          {note.ok && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
          {note.text}
        </span>
      )}
    </div>
  );
}

function SmallBtn({ children, label, onClick, disabled, busy }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-[#f0f0f0] text-[#454545] hover:bg-[#f4f4f4] disabled:cursor-not-allowed disabled:text-[#cfcfcf] disabled:hover:bg-transparent"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : children}
    </button>
  );
}

function PillBtn({ children, onClick, disabled, busy }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-[#0e0f11] px-3 text-[12px] font-semibold text-white hover:bg-[#0e0f11]/85 disabled:opacity-50"
    >
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
      {children}
    </button>
  );
}
