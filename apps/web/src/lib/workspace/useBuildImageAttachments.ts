"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { uploadErrorMessage } from "@/lib/workspace/uploadErrorMessage";

export const BUILD_IMAGE_MAX = 3;
export const BUILD_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type BuildImage = {
  id: string;
  name: string;
  previewUrl: string;
  status: "uploading" | "ready" | "error";
  path?: string;
};

export function imageFilesFrom(
  data: { files?: FileList | null; items?: DataTransferItemList | null } | null | undefined,
): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const file of Array.from(data.files ?? [])) {
    if (file.type.startsWith("image/")) files.push(file);
  }
  if (files.length > 0) return files;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function previewFor(file: File): string {
  try {
    return URL.createObjectURL(file);
  } catch {
    return "";
  }
}

function revoke(url: string) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    return;
  }
}

export function useBuildImageAttachments(onError: (message: string) => void) {
  const [images, setImages] = useState<BuildImage[]>([]);
  const imagesRef = useRef<BuildImage[]>([]);
  imagesRef.current = images;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => () => imagesRef.current.forEach((img) => revoke(img.previewUrl)), []);

  const patch = useCallback((id: string, next: Partial<BuildImage>) => {
    setImages((prev) => prev.map((img) => (img.id === id ? { ...img, ...next } : img)));
  }, []);

  const upload = useCallback(
    async (id: string, file: File) => {
      const name = file.name || "image";
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await apiFetch("/api/chat/upload-image", { method: "POST", body: form });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          onErrorRef.current(
            uploadErrorMessage(name, BUILD_IMAGE_MAX_BYTES / 1024 / 1024, { kind: "http", status: res.status, body }),
          );
          patch(id, { status: "error" });
          return;
        }
        const data = (await res.json()) as { image_path?: unknown };
        if (typeof data.image_path !== "string" || !data.image_path) {
          onErrorRef.current(`Couldn't upload ${name}: upload failed. Try again.`);
          patch(id, { status: "error" });
          return;
        }
        patch(id, { status: "ready", path: data.image_path });
      } catch (error) {
        onErrorRef.current(uploadErrorMessage(name, BUILD_IMAGE_MAX_BYTES / 1024 / 1024, { kind: "thrown", error }));
        patch(id, { status: "error" });
      }
    },
    [patch],
  );

  const add = useCallback(
    (files: File[]) => {
      let room = BUILD_IMAGE_MAX - imagesRef.current.filter((img) => img.status !== "error").length;
      const added: BuildImage[] = [];
      for (const file of files) {
        const name = file.name || "image";
        if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
          onErrorRef.current(`Skipping ${name}: only PNG, JPEG or WebP images can be attached.`);
          continue;
        }
        if (file.size > BUILD_IMAGE_MAX_BYTES) {
          onErrorRef.current(`Skipping ${name}: each image must be 5 MB or smaller.`);
          continue;
        }
        if (room <= 0) {
          onErrorRef.current(`Attach at most ${BUILD_IMAGE_MAX} images to a change.`);
          break;
        }
        room--;
        const img: BuildImage = { id: crypto.randomUUID(), name, previewUrl: previewFor(file), status: "uploading" };
        added.push(img);
        void upload(img.id, file);
      }
      if (added.length > 0) setImages((prev) => [...prev, ...added]);
    },
    [upload],
  );

  const remove = useCallback((id: string) => {
    setImages((prev) => {
      const gone = prev.find((img) => img.id === id);
      if (gone) revoke(gone.previewUrl);
      return prev.filter((img) => img.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setImages((prev) => {
      prev.forEach((img) => revoke(img.previewUrl));
      return [];
    });
  }, []);

  const paths = images.flatMap((img) => (img.status === "ready" && img.path ? [img.path] : []));
  const uploading = images.some((img) => img.status === "uploading");
  return { images, paths, uploading, add, remove, clear };
}
