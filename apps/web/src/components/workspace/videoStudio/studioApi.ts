"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, IDEMPOTENCY_HEADER, newIdempotencyKey } from "@/lib/api";
import { ApiError } from "@/lib/workspace/channelActionsApi";
import { primeChatImageUrl } from "../ChatImageThumb";
import { useWorkspaceOptional } from "@/components/workspace/WorkspaceShell";
import { STUDIO_IMAGE_MAX_BYTES, STUDIO_IMAGE_TYPES, STUDIO_PATH, type GalleryVideo } from "./types";

export const RENDER_POLL_MS = 5_000;
const IN_PROGRESS_WAIT_MS = 3_000;
const IN_PROGRESS_MAX_TRIES = 20;

async function inProgress(res: Response): Promise<boolean> {
  if (res.status !== 409) return false;
  try {
    const body = (await (typeof res.clone === "function" ? res.clone() : res).json()) as { error?: { code?: string } };
    return body.error?.code === "idempotency_in_progress";
  } catch {
    return false;
  }
}

export async function postOnce(path: string, body: string): Promise<Response> {
  const key = newIdempotencyKey();
  let res = await apiFetch(path, { method: "POST", idempotent: true, headers: { [IDEMPOTENCY_HEADER]: key }, body });
  for (let i = 0; i < IN_PROGRESS_MAX_TRIES && (await inProgress(res)); i++) {
    await new Promise((r) => setTimeout(r, IN_PROGRESS_WAIT_MS));
    res = await apiFetch(path, { method: "POST", idempotent: true, headers: { [IDEMPOTENCY_HEADER]: key }, body });
  }
  return res;
}

export async function uploadStudioImage(file: File): Promise<string> {
  if (!STUDIO_IMAGE_TYPES.includes(file.type)) throw new Error("Attach a PNG, JPEG or WebP image.");
  if (file.size > STUDIO_IMAGE_MAX_BYTES) throw new Error("That image is over 5 MB. Attach a smaller one.");
  const form = new FormData();
  form.append("file", file);
  let res: Response;
  try {
    res = await apiFetch("/api/chat/upload-image", { method: "POST", body: form });
  } catch {
    throw new Error("The image did not upload. Check your connection.");
  }
  if (!res.ok) throw new Error(await uploadErrorMessage(res));
  const body = (await res.json()) as { image_path?: string };
  if (!body.image_path) throw new Error("The image did not upload. Try again.");
  try {
    primeChatImageUrl(body.image_path, URL.createObjectURL(file));
  } catch {
    return body.image_path;
  }
  return body.image_path;
}

const UPLOAD_ERROR_COPY: Record<string, string> = {
  unsupported_mime: "That file is not a PNG, JPEG or WebP image. Attach a real image.",
  invalid_image: "That image could not be read. Attach a different PNG, JPEG or WebP image.",
  file_too_large: "That image is over 5 MB. Attach a smaller one.",
  upload_rejected: "That image could not be uploaded. Attach a different PNG, JPEG or WebP image.",
  no_file: "No image was attached. Choose an image and try again.",
  unauthenticated: "You are signed out. Sign in again and retry.",
};

const UPLOAD_ERROR_FALLBACK = "The image did not upload. Try again.";

async function uploadErrorMessage(res: Response): Promise<string> {
  if (res.status >= 500) return UPLOAD_ERROR_FALLBACK;
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    return UPLOAD_ERROR_COPY[body.error?.code ?? ""] ?? UPLOAD_ERROR_FALLBACK;
  } catch {
    return UPLOAD_ERROR_FALLBACK;
  }
}

export async function writeStudioScript(prompt: string): Promise<string> {
  let res: Response;
  try {
    res = await apiFetch(`${STUDIO_PATH}/script`, { method: "POST", body: JSON.stringify({ prompt }) });
  } catch {
    throw new Error("Could not reach Zavi. Check your connection.");
  }
  if (!res.ok) {
    const failed = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiError(failed?.error?.message || "The script could not be written. Try again.", res.status, failed);
  }
  const body = (await res.json().catch(() => ({}))) as { script?: string };
  if (!body.script) throw new Error("The script could not be written. Try again.");
  return body.script;
}

async function readStudioPrompt(after: number | null = null): Promise<{ prompt: string; variant: number | null }> {
  const res = await apiFetch(after === null ? `${STUDIO_PATH}/prompt` : `${STUDIO_PATH}/prompt?after=${after}`);
  if (!res.ok) throw new Error("The prompt could not be loaded.");
  const body = (await res.json().catch(() => ({}))) as { prompt?: string; variant?: number };
  if (!body.prompt) throw new Error("The prompt could not be loaded.");
  return { prompt: body.prompt, variant: Number.isInteger(body.variant) ? (body.variant as number) : null };
}

const PROMPT_VARIANT_KEY = "zavi.studio.promptVariant";

function readLastVariant(key: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function writeLastVariant(key: string, variant: number | null) {
  try {
    if (variant === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, String(variant));
  } catch {
    return;
  }
}

export function useStudioPromptLoader(): () => Promise<string> {
  const tenantId = useWorkspaceOptional()?.tenantId ?? null;
  const key = `${PROMPT_VARIANT_KEY}:${tenantId ?? "default"}`;
  const last = useRef<number | null>(null);
  return useCallback(async () => {
    const { prompt, variant } = await readStudioPrompt(readLastVariant(key) ?? last.current);
    last.current = variant;
    writeLastVariant(key, variant);
    return prompt;
  }, [key]);
}

const LIBRARY_LOAD_ERROR = "Zavi could not load your videos. Try again.";

export function useStudioLibrary(enabled: boolean) {
  const [videos, setVideos] = useState<GalleryVideo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(async (): Promise<boolean> => {
    if (!enabled) return false;
    const mine = ++seq.current;
    try {
      const res = await apiFetch(`${STUDIO_PATH}/videos`);
      if (mine !== seq.current) return false;
      if (!res.ok) {
        if (mine === seq.current) setError(LIBRARY_LOAD_ERROR);
        return false;
      }
      const body = (await res.json()) as { videos?: GalleryVideo[] };
      if (mine !== seq.current) return false;
      setVideos(body.videos ?? []);
      setError(null);
      return true;
    } catch {
      if (mine === seq.current) setError("Could not reach Zavi. Check your connection.");
      return false;
    }
  }, [enabled]);
  useEffect(() => {
    void reload();
    return () => {
      seq.current++;
    };
  }, [reload]);
  return { videos, error, reload };
}
