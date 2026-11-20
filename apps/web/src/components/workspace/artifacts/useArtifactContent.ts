"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
  artifactRenderMode,
  isTextRenderMode,
  MAX_INLINE_BYTES,
} from "./artifactRender";
import type { Artifact } from "./types";

export type ArtifactContent = {
  url: string | null;
  text: string | null;
  loading: boolean;
  error: string | null;
  tooLarge: boolean;
};

const IDLE: ArtifactContent = {
  url: null,
  text: null,
  loading: false,
  error: null,
  tooLarge: false,
};

const MINT_RETRIES = 1;
const MINT_RETRY_MS = 700;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function mintSignedUrl(
  id: string,
  signal: AbortSignal,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const response = await apiFetch(
      `/api/run-artifacts/${encodeURIComponent(id)}/url`,
      { signal },
    );
    if (response.ok) {
      const payload = (await response.json()) as { signed_url?: string };
      if (payload.signed_url) return payload.signed_url;
    }
    if (attempt >= MINT_RETRIES || response.status !== 404) {
      throw new Error("Could not open this artifact.");
    }
    await sleep(MINT_RETRY_MS);
    if (signal.aborted) {
      const aborted = new Error("aborted");
      aborted.name = "AbortError";
      throw aborted;
    }
  }
}

export function useArtifactContent(
  artifact: Artifact | null,
  enabled = true,
  textByteLimit?: number,
): ArtifactContent {
  const [state, setState] = useState<ArtifactContent>(IDLE);
  const id = artifact?.id ?? null;
  const mime = artifact?.mime ?? "";
  const filename = artifact?.filename ?? "";
  const bytes = artifact?.bytes ?? 0;

  const listUrlRef = useRef(artifact?.preview_url ?? null);
  listUrlRef.current = artifact?.preview_url ?? null;

  useEffect(() => {
    if (!enabled || !id) {
      setState(IDLE);
      return;
    }
    const mode = artifactRenderMode(mime, filename);
    if (mode === "unsupported" || mode === "ui-block" || mode === "page") {
      setState(IDLE);
      return;
    }
    const wantsText = isTextRenderMode(mode);
    if (wantsText && textByteLimit === undefined && bytes > MAX_INLINE_BYTES) {
      setState({ ...IDLE, tooLarge: true });
      return;
    }

    const controller = new AbortController();
    setState({ ...IDLE, loading: true });

    void (async () => {
      try {
        if (!wantsText) {
          const url = listUrlRef.current ?? (await mintSignedUrl(id, controller.signal));
          if (!controller.signal.aborted) setState({ ...IDLE, url });
          return;
        }

        let url = listUrlRef.current;
        const fetchOptions: RequestInit = {
          signal: controller.signal,
          ...(textByteLimit !== undefined
            ? { headers: { Range: `bytes=0-${textByteLimit - 1}` } }
            : {}),
        };
        let file = url
          ? await fetch(url, fetchOptions).catch(() => null)
          : null;
        if (!file?.ok) {
          url = await mintSignedUrl(id, controller.signal);
          file = await fetch(url, fetchOptions);
        }
        if (!file.ok) throw new Error("Could not read this artifact.");
        const text = await readText(file, textByteLimit);
        if (controller.signal.aborted) return;
        setState({ ...IDLE, url, text });
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setState({
          ...IDLE,
          error: (error as Error).message || "Could not open this artifact.",
        });
      }
    })();

    return () => controller.abort();
  }, [bytes, enabled, filename, id, mime, textByteLimit]);

  return state;
}

async function readText(response: Response, byteLimit?: number): Promise<string> {
  if (byteLimit === undefined || !response.body) return response.text();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let complete = false;
  try {
    while (received < byteLimit) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      const remaining = byteLimit - received;
      const chunk = next.value.byteLength > remaining
        ? next.value.subarray(0, remaining)
        : next.value;
      chunks.push(chunk);
      received += chunk.byteLength;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
