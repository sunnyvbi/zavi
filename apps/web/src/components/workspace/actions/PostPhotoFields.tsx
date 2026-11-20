"use client";

import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { Check, ImagePlus } from "lucide-react";
import { z } from "zod";
import type { PostImageSize } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/cn";
import { campaignFetch } from "./managed-campaigns/api";
import { PostPhoto } from "./PostPhoto";

const HEADING = "text-ca-title font-semibold text-ca-xdark";
const LABEL = "flex items-center justify-between gap-3 text-ca-label font-medium text-ca-xdark";
const NOTE = "text-ca-action text-ca-secondary";
const FIELD = "w-full rounded-xl border border-ca-strong bg-ca-bg px-3.5 py-3 text-ca-row text-ca-xdark placeholder:text-ca-secondary focus-visible:shadow-ca-focus focus-visible:outline-none disabled:opacity-60";
const THUMB = "relative size-20 shrink-0 overflow-hidden rounded-xl border-2 focus-visible:shadow-ca-focus focus-visible:outline-none";
export type PostPhotoValues = { image_path?: string; headline?: string; size?: PostImageSize };
const uploadResponse = z.object({ image_path: z.string() });
const formats = [{ value: "feed", label: "Feed 4:5" }, { value: "square", label: "Square 1:1" }, { value: "story", label: "Story 9:16" }] satisfies Array<{ value: PostImageSize; label: string }>;
export function PostPhotoFields({ value, original, disabled, sizes = formats, onChange, onBusy }: { value: PostPhotoValues; original?: string; disabled: boolean; sizes?: ReadonlyArray<{ value: PostImageSize; label: string }>; onChange: (value: PostPhotoValues) => void; onBusy: (value: boolean) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const headlineId = useId();
  const [uploads, setUploads] = useState<string[]>([]);
  const [imported, setImported] = useState<Record<string, string>>({});
  const fallbackSize = sizes[0].value;
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);
  const [library, setLibrary] = useState<Array<{ id: string; name: string; url: string }>>([]);
  useEffect(() => {
    let stopped = false;
    const schema = z.object({ files: z.array(z.object({ id: z.string(), name: z.string(), mime: z.string(), url: z.string() })) });
    void campaignFetch<unknown>("/api/workspace/files").then((data) => { const files = schema.parse(data).files.filter((file) => /^image\/(jpeg|png|webp)$/.test(file.mime)); if (!stopped) setLibrary(files); }).catch(() => { if (!stopped) setError("Workspace photos could not be read. You can still upload a photo."); });
    return () => { stopped = true; };
  }, []);
  async function selectLibrary(id: string, url: string) {
    onBusy(true); setError("");
    try { const selected = uploadResponse.parse(await campaignFetch<unknown>("/api/channel-actions/post-draft/photo/import", { method: "POST", body: JSON.stringify({ file_id: id }) })); setImported((all) => ({ ...all, [selected.image_path]: url })); setUploads((all) => [...all, selected.image_path]); onChange({ ...value, image_path: selected.image_path, size: value.size ?? fallbackSize }); }
    catch (error) { setError(error instanceof Error ? error.message : "The photo could not be loaded."); }
    finally { onBusy(false); }
  }
  async function upload(input: File) {
    if (!/^image\/(jpeg|png|webp)$/.test(input.type) || input.size > 10 * 1024 * 1024) { setError("Choose a JPG, PNG or WebP image up to 10 MB."); return; }
    onBusy(true); setError("");
    try {
      const form = new FormData(); form.append("file", input);
      const result = await apiFetch("/api/channel-actions/post-draft/photo", { method: "POST", body: form });
      if (!result.ok) throw new Error("The image could not be uploaded. Try again.");
      const saved = uploadResponse.parse(await result.json());
      setUploads((all) => [...all, saved.image_path]); onChange({ ...value, image_path: saved.image_path, size: value.size ?? fallbackSize });
    } catch (error) { setError(error instanceof Error ? error.message : "The image could not be uploaded."); }
    finally { onBusy(false); if (file.current) file.current.value = ""; }
  }
  const photos = [...new Set([original, value.image_path, ...uploads].filter((source): source is string => !!source))];
  const shownLibrary = library.filter((photo) => !Object.values(imported).includes(photo.url));
  const drop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setOver(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped && !disabled) void upload(dropped);
  };
  const activeSize = value.size ?? fallbackSize;
  return <div className="space-y-8">
    <section aria-label="Photo" className="space-y-4">
      <h4 className={HEADING}>Photo</h4>
      <fieldset disabled={disabled} className="min-w-0 space-y-2.5">
        <legend className={cn(LABEL, "mb-2.5")}>Replace the photo</legend>
        <button
          type="button"
          onClick={() => file.current?.click()}
          onDragOver={(event) => { event.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
          className={cn("flex w-full flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed px-4 py-7 text-center transition-colors focus-visible:shadow-ca-focus focus-visible:outline-none disabled:opacity-60", over ? "border-ca-primary bg-ca-subtle" : "border-ca-strong bg-ca-bg hover:bg-ca-subtle")}
        >
          <ImagePlus className="size-6 text-ca-secondary" aria-hidden />
          <span className="text-ca-row font-semibold text-ca-xdark">Upload</span>
          <span className="text-ca-action text-ca-secondary">Click to choose, or drag a file here</span>
        </button>
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Upload photo" className="sr-only" onChange={(event) => { const selected = event.target.files?.[0]; if (selected) void upload(selected); }} />
        <p className={NOTE}>JPG, PNG or WebP, up to 10 MB.</p>
      </fieldset>
      {(photos.length > 0 || shownLibrary.length > 0) && (
        <fieldset disabled={disabled} className="min-w-0">
          <legend className={cn(NOTE, "mb-2.5")}>Or pick one of yours</legend>
          <div data-testid="post-photo-choices" className="flex max-h-48 min-w-0 flex-wrap gap-3 overflow-y-auto p-0.5">
            {photos.map((source) => {
              const selected = (value.image_path ?? original) === source;
              return <button type="button" key={source} aria-label="Select photo" aria-pressed={selected} onClick={() => onChange({ ...value, image_path: source === original ? undefined : source })} className={cn(THUMB, selected ? "border-ca-xdark" : "border-ca-border")}><PostPhoto source={source} size="square" thumbnail fallback={imported[source]} />{selected && <span className="absolute right-1 top-1 rounded-full bg-ca-xdark p-1 text-ca-bg"><Check className="size-3" aria-hidden /></span>}</button>;
            })}
            {shownLibrary.map((photo) => <button type="button" key={photo.id} aria-label={`Select ${photo.name}`} onClick={() => void selectLibrary(photo.id, photo.url)} className={cn(THUMB, "border-ca-border")}><PostPhoto source={photo.url} size="square" thumbnail /></button>)}
          </div>
        </fieldset>
      )}
      <fieldset disabled={disabled} className="min-w-0">
        <legend className={cn(LABEL, "mb-2.5")}>Size</legend>
        <div className="inline-flex max-w-full flex-wrap rounded-full bg-ca-surface p-1">
          {sizes.map((format) => <button type="button" key={format.value} aria-pressed={activeSize === format.value} onClick={() => onChange({ ...value, size: format.value })} className={cn("h-9 rounded-full px-4 text-ca-action font-semibold transition-colors focus-visible:shadow-ca-focus focus-visible:outline-none", activeSize === format.value ? "bg-ca-bg text-ca-xdark shadow-ca-sm" : "bg-transparent text-ca-secondary shadow-none hover:bg-transparent hover:text-ca-primary")}>{format.label}</button>)}
        </div>
        <p className={cn(NOTE, "mt-2.5")}>The photo is cropped to this shape when it posts.</p>
      </fieldset>
      <label htmlFor={headlineId} className="flex min-w-0 flex-col gap-2.5">
        <span className={LABEL}><span>Headline</span><span className="text-ca-action font-normal tabular-nums text-ca-secondary">{(value.headline ?? "").length}/40</span></span>
        <input aria-label="Headline" id={headlineId} value={value.headline ?? ""} disabled={disabled} maxLength={40} onChange={(event) => onChange({ ...value, headline: event.target.value })} className={FIELD} />
      </label>
      {error && <p role="alert" className="text-ca-action text-ca-danger">{error}</p>}
    </section>
  </div>;
}
