
import { CREATOR_PHOTO_MAX_BYTES, CREATOR_PHOTO_MIME } from "@zavi/shared";
import { createBrowserSupabase } from "@/lib/supabase";
import { creatorApi } from "./api";

export const PHOTO_ACCEPT = CREATOR_PHOTO_MIME.join(",");

export function photoFileError(file: { type: string; size: number }): string | null {
  if (!(CREATOR_PHOTO_MIME as readonly string[]).includes(file.type)) return "Upload a JPG, PNG or WebP photo.";
  if (file.size <= 0) return "That file is empty.";
  if (file.size > CREATOR_PHOTO_MAX_BYTES) return "Photos can be up to 5 MB.";
  return null;
}

export async function uploadProfilePhoto(file: File): Promise<void> {
  const bad = photoFileError(file);
  if (bad) throw new Error(bad);
  const ticket = await creatorApi.photoUploadUrl(file.type, file.size);
  const { error } = await createBrowserSupabase().storage.from("creator-media").uploadToSignedUrl(ticket.path, ticket.token, file);
  if (error) throw new Error("The upload did not finish. Try again.");
  await creatorApi.saveProfile({ photo_path: ticket.path });
}
