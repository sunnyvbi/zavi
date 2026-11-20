"use client";
import { useId, useRef, useState } from "react";
import { ImagePlus, Sparkles, RefreshCw, Link2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { isAdImagePath, type AdImageAi } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { campaignFetch } from "./api";
import { sheetHint, sheetInput } from "./AdsSheet";
import { useAdImagePreview } from "../ads/useAdImagePreview";

const MAX_BYTES = 5 * 1024 * 1024;
const button = "inline-flex h-10 items-center gap-2 rounded-cta border border-rule bg-cream px-3 text-[14px] font-semibold text-ink disabled:opacity-40";

type Props = {
  value: string | null;
  onChange: (value: string | null) => void;
  defaultPrompt: string;
  ai: AdImageAi | null;
  generatePath?: string;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
  label?: string;
};

export function AdImageSlot({ value, onChange, defaultPrompt, ai, generatePath, disabled = false, onBusy, label = "Ad image" }: Props) {
  const [state, setState] = useState<"idle" | "uploading" | "generating">("idle");
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(defaultPrompt.slice(0, 900));
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [variation, setVariation] = useState(1);
  const [link, setLink] = useState(value && !isAdImagePath(value) ? value : "");
  const file = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const promptId = useId();
  const busy = state !== "idle";
  const set = (s: typeof state) => { setState(s); onBusy?.(s !== "idle"); };
  const canAi = !!ai?.available && !!generatePath;
  const outOfVersions = variation > 100;

  async function upload(f: File) {
    setError(null);
    if (f.size > MAX_BYTES) { setError("That file is over 5 MB. Choose a smaller image."); return; }
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { setError("Use a JPG, PNG or WebP image."); return; }
    set("uploading");
    try {
      const form = new FormData();
      form.append("file", f);
      const res = await apiFetch("/api/chat/upload-image", { method: "POST", body: form });
      const body = await res.json().catch(() => null) as { image_path?: string; error?: { message?: string } } | null;
      if (!res.ok || !body?.image_path || !isAdImagePath(body.image_path)) throw new Error(body?.error?.message ? "That image could not be used. Try a different file." : "The upload did not finish. Try again.");
      onChange(body.image_path);
    } catch (e) { setError(e instanceof Error ? e.message : "The upload did not finish. Try again."); }
    finally { set("idle"); if (file.current) file.current.value = ""; }
  }

  async function generate() {
    if (!generatePath || prompt.trim().length < 3) return;
    setError(null); set("generating");
    try {
      const r = await campaignFetch<{ image_path: string }>(generatePath, { method: "POST", body: JSON.stringify({ prompt: prompt.trim(), ...(variation > 1 ? { variation } : {}) }) });
      onChange(r.image_path);
      setVariation(v => v + 1);
      setEditingPrompt(false);
    } catch (e) { setError(e instanceof Error ? e.message : "The image did not come out. Try again."); }
    finally { set("idle"); }
  }

  const credits = ai?.credits ? ` · ~${ai.credits.toLocaleString()} credits` : "";
  const locked = disabled || busy;
  const { src, failed } = useAdImagePreview(value);
  return <div className="space-y-3" data-testid="ad-image-slot">
    <p className="text-[14px] font-medium text-inkSoft">{label}</p>
    <button type="button" data-testid="ad-image-drop" data-over={over || undefined} aria-label={value ? "Replace" : "Upload image"} disabled={locked} onClick={() => file.current?.click()} onDragOver={(e) => { e.preventDefault(); if (!locked) setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); const dropped = e.dataTransfer.files?.[0]; if (dropped && !locked) void upload(dropped); }} className={cn("flex w-full flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed px-4 py-7 text-center transition-colors focus-visible:shadow-ca-focus focus-visible:outline-none disabled:opacity-60", over ? "border-ca-primary bg-ca-subtle" : "border-ca-strong bg-ca-bg hover:bg-ca-subtle")} aria-live="polite">
      {busy ? <span role="status" className="py-4 text-ca-action font-medium text-ca-secondary">{state === "uploading" ? "Uploading…" : "Making your image…"}</span> : <>
        {src ? <img src={src} alt={`${label} preview`} className="mb-2 size-24 rounded-xl object-cover" /> : <ImagePlus className="size-6 text-ca-secondary" aria-hidden />}
        <span className="text-ca-row font-semibold text-ca-xdark">{value ? failed ? "Preview unavailable" : "Replace image" : "Image Upload"}</span>
        <span className="text-ca-action text-ca-secondary">{over ? "Drop to upload" : "Click to choose, or drag a file here"}</span>
      </>}
    </button>
    <p className={`${sheetHint} !mt-0`}>JPG, PNG or WebP, up to 5 MB. Square images fit the ad best.</p>
    {(canAi || value) && <div className="flex flex-wrap gap-2">
      {canAi && <button type="button" className={button} disabled={locked || prompt.trim().length < 3 || outOfVersions} onClick={() => void generate()}>
        <Sparkles className="size-4" aria-hidden />{value ? "New AI image" : "Create with AI"}{credits}
      </button>}
      {value && <button type="button" className={`${button} border-transparent`} disabled={locked} onClick={() => { onChange(null); setLink(""); }}>Remove</button>}
    </div>}
    {canAi && (editingPrompt
      ? <label htmlFor={promptId} className="block text-[14px] font-medium text-inkSoft">What the picture shows
          <textarea id={promptId} className={`${sheetInput} h-20 resize-none py-2`} maxLength={900} value={prompt} disabled={locked} onChange={e => { setPrompt(e.target.value); setVariation(1); }} />
        </label>
      : <p className={`${sheetHint} !mt-0`}>Zavi&apos;s idea: “{prompt}” <button type="button" className="underline" disabled={locked} onClick={() => setEditingPrompt(true)}>Change</button></p>)}
    {canAi && outOfVersions && <p className={`${sheetHint} !mt-0`}>That is every version of this description. Change the description for new ones.</p>}
    <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} aria-hidden onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
    {error && <p role="alert" className="text-[13px] font-medium text-danger">{error}</p>}
    {!linkOpen
      ? <button type="button" className="inline-flex items-center gap-2 text-[13px] font-medium text-inkMuted underline" disabled={disabled || busy} onClick={() => setLinkOpen(true)}><Link2 className="size-3.5" aria-hidden />Use an image link instead</button>
      : <div className="flex gap-2">
          <input aria-label="Image link" type="url" placeholder="https://…" className={sheetInput} value={link} disabled={disabled || busy} onChange={e => setLink(e.target.value)} />
          <button type="button" className={`${button} mt-1.5`} disabled={disabled || busy || !/^https:\/\/\S+$/i.test(link.trim())} onClick={() => { onChange(link.trim()); setLinkOpen(false); }}><RefreshCw className="size-4" aria-hidden />Use link</button>
        </div>}
  </div>;
}
