import * as Device from "expo-device";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { AccessDeniedError, ImageAttachError, MAX_IMAGE_BYTES, type PickedImage } from "./uploadImage";

export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEOS_PER_TURN = 1;
export const MAX_DOC_BYTES = 10 * 1024 * 1024;
export const MAX_DOCS_PER_TURN = 4;
export const ALLOWED_DOC_EXTS = new Set(["pdf", "docx", "csv", "txt"]);

export class CameraUnavailableError extends ImageAttachError {}

const DOC_MIMES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
  "text/comma-separated-values",
  "text/plain",
];

const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

function sizeOf(uri: string): number | null {
  try {
    const f = new File(uri);
    return f.exists ? f.size : null;
  } catch {
    return null;
  }
}

export async function takePhoto(): Promise<PickedImage | null> {
  if (!Device.isDevice) {
    throw new CameraUnavailableError("This device doesn't have a camera. Pick a photo from Photos instead.");
  }
  const current = await ImagePicker.getCameraPermissionsAsync();
  const perm = current.granted ? current : await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) {
    if (!perm.canAskAgain) {
      throw new AccessDeniedError(
        "Allow camera access",
        "Camera access is turned off for Zavi. Allow it in Settings to take a photo.",
      );
    }
    throw new ImageAttachError("Camera access is needed to take a photo.");
  }
  let result: ImagePicker.ImagePickerResult;
  try {
    result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 });
  } catch {
    throw new CameraUnavailableError("The camera isn't available right now. Pick a photo from Photos instead.");
  }
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const size = sizeOf(asset.uri);
  if (size !== null && size > MAX_IMAGE_BYTES) {
    throw new ImageAttachError("That photo is over 5MB. Try again, or pick a smaller one.");
  }
  return { uri: asset.uri, name: asset.fileName ?? "photo.jpg", mime: asset.mimeType ?? "image/jpeg" };
}

export async function pickVideo(): Promise<PickedImage | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    if (!perm.canAskAgain) {
      throw new AccessDeniedError(
        "Allow photo access",
        "Photo access is turned off for Zavi. Allow it in Settings to attach a video.",
      );
    }
    throw new ImageAttachError("Photo access is needed to attach a video.");
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["videos"],
    allowsMultipleSelection: false,
  });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const name = asset.fileName ?? asset.uri.split("/").pop() ?? "video.mp4";
  const mime = (asset.mimeType ?? "").toLowerCase();
  if (mime && !mime.startsWith("video/")) {
    throw new ImageAttachError(`${name} isn't a video.`);
  }
  const size = sizeOf(asset.uri);
  if (size !== null && size > MAX_VIDEO_BYTES) {
    throw new ImageAttachError(`${name} is over 50MB. Pick a shorter video.`);
  }
  return { uri: asset.uri, name, mime: mime || "video/mp4" };
}

type DocPicker = typeof import("expo-document-picker");
function docPicker(): DocPicker | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-document-picker") as DocPicker;
  } catch {
    return null;
  }
}

export async function pickDocuments(
  slots: number,
  onSkip?: (message: string) => void,
): Promise<PickedImage[]> {
  if (slots <= 0) throw new ImageAttachError(`Max ${MAX_DOCS_PER_TURN} files per message.`);
  const picker = docPicker();
  if (!picker) {
    throw new ImageAttachError("Attaching files needs the latest version of the app.");
  }
  const result = await picker.getDocumentAsync({
    type: DOC_MIMES,
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];

  const picked: PickedImage[] = [];
  for (const asset of result.assets.slice(0, slots)) {
    const name = asset.name ?? "file";
    if (!ALLOWED_DOC_EXTS.has(extOf(name))) {
      onSkip?.(`Skipping ${name}: only PDF, DOCX, CSV and TXT files.`);
      continue;
    }
    const size = asset.size ?? sizeOf(asset.uri);
    if (size !== null && size !== undefined && size > MAX_DOC_BYTES) {
      onSkip?.(`Skipping ${name}: max 10MB per file.`);
      continue;
    }
    picked.push({ uri: asset.uri, name, mime: asset.mimeType ?? "" });
  }
  if (result.assets.length > slots) {
    onSkip?.(`Only ${slots} more file${slots === 1 ? "" : "s"} fit in this message.`);
  }
  return picked;
}
