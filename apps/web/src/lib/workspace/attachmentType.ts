
const MEDIA_TYPE_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
};

export function normalizeAttachmentFile(file: File): File {
  if (file.type) return file;
  const dot = file.name.lastIndexOf(".");
  if (dot < 0) return file;
  const inferred = MEDIA_TYPE_BY_EXT[file.name.slice(dot + 1).toLowerCase()];
  if (!inferred) return file;
  return new File([file], file.name, {
    type: inferred,
    lastModified: file.lastModified,
  });
}
