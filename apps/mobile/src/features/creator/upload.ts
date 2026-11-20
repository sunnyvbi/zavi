import { File, UploadType } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { creatorApi, type CreatorSubmissionFile } from "./api";

export const DELIVERABLE_MIMES: Record<string, "video" | "image"> = {
  "video/mp4": "video",
  "video/quicktime": "video",
  "video/webm": "video",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
};

const EXTENSION_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  qt: "video/quicktime",
  webm: "video/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export type PickedDeliverable = {
  uri: string;
  name: string;
  mime: string;
  kind: "video" | "image";
  bytes: number;
};

export class DeliverableError extends Error {}

function mimeFor(assetMime: string | null | undefined, name: string): string {
  const fromPicker = (assetMime ?? "").toLowerCase();
  if (DELIVERABLE_MIMES[fromPicker]) return fromPicker;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MIME[ext] ?? fromPicker;
}

export async function pickDeliverables(
  onSkip?: (message: string) => void,
): Promise<PickedDeliverable[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    throw new DeliverableError("Photo access is needed to send your work.");
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["videos", "images"],
    allowsMultipleSelection: true,
    selectionLimit: 10,
    quality: 1,
  });
  if (result.canceled) return [];

  const picked: PickedDeliverable[] = [];
  for (const asset of result.assets) {
    let file: File;
    try {
      file = new File(asset.uri);
      if (!file.exists) throw new Error("missing");
    } catch {
      onSkip?.("Skipping a file: it is no longer on this device.");
      continue;
    }
    const name = asset.fileName ?? file.name ?? "upload";
    const mime = mimeFor(asset.mimeType, name);
    const kind = DELIVERABLE_MIMES[mime];
    if (!kind) {
      onSkip?.(`Skipping ${name}. Send an MP4, MOV or WebM video, or a PNG, JPEG or WebP image.`);
      continue;
    }
    picked.push({ uri: asset.uri, name, mime, kind, bytes: file.size ?? 0 });
  }
  return picked;
}

export async function uploadDeliverable(
  orderId: string,
  picked: PickedDeliverable,
  onProgress?: (fraction: number) => void,
): Promise<CreatorSubmissionFile> {
  const slot = await creatorApi.uploadUrl(orderId, picked.mime);
  const file = new File(picked.uri);
  const result = await file.upload(slot.signed_url, {
    httpMethod: "PUT",
    uploadType: UploadType.BINARY_CONTENT,
    headers: { "Content-Type": picked.mime },
    onProgress: onProgress
      ? ({ bytesSent, totalBytes }) =>
          onProgress(totalBytes > 0 ? Math.min(1, bytesSent / totalBytes) : 0)
      : undefined,
  });
  if (result.status < 200 || result.status >= 300) {
    throw new DeliverableError("That upload did not finish. Try again.");
  }
  return {
    kind: picked.kind,
    storage_path: slot.path,
    mime_type: picked.mime,
    bytes: picked.bytes,
  };
}
