export const WORKSPACE_FILE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

export type WorkspaceFileMime = (typeof WORKSPACE_FILE_MIMES)[number];

const MIME_EXT: Record<WorkspaceFileMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

const DECLARED_ALIASES: Record<string, WorkspaceFileMime> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
  "image/avif": "image/avif",
};

export function normalizeDeclaredMime(declared: string | undefined | null): WorkspaceFileMime | null {
  const key = String(declared ?? "").split(";")[0].trim().toLowerCase();
  return Object.hasOwn(DECLARED_ALIASES, key) ? DECLARED_ALIASES[key] : null;
}

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.length >= end ? buf.toString("latin1", start, end) : "";
}

function isAvif(buf: Buffer): boolean {
  if (buf.length < 16 || ascii(buf, 4, 8) !== "ftyp") return false;
  const boxSize = buf.readUInt32BE(0);
  const end = Math.min(boxSize >= 16 ? boxSize : 16, buf.length, 256);
  const brands = [ascii(buf, 8, 12)];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(buf, i, i + 4));
  return brands.some((b) => b === "avif" || b === "avis");
}

export function sniffImageMime(buf: Buffer): WorkspaceFileMime | null {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (ascii(buf, 0, 4) === "GIF8") return "image/gif";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WEBP") return "image/webp";
  if (isAvif(buf)) return "image/avif";
  return null;
}

export function extensionForMime(mime: WorkspaceFileMime): string {
  return MIME_EXT[mime];
}

const STORAGE_NAME_MAX = 100;

function clean(part: string): string {
  return part
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

export function sanitizeFileName(original: string, mime: WorkspaceFileMime): string {
  const base = String(original ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const rawExt = dot > 0 ? base.slice(dot + 1) : "";
  const hasExt = /^[A-Za-z0-9]{1,10}$/.test(rawExt);
  const ext = (hasExt ? rawExt : extensionForMime(mime)).toLowerCase();
  const stem = clean(hasExt ? base.slice(0, dot) : base) || "image";
  const room = STORAGE_NAME_MAX - ext.length - 1;
  const trimmed = stem.slice(0, room).replace(/[-.]+$/g, "") || "image";
  return `${trimmed}.${ext}`;
}

export function displayName(original: string): string {
  const base = (String(original ?? "").split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return Array.from(base || "image").slice(0, 255).join("");
}
