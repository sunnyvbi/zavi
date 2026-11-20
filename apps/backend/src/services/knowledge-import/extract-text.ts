
import path from "node:path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

export const TEXT_EXTENSIONS = new Set(["md", "txt", "csv", "json", "pdf", "docx"]);
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

export type ExtractResult = { ok: true; text: string } | { ok: false; reason: string };

export function extensionOf(filename: string): string {
  return path.extname(filename).toLowerCase().slice(1);
}

export function fileKind(filename: string): "text" | "image" | "unsupported" {
  const ext = extensionOf(filename);
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "unsupported";
}

function nonEmpty(text: string, reason: string): ExtractResult {
  return text.trim() ? { ok: true, text } : { ok: false, reason };
}

export async function extractText(buffer: Buffer, ext: string): Promise<ExtractResult> {
  try {
    if (ext === "pdf") return nonEmpty((await pdfParse(buffer)).text ?? "", "no text in it, it may be a scan");
    if (ext === "docx") return nonEmpty((await mammoth.extractRawText({ buffer })).value ?? "", "the document has no text");
    if (ext === "md" || ext === "txt" || ext === "csv" || ext === "json") {
      const s = buffer.toString("utf8");
      if (s.includes("\u0000")) return { ok: false, reason: "it isn't a text file" };
      return nonEmpty(s, "the file is empty");
    }
    return { ok: false, reason: `.${ext || "?"} files aren't supported` };
  } catch {
    return { ok: false, reason: "the file looks damaged" };
  }
}
