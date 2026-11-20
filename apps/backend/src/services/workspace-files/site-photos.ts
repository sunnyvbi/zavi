import type { SupabaseClient } from "@supabase/supabase-js";
import { asTenantId, tenantStorage } from "@/services/tenant-client";
import { WORKSPACE_FILES_BUCKET, fileObjectPath, isServableName, isUuid } from "./workspace-files";

export const SITE_PHOTO_DOWNLOAD_TTL_SECONDS = 60 * 60;
export const SITE_PHOTO_DIR = "public/images";
const MAX_SITE_PHOTOS = 20;
export const CHAT_IMAGE_BUCKET = "agent-chat-images";
const CHAT_IMAGE_PATH = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\.jpg$/;

const WORKSPACE_FILE_URL =
  /https?:\/\/[^\s"'<>]+?\/api\/public\/workspace-files\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([^\s/"'<>]+)/gi;

export type WorkspacePhotoRef = { tenantId: string; fileId: string; name: string };

export type SitePhoto = { name: string; sitePath: string; repoPath: string; downloadUrl: string };

function decodeName(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function findWorkspacePhotoRefs(text: string): WorkspacePhotoRef[] {
  const refs: WorkspacePhotoRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(WORKSPACE_FILE_URL)) {
    const tenantId = m[1]!.toLowerCase();
    const fileId = m[2]!.toLowerCase();
    const name = decodeName(m[3]!);
    if (!isUuid(tenantId) || !isUuid(fileId) || !isServableName(name) || seen.has(fileId)) continue;
    seen.add(fileId);
    refs.push({ tenantId, fileId, name });
  }
  return refs;
}

export function sitePhotoFileName(name: string, fileId: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const stem = (dot > 0 ? name.slice(0, dot) : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const base = stem || `photo-${fileId.slice(0, 8)}`;
  return ext ? `${base}.${ext}` : base;
}

export async function signSitePhotos(
  storage: SupabaseClient["storage"],
  tenantId: string,
  text: string,
): Promise<SitePhoto[]> {
  const owner = tenantId.toLowerCase();
  const refs = findWorkspacePhotoRefs(text)
    .filter((r) => r.tenantId === owner)
    .slice(0, MAX_SITE_PHOTOS);
  const used = new Set<string>();
  const photos: SitePhoto[] = [];
  for (const ref of refs) {
    const { data, error } = await storage
      .from(WORKSPACE_FILES_BUCKET)
      .createSignedUrl(fileObjectPath(owner, ref.fileId, ref.name), SITE_PHOTO_DOWNLOAD_TTL_SECONDS);
    if (error || !data?.signedUrl) continue;
    let file = sitePhotoFileName(ref.name, ref.fileId);
    if (used.has(file)) file = `${ref.fileId.slice(0, 8)}-${file}`;
    used.add(file);
    photos.push({
      name: ref.name,
      sitePath: `/images/${file}`,
      repoPath: `${SITE_PHOTO_DIR}/${file}`,
      downloadUrl: data.signedUrl,
    });
  }
  return photos;
}

export function ownChatImagePaths(tenantId: string, paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const owner = tenantId.toLowerCase();
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string") continue;
    const m = CHAT_IMAGE_PATH.exec(p.toLowerCase());
    if (!m || m[1] !== owner || out.includes(p.toLowerCase())) continue;
    out.push(p.toLowerCase());
    if (out.length >= MAX_SITE_PHOTOS) break;
  }
  return out;
}

export async function signChatPhotos(
  storage: SupabaseClient["storage"],
  tenantId: string,
  paths: ReadonlyArray<string>,
): Promise<SitePhoto[]> {
  const photos: SitePhoto[] = [];
  for (const path of ownChatImagePaths(tenantId, paths)) {
    const { data, error } = await storage
      .from(CHAT_IMAGE_BUCKET)
      .createSignedUrl(path, SITE_PHOTO_DOWNLOAD_TTL_SECONDS);
    if (error || !data?.signedUrl) continue;
    const file = `chat-photo-${path.split("/")[1]!.slice(0, 8)}.jpg`;
    photos.push({
      name: `photo attached in chat (${file})`,
      sitePath: `/images/${file}`,
      repoPath: `${SITE_PHOTO_DIR}/${file}`,
      downloadUrl: data.signedUrl,
    });
  }
  return photos;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function renderSitePhotoBlock(photos: ReadonlyArray<SitePhoto>, repoRoot: string): string {
  if (photos.length === 0) return "";
  const lines = photos.map(
    (p) =>
      `- \`${p.name}\` → site path \`${p.sitePath}\`\n  \`mkdir -p ${repoRoot}/${SITE_PHOTO_DIR} && curl -fsSL -o ${shellQuote(`${repoRoot}/${p.repoPath}`)} ${shellQuote(p.downloadUrl)}\``,
  );
  return [
    "",
    "",
    "### Workspace photos to put on the site",
    "The user gave you these photos, from their workspace Files or attached in chat. Any workspace link in the request can point at a host this sandbox cannot reach (for example localhost), so never fetch it and never put it in code. Run the command next to each photo instead: it downloads the exact file into the repo. The download links expire in about an hour and must not appear in code either.",
    `Use each photo by its site path (for example \`<SiteImage image={{ src: "${photos[0]!.sitePath}", alt: "..." }} />\` from \`src/components/ui/image\` when the site has it, else \`<img src="${photos[0]!.sitePath}" alt="...">\` or a CSS \`url(${photos[0]!.sitePath})\`), and commit the image file under \`${SITE_PHOTO_DIR}/\` together with the code that uses it. If a download fails, stop and say so; do not substitute a stock photo.`,
    USER_OWNS_THEIR_IMAGES,
    ...lines,
  ].join("\n");
}

export async function sitePhotoBlockForRefine(
  tenantId: string,
  text: string,
  repoRoot: string,
  chatImagePaths: ReadonlyArray<string> = [],
): Promise<string> {
  if (!isUuid(tenantId)) return "";
  const hasLinks = findWorkspacePhotoRefs(text).length > 0;
  const chatPaths = ownChatImagePaths(tenantId, chatImagePaths);
  if (!hasLinks && chatPaths.length === 0) return "";
  try {
    const storage = tenantStorage(asTenantId(tenantId.toLowerCase()));
    const photos = [
      ...(hasLinks ? await signSitePhotos(storage, tenantId, text) : []),
      ...(chatPaths.length > 0 ? await signChatPhotos(storage, tenantId, chatPaths) : []),
    ];
    return renderSitePhotoBlock(photos, repoRoot);
  } catch {
    return "";
  }
}

const USER_OWNS_THEIR_IMAGES =
  "Any image the user gives Zavi is theirs to use however they ask, on their app, site or posts: " +
  "never ask who made it, whether they own it, where it came from, or about copyright, licensing or rights, " +
  "and never refuse, delay or add conditions on those grounds. A filename, tag or subject is not a reason to ask.";

export function workspacePhotosNote(tenantId: string, text: string): string {
  const owner = tenantId.toLowerCase();
  if (!findWorkspacePhotoRefs(text).some((r) => r.tenantId === owner)) return "";
  return (
    "[Note from Zavi, not the user: the user linked photos from their workspace Files in this message. " +
    "They are the user's own uploads and Zavi already has them. The links may not open from where you are (they can point at localhost), " +
    "but that does not mean the photo is missing: never tell the user the image is local, broken or out of reach, and never ask them to upload it again. " +
    `${USER_OWNS_THEIR_IMAGES} ` +
    "If they want it on their app or site, hand the change to the engineer and keep the links in your request; " +
    "Zavi passes these exact files to the engineer automatically.]"
  );
}

export function attachedPhotosNote(tenantId: string, imagePaths: unknown): string {
  const count = ownChatImagePaths(tenantId, imagePaths).length;
  if (count === 0) return "";
  const noun = count === 1 ? "a photo" : `${count} photos`;
  return (
    `[Note from Zavi, not the user: the user attached ${noun} to this message. ` +
    "It is the user's own upload, Zavi has already stored it, and it can go straight onto their app or site as it is. " +
    `${USER_OWNS_THEIR_IMAGES} ` +
    "Never say the image is local, unreachable or missing, and never ask them to send it again. " +
    "If they want it on their app or site, hand the change to the engineer with their ask verbatim; " +
    "Zavi passes the attached file to the engineer automatically.]"
  );
}
