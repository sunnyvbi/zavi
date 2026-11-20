"use client";

import { useRef, useState } from "react";

export const IDEA_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const IDEA_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IDEA_IMAGE_MAX_COUNT = 3;
export const IDEA_IMAGE_TYPE_ERROR = "Images must be PNG, JPEG or WebP.";
export const IDEA_IMAGE_SIZE_ERROR = "Each image must be 5 MB or smaller.";
export const IDEA_IMAGE_COUNT_ERROR = `You can attach up to ${IDEA_IMAGE_MAX_COUNT} images.`;
export const IDEA_IMAGE_TOTAL_MAX_CHARS = 4_000_000;
export const IDEA_IMAGE_TOTAL_ERROR = "These images are too large together. Try smaller images.";
const MAX_EDGE = 1568;

export function isIdeaImageDataUrl(v: unknown): v is string {
  return typeof v === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(v);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function shrink(file: File, raw: string): Promise<string> {
  try {
    if (typeof createImageBitmap !== "function") return raw;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return raw;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL("image/jpeg", 0.85);
    return out.startsWith("data:image/jpeg;base64,") && out.length < raw.length ? out : raw;
  } catch {
    return raw;
  }
}

export function useIdeaImageAttach(
  images: string[],
  onChange: (next: string[]) => void,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const full = images.length >= IDEA_IMAGE_MAX_COUNT;

  async function addFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (inputRef.current) inputRef.current.value = "";
    if (files.length === 0) return;
    let problem: string | null = null;
    const next = [...images];
    for (const file of files) {
      if (!IDEA_IMAGE_TYPES.includes(file.type)) {
        problem = IDEA_IMAGE_TYPE_ERROR;
        continue;
      }
      if (file.size > IDEA_IMAGE_MAX_BYTES) {
        problem = IDEA_IMAGE_SIZE_ERROR;
        continue;
      }
      if (next.length >= IDEA_IMAGE_MAX_COUNT) {
        problem = IDEA_IMAGE_COUNT_ERROR;
        break;
      }
      try {
        const raw = await readAsDataUrl(file);
        const url = await shrink(file, raw);
        const total = next.reduce((n, u) => n + u.length, 0) + url.length;
        if (total > IDEA_IMAGE_TOTAL_MAX_CHARS) {
          problem = IDEA_IMAGE_TOTAL_ERROR;
          continue;
        }
        next.push(url);
      } catch {
        problem = IDEA_IMAGE_TYPE_ERROR;
      }
    }
    setError(problem);
    if (next.length !== images.length) onChange(next);
  }

  function remove(index: number) {
    setError(null);
    onChange(images.filter((_, j) => j !== index));
  }

  return {
    inputRef,
    error,
    full,
    addFiles,
    remove,
    open: () => inputRef.current?.click(),
  };
}

export type IdeaImageAttachState = ReturnType<typeof useIdeaImageAttach>;

export function IdeaImageInput({ attach }: { attach: IdeaImageAttachState }) {
  return (
    <input
      ref={attach.inputRef}
      id="idea-image-input"
      type="file"
      accept={IDEA_IMAGE_TYPES.join(",")}
      multiple
      className="sr-only"
      aria-label="Attach image"
      disabled={attach.full}
      onChange={(e) => void attach.addFiles(e.target.files)}
    />
  );
}

export function IdeaImageThumbs({
  images,
  attach,
}: {
  images: string[];
  attach: IdeaImageAttachState;
}) {
  if (images.length === 0) return null;
  return (
    <ul aria-label="Attached images" className="flex flex-wrap gap-2 px-4 pt-3">
      {images.map((src, i) => (
        <li key={`${i}-${src.length}`} className="relative">
          <img
            src={src}
            alt={`Attached image ${i + 1}`}
            className="h-14 w-14 rounded-xl border border-onboarding-rule object-cover"
          />
          <button
            type="button"
            aria-label={`Remove image ${i + 1}`}
            onClick={() => attach.remove(i)}
            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-xs leading-none text-white"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

export function IdeaImageError({ attach }: { attach: IdeaImageAttachState }) {
  if (!attach.error) return null;
  return (
    <p role="alert" className="mt-2 text-sm text-danger">
      {attach.error}
    </p>
  );
}
