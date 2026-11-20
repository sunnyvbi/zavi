"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  Type,
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Trash2,
  Undo2,
  Redo2,
  X,
  Minus,
  Plus,
  Baseline,
  PaintBucket,
  Eraser,
  Link2,
  Image as ImageIcon,
  GripVertical,
  Loader2,
  PenLine,
  ChevronDown,
  Send,
} from "lucide-react";
import type { EditPatch, EditStyle, SelectedElement } from "./editorProtocol";
import { SITE_CHANGE_STARTED, SITE_CHANGE_USE_CHAT, SiteChangeOffer, type SiteChangeResult } from "./websiteChatEdit";

const FONT_FAMILIES: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Default", value: "" },
  { label: "Sans (Jakarta)", value: "'Plus Jakarta Sans', sans-serif" },
  { label: "Inter", value: "Inter, sans-serif" },
  { label: "System", value: "system-ui, sans-serif" },
  { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
  { label: "Mono", value: "'Courier New', monospace" },
];

export function parseFontSizePx(v: string | undefined): number {
  if (!v) return 16;
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n) : 16;
}

export function toHexColor(v: string | undefined): string {
  if (!v) return "#000000";
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
  }
  return "#000000";
}

export function WebsiteEditorToolbar({
  selected,
  canUndo,
  canRedo,
  onApply,
  onDelete,
  onUndo,
  onRedo,
  onClose,
  onAskAi,
  onRequestSiteChange,
  onHandlePointerDown,
  designControls,
  imageUrlField = true,
  onDraftChange,
  notice,
  draftResetKey = 0,
  draftAppliedKey = 0,
  onBeforeAskAi,
}: {
  selected: SelectedElement;
  canUndo: boolean;
  canRedo: boolean;
  onApply: (patch: EditPatch) => void;
  onDelete: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onClose: () => void;
  onAskAi?: (message: string) => Promise<void>;
  onRequestSiteChange?: (request: string) => Promise<SiteChangeResult>;
  onHandlePointerDown?: (e: ReactPointerEvent) => void;
  designControls?: ReactNode;
  imageUrlField?: boolean;
  onDraftChange?: (patch: EditPatch | null) => void;
  notice?: ReactNode;
  draftResetKey?: number;
  draftAppliedKey?: number;
  onBeforeAskAi?: (go: () => void) => void;
}) {
  const style = selected.style;
  const [text, setText] = useState(selected.text);
  const curHref = selected.attrs?.href ?? "";
  const curSrc = selected.attrs?.src ?? "";
  const [href, setHref] = useState(curHref);
  const [src, setSrc] = useState(curSrc);

  useEffect(() => {
    setText(selected.text);
  }, [selected.selector, selected.text]);
  useEffect(() => {
    setHref(curHref);
    setSrc(curSrc);
  }, [selected.selector, curHref, curSrc]);

  const [ai, setAi] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [offer, setOffer] = useState<SiteChangeOffer | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [aiMode, setAiMode] = useState(false);
  const [showDesign, setShowDesign] = useState(false);
  const [designOpened, setDesignOpened] = useState(false);
  const askGen = useRef(0);
  useEffect(() => {
    askGen.current += 1;
    setAiMode(false);
    setShowDesign(false);
    setDesignOpened(false);
    setOffer(null);
    setAiNote(null);
    setAiBusy(false);
    setAiErr(null);
    setAi("");
    return () => {
      askGen.current += 1;
    };
  }, [selected.selector]);
  const submitAi = async () => {
    const msg = ai.trim();
    if (!msg || !onAskAi || aiBusy) return;
    setAiBusy(true);
    setAiErr(null);
    setOffer(null);
    setAiNote(null);
    const gen = askGen.current;
    try {
      await onAskAi(msg);
      if (gen === askGen.current) setAi("");
    } catch (e) {
      if (gen !== askGen.current) return;
      if (e instanceof SiteChangeOffer) {
        setOffer(e);
        return;
      }
      const reason = e instanceof Error ? e.message.trim() : "";
      setAiErr(reason || "Couldn't do that. Try again");
    } finally {
      if (gen === askGen.current) setAiBusy(false);
    }
  };
  const startSiteChange = async () => {
    if (!offer || !onRequestSiteChange || aiBusy) return;
    setAiBusy(true);
    setAiErr(null);
    const gen = askGen.current;
    try {
      const result = await onRequestSiteChange(offer.request);
      if (gen !== askGen.current) return;
      if (result.ok) {
        setOffer(null);
        setAi("");
        setAiNote(result.held ?? SITE_CHANGE_STARTED);
      } else {
        setAiErr(result.message || "Couldn't start that change. Try again.");
      }
    } catch {
      if (gen === askGen.current) setAiErr("Couldn't start that change. Try again.");
    } finally {
      if (gen === askGen.current) setAiBusy(false);
    }
  };

  const applyStyle = (patch: EditStyle) => onApply({ style: patch });
  const size = parseFontSizePx(style.fontSize);
  const isBold = style.fontWeight === "700" || style.fontWeight === "bold";
  const isItalic = style.fontStyle === "italic";
  const isUnderline = (style.textDecoration ?? "").includes("underline");
  const textDirty = selected.textEditable && text !== selected.text;
  const hrefDirty = selected.tag === "a" && href !== curHref;
  const srcDirty = selected.tag === "img" && src !== curSrc;
  const dirty = textDirty || hrefDirty || srcDirty;
  const attrs = { ...(hrefDirty ? { href } : {}), ...(srcDirty ? { src } : {}) };
  const typed: EditPatch | null = dirty ? { ...(textDirty ? { text } : {}), ...(hrefDirty || srcDirty ? { attrs } : {}) } : null;
  const [appliedKey, setAppliedKey] = useState("");
  useEffect(() => setAppliedKey(""), [selected.selector, selected.text, curHref, curSrc]);
  useEffect(() => {
    if (draftResetKey === 0) return;
    setText(selected.text);
    setHref(curHref);
    setSrc(curSrc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftResetKey]);
  const typedKey = typed ? JSON.stringify(typed) : "";
  useEffect(() => {
    if (draftAppliedKey !== 0) setAppliedKey(typedKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftAppliedKey]);
  const draftKey = typedKey && typedKey !== appliedKey ? typedKey : "";
  const draft: EditPatch | null = draftKey ? typed : null;
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  useEffect(() => {
    onDraftChangeRef.current?.(draftKey ? (JSON.parse(draftKey) as EditPatch) : null);
  }, [draftKey]);
  useEffect(() => () => onDraftChangeRef.current?.(null), []);
  const applyTyped = () => {
    if (!draft) return;
    setAppliedKey(draftKey);
    onApply(draft);
  };
  const fieldKeys = (reset: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyTyped();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      reset();
    }
  };

  const aiOpen = aiMode && !!onAskAi;
  const card = "rounded-xl border border-rule bg-cream shadow-[0_8px_24px_-10px_rgba(14,15,17,0.35)]";
  const modeBtn =
    "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-inkMuted transition-colors hover:bg-bone hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30";

  return (
    <div data-testid="editor-toolbar" className="pointer-events-auto flex max-w-full flex-col items-start gap-1.5">
      <div data-testid="editor-toolbar-tools" className={`flex min-h-11 max-w-full items-start gap-1 p-1 ${card}`}>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {onHandlePointerDown && (
            <span
              onPointerDown={onHandlePointerDown}
              title="Drag to move"
              aria-label="Drag toolbar"
              role="button"
              className="flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-inkLight hover:bg-bone hover:text-inkMuted active:cursor-grabbing"
            >
              <GripVertical className="h-4 w-4" />
            </span>
          )}
          {onAskAi && !aiOpen && (
            <button
              type="button"
              data-testid="editor-toolbar-mode"
              onClick={() => (draft && onBeforeAskAi ? onBeforeAskAi(() => setAiMode(true)) : setAiMode(true))}
              className={modeBtn}
            >
              <PenLine className="h-4 w-4" />
              Edit Element
            </button>
          )}
          {aiOpen ? (
            <div
              className={`flex h-9 w-[min(520px,70vw)] min-w-0 items-center gap-1 rounded-lg border pl-2.5 pr-0.5 ${
                aiErr ? "border-[#cb2029]" : "border-rule"
              }`}
            >
              <input
                autoFocus
                value={ai}
                onChange={(e) => {
                  setAi(e.target.value);
                  if (aiErr) setAiErr(null);
                  if (offer) setOffer(null);
                  if (aiNote) setAiNote(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitAi();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setAiMode(false);
                  }
                }}
                placeholder="What to change?"
                aria-label="Ask AI to change this element"
                disabled={aiBusy}
                className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-inkLight disabled:opacity-60"
              />
              {aiErr && (
                <span role="alert" title={aiErr} className="max-w-[200px] shrink truncate text-[11px] text-[#cb2029]">
                  {aiErr}
                </span>
              )}
              <button
                type="button"
                onClick={() => void submitAi()}
                disabled={aiBusy || !ai.trim()}
                title="Send"
                aria-label="Send"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ink text-cream transition-colors hover:bg-ink/85 disabled:cursor-not-allowed disabled:bg-bone disabled:text-inkLight"
              >
                {aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </div>
          ) : (
            <div className="contents">
      {}
      {selected.textEditable && (
        <>
          <div className="flex items-center gap-1 rounded-lg border border-rule px-2">
            <Type className="h-3.5 w-3.5 text-inkLight" />
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={fieldKeys(() => setText(selected.text))}
              placeholder="Text…"
              aria-label="Element text"
              className="h-7 w-32 bg-transparent text-[12px] text-ink outline-none placeholder:text-inkLight"
            />
          </div>

          <Divider />
        </>
      )}

      {}
      {selected.tag === "a" && (
        <>
          <div className="flex items-center gap-1 rounded-lg border border-rule px-2">
            <Link2 className="h-3.5 w-3.5 text-inkLight" />
            <input
              value={href}
              onChange={(e) => setHref(e.target.value)}
              onKeyDown={fieldKeys(() => setHref(curHref))}
              placeholder="https://…"
              aria-label="Link URL"
              className="h-7 w-40 bg-transparent text-[12px] text-ink outline-none placeholder:text-inkLight"
            />
          </div>
          <Divider />
        </>
      )}

      {}
      {selected.tag === "img" && imageUrlField && (
        <>
          <div className="flex items-center gap-1 rounded-lg border border-rule px-2">
            <ImageIcon className="h-3.5 w-3.5 text-inkLight" />
            <input
              value={src}
              onChange={(e) => setSrc(e.target.value)}
              onKeyDown={fieldKeys(() => setSrc(curSrc))}
              placeholder="https://…/image.png"
              aria-label="Image URL"
              className="h-7 w-40 bg-transparent text-[12px] text-ink outline-none placeholder:text-inkLight"
            />
          </div>
          <Divider />
        </>
      )}

      <span className="relative inline-flex items-center">
        <select
          aria-label="Font"
          value={style.fontFamily ?? ""}
          onChange={(e) => applyStyle({ fontFamily: e.target.value })}
          className="h-7 appearance-none rounded-lg border border-rule bg-cream pl-2 pr-7 text-[12px] text-ink outline-none"
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f.label} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-inkMuted" />
      </span>

      {}
      <div className="flex items-center rounded-lg border border-rule">
        <IconBtn label="Smaller" onClick={() => applyStyle({ fontSize: `${Math.max(8, size - 1)}px` })}>
          <Minus className="h-3.5 w-3.5" />
        </IconBtn>
        <span className="w-7 text-center text-[12px] tabular-nums text-ink">{size}</span>
        <IconBtn label="Larger" onClick={() => applyStyle({ fontSize: `${Math.min(200, size + 1)}px` })}>
          <Plus className="h-3.5 w-3.5" />
        </IconBtn>
      </div>

      <Divider />

      {}
      <ToggleBtn active={isBold} label="Bold" onClick={() => applyStyle({ fontWeight: isBold ? "400" : "700" })}>
        <Bold className="h-4 w-4" />
      </ToggleBtn>
      <ToggleBtn active={isItalic} label="Italic" onClick={() => applyStyle({ fontStyle: isItalic ? "normal" : "italic" })}>
        <Italic className="h-4 w-4" />
      </ToggleBtn>
      <ToggleBtn
        active={isUnderline}
        label="Underline"
        onClick={() => applyStyle({ textDecoration: isUnderline ? "none" : "underline" })}
      >
        <Underline className="h-4 w-4" />
      </ToggleBtn>

      <Divider />

      {}
      <ToggleBtn active={style.textAlign === "left"} label="Align left" onClick={() => applyStyle({ textAlign: "left" })}>
        <AlignLeft className="h-4 w-4" />
      </ToggleBtn>
      <ToggleBtn active={style.textAlign === "center"} label="Align center" onClick={() => applyStyle({ textAlign: "center" })}>
        <AlignCenter className="h-4 w-4" />
      </ToggleBtn>
      <ToggleBtn active={style.textAlign === "right"} label="Align right" onClick={() => applyStyle({ textAlign: "right" })}>
        <AlignRight className="h-4 w-4" />
      </ToggleBtn>

      <Divider />

      {}
      <label className="flex h-8 cursor-pointer items-center gap-1 rounded-lg px-1.5 hover:bg-bone" title="Text color">
        <Baseline className="h-4 w-4 text-inkSoft" />
        <span
          className="h-4 w-4 rounded-full border border-rule"
          style={{ backgroundColor: toHexColor(style.color) }}
        />
        <input
          type="color"
          aria-label="Text color"
          value={toHexColor(style.color)}
          onChange={(e) => applyStyle({ color: e.target.value })}
          className="h-0 w-0 opacity-0"
        />
      </label>

      {}
      <label
        className="flex h-8 cursor-pointer items-center gap-1 rounded-lg px-1.5 hover:bg-bone"
        title="Background color"
      >
        <PaintBucket className="h-4 w-4 text-inkSoft" />
        <span
          className="h-4 w-4 rounded-full border border-rule"
          style={{ backgroundColor: toHexColor(style.backgroundColor) }}
        />
        <input
          type="color"
          aria-label="Background color"
          value={toHexColor(style.backgroundColor)}
          onChange={(e) => applyStyle({ backgroundColor: e.target.value })}
          className="h-0 w-0 opacity-0"
        />
      </label>
      <IconBtn label="Clear background" onClick={() => applyStyle({ backgroundColor: "transparent" })}>
        <Eraser className="h-3.5 w-3.5" />
      </IconBtn>

      <Divider />

      {}
      <IconBtn label="Undo" disabled={!canUndo} onClick={onUndo}>
        <Undo2 className="h-4 w-4" />
      </IconBtn>
      <IconBtn label="Redo" disabled={!canRedo} onClick={onRedo}>
        <Redo2 className="h-4 w-4" />
      </IconBtn>
      <IconBtn label="Delete element" onClick={onDelete}>
        <Trash2 className="h-4 w-4 text-[#cb2029]" />
      </IconBtn>
      {designControls && (
        <button type="button" aria-expanded={showDesign} onClick={() => { setDesignOpened(true); setShowDesign((open) => !open); }} className={modeBtn}>
          Design options
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
      {draft && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={applyTyped}
          className="inline-flex h-9 shrink-0 items-center rounded-lg bg-ink px-3 text-[12px] font-semibold text-cream transition-colors hover:bg-ink/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          Apply
        </button>
      )}
            </div>
          )}
        </div>
          {aiOpen ? (
            <IconBtn label="Back to tools" onClick={() => setAiMode(false)}>
              <X className="h-4 w-4" />
            </IconBtn>
          ) : (
            <IconBtn label="Done" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconBtn>
          )}
      </div>

      {designOpened && designControls && (
        <div hidden={!showDesign || aiOpen} className={`max-h-[min(420px,60vh)] max-w-full overflow-auto p-3 ${card}`}>{designControls}</div>
      )}
      {(offer || aiNote) && (
        <div role="status" className={`flex max-w-[480px] flex-wrap items-center gap-2 px-3 py-2 text-[12px] leading-5 text-inkSoft ${card}`}>
          <span className="min-w-0 flex-1">
            {offer ? (onRequestSiteChange ? offer.message : `${offer.message} ${SITE_CHANGE_USE_CHAT}`) : aiNote}
          </span>
          {offer && onRequestSiteChange && (
            <button
              type="button"
              onClick={() => void startSiteChange()}
              disabled={aiBusy}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-ink px-3 text-[12px] font-semibold text-cream transition-colors hover:bg-ink/85 disabled:opacity-60"
            >
              {aiBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Make this change
            </button>
          )}
        </div>
      )}
      {notice}
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px bg-bone" />;
}

function IconBtn({
  children,
  onClick,
  label,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-cta text-inkSoft transition-colors hover:bg-bone hover:text-ink disabled:cursor-not-allowed disabled:text-inkLight disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function ToggleBtn({
  children,
  onClick,
  label,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  active: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-cta transition-colors ${
        active ? "bg-ink text-cream" : "text-inkSoft hover:bg-bone hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
