"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MutableRefObject, type ReactNode, type Ref } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { Loader2, X } from "lucide-react";
import { ZaviMascot } from "@/components/ZaviMascot";
import { MicButton } from "@/components/voice/MicButton";
import { appendDictatedText } from "@/lib/voice/useDictation";
import { ApiError } from "@/lib/workspace/channelActionsApi";
import { creditRefusalFrom } from "@/lib/workspace/creditRefusal";
import { cx, FOCUS_RING } from "../layout/shared";
import { GenerateIcon, ImageAddIcon, ImageIcon, MicIcon, ScriptIcon, UndoIcon } from "./libraryIcons";
import { TopUp } from "./TopUp";
import { STUDIO_IMAGE_TYPES } from "./types";

export type StudioMode = "script" | "image";

export type HeroAttachment = { preview: string | null; path: string | null };

export type HeroEditing = { title: string; ready?: boolean; onClear?: () => void };

export const REVISIONS = [
  { label: "Make it shorter", line: "Make it shorter" },
  { label: "Different presenter", line: "Use a different presenter" },
] as const;

const MIN_SCRIPT_CHARS = 3;
const MIN_SCRIPT_WORDS = 6;
const MAX_SCRIPT_WORDS = 150;

export function scriptWordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
const TYPE_MS = 45;
const WRITE_FAILED = "The script could not be written. Try again.";
const ELEVATION_2 = "shadow-[0px_2px_4px_-1px_rgba(0,0,0,0.06),0px_6px_16px_-4px_rgba(0,0,0,0.1)]";
const CHIP = "inline-flex min-h-9 items-center rounded-full border border-rule bg-cream px-3.5 py-1.5 text-left text-[14px] font-semibold leading-5 text-ink transition-colors duration-[120ms] hover:bg-bone";

export function StudioHero({
  text,
  setText,
  sending,
  attachment,
  attachError,
  onAttach,
  onRemoveAttachment,
  onSubmit,
  onWriteScript,
  onLoadPrompt,
  inputRef,
  promptOn: promptOnProp,
  onPromptOnChange,
  editing = null,
  listBelow = false,
}: {
  text: string;
  setText: (t: string) => void;
  sending: boolean;
  attachment: HeroAttachment | null;
  attachError: string | null;
  onAttach?: (file: File) => void;
  onRemoveAttachment: () => void;
  onSubmit: (opts: { verbatim: boolean; revise?: boolean }) => void;
  onWriteScript?: (prompt: string) => Promise<string>;
  onLoadPrompt?: () => Promise<string>;
  inputRef?: Ref<HTMLTextAreaElement>;
  promptOn?: boolean;
  onPromptOnChange?: (on: boolean) => void;
  editing?: HeroEditing | null;
  listBelow?: boolean;
}) {
  const id = useId();
  const [mode, setMode] = useState<StudioMode>(attachment ? "image" : "script");
  const modeNow = useRef(mode);
  modeNow.current = mode;
  const [promptOnState, setPromptOnState] = useState(false);
  const promptOn = promptOnProp ?? promptOnState;
  const setPromptOn = (on: boolean) => {
    setPromptOnState(on);
    onPromptOnChange?.(on);
  };
  const filled = useRef<string | null>(null);
  const toggleSeq = useRef(0);
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [writing, setWriting] = useState(false);
  const [undoText, setUndoText] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const typer = useRef<number | null>(null);
  const alive = useRef(true);
  const modeText = useRef<Record<StudioMode, string>>({ script: "", image: "" });
  const pendingUndo = useRef<Partial<Record<StudioMode, string>>>({});
  const latestText = useRef(text);
  latestText.current = text;
  const box = useRef<HTMLTextAreaElement | null>(null);
  const setBox = useCallback(
    (el: HTMLTextAreaElement | null) => {
      box.current = el;
      if (typeof inputRef === "function") inputRef(el);
      else if (inputRef) (inputRef as MutableRefObject<HTMLTextAreaElement | null>).current = el;
    },
    [inputRef],
  );
  const focusBox = () => box.current?.focus();
  const stopTyping = () => {
    if (typer.current === null) return;
    window.clearInterval(typer.current);
    typer.current = null;
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (typer.current !== null) window.clearInterval(typer.current);
    };
  }, []);

  const togglePrompt = async () => {
    const seq = ++toggleSeq.current;
    setPromptError(null);
    if (promptOn) {
      setPromptOn(false);
      setLoadingPrompt(false);
      if (filled.current !== null && text === filled.current) setText("");
      filled.current = null;
      return;
    }
    setPromptOn(true);
    if (!onLoadPrompt || text.trim()) return;
    setLoadingPrompt(true);
    try {
      const prompt = await onLoadPrompt();
      if (seq !== toggleSeq.current) return;
      filled.current = prompt;
      setText(prompt);
    } catch {
      if (seq === toggleSeq.current) {
        setPromptOn(false);
        setPromptError("Zavi could not write a prompt for your business. Write your own, or try again.");
      }
      return;
    } finally {
      if (seq === toggleSeq.current) setLoadingPrompt(false);
    }
  };

  const writeScript = async (prompt: string) => {
    if (!onWriteScript) return;
    const before = text;
    const startMode = mode;
    setWriting(true);
    let script: string;
    try {
      script = await onWriteScript(prompt);
    } catch (e) {
      if (alive.current) setWriting(false);
      throw e;
    }
    if (!alive.current) return;
    if (modeNow.current !== startMode) {
      modeText.current[startMode] = script;
      pendingUndo.current[startMode] = before;
      toggleSeq.current++;
      filled.current = null;
      setLoadingPrompt(false);
      setPromptOn(false);
      return;
    }
    toggleSeq.current++;
    filled.current = null;
    setLoadingPrompt(false);
    setPromptOn(false);
    setUndoText(before);
    stopTyping();
    const words = script.split(" ");
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || words.length < 2) {
      setText(script);
      setWriting(false);
      focusBox();
      return;
    }
    let shown = 0;
    setText("");
    typer.current = window.setInterval(() => {
      shown += 1;
      setText(words.slice(0, shown).join(" "));
      if (shown < words.length) return;
      stopTyping();
      setWriting(false);
      focusBox();
    }, TYPE_MS);
  };

  const undo = () => {
    stopTyping();
    setWriting(false);
    setText(undoText ?? "");
    setUndoText(null);
    focusBox();
  };

  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = attachment !== null && attachment.path === null;
  const imageMode = mode === "image";
  const modeGroup = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ left: 0, width: 0, ready: false });
  useLayoutEffect(() => {
    const group = modeGroup.current;
    if (!group) return;
    const place = () => {
      const on = group.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
      if (!on) return;
      setThumb((t) => ({ left: on.offsetLeft, width: on.offsetWidth, ready: t.width > 0 }));
    };
    place();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    ro?.observe(group);
    return () => ro?.disconnect();
  }, [imageMode]);
  const words = scriptWordCount(text);
  const verbatimScript = !imageMode && !promptOn;
  const lengthHint =
    verbatimScript && words > 0 && (words < MIN_SCRIPT_WORDS || words > MAX_SCRIPT_WORDS)
      ? `A word-for-word script needs ${MIN_SCRIPT_WORDS} to ${MAX_SCRIPT_WORDS} words. This one has ${words}.`
      : null;
  const scriptOk = promptOn ? text.trim().length >= MIN_SCRIPT_CHARS : words >= MIN_SCRIPT_WORDS && words <= MAX_SCRIPT_WORDS;
  const canSend = !sending && !uploading && !writing && (imageMode ? !!attachment?.path : scriptOk);

  const submit = () => {
    if (!canSend) return;
    setUndoText(null);
    onSubmit({ verbatim: !imageMode && !promptOn });
  };

  const sendLine = (line: string) => {
    if (sending || writing) return;
    setUndoText(null);
    setText(line);
    onSubmit({ verbatim: false, revise: true });
  };

  const switchMode = (next: StudioMode) => {
    if (next === mode) return;
    stopTyping();
    setWriting(false);
    modeText.current[mode] = latestText.current;
    const restored = modeText.current[next];
    modeText.current[next] = "";
    const pending = pendingUndo.current[next];
    delete pendingUndo.current[next];
    setUndoText(pending ?? null);
    if (pending !== undefined) {
      toggleSeq.current++;
      filled.current = null;
      setLoadingPrompt(false);
      setPromptOn(false);
    }
    latestText.current = restored;
    setText(restored);
    setMode(next);
  };

  const pickMode = (next: StudioMode) => {
    if (next !== mode) {
      if (next === "script" && attachment) onRemoveAttachment();
      switchMode(next);
    }
    focusBox();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onAttach) return;
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    switchMode("image");
    onAttach(file);
  };

  const placeholder = imageMode
    ? "Describe how it should move (optional)…"
    : loadingPrompt
      ? "Writing a prompt for your business…"
      : promptOn
      ? "Describe your video. Zavi writes the script."
      : "Write your script. The presenter says it word for word.";

  return (
    <div
      data-testid="video-studio-empty"
      className={cx("flex flex-col items-center", listBelow ? "min-h-[min(560px,70vh)] justify-center pb-10 pt-6" : "flex-1 justify-center pb-[10vh] pt-6")}
    >
      <ZaviMascot size={96} />
      <h2 className="mt-4 text-balance text-center text-[28px] font-semibold leading-9 tracking-[-0.02em] text-ink">What video do you want to make?</h2>
      <p className="mt-2 text-center text-[13px] leading-[18px] text-inkMuted">Describe your idea: write a script, or start from an image.</p>
      <div className="mt-6 w-full max-w-[760px]">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div ref={modeGroup} role="radiogroup" aria-label="How to make the video" className="relative isolate inline-flex rounded-full bg-bone p-1">
            <span
              aria-hidden
              data-testid="video-studio-mode-thumb"
              className={cx(
                "absolute inset-y-1 -z-10 rounded-full bg-cream motion-reduce:transition-none",
                ELEVATION_2,
                thumb.ready && "transition-[left,width] duration-300 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]",
              )}
              style={{ left: thumb.left, width: thumb.width, opacity: thumb.width ? 1 : 0 }}
            />
            <ModePill selected={!imageMode} onClick={() => pickMode("script")} icon={<ScriptIcon className="h-4 w-4" />}>
              Script to video
            </ModePill>
            {onAttach && (
              <ModePill selected={imageMode} onClick={() => pickMode("image")} icon={<ImageIcon className="h-4 w-4" />}>
                Image to video
              </ModePill>
            )}
          </div>
          {editing && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <span data-testid="video-studio-editing" className="min-w-0 truncate text-[13px] leading-[18px] text-inkMuted">
                Editing “{editing.title}”
              </span>
              {editing.onClear && (
                <button
                  type="button"
                  aria-label="Cancel edit"
                  title="Cancel edit"
                  onClick={() => {
                    editing.onClear?.();
                    focusBox();
                  }}
                  className={cx("grid h-6 w-6 shrink-0 place-items-center rounded-full text-inkMuted hover:bg-bone hover:text-ink", FOCUS_RING)}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </span>
          )}
          {editing?.ready && (
            <>
              {REVISIONS.map((r) => (
                <button key={r.line} type="button" onClick={() => sendLine(r.line)} className={cx(CHIP, FOCUS_RING)}>
                  {r.label}
                </button>
              ))}
            </>
          )}
        </div>
        <div className="relative rounded-[28px] border border-rule bg-cream px-3 pb-2 pt-3 shadow-composer transition-shadow focus-within:border-ink/25 focus-within:shadow-composerFocus">
          {imageMode && (
            <div className="animate-fade-in motion-reduce:animate-none">
              {attachment ? (
                <span data-testid="video-studio-attachment" className="relative mx-1 mb-2 block h-28 w-28 overflow-hidden rounded-2xl border border-rule bg-bone">
                  {attachment.preview && <img src={attachment.preview} alt="Your image" className="size-full object-cover" />}
                  {attachment.path === null && (
                    <span role="status" aria-label="Uploading image" className="absolute inset-0 grid place-items-center bg-cream/60">
                      <Loader2 className="h-5 w-5 animate-spin text-ink" aria-hidden />
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label="Remove the image"
                    onClick={onRemoveAttachment}
                    className={cx("absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-ink/70 text-cream hover:bg-ink", FOCUS_RING)}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  data-testid="video-studio-dropzone"
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type.startsWith("image/"));
                    if (file && onAttach) onAttach(file);
                  }}
                  className={cx(
                    "mb-1 flex w-full items-center gap-3 rounded-2xl border-[1.5px] border-dashed border-ink/25 px-4 py-3 text-left transition-colors duration-[120ms] hover:border-ink/40 hover:bg-bone",
                    FOCUS_RING,
                  )}
                >
                  <ImageAddIcon className="h-6 w-6 shrink-0 text-ink" />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[15px] font-semibold leading-5 text-ink">Add an image</span>
                    <span className="text-[13px] leading-[18px] text-inkMuted">A photo of your product, car or place. PNG, JPEG or WebP, up to 5 MB.</span>
                  </span>
                </button>
              )}
              <input
                ref={fileRef}
                id="video-studio-image"
                type="file"
                accept={STUDIO_IMAGE_TYPES.join(",")}
                className="hidden"
                data-testid="video-studio-file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file && onAttach) onAttach(file);
                }}
              />
            </div>
          )}
          <label htmlFor={`${id}-msg`} className="sr-only">
            {imageMode ? "How the image should move" : "Your script"}
          </label>
          <TextareaAutosize
            id={`${id}-msg`}
            ref={setBox}
            value={text}
            onChange={(e) => {
              if (undoText !== null) setUndoText(null);
              setText(e.target.value);
            }}
            aria-describedby={lengthHint ? `${id}-length` : undefined}
            onKeyDown={onKey}
            onPaste={onPaste}
            readOnly={writing}
            autoFocus
            minRows={imageMode ? 1 : 2}
            maxRows={8}
            maxLength={2000}
            placeholder={placeholder}
            className="block w-full resize-none border-0 bg-transparent px-2.5 py-2 text-[16px] font-medium leading-6 text-ink outline-none placeholder:text-inkLight"
          />
          <div className="flex flex-wrap items-center gap-2 px-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {imageMode && attachment && (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className={cx("inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-[14px] font-semibold text-inkMuted hover:bg-bone", FOCUS_RING)}
                >
                  <ImageAddIcon className="h-[18px] w-[18px]" />
                  Change image
                </button>
              )}
              {!imageMode && (
                <>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={promptOn}
                    aria-busy={loadingPrompt || undefined}
                    onClick={() => void togglePrompt()}
                    title={promptOn ? "Zavi turns your words into a script" : "The presenter says your words exactly"}
                    className={cx("inline-flex min-h-11 items-center gap-2.5 rounded-full px-2 text-[14px] font-semibold leading-5 text-ink transition-colors duration-[120ms] hover:bg-bone", FOCUS_RING)}
                  >
                    <span aria-hidden className={cx("relative h-6 w-10 shrink-0 rounded-full transition-colors", promptOn ? "bg-ink" : "bg-ink/20")}>
                      <span className={cx("absolute left-0 top-0.5 h-5 w-5 rounded-full bg-cream shadow-sm transition-transform", promptOn ? "translate-x-[18px]" : "translate-x-0.5")} />
                    </span>
                    Enable prompt
                  </button>
                  {onWriteScript && <ScriptWriter id={`${id}-writer`} writing={writing} onWrite={writeScript} />}
                  {undoText !== null && (
                    <button
                      type="button"
                      onClick={undo}
                      className={cx("inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[14px] font-semibold text-inkMuted hover:bg-bone", FOCUS_RING)}
                    >
                      <UndoIcon className="h-4 w-4" />
                      Undo
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <MicButton
                disabled={writing}
                showUnsupported
                icon={<MicIcon className="h-5 w-5" />}
                onTranscript={(phrase) => {
                  const next = appendDictatedText(latestText.current, phrase);
                  latestText.current = next;
                  if (undoText !== null) setUndoText(null);
                  setText(next);
                }}
              />
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-busy={sending || undefined}
                className={cx(
                  "inline-flex h-11 items-center gap-2 rounded-full px-5 text-[16px] font-semibold transition-colors",
                  canSend || sending ? "bg-ink text-cream hover:bg-inkSoft" : "cursor-not-allowed bg-bone text-inkLight",
                  FOCUS_RING,
                )}
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <GenerateIcon className="h-4 w-4" />}
                Generate
              </button>
            </div>
          </div>
        </div>
        {lengthHint && (
          <p id={`${id}-length`} data-testid="video-studio-length-hint" className="mt-2 px-1 text-[13px] text-inkMuted">
            {lengthHint}
          </p>
        )}
        {promptError && (
          <p role="alert" data-testid="video-studio-prompt-error" className="mt-2 px-1 text-[13px] text-coral">
            {promptError}
          </p>
        )}
        {attachError && (
          <p role="alert" className="mt-2 px-1 text-[13px] text-coral">
            {attachError}
          </p>
        )}
        <p className="mt-3 text-center text-[12px] text-inkLight">Credits are charged only when a video arrives.</p>
      </div>
    </div>
  );
}

function ModePill({ selected, onClick, icon, children }: { selected: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cx(
        "inline-flex min-h-9 items-center gap-1.5 rounded-full px-3.5 text-[14px] font-semibold leading-5 transition-colors duration-300 motion-reduce:transition-none",
        selected ? "text-ink" : "text-inkMuted hover:text-ink",
        FOCUS_RING,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function ScriptWriter({ id, writing, onWrite }: { id: string; writing: boolean; onWrite: (prompt: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<{ text: string; credit: boolean } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const write = async () => {
    const p = prompt.trim();
    if (!p || writing || inFlight.current) return;
    inFlight.current = true;
    setOpen(false);
    setError(null);
    try {
      await onWrite(p);
      if (alive.current) setPrompt("");
    } catch (e) {
      if (!alive.current) return;
      const credit = creditRefusalFrom(e instanceof ApiError ? e.body : null, "channel");
      setError(
        credit
          ? { text: credit.headline, credit: true }
          : { text: e instanceof ApiError ? (e.status < 500 && e.message ? e.message : WRITE_FAILED) : (e as Error | null)?.message || WRITE_FAILED, credit: false },
      );
      setOpen(true);
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <span ref={ref}>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        disabled={writing}
        onClick={() => setOpen(!open)}
        className={cx(
          "inline-flex min-h-11 items-center gap-2 rounded-full border border-rule bg-cream px-3.5 text-[14px] font-semibold leading-5 text-ink transition-colors duration-[120ms] hover:bg-bone disabled:cursor-wait disabled:opacity-60",
          FOCUS_RING,
        )}
      >
        {writing ? "Writing…" : "Script writer"}
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label="Script writer"
          className="absolute left-3 top-full z-30 mt-2 w-[min(360px,calc(100%-24px))] rounded-2xl border border-rule bg-cream p-3 shadow-composer"
        >
          <label htmlFor={`${id}-prompt`} className="sr-only">
            Your prompt
          </label>
          <TextareaAutosize
            id={`${id}-prompt`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void write();
              }
            }}
            autoFocus
            minRows={3}
            maxRows={6}
            maxLength={2000}
            placeholder="Add your prompt"
            className="block w-full resize-none rounded-2xl border border-rule bg-cream px-3.5 py-2.5 text-[15px] font-medium leading-[22px] text-ink outline-none transition-colors duration-[120ms] placeholder:text-inkLight focus:border-ink/25"
          />
          {error && (
            <p role="alert" className="mt-2 text-[13px] text-coral">
              {error.text}
              {error.credit && (
                <TopUp testId="script-writer-top-up" className="ml-2 inline font-semibold text-ink underline underline-offset-2" />
              )}
            </p>
          )}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => void write()}
              disabled={!prompt.trim()}
              className={cx(
                "inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-full px-5 text-[15px] font-semibold",
                prompt.trim() ? "bg-ink text-cream hover:bg-inkSoft" : "cursor-not-allowed bg-bone text-inkLight",
                FOCUS_RING,
              )}
            >
              Generate
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
