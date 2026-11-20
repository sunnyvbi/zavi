import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { apiFetch } from "../../lib/api";

export const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_TURN = 4;

export type PickedImage = {
  uri: string;
  name: string;
  mime: string;
};

export class ImageAttachError extends Error {}

export class AccessDeniedError extends ImageAttachError {
  constructor(
    readonly title: string,
    message: string,
  ) {
    super(message);
  }
}

export async function pickImages(
  slots: number,
  onSkip?: (message: string) => void,
): Promise<PickedImage[]> {
  if (slots <= 0) {
    throw new ImageAttachError(`Max ${MAX_IMAGES_PER_TURN} images per turn.`);
  }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    if (!perm.canAskAgain) {
      throw new AccessDeniedError(
        "Allow photo access",
        "Photo access is turned off for Zavi. Allow it in Settings to attach an image.",
      );
    }
    throw new ImageAttachError("Photo access is needed to attach an image.");
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.8,
    allowsMultipleSelection: true,
    selectionLimit: slots,
  });
  if (result.canceled) return [];

  const picked: PickedImage[] = [];
  for (const asset of result.assets.slice(0, slots)) {
    let file: File;
    try {
      file = new File(asset.uri);
      if (!file.exists) throw new Error("missing");
    } catch {
      onSkip?.("Skipping an image: it is no longer available on this device.");
      continue;
    }
    const name = asset.fileName ?? file.name ?? "image.jpg";
    const mime = (asset.mimeType || file.type || "").toLowerCase();
    if (mime && !ALLOWED_IMAGE_MIMES.has(mime)) {
      onSkip?.(`Skipping ${name}: only PNG/JPEG/WebP allowed.`);
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      onSkip?.(`Skipping ${name}: max 5MB per image.`);
      continue;
    }
    picked.push({ uri: asset.uri, name, mime });
  }
  return picked;
}

export async function uploadChatFile(
  uri: string,
  route: "/api/chat/upload-image" | "/api/chat/upload-video" | "/api/chat/upload-doc",
  field: "image_path" | "video_path" | "doc_path",
): Promise<string> {
  const form = new FormData();
  form.append("file", new File(uri) as unknown as Blob);
  const res = await apiFetch(route, { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = "";
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? "";
    } catch {
    }
    if (res.status === 413) {
      throw new Error("This file is too large for the server right now. Try a smaller or shorter one.");
    }
    throw new Error(message || `upload failed (${res.status})`);
  }
  const json = (await res.json()) as Record<string, string>;
  return json[field];
}

export async function uploadImage(picked: PickedImage): Promise<string> {
  const form = new FormData();
  form.append("file", new File(picked.uri) as unknown as Blob);

  const res = await apiFetch("/api/chat/upload-image", { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `upload failed (${res.status})`);
  }
  const json = (await res.json()) as { image_path: string };
  return json.image_path;
}
